#!/usr/bin/env bun
import { parseArgs } from "util";
import { loadOciProfiles, ociJson, ociListAll, type OciProfile } from "./oci-fetch.ts";

interface Compartment {
  id: string;
  name: string;
  lifecycleState: string;
}

interface Instance {
  id: string;
  compartmentId: string;
  displayName: string;
  lifecycleState: string;
  shape: string;
  shapeConfig?: {
    ocpus?: number;
    memoryInGBs?: number;
  };
}

interface VnicAttachment {
  id: string;
  instanceId: string;
  vnicId: string;
  lifecycleState: string;
}

interface Vnic {
  id: string;
  privateIp?: string;
  publicIp?: string | null;
}

interface InstanceRow {
  profile: string;
  region: string;
  name: string;
  state: string;
  shape: string;
  cpu: number | string;
  memoryGB: number | string;
  privateIp: string;
  publicIp: string;
}

async function listCompartmentData(
  iaasBase: string,
  compartmentId: string,
  profile: OciProfile,
): Promise<{ instances: Instance[]; vnicsByInstance: Map<string, Vnic[]> }> {
  const instancesUrl = new URL(`${iaasBase}/instances`);
  instancesUrl.searchParams.set("compartmentId", compartmentId);

  const attUrl = new URL(`${iaasBase}/vnicAttachments`);
  attUrl.searchParams.set("compartmentId", compartmentId);

  // Fetch instances and VNIC attachments (+ their VNIC details) for this compartment in parallel
  const [instances, vnicsByInstance] = await Promise.all([
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
  ]);

  return { instances, vnicsByInstance };
}

async function listProfileInstances(profile: OciProfile): Promise<InstanceRow[]> {
  const identityBase = `https://identity.${profile.region}.oci.oraclecloud.com/20160918`;
  const iaasBase = `https://iaas.${profile.region}.oraclecloud.com/20160918`;

  const compartmentsUrl = new URL(`${identityBase}/compartments`);
  compartmentsUrl.searchParams.set("compartmentId", profile.tenancy);
  compartmentsUrl.searchParams.set("compartmentIdInSubtree", "true");
  compartmentsUrl.searchParams.set("accessLevel", "ACCESSIBLE");

  // Query the root tenancy compartment immediately in parallel with discovering child compartments
  const [rootData, childDataList] = await Promise.all([
    listCompartmentData(iaasBase, profile.tenancy, profile),
    ociListAll<Compartment>(compartmentsUrl, profile).then((compartments) => {
      const childIds = [
        ...new Set(
          compartments
            .filter((c) => c.lifecycleState === "ACTIVE" && c.id !== profile.tenancy)
            .map((c) => c.id),
        ),
      ];
      return Promise.all(
        childIds.map((id) => listCompartmentData(iaasBase, id, profile)),
      );
    }),
  ]);

  const allCompartmentData = [rootData, ...childDataList];
  const instances = allCompartmentData
    .flatMap((d) => d.instances)
    .filter((inst) => inst.lifecycleState !== "TERMINATED");

  const vnicsByInstance = new Map<string, Vnic[]>();
  for (const d of allCompartmentData) {
    for (const [instanceId, vnics] of d.vnicsByInstance) {
      vnicsByInstance.set(instanceId, vnics);
    }
  }

  return instances.map((instance): InstanceRow => {
    const vnics = vnicsByInstance.get(instance.id) ?? [];
    const privateIp = vnics.map((v) => v.privateIp).filter(Boolean).join(", ") || "None";
    const publicIp = vnics.map((v) => v.publicIp).filter(Boolean).join(", ") || "None";

    return {
      profile: profile.name,
      region: profile.region,
      name: instance.displayName ?? "",
      state: instance.lifecycleState ?? "",
      shape: instance.shape ?? "",
      cpu: instance.shapeConfig?.ocpus ?? "N/A",
      memoryGB: instance.shapeConfig?.memoryInGBs ?? "N/A",
      privateIp,
      publicIp,
    };
  });
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    profile: { type: "string", short: "p", multiple: true },
  },
  allowPositionals: true,
});

try {
  const allProfiles = await loadOciProfiles();
  const requested = [
    ...(values.profile ?? []),
    ...positionals,
    ...(process.env.OCI_PROFILES?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? []),
  ].filter(Boolean);
  const profiles = requested.length
    ? allProfiles.filter((p) => requested.includes(p.name))
    : allProfiles;

  if (!profiles.length) {
    throw new Error("No matching OCI profiles found in config");
  }

  const results = await Promise.all(
    profiles.map(async (profile) => {
      try {
        return await listProfileInstances(profile);
      } catch (err) {
        console.error(`ERROR profile ${profile.name} (${profile.region}): ${String(err)}`);
        process.exitCode = 1;
        return [];
      }
    }),
  );

  const rows = results.flat();
  if (rows.length) {
    console.table(rows);
  } else {
    console.log("No instances found.");
  }
} catch (err) {
  console.error(String(err));
  process.exitCode = 1;
}
