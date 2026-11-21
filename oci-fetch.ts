import { createHash, createPrivateKey, createSign, type KeyObject } from "node:crypto";
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
  privateKeyObject?: KeyObject;
  passphrase?: string;
}

const keyFileCache = new Map<
  string,
  Promise<{ privateKey: string; privateKeyObject: KeyObject }>
>();
const keyObjectCache = new Map<string, KeyObject>();

function getOrCreateKeyObject(privateKey: string, passphrase?: string): KeyObject {
  const cacheKey = passphrase ? `${privateKey}\0${passphrase}` : privateKey;
  let keyObj = keyObjectCache.get(cacheKey);
  if (!keyObj) {
    keyObj = createPrivateKey(
      passphrase ? { key: privateKey, passphrase } : privateKey,
    );
    keyObjectCache.set(cacheKey, keyObj);
  }
  return keyObj;
}

function loadKeyFile(
  keyFile: string,
  passphrase?: string,
): Promise<{ privateKey: string; privateKeyObject: KeyObject }> {
  const cacheKey = passphrase ? `${keyFile}\0${passphrase}` : keyFile;
  let pending = keyFileCache.get(cacheKey);
  if (!pending) {
    pending = Bun.file(keyFile)
      .text()
      .then((privateKey) => ({
        privateKey,
        privateKeyObject: getOrCreateKeyObject(privateKey, passphrase),
      }));
    keyFileCache.set(cacheKey, pending);
  }
  return pending;
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
 * Uses `Bun.TOML.parse` after quoting unquoted INI values (`key=value` -> `key='value'`).
 */
export async function loadOciProfiles(
  configPath: string = DEFAULT_OCI_CONFIG_PATH,
): Promise<OciProfile[]> {
  const iniText = await Bun.file(expandHome(configPath)).text();
  const tomlText = iniText.replace(
    /^(\s*[\w.-]+\s*=\s*)(?!["'])(.+?)\s*$/gm,
    "$1'$2'",
  );
  const parsed = Bun.TOML.parse(tomlText) as Record<string, Record<string, string>>;

  const entries = Object.entries(parsed).filter(
    ([, r]) => r && r.tenancy && r.user && r.fingerprint && r.region && r.key_file,
  );

  return Promise.all(
    entries.map(async ([name, raw]): Promise<OciProfile> => {
      const { tenancy, user, fingerprint, region, key_file, pass_phrase } = raw;
      const keyFile = expandHome(key_file!);
      const { privateKey, privateKeyObject } = await loadKeyFile(keyFile, pass_phrase);
      return {
        name,
        tenancy: tenancy!,
        user: user!,
        fingerprint: fingerprint!,
        region: region!,
        keyFile,
        privateKey,
        privateKeyObject,
        ...(pass_phrase ? { passphrase: pass_phrase } : {}),
      };
    }),
  );
}

export type OciCredentials = Pick<
  OciProfile,
  "tenancy" | "user" | "fingerprint" | "privateKey" | "privateKeyObject" | "passphrase"
>;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface OciFetchInit extends RequestInit {
  /** Maximum number of retries on transient 429/5xx or network errors (default: 4). */
  maxRetries?: number;
}

/**
 * Signs and executes an HTTP request against the Oracle Cloud Infrastructure REST API,
 * with automatic exponential-backoff retry on transient 429/5xx responses.
 */
export async function ociFetch(
  input: string | URL,
  profile: OciCredentials,
  init: OciFetchInit = {},
): Promise<Response> {
  const { maxRetries = 4, ...fetchInit } = init;
  const url = typeof input === "string" ? new URL(input) : input;
  const method = (fetchInit.method ?? "GET").toUpperCase();
  const body =
    typeof fetchInit.body === "string"
      ? fetchInit.body
      : fetchInit.body instanceof Uint8Array
        ? Buffer.from(fetchInit.body).toString("utf8")
        : "";
  const hasBody = ["POST", "PUT", "PATCH"].includes(method);
  const bodyLength = hasBody ? Buffer.byteLength(body).toString() : undefined;
  const bodySha256 = hasBody ? createHash("sha256").update(body).digest("base64") : undefined;

  const baseHeaders: Record<string, string> = {
    host: url.host,
    accept: "application/json",
  };

  if (fetchInit.headers) {
    const incoming = new Headers(fetchInit.headers);
    incoming.forEach((value, key) => {
      baseHeaders[key.toLowerCase()] = value;
    });
  }

  const signedHeaderNames = ["(request-target)", "date", "host"];
  if (hasBody) {
    baseHeaders["content-type"] ??= "application/json";
    baseHeaders["content-length"] = bodyLength!;
    baseHeaders["x-content-sha256"] = bodySha256!;
    signedHeaderNames.push("x-content-sha256", "content-type", "content-length");
  }

  const targetPath = `${url.pathname}${url.search}`;
  const key =
    profile.privateKeyObject ?? getOrCreateKeyObject(profile.privateKey, profile.passphrase);
  const keyId = `${profile.tenancy}/${profile.user}/${profile.fingerprint}`;
  const signedHeadersAttr = signedHeaderNames.join(" ");

  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = {
      ...baseHeaders,
      date: new Date().toUTCString(),
    };

    const signingString = signedHeaderNames
      .map((name) =>
        name === "(request-target)"
          ? `(request-target): ${method.toLowerCase()} ${targetPath}`
          : `${name}: ${headers[name]}`,
      )
      .join("\n");

    const signer = createSign("RSA-SHA256");
    signer.update(signingString);
    const signature = signer.sign(key, "base64");

    headers["authorization"] =
      `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",` +
      `headers="${signedHeadersAttr}",signature="${signature}"`;

    try {
      const res = await fetch(url, {
        ...fetchInit,
        method,
        headers,
        ...(hasBody ? { body } : {}),
      });

      if (!RETRYABLE_STATUSES.has(res.status) || attempt >= maxRetries) {
        return res;
      }

      // Drain body before retrying so the underlying connection can be reused
      await res.arrayBuffer().catch(() => {});

      const retryAfterSec = Number(res.headers.get("retry-after"));
      const delayMs =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? retryAfterSec * 1000
          : Math.min(8000, 400 * 2 ** attempt) + Math.random() * 300;
      await Bun.sleep(delayMs);
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      const delayMs = Math.min(8000, 400 * 2 ** attempt) + Math.random() * 300;
      await Bun.sleep(delayMs);
    }
  }
}

/**
 * Convenience wrapper around `ociFetch` that parses JSON and throws on non-2xx responses.
 */
export async function ociJson<T>(
  input: string | URL,
  profile: OciCredentials,
  init: OciFetchInit = {},
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
  profile: OciCredentials,
  init: OciFetchInit = {},
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

    const data = (await res.json()) as T[] | { items?: T[] };
    const items = Array.isArray(data) ? data : (data.items ?? []);
    results.push(...items);
    nextPage = res.headers.get("opc-next-page");
  } while (nextPage);

  return results;
}
