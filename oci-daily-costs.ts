#!/usr/bin/env bun
/** Daily OCI usage-cost report. Defaults to yesterday UTC; use --days N for a rolling N-day range and --profile NAME to run for a single profile. */
import { parseArgs } from "util";
import { loadOciProfiles, ociListAll, type OciProfile } from "./oci-fetch.ts";

type UsageItem = {
  service?: string;
  skuName?: string;
  resourceId?: string;
  resourceName?: string;
  attributedCost?: string | number;
  computedAmount?: number;
  currency?: string;
  timeUsageStarted?: string;
  timeUsageEnded?: string;
};
type BootVolume = {
  id: string;
  displayName?: string;
  sizeInGBs?: number;
  lifecycleState?: string;
};
type CostRow = {
  profile: string;
  region: string;
  day: string;
  sku: string;
  resource: string;
  state: string;
  currency: string;
  cost: string;
};

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    days: { type: "string", short: "d", default: "1" },
    profile: { type: "string", short: "p", multiple: true },
    all: { type: "boolean", short: "a", default: false },
  },
  allowPositionals: true,
});

const includeZero = values.all;
const days = Number(values.days);
if (!Number.isInteger(days) || days < 1 || days > 365) {
  throw new Error("--days must be an integer from 1 to 365");
}
const requested = [
  ...(values.profile ?? []),
  ...positionals,
  ...(process.env.OCI_PROFILES?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? []),
].filter(Boolean);

const now = new Date();
const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const start = new Date(end);
start.setUTCDate(start.getUTCDate() - days);
const date = (d: Date) => d.toISOString().slice(0, 10);
const startDate = date(start);
const endDate = date(end);

async function fetchProfileCostRows(profile: OciProfile): Promise<CostRow[]> {
  const usageUrl = `https://usageapi.${profile.region}.oci.oraclecloud.com/20200107/usage`;
  const bvUrl = new URL(`https://iaas.${profile.region}.oraclecloud.com/20160918/bootVolumes`);
  bvUrl.searchParams.set("compartmentId", profile.tenancy);

  const [items, bootVolumes] = await Promise.all([
    ociListAll<UsageItem>(usageUrl, profile, {
      method: "POST",
      body: JSON.stringify({
        tenantId: profile.tenancy,
        timeUsageStarted: `${startDate}T00:00:00Z`,
        timeUsageEnded: `${endDate}T00:00:00Z`,
        granularity: "DAILY",
        queryType: "COST",
        groupBy: ["service", "skuName", "resourceId"],
      }),
    }),
    ociListAll<BootVolume>(bvUrl, profile).catch(() => [] as BootVolume[]),
  ]);

  const volumes = new Map(bootVolumes.map((v) => [v.id, v]));
  const currency =
    items.find((i) => i.currency?.trim())?.currency?.trim() || "N/A";

  const mapped = items
    .map((item) => {
      const volume = volumes.get(item.resourceId ?? "");
      const costNum = Number(item.attributedCost ?? item.computedAmount ?? 0);
      const day = item.timeUsageStarted?.slice(0, 10) ?? startDate;
      return {
        costNum,
        row: {
          profile: profile.name,
          region: profile.region,
          day,
          sku: item.skuName ?? "",
          resource:
            item.resourceName ?? volume?.displayName ?? item.resourceId ?? "(not attributed)",
          state: volume?.lifecycleState ?? "",
          currency: item.currency?.trim() || currency,
          cost: costNum.toFixed(4),
        } satisfies CostRow,
      };
    })
    .filter((x) => includeZero || x.costNum !== 0)
    .sort((a, b) => a.row.day.localeCompare(b.row.day) || b.costNum - a.costNum)
    .map((x) => x.row);

  if (mapped.length > 0) {
    return mapped;
  }

  return [
    {
      profile: profile.name,
      region: profile.region,
      day: days === 1 ? startDate : `${startDate}..${endDate}`,
      sku: "(free tier / zero cost)",
      resource: `${items.length} usage items`,
      state: "",
      currency,
      cost: "0.0000",
    },
  ];
}

try {
  const allProfiles = await loadOciProfiles();
  const profiles = requested.length
    ? allProfiles.filter((p) => requested.includes(p.name))
    : allProfiles;
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
        return await fetchProfileCostRows(profile);
      } catch (e) {
        console.error(`ERROR profile ${profile.name} (${profile.region}): ${String(e)}`);
        process.exitCode = 1;
        return [] as CostRow[];
      }
    }),
  );

  const rows = results.flat();
  if (rows.length) {
    console.table(rows);
    const totalsByCurrency = new Map<string, number>();
    for (const r of rows) {
      const amount = Number(r.cost) || 0;
      if (amount === 0 && totalsByCurrency.size > 0) continue;
      const curr = r.currency && r.currency !== "N/A" ? r.currency : "BRL";
      totalsByCurrency.set(curr, (totalsByCurrency.get(curr) ?? 0) + amount);
    }
    const formattedTotals = [...totalsByCurrency.entries()]
      .map(([curr, total]) => `${curr} ${total.toFixed(4)}`)
      .join(", ");
    console.log(`Total (${startDate} to ${endDate} UTC): ${formattedTotals || "0.0000"}`);
  } else {
    console.log(`No non-zero cost items returned for ${startDate} to ${endDate} UTC.`);
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
