#!/usr/bin/env bun
import { parseArgs } from "util";
import { loadOciProfiles, ociJson, ociListAll, type OciProfile } from "./oci-fetch.ts";

type Compartment = { id: string; lifecycleState: string };
type Instance = {
  id: string;
  compartmentId: string;
  displayName?: string;
  lifecycleState?: string;
  shape?: string;
  shapeConfig?: { ocpus?: number; memoryInGBs?: number };
};
type VnicAttachment = {
  instanceId: string;
  vnicId: string;
  lifecycleState: string;
};
type Vnic = {
  privateIp?: string;
  publicIp?: string | null;
};
type MysqlDbSystem = {
  displayName?: string;
  lifecycleState?: string;
  shapeName?: string;
};
type ReportRow = {
  profile: string;
  region: string;
  type: "Instance" | "MySQL";
  name: string;
  state: string;
  shape: string;
  cpu: number | string;
  memoryGB: number | string;
  privateIp: string;
  publicIp: string;
};

async function fetchCompartmentResources(
  iaasBase: string,
  mysqlBase: string,
  compartmentId: string,
  profile: OciProfile,
) {
  const instancesUrl = new URL(`${iaasBase}/instances`);
  instancesUrl.searchParams.set("compartmentId", compartmentId);

  const attUrl = new URL(`${iaasBase}/vnicAttachments`);
  attUrl.searchParams.set("compartmentId", compartmentId);

  const mysqlUrl = new URL(`${mysqlBase}/dbSystems`);
  mysqlUrl.searchParams.set("compartmentId", compartmentId);

  const [instances, vnicsByInstance, mysqlDbs] = await Promise.all([
    ociListAll<Instance>(instancesUrl, profile),
    (async () => {
      const attachments = await ociListAll<VnicAttachment>(attUrl, profile);
      const active = attachments.filter((a) => a.lifecycleState === "ATTACHED");
      const entries = await Promise.all(
        active.map(async (a) => {
          const vnic = await ociJson<Vnic>(`${iaasBase}/vnics/${a.vnicId}`, profile);
          return [a.instanceId, vnic] as const;
        }),
      );
      const map = new Map<string, Vnic[]>();
      for (const [instanceId, vnic] of entries) {
        const list = map.get(instanceId);
        if (list) list.push(vnic);
        else map.set(instanceId, [vnic]);
      }
      return map;
    })(),
    ociListAll<MysqlDbSystem>(mysqlUrl, profile).catch(() => [] as MysqlDbSystem[]),
  ]);

  return { instances, vnicsByInstance, mysqlDbs };
}

async function reportProfile(profile: OciProfile): Promise<ReportRow[]> {
  const identityBase = `https://identity.${profile.region}.oci.oraclecloud.com/20160918`;
  const iaasBase = `https://iaas.${profile.region}.oraclecloud.com/20160918`;
  const mysqlBase = `https://mysql.${profile.region}.ocp.oraclecloud.com/20190415`;

  const compartmentsUrl = new URL(`${identityBase}/compartments`);
  compartmentsUrl.searchParams.set("compartmentId", profile.tenancy);
  compartmentsUrl.searchParams.set("compartmentIdInSubtree", "true");
  compartmentsUrl.searchParams.set("accessLevel", "ACCESSIBLE");

  // Query root tenancy immediately in parallel with child-compartment discovery
  const [rootData, childDataList] = await Promise.all([
    fetchCompartmentResources(iaasBase, mysqlBase, profile.tenancy, profile),
    ociListAll<Compartment>(compartmentsUrl, profile).then((compartments) => {
      const childIds = [
        ...new Set(
          compartments
            .filter((c) => c.lifecycleState === "ACTIVE" && c.id !== profile.tenancy)
            .map((c) => c.id),
        ),
      ];
      return Promise.all(
        childIds.map((id) => fetchCompartmentResources(iaasBase, mysqlBase, id, profile)),
      );
    }),
  ]);

  const allData = [rootData, ...childDataList];
  const instances = allData
    .flatMap((d) => d.instances)
    .filter((i) => i.lifecycleState !== "TERMINATED");
  const mysqlDbs = allData
    .flatMap((d) => d.mysqlDbs)
    .filter((db) => db.lifecycleState !== "DELETED");

  const vnicsByInstance = new Map<string, Vnic[]>();
  for (const d of allData) {
    for (const [instanceId, vnics] of d.vnicsByInstance) {
      vnicsByInstance.set(instanceId, vnics);
    }
  }

  const rows: ReportRow[] = instances.map((instance) => {
    const vnics = vnicsByInstance.get(instance.id) ?? [];
    const privateIp = vnics.map((v) => v.privateIp).filter(Boolean).join(", ") || "None";
    const publicIp = vnics.map((v) => v.publicIp).filter(Boolean).join(", ") || "None";

    return {
      profile: profile.name,
      region: profile.region,
      type: "Instance",
      name: instance.displayName ?? "",
      state: instance.lifecycleState ?? "",
      shape: instance.shape ?? "",
      cpu: instance.shapeConfig?.ocpus ?? "N/A",
      memoryGB: instance.shapeConfig?.memoryInGBs ?? "N/A",
      privateIp,
      publicIp,
    };
  });

  rows.push(
    ...mysqlDbs.map((db): ReportRow => ({
      profile: profile.name,
      region: profile.region,
      type: "MySQL",
      name: db.displayName ?? "",
      state: db.lifecycleState ?? "",
      shape: db.shapeName ?? "",
      cpu: "N/A",
      memoryGB: "N/A",
      privateIp: "N/A",
      publicIp: "N/A",
    })),
  );

  return rows;
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
      .map((s) => s.trim())
      .filter(Boolean) ?? []),
  ].filter(Boolean);
  const profiles = requested.length
    ? configured.filter((p) => requested.includes(p.name))
    : configured;
  if (!profiles.length) throw new Error("No matching OCI profiles found in config");

  const results = await Promise.all(
    profiles.map(async (profile) => {
      try {
        return await reportProfile(profile);
      } catch (error) {
        console.error(`ERROR profile ${profile.name} (${profile.region}): ${String(error)}`);
        process.exitCode = 1;
        return [] as ReportRow[];
      }
    }),
  );

  const rows = results.flat();
  if (rows.length) {
    console.table(rows);
  } else {
    console.log("No instances found.");
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
