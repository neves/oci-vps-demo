#!/usr/bin/env bun
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

async function listProfileInstances(profile: OciProfile): Promise<InstanceRow[]> {
  const identityBase = `https://identity.${profile.region}.oci.oraclecloud.com/20160918`;
  const iaasBase = `https://iaas.${profile.region}.oraclecloud.com/20160918`;

  // 1. Discover all accessible compartments in the tenancy
  const compartmentsUrl = new URL(`${identityBase}/compartments`);
  compartmentsUrl.searchParams.set("compartmentId", profile.tenancy);
  compartmentsUrl.searchParams.set("compartmentIdInSubtree", "true");
  compartmentsUrl.searchParams.set("accessLevel", "ACCESSIBLE");

  const compartments = await ociListAll<Compartment>(compartmentsUrl, profile);
  const compartmentIds = [
    ...new Set([
      profile.tenancy,
      ...compartments.filter((c) => c.lifecycleState === "ACTIVE").map((c) => c.id),
    ]),
  ];

  // 2. List compute instances across all compartments concurrently
  const instancesByCompartment = await Promise.all(
    compartmentIds.map((compartmentId) => {
      const url = new URL(`${iaasBase}/instances`);
      url.searchParams.set("compartmentId", compartmentId);
      return ociListAll<Instance>(url, profile);
    }),
  );
  const instances = instancesByCompartment
    .flat()
    .filter((inst) => inst.lifecycleState !== "TERMINATED");

  // 3. Resolve VNIC IPv4 addresses for each instance concurrently
  return Promise.all(
    instances.map(async (instance): Promise<InstanceRow> => {
      let privateIp = "N/A";
      let publicIp = "N/A";
      try {
        const attUrl = new URL(`${iaasBase}/vnicAttachments`);
        attUrl.searchParams.set("compartmentId", instance.compartmentId);
        attUrl.searchParams.set("instanceId", instance.id);

        const attachments = await ociListAll<VnicAttachment>(attUrl, profile);
        const activeAttachments = attachments.filter((a) => a.lifecycleState === "ATTACHED");

        const vnics = await Promise.all(
          activeAttachments.map((a) => ociJson<Vnic>(`${iaasBase}/vnics/${a.vnicId}`, profile)),
        );

        privateIp = vnics.map((v) => v.privateIp).filter(Boolean).join(", ") || "None";
        publicIp = vnics.map((v) => v.publicIp).filter(Boolean).join(", ") || "None";
      } catch (err) {
        const msg = `ERROR: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
        privateIp = msg;
        publicIp = msg;
      }

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
    }),
  );
}

try {
  const allProfiles = await loadOciProfiles();
  const requested = process.env.OCI_PROFILES?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const profiles = requested?.length
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
