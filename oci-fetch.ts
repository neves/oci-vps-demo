import { createHash, createSign } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface OciProfile {
  name: string;
  tenancy: string;
  user: string;
  fingerprint: string;
  region: string;
  keyFile: string;
  privateKey: string;
  passphrase?: string;
}

export const DEFAULT_OCI_CONFIG_PATH =
  process.env.OCI_CLI_CONFIG_FILE ?? `${homedir()}/.oci/config`;

function expandHome(filepath: string): string {
  if (filepath.startsWith("~/") || filepath === "~") {
    return resolve(homedir(), filepath.slice(2));
  }
  return resolve(filepath);
}

/**
 * Parses an OCI config file (default `~/.oci/config`) and loads each profile's private key.
 */
export async function loadOciProfiles(
  configPath: string = DEFAULT_OCI_CONFIG_PATH,
): Promise<OciProfile[]> {
  const text = await Bun.file(expandHome(configPath)).text();
  const rawProfiles: Array<Record<string, string> & { name: string }> = [];
  let current: (Record<string, string> & { name: string }) | undefined;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;

    const section = trimmed.match(/^\[([^\]]+)\]$/);
    if (section?.[1]) {
      if (current) rawProfiles.push(current);
      current = { name: section[1].trim() };
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex > 0 && current) {
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      current[key] = value;
    }
  }
  if (current) rawProfiles.push(current);

  const profiles: OciProfile[] = [];
  for (const raw of rawProfiles) {
    const { name, tenancy, user, fingerprint, region, key_file, pass_phrase } = raw;
    if (!tenancy || !user || !fingerprint || !region || !key_file) continue;

    const keyFile = expandHome(key_file);
    const privateKey = await Bun.file(keyFile).text();
    profiles.push({
      name,
      tenancy,
      user,
      fingerprint,
      region,
      keyFile,
      privateKey,
      ...(pass_phrase ? { passphrase: pass_phrase } : {}),
    });
  }

  return profiles;
}

/**
 * Signs and executes an HTTP request against the Oracle Cloud Infrastructure REST API.
 */
export async function ociFetch(
  input: string | URL,
  profile: Pick<OciProfile, "tenancy" | "user" | "fingerprint" | "privateKey" | "passphrase">,
  init: RequestInit = {},
): Promise<Response> {
  const url = typeof input === "string" ? new URL(input) : input;
  const method = (init.method ?? "GET").toUpperCase();
  const body =
    typeof init.body === "string"
      ? init.body
      : init.body instanceof Uint8Array
        ? Buffer.from(init.body).toString("utf8")
        : "";
  const hasBody = ["POST", "PUT", "PATCH"].includes(method);

  const headers: Record<string, string> = {
    date: new Date().toUTCString(),
    host: url.host,
    accept: "application/json",
  };

  if (init.headers) {
    const incoming = new Headers(init.headers);
    incoming.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
  }

  const signedHeaderNames = ["(request-target)", "date", "host"];

  if (hasBody) {
    headers["content-type"] ??= "application/json";
    headers["content-length"] = Buffer.byteLength(body).toString();
    headers["x-content-sha256"] = createHash("sha256").update(body).digest("base64");
    signedHeaderNames.push("x-content-sha256", "content-type", "content-length");
  }

  const targetPath = `${url.pathname}${url.search}`;
  const signingString = signedHeaderNames
    .map((name) =>
      name === "(request-target)"
        ? `(request-target): ${method.toLowerCase()} ${targetPath}`
        : `${name}: ${headers[name]}`,
    )
    .join("\n");

  const signer = createSign("RSA-SHA256");
  signer.update(signingString);
  const signature = signer.sign(
    profile.passphrase
      ? { key: profile.privateKey, passphrase: profile.passphrase }
      : profile.privateKey,
    "base64",
  );

  const keyId = `${profile.tenancy}/${profile.user}/${profile.fingerprint}`;
  headers["authorization"] =
    `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",` +
    `headers="${signedHeaderNames.join(" ")}",signature="${signature}"`;

  return fetch(url, {
    ...init,
    method,
    headers,
    ...(hasBody ? { body } : {}),
  });
}

/**
 * Convenience wrapper around `ociFetch` that parses JSON and throws on non-2xx responses.
 */
export async function ociJson<T>(
  input: string | URL,
  profile: Pick<OciProfile, "tenancy" | "user" | "fingerprint" | "privateKey" | "passphrase">,
  init: RequestInit = {},
): Promise<T> {
  const res = await ociFetch(input, profile, init);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OCI API ${res.status} ${res.statusText} (${input}): ${errText}`);
  }
  return (await res.json()) as T;
}

/**
 * Fetches all pages of a paginated OCI list endpoint by following the `opc-next-page` header.
 */
export async function ociListAll<T>(
  input: string | URL,
  profile: Pick<OciProfile, "tenancy" | "user" | "fingerprint" | "privateKey" | "passphrase">,
  init: RequestInit = {},
): Promise<T[]> {
  const baseUrl = typeof input === "string" ? new URL(input) : new URL(input.toString());
  const results: T[] = [];
  let nextPage: string | null = null;

  do {
    const pageUrl = new URL(baseUrl.toString());
    if (nextPage) pageUrl.searchParams.set("page", nextPage);

    const res = await ociFetch(pageUrl, profile, init);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OCI API ${res.status} ${res.statusText} (${pageUrl}): ${errText}`);
    }

    const items = (await res.json()) as T[];
    results.push(...items);
    nextPage = res.headers.get("opc-next-page");
  } while (nextPage);

  return results;
}
