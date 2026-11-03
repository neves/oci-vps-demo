#!/usr/bin/env bun

type Profile = { name: string; tenancy: string; region: string };
type User = {
  id: string;
  name: string;
  "display-name"?: string;
  email?: string;
  "lifecycle-state"?: string;
  "time-created"?: string;
  "last-successful-login-time"?: string;
};
type UserRow = { profile: string; name: string; displayName: string; email: string; created: string; lastLogin: string };

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

async function listUsers(profile: Profile): Promise<User[]> {
  const proc = Bun.spawn([
    "oci", "--config-file", configPath, "--profile", profile.name,
    "iam", "user", "list", "--compartment-id", profile.tenancy, "--all", "--output", "json",
  ], { stdout: "pipe", stderr: "pipe" });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const [stdout, stderr, code] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
  if (code !== 0) throw new Error(stderr.trim() || `oci exited with status ${code}`);
  const result = JSON.parse(stdout) as { data?: User[] };
  return result.data ?? [];
}

function renderTable(rows: UserRow[]): string {
  const headers = ["Profile", "Name", "Display name", "Email", "Created", "Last successful login"];
  const values = rows.map(r => [r.profile, r.name, r.displayName, r.email, r.created, r.lastLogin]);
  const widths = headers.map((header, i) => Math.max(header.length, ...values.map(row => row[i].length)));
  const format = (row: string[]) => row.map((value, i) => value.padEnd(widths[i])).join("  ");
  return [format(headers), widths.map(width => "-".repeat(width)).join("  "), ...values.map(format)].join("\n");
}

try {
  const configured = profilesFrom(await Bun.file(configPath).text());
  const requested = process.env.OCI_PROFILES?.split(",").map(name => name.trim()).filter(Boolean);
  if (requested?.some(name => !configured.some(profile => profile.name === name))) {
    throw new Error(`Unknown profile(s): ${requested.filter(name => !configured.some(profile => profile.name === name)).join(", ")}`);
  }
  const profiles = requested?.length ? configured.filter(profile => requested.includes(profile.name)) : configured;
  if (!profiles.length) throw new Error("No OCI profiles found in config");

  const results = await Promise.all(profiles.map(async profile => {
    try {
      const users = await listUsers(profile);
      return users.map(user => ({
        profile: profile.name,
        name: user.name ?? "",
        displayName: user["display-name"] ?? "",
        email: user.email ?? "",
        created: user["time-created"] ?? "",
        lastLogin: user["last-successful-login-time"] ?? "", 
      }));
    } catch (error) {
      console.error(`ERROR profile ${profile.name} (${profile.region}): ${String(error)}`);
      process.exitCode = 1;
      return [];
    }
  }));
  const rows = results.flat();
  console.log(rows.length ? renderTable(rows) : "No users found.");
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
