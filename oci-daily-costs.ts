#!/usr/bin/env bun
/** Daily OCI usage-cost report. Defaults to yesterday UTC; use --days N for a rolling N-day range. */
type Profile = { name: string; tenancy: string; region: string };
type UsageItem = {
  service?: string;
  "sku-name"?: string;
  "resource-id"?: string;
  "resource-name"?: string;
  "attributed-cost"?: string;
  "computed-amount"?: number;
  currency?: string;
};
type BootVolume = { id: string; "display-name"?: string; "size-in-gbs"?: number; "lifecycle-state"?: string };

const configPath = process.env.OCI_CLI_CONFIG_FILE ?? `${Bun.env.HOME}/.oci/config`;
const daysArg = process.argv.indexOf("--days");
const days = daysArg >= 0 ? Number(process.argv[daysArg + 1]) : 1;
if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("--days must be an integer from 1 to 365");

function profilesFrom(config: string): Profile[] {
  const result: Profile[] = [];
  let current: Partial<Profile> | undefined;
  for (const line of config.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      if (current?.name && current.tenancy && current.region) result.push(current as Profile);
      current = { name: section[1] };
      continue;
    }
    const setting = line.match(/^\s*(tenancy|region)\s*=\s*(.*?)\s*$/);
    if (setting && current) current[setting[1] as "tenancy" | "region"] = setting[2];
  }
  if (current?.name && current.tenancy && current.region) result.push(current as Profile);
  return result;
}

async function ociJson<T>(args: string[]): Promise<T> {
  const proc = Bun.spawn(["oci", "--config-file", configPath, ...args, "--output", "json"], { stdout: "pipe", stderr: "pipe" });
  const out = new Response(proc.stdout).text();
  const err = new Response(proc.stderr).text();
  const codePromise = proc.exited;
  const [stdout, stderr, code] = await Promise.all([out, err, codePromise]);
  if (code !== 0) throw new Error(stderr.trim() || `oci exited with status ${code}`);
  if (!stdout.trim()) throw new Error(`oci returned empty output${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  return JSON.parse(stdout) as T;
}

const now = new Date();
const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const start = new Date(end);
start.setUTCDate(start.getUTCDate() - days);
const date = (d: Date) => d.toISOString().slice(0, 10);
const startDate = date(start), endDate = date(end);
const requested = process.env.OCI_PROFILES?.split(",").map(s => s.trim()).filter(Boolean);
const allProfiles = profilesFrom(await Bun.file(configPath).text());
const profiles = requested?.length ? allProfiles.filter(p => requested.includes(p.name)) : allProfiles;
if (!profiles.length) throw new Error("No matching OCI profiles found in config");

for (const profile of profiles) {
  console.log(`\n=== ${profile.name} | ${startDate} to ${endDate} UTC | costs in reported currency ===`);
  try {
    const data = await ociJson<{ data?: { items?: UsageItem[] } }>([
      "--profile", profile.name, "usage-api", "usage-summary", "request-summarized-usages",
      "--tenant-id", profile.tenancy, "--time-usage-started", startDate, "--time-usage-ended", endDate,
      "--granularity", "DAILY", "--query-type", "COST", "--group-by", '["service","skuName","resourceId"]',
      "--is-aggregate-by-time", "true",
    ]);
    const items = data.data?.items ?? [];
    const volumeIds = [...new Set(items.filter(i => i.service === "Block Storage" && i["resource-id"]?.startsWith("ocid1.bootvolume.")).map(i => i["resource-id"]!))];
    const compartments = await ociJson<{ data?: { id: string }[] }>(["--profile", profile.name, "iam", "compartment", "list", "--compartment-id", profile.tenancy, "--compartment-id-in-subtree", "true", "--access-level", "ACCESSIBLE", "--all"]);
    const compartmentIds = [...new Set([profile.tenancy, ...(compartments.data ?? []).map(c => c.id)])];
    const volLists = await Promise.all(compartmentIds.map(id => ociJson<{ data?: BootVolume[] }>(["--profile", profile.name, "bv", "boot-volume", "list", "--compartment-id", id, "--all"])));
    const volumes = new Map(volLists.flatMap(r => r.data ?? []).map(v => [v.id, v]));
    const rows = items.map(item => {
      const volume = volumes.get(item["resource-id"] ?? "");
      const cost = Number(item["attributed-cost"] ?? item["computed-amount"] ?? 0);
      return { service: item.service ?? "Unknown", sku: item["sku-name"] ?? "", resource: item["resource-name"] ?? volume?.["display-name"] ?? item["resource-id"] ?? "(not attributed)", state: volume?.["lifecycle-state"] ?? "", cost, currency: item.currency ?? "" };
    }).filter(r => r.cost !== 0).sort((a, b) => b.cost - a.cost);
    if (!rows.length) console.log("No non-zero cost items returned.");
    for (const r of rows) console.log(`${r.currency} ${r.cost.toFixed(4)}  ${r.service} | ${r.sku} | ${r.resource}${r.state ? ` [${r.state}]` : ""}`);
    const totals = new Map<string, number>();
    for (const r of rows) totals.set(`${r.currency} ${r.service}`, (totals.get(`${r.currency} ${r.service}`) ?? 0) + r.cost);
    console.log("Service totals:");
    for (const [name, amount] of [...totals].sort((a, b) => b[1] - a[1])) console.log(`  ${name}: ${amount.toFixed(4)}`);
    if (volumeIds.length) {
      console.log("\nBlock-volume resource IDs missing from inventory (possibly permission-restricted):");
      for (const id of volumeIds) if (!volumes.has(id)) console.log(`  ${id}`);
    }
  } catch (e) { console.error(`ERROR: ${String(e)}`); }
}
