#!/usr/bin/env bun
/** Per-profile OCI account report: tenancy + IAM users. Company name, email, MFA, state, last login, created. */
import { parseArgs } from "util";
import { loadOciProfiles, ociJson, ociListAll, type OciProfile } from "./oci-fetch.ts";

type Tenancy = {
  id: string;
  name?: string;
  description?: string;
  homeRegionKey?: string;
};
type User = {
  id: string;
  name?: string;
  email?: string;
  description?: string;
  lifecycleState?: string;
  isMfaActivated?: boolean;
  lastSuccessfulLoginTime?: string;
  timeCreated?: string;
};
type AccountRow = {
  profile: string;
  region: string;
  tenancyName: string;
  homeRegion: string;
  user: string;
  email: string;
  mfa: string;
  lifecycle: string;
  lastLogin: string;
  created: string;
};

async function accountRows(profile: OciProfile): Promise<AccountRow[]> {
  const identityBase = `https://identity.${profile.region}.oci.oraclecloud.com/20160918`;
  const usersUrl = new URL(`${identityBase}/users`);
  usersUrl.searchParams.set("compartmentId", profile.tenancy);

  const [tenancy, users] = await Promise.all([
    ociJson<Tenancy>(`${identityBase}/tenancies/${profile.tenancy}`, profile),
    ociListAll<User>(usersUrl, profile),
  ]);

  const tenancyName = tenancy.name ?? "";
  const homeRegion = tenancy.homeRegionKey ?? "";

  return users.map((user) => ({
    profile: profile.name,
    region: profile.region,
    tenancyName,
    homeRegion,
    user: user.name ?? "",
    email: user.email ?? "",
    mfa: user.isMfaActivated ? "yes" : "no",
    lifecycle: user.lifecycleState ?? "",
    lastLogin: user.lastSuccessfulLoginTime ?? "",
    created: user.timeCreated ?? "",
  }));
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    profile: { type: "string", short: "p", multiple: true },
  },
  allowPositionals: true,
});

const requested = [
  ...(values.profile ?? []),
  ...positionals,
  ...(process.env.OCI_PROFILES?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? []),
].filter(Boolean);

try {
  const configured = await loadOciProfiles();
  const profiles = requested.length
    ? configured.filter((p) => requested.includes(p.name))
    : configured;
  if (!profiles.length) {
    throw new Error(
      requested.length
        ? `No matching OCI profile found: ${requested.join(", ")}`
        : "No OCI profiles found in config",
    );
  }

  const results = await Promise.all(
    profiles.map(async (profile) => {
      try {
        return await accountRows(profile);
      } catch (error) {
        console.error(`ERROR profile ${profile.name} (${profile.region}): ${String(error)}`);
        process.exitCode = 1;
        return [] as AccountRow[];
      }
    }),
  );

  const rows = results.flat();
  if (rows.length) {
    console.table(rows);
  } else {
    console.log("No users found in tenancy.");
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
