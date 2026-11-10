#!/usr/bin/env bun
/** Per-profile OCI account report: tenancy + IAM users. Company name, email, MFA, state, last login, created. */

type Profile = { name: string; tenancy: string; region: string };
type Tenancy = { id: string; name: string; description: string; "home-region-key"?: string };
type User = {
  id: string;
  name: string;
  email?: string;
  description?: string;
  "lifecycle-state"?: string;
  "is-mfa-activated"?: boolean;
  "last-successful-login-time"?: string;
  "time-created"?: string;
};
type AccountRow = {
  profile: string;
  region: string;
  tenancy: string;
  tenancyName: string;
  homeRegion: string;
  user: string;
  email: string;
  description: string;
  mfa: string;
  lifecycle: string;
  lastLogin: string;
  created: string;
};

const configPath = process.env.OCI_CLI_CONFIG_FILE ?? `${Bun.env.HOME}/.oci/config`;

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
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const [stdout, stderr, code] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
  if (code !== 0) throw new Error(stderr.trim() || `oci exited with status ${code}`);
  if (!stdout.trim()) throw new Error(`oci returned empty output for: ${args.slice(-6).join(" ")}; stderr=${stderr.trim() || "(empty)"}`);
  return JSON.parse(stdout) as T;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map(row => row[i]?.length ?? 0)));
  const format = (row: string[]) => row.map((value, i) => value.padEnd(widths[i] ?? 0)).join("  ");
  return [
    format(headers),
    widths.map(width => "-".repeat(width)).join("  "),
    ...rows.map(format),
  ].join("\n");
}

async function accountRows(profile: Profile): Promise<AccountRow[]> {
  const tenancy = await ociJson<{ data?: Tenancy }>(["--profile", profile.name, "iam", "tenancy", "get", "--tenancy-id", profile.tenancy]);
  const users = await ociJson<{ data?: User[] }>(["--profile", profile.name, "iam", "user", "list", "--compartment-id", profile.tenancy, "--all"]);
  const tenancyName = tenancy.data?.name ?? "";
  const homeRegion = tenancy.data?.["home-region-key"] ?? "";
  const rows: AccountRow[] = [];
  for (const user of users.data ?? []) {
    rows.push({
      profile: profile.name,
      region: profile.region,
      tenancy: tenancy.data?.id ?? "",
      tenancyName,
      homeRegion,
      user: user.name ?? "",
      email: user.email ?? "",
      description: user.description ?? "",
      mfa: user["is-mfa-activated"] ? "yes" : "no",
      lifecycle: user["lifecycle-state"] ?? "",
      lastLogin: user["last-successful-login-time"] ?? "",
      created: user["time-created"] ?? "",
    });
  }
  return rows;
}

const profileFlag = process.argv.indexOf("--profile");
if (profileFlag >= 0 && !process.argv[profileFlag + 1]) throw new Error("--profile requires a profile name");
const profileFlagValue = profileFlag >= 0 ? process.argv[profileFlag + 1] : undefined;
const positionalProfile = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : undefined;
const requested = [
  ...(profileFlagValue ? [profileFlagValue] : positionalProfile ? [positionalProfile] : []),
  ...(process.env.OCI_PROFILES?.split(",").map(s => s.trim()).filter(Boolean) ?? []),
].filter(Boolean);

function renderAccountTable(rows: AccountRow[]): string {
  const headers = ["Profile", "Region", "Tenancy", "Tenancy name", "Home region", "User", "Email", "Description", "MFA", "Lifecycle", "Last login", "Created"];
  const values = rows.map(r => [
    r.profile, r.region, r.tenancy, r.tenancyName, r.homeRegion, r.user, r.email, r.description, r.mfa, r.lifecycle, r.lastLogin, r.created,
  ]);
  return renderTable(headers, values);
}

try {
  const configured = profilesFrom(await Bun.file(configPath).text());
  const profiles = requested.length ? configured.filter(p => requested.includes(p.name)) : configured;
  if (!profiles.length) throw new Error(requested.length ? `No matching OCI profile found: ${requested.join(", ")}` : "No OCI profiles found in config");

  const results = await Promise.all(profiles.map(async profile => {
    try {
      const rows = await accountRows(profile);
      return { profile, rows };
    } catch (error) {
      console.error(`ERROR profile ${profile.name} (${profile.region}): ${String(error)}`);
      process.exitCode = 1;
      return { profile, rows: [] as AccountRow[] };
    }
  }));

  for (const { profile, rows } of results) {
    console.log(`\n=== Profile: ${profile.name} | region: ${profile.region} | tenancy: ${profile.tenancy} ===`);
    console.log(rows.length ? renderAccountTable(rows) : "No users found in tenancy.");
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
