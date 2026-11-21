#!/usr/bin/env bun
import { parseArgs } from "util";
import { loadOciProfiles, ociJson, ociListAll, type OciProfile } from "./oci-fetch.ts";

type Compartment = {
  id: string;
  name?: string;
  lifecycleState: string;
};

type BucketSummary = {
  name: string;
  namespace: string;
  compartmentId: string;
  timeCreated?: string;
};

type BucketDetails = {
  name: string;
  namespace: string;
  compartmentId: string;
  storageTier?: string;
  publicAccessType?: string;
  versioning?: string;
  approximateCount?: number | null;
  approximateSize?: number | null;
  timeCreated?: string;
};

type BucketRow = {
  profile: string;
  region: string;
  namespace: string;
  compartment: string;
  name: string;
  tier: string;
  publicAccess: string;
  objects: number | string;
  size: string;
  created: string;
};

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "N/A";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / 1024 ** i;
  return `${val >= 10 || i === 0 ? val.toFixed(1) : val.toFixed(2)} ${units[i]}`;
}

async function listProfileBuckets(profile: OciProfile): Promise<BucketRow[]> {
  const identityBase = `https://identity.${profile.region}.oci.oraclecloud.com/20160918`;
  const objBase = `https://objectstorage.${profile.region}.oraclecloud.com`;

  const nsUrl = new URL(`${objBase}/n/`);
  nsUrl.searchParams.set("compartmentId", profile.tenancy);

  const compartmentsUrl = new URL(`${identityBase}/compartments`);
  compartmentsUrl.searchParams.set("compartmentId", profile.tenancy);
  compartmentsUrl.searchParams.set("compartmentIdInSubtree", "true");
  compartmentsUrl.searchParams.set("accessLevel", "ACCESSIBLE");

  // 1. Fetch Object Storage namespace and accessible compartments in parallel;
  //    as soon as namespace resolves, immediately query the root compartment's buckets.
  const namespacePromise = ociJson<string>(nsUrl, profile);

  const rootBucketsPromise = namespacePromise.then((namespace) => {
    const url = new URL(`${objBase}/n/${encodeURIComponent(namespace)}/b/`);
    url.searchParams.set("compartmentId", profile.tenancy);
    return ociListAll<BucketSummary>(url, profile).catch(() => [] as BucketSummary[]);
  });

  const [namespace, rootBuckets, compartments] = await Promise.all([
    namespacePromise,
    rootBucketsPromise,
    ociListAll<Compartment>(compartmentsUrl, profile),
  ]);

  const compartmentNames = new Map<string, string>([[profile.tenancy, "(root)"]]);
  const childCompartmentIds: string[] = [];
  for (const c of compartments) {
    if (c.lifecycleState === "ACTIVE" && c.id !== profile.tenancy) {
      compartmentNames.set(c.id, c.name ?? c.id);
      childCompartmentIds.push(c.id);
    }
  }

  const encodedNs = encodeURIComponent(namespace);

  // 2. List buckets across any active child compartments in parallel
  const childBucketsByCompartment = await Promise.all(
    childCompartmentIds.map((compartmentId) => {
      const url = new URL(`${objBase}/n/${encodedNs}/b/`);
      url.searchParams.set("compartmentId", compartmentId);
      return ociListAll<BucketSummary>(url, profile).catch(() => [] as BucketSummary[]);
    }),
  );

  const summaries = [...rootBuckets, ...childBucketsByCompartment.flat()];
  if (!summaries.length) return [];

  // 3. Fetch bucket details (tier, public access, approximate object count & size) in parallel
  return Promise.all(
    summaries.map(async (summary): Promise<BucketRow> => {
      const detailUrl = new URL(
        `${objBase}/n/${encodedNs}/b/${encodeURIComponent(summary.name)}`,
      );
      detailUrl.searchParams.set("fields", "approximateCount,approximateSize");

      const detail = await ociJson<BucketDetails>(detailUrl, profile).catch(
        () => undefined,
      );

      return {
        profile: profile.name,
        region: profile.region,
        namespace,
        compartment: compartmentNames.get(summary.compartmentId) ?? summary.compartmentId,
        name: summary.name,
        tier: detail?.storageTier ?? "Standard",
        publicAccess: detail?.publicAccessType ?? "N/A",
        objects: detail?.approximateCount ?? "N/A",
        size: formatBytes(detail?.approximateSize),
        created: detail?.timeCreated ?? summary.timeCreated ?? "",
      };
    }),
  );
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
        return await listProfileBuckets(profile);
      } catch (error) {
        console.error(`ERROR profile ${profile.name} (${profile.region}): ${String(error)}`);
        process.exitCode = 1;
        return [] as BucketRow[];
      }
    }),
  );

  const rows = results.flat();
  if (rows.length) {
    console.table(rows);
  } else {
    console.log("No buckets found.");
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
