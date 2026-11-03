#!/usr/bin/env bun

type Profile = { name: string; tenancy: string; region: string };
type Instance = {
  id: string;
  "display-name": string;
  "lifecycle-state": string;
  shape: string;
  "shape-config"?: { ocpus?: number; "memory-in-gbs"?: number };
};
type MysqlDbSystem = {
  "display-name": string;
  "lifecycle-state": string;
  "shape-name": string;
};
type ReportRow = { type: string; name: string; state: string; shape: string; cpu: string; memory: string };

const configPath = process.env.OCI_CLI_CONFIG_FILE ?? `${Bun.env.HOME}/.oci/config`;

function profilesFrom(config: string): Profile[] {
  const profiles: Profile[] = [];
  let current: Partial<Profile> | undefined;
  for (const line of config.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      if (current?.name && current.tenancy && current.region) profiles.push(current as Profile);
      current = { name: section[1] };
      continue;
    }
    const setting = line.match(/^\s*(tenancy|region)\s*=\s*(.*?)\s*$/);
    if (setting && current) current[setting[1] as "tenancy" | "region"] = setting[2];
  }
  if (current?.name && current.tenancy && current.region) profiles.push(current as Profile);
  return profiles;
}

async function ociJson<T>(args: string[]): Promise<T> {
  const proc = Bun.spawn(["oci", "--config-file", configPath, ...args, "--output", "json"], {
    stdout: "pipe", stderr: "pipe",
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const [stdout, stderr, code] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
  if (code !== 0) throw new Error(stderr.trim() || `oci exited with status ${code}`);
  return (stdout.trim() ? JSON.parse(stdout) : {}) as T;
}

function table(profile: Profile, rows: ReportRow[]): string {
  const headers = ["Type", "Name", "State", "Shape", "CPU", "Memory (GB)"];
  const values = rows.map(r => [r.type, r.name, r.state, r.shape, r.cpu, r.memory]);
  const widths = headers.map((h, n) => Math.max(h.length, ...values.map(r => r[n].length)));
  const format = (row: string[]) => row.map((value, n) => value.padEnd(widths[n])).join("  ");
  return [
    `=== Profile: ${profile.name} | region: ${profile.region} ===`,
    format(headers), widths.map(w => "-".repeat(w)).join("  "), ...values.map(format),
  ].join("\n");
}

async function report(profile: Profile): Promise<string> {
  const compartments = await ociJson<{ data?: { id: string }[] }>([
    "--profile", profile.name, "iam", "compartment", "list",
    "--compartment-id", profile.tenancy, "--compartment-id-in-subtree", "true",
    "--access-level", "ACCESSIBLE", "--all",
  ]);
  const ids = [...new Set([profile.tenancy, ...(compartments.data ?? []).map(c => c.id)])];

  // Each list response includes shape-config; no per-instance get request is needed.
  const [computeResults, mysqlResults] = await Promise.all([
    Promise.all(ids.map(id => ociJson<{ data?: Instance[] }>([
      "--profile", profile.name, "compute", "instance", "list",
      "--compartment-id", id, "--all",
    ]))),
    Promise.all(ids.map(id => ociJson<{ data?: MysqlDbSystem[] }>([
      "--profile", profile.name, "mysql", "db-system", "list",
      "--compartment-id", id, "--all",
    ]))),
  ]);
  const rows: ReportRow[] = computeResults.flatMap(result => result.data ?? []).map(instance => ({
    type: "Instance",
    name: instance["display-name"] ?? "",
    state: instance["lifecycle-state"] ?? "",
    shape: instance.shape ?? "",
    cpu: String(instance["shape-config"]?.ocpus ?? "N/A"),
    memory: String(instance["shape-config"]?.["memory-in-gbs"] ?? "N/A"),
  }));
  rows.push(...mysqlResults.flatMap(result => result.data ?? []).map(db => ({
    type: "MySQL",
    name: db["display-name"] ?? "",
    state: db["lifecycle-state"] ?? "",
    shape: db["shape-name"] ?? "",
    cpu: "N/A",
    memory: "N/A",
  })));
  return table(profile, rows);
}

try {
  const configured = profilesFrom(await Bun.file(configPath).text());
  const requested = process.env.OCI_PROFILES?.split(",").map(s => s.trim()).filter(Boolean);
  const profiles = requested?.length ? configured.filter(p => requested.includes(p.name)) : configured;
  if (!profiles.length) throw new Error("No matching OCI profiles found in config");

  // Finish one profile before starting the next; compartment queries within each profile run concurrently.
  for (const profile of profiles) {
    try {
      console.log(`\n${await report(profile)}`);
    } catch (error) {
      console.error(`\n=== Profile: ${profile.name} | region: ${profile.region} ===\nERROR: ${String(error)}`);
    }
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
