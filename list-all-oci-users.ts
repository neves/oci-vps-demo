#!/usr/bin/env bun
import { parseArgs } from "util";
import { loadOciProfiles, ociListAll, type OciProfile } from "./oci-fetch.ts";

type User = {
  id: string;
  name?: string;
  description?: string;
  email?: string;
  lifecycleState?: string;
  timeCreated?: string;
  lastSuccessfulLoginTime?: string;
};
type UserRow = {
  profile: string;
  region: string;
  name: string;
  displayName: string;
  email: string;
  created: string;
  lastLogin: string;
};

async function listUsers(profile: OciProfile): Promise<User[]> {
  const url = new URL(
    `https://identity.${profile.region}.oci.oraclecloud.com/20160918/users`,
  );
  url.searchParams.set("compartmentId", profile.tenancy);
  return ociListAll<User>(url, profile);
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    profile: { type: "string", short: "p", multiple: true },
  },
  allowPositionals: true,
});

try {
  const configured = await loadOciProfiles();
  const requested = [
    ...(values.profile ?? []),
    ...positionals,
    ...(process.env.OCI_PROFILES?.split(",")
      .map((name) => name.trim())
      .filter(Boolean) ?? []),
  ].filter(Boolean);
  if (requested.some((name) => !configured.some((profile) => profile.name === name))) {
    throw new Error(
      `Unknown profile(s): ${requested.filter((name) => !configured.some((profile) => profile.name === name)).join(", ")}`,
    );
  }
  const profiles = requested.length
    ? configured.filter((profile) => requested.includes(profile.name))
    : configured;
  if (!profiles.length) throw new Error("No OCI profiles found in config");

  const results = await Promise.all(
    profiles.map(async (profile) => {
      try {
        const users = await listUsers(profile);
        return users.map(
          (user): UserRow => ({
            profile: profile.name,
            region: profile.region,
            name: user.name ?? "",
            displayName: user.description ?? "",
            email: user.email ?? "",
            created: user.timeCreated ?? "",
            lastLogin: user.lastSuccessfulLoginTime ?? "",
          }),
        );
      } catch (error) {
        console.error(`ERROR profile ${profile.name} (${profile.region}): ${String(error)}`);
        process.exitCode = 1;
        return [] as UserRow[];
      }
    }),
  );

  const rows = results.flat();
  if (rows.length) {
    console.table(rows);
  } else {
    console.log("No users found.");
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
