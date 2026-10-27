// Oracle Cloud Infrastructure request signing and a minimal client, on the Node standard library alone.
//
// OCI authenticates each request with an HTTP Signature (draft-cavage-http-signatures, rsa-sha256) over a
// fixed list of headers, documented at
// https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm :
//   GET, HEAD, DELETE   (request-target) date host
//   POST, PUT, PATCH    (request-target) date host x-content-sha256 content-type content-length
// keyId is "<tenancy OCID>/<user OCID>/<key fingerprint>".
//
// This file holds no credential. `loadOciCredentials(path)` reads the one the caller names; no function here
// prints a credential value, and an error names the field that is wrong, never its contents.
import { createHash, createPrivateKey, createPublicKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

export class OciCredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = "OciCredentialError";
  }
}

/** A response with status 400 or above. Carries Oracle's own code and message, and the request id Oracle support asks for. */
export class OciError extends Error {
  constructor({ status, code, message, opcRequestId, method, path }) {
    super(`OCI ${method} ${path} -> ${status} ${code}: ${message}`);
    this.name = "OciError";
    this.status = status;
    this.code = code;
    this.ociMessage = message;
    this.opcRequestId = opcRequestId;
  }
}

/** Raised before any network call when a read-only client is asked to change something. */
export class OciReadOnlyError extends Error {
  constructor(method, path) {
    super(`read-only client refused ${method} ${path}`);
    this.name = "OciReadOnlyError";
  }
}

const PEM_BLOCK = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/u;

/** A credential file is either one JSON object, or the OCI config text the console shows with the downloaded PEM key appended. */
function readFields(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let json;
    try { json = JSON.parse(trimmed); } catch { throw new OciCredentialError("credential file starts with { but is not valid JSON"); }
    return {
      tenancy: json.tenancy,
      user: json.user,
      fingerprint: json.fingerprint,
      region: json.region,
      privateKeyPem: json.privateKey ?? json.private_key ?? json.key,
      passphrase: json.passphrase ?? json.pass_phrase,
    };
  }
  const pem = PEM_BLOCK.exec(text)?.[0];
  const fields = {};
  for (const line of text.replace(PEM_BLOCK, "").split(/\r?\n/u)) {
    const match = /^\s*([a-z_]+)\s*=\s*(.*?)\s*$/u.exec(line);
    if (match) fields[match[1]] = match[2];
  }
  return { tenancy: fields.tenancy, user: fields.user, fingerprint: fields.fingerprint, region: fields.region, privateKeyPem: pem, passphrase: fields.pass_phrase };
}

/** The colon-separated MD5 of the public key's DER (SubjectPublicKeyInfo), which is what OCI calls the key fingerprint. */
export function fingerprintOf(privateKey) {
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return createHash("md5").update(der).digest("hex").match(/../gu).join(":");
}

/**
 * Parse and check credential text. Every check names a field, never a value.
 * @returns {{tenancy: string, user: string, fingerprint: string, region: string, privateKey: import("node:crypto").KeyObject, keyId: string}}
 */
export function parseOciCredentials(text) {
  const fields = readFields(text);
  const missing = ["tenancy", "user", "fingerprint", "region", "privateKeyPem"].filter((name) => typeof fields[name] !== "string" || fields[name] === "");
  if (missing.length > 0) {
    throw new OciCredentialError(`credential is missing: ${missing.map((name) => (name === "privateKeyPem" ? "private key (PEM)" : name)).join(", ")}`);
  }
  if (!/^ocid1\.tenancy\./u.test(fields.tenancy)) throw new OciCredentialError("tenancy is not a tenancy OCID (ocid1.tenancy...)");
  if (!/^ocid1\.user\./u.test(fields.user)) throw new OciCredentialError("user is not a user OCID (ocid1.user...)");
  if (!/^[a-z]{2}-[a-z]+(?:-[a-z]+)*-\d+$/u.test(fields.region)) throw new OciCredentialError("region is not a region name such as us-ashburn-1");
  if (!/^(?:[0-9a-f]{2}:){15}[0-9a-f]{2}$/iu.test(fields.fingerprint)) throw new OciCredentialError("fingerprint is not 16 colon-separated hex bytes");

  let privateKey;
  try {
    privateKey = createPrivateKey({ key: fields.privateKeyPem, ...(fields.passphrase ? { passphrase: fields.passphrase } : {}) });
  } catch {
    throw new OciCredentialError("private key could not be read: it is not a PEM RSA key, or it is encrypted and the passphrase is absent or wrong");
  }
  if (privateKey.asymmetricKeyType !== "rsa") throw new OciCredentialError("private key is not an RSA key; OCI API signing keys are RSA");
  if (privateKey.asymmetricKeyDetails.modulusLength < 2048) throw new OciCredentialError("private key is shorter than 2048 bits; OCI refuses it");
  if (fingerprintOf(privateKey).toLowerCase() !== fields.fingerprint.toLowerCase()) {
    throw new OciCredentialError("fingerprint does not match the private key; the key and the fingerprint came from different API keys");
  }
  const { tenancy, user, region } = fields;
  const fingerprint = fields.fingerprint.toLowerCase();
  return Object.freeze({ tenancy, user, fingerprint, region, privateKey, keyId: `${tenancy}/${user}/${fingerprint}` });
}

/** Read credentials from the file the caller names (a path such as /dev/stdin works). */
export function loadOciCredentials(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch (error) { throw new OciCredentialError(`credential file cannot be read: ${error.code ?? "error"}`); }
  return parseOciCredentials(text);
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/**
 * Sign one request.
 * @param {{credentials: ReturnType<typeof parseOciCredentials>, method: string, url: URL, body?: string|Buffer, date: Date}} input
 *   `date` is the single clock reading a signed request needs; the caller supplies it.
 * @returns {{headers: Record<string,string>, signedHeaders: string[], signingString: string}}
 */
export function signRequest({ credentials, method, url, body, date }) {
  const verb = method.toUpperCase();
  const headers = { date: date.toUTCString(), host: url.host };
  const signedHeaders = ["(request-target)", "date", "host"];
  if (BODY_METHODS.has(verb)) {
    const payload = Buffer.from(body ?? "");
    headers["x-content-sha256"] = createHash("sha256").update(payload).digest("base64");
    headers["content-type"] = "application/json";
    headers["content-length"] = String(payload.length);
    signedHeaders.push("x-content-sha256", "content-type", "content-length");
  }
  const signingString = signedHeaders
    .map((name) => (name === "(request-target)" ? `(request-target): ${verb.toLowerCase()} ${url.pathname}${url.search}` : `${name}: ${headers[name]}`))
    .join("\n");
  const signature = createSign("RSA-SHA256").update(signingString).sign(credentials.privateKey, "base64");
  headers.authorization = `Signature version="1",headers="${signedHeaders.join(" ")}",keyId="${credentials.keyId}",algorithm="rsa-sha256",signature="${signature}"`;
  return { headers, signedHeaders, signingString };
}

export const defaultEndpointFor = (service, region) => `https://${service}.${region}.oraclecloud.com`;

const queryOf = (query = {}) => {
  const pairs = Object.entries(query).filter(([, value]) => value !== undefined && value !== null);
  return pairs.length === 0 ? "" : `?${pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`;
};

function send(url, method, headers, payload) {
  const transport = url.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const request = transport.request({ method, hostname: url.hostname, port: url.port || undefined, path: `${url.pathname}${url.search}`, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(payload);
  });
}

const MAX_PAGES = 100;

/**
 * A signing client. It makes exactly the requests it is asked to: no retry, no polling, no timer. With
 * `readOnly`, anything but GET is refused before it touches the network.
 *
 * @param {{credentials: object, readOnly?: boolean, now?: () => Date, endpointFor?: (service: string, region: string) => string}} options
 */
export function createOciClient({ credentials, readOnly = false, now = () => new Date(), endpointFor = defaultEndpointFor }) {
  async function request({ service, region, method, path, query, body, retryToken }) {
    const verb = method.toUpperCase();
    if (readOnly && verb !== "GET") throw new OciReadOnlyError(verb, path);
    const url = new URL(`${endpointFor(service, region)}${path}${queryOf(query)}`);
    const payload = BODY_METHODS.has(verb) ? JSON.stringify(body ?? {}) : undefined;
    const { headers: signed } = signRequest({ credentials, method: verb, url, body: payload, date: now() });
    const headers = { ...signed, accept: "application/json", "user-agent": "561-group-oracle-cloud-engineering/0.1", ...(retryToken ? { "opc-retry-token": retryToken } : {}) };
    const response = await send(url, verb, headers, payload);
    let parsed = null;
    if (response.text !== "") { try { parsed = JSON.parse(response.text); } catch { parsed = response.text; } }
    if (response.status >= 400) {
      throw new OciError({
        status: response.status,
        code: parsed?.code ?? "Unknown",
        message: parsed?.message ?? (typeof parsed === "string" ? parsed.slice(0, 200) : "no message"),
        opcRequestId: response.headers["opc-request-id"],
        method: verb,
        path,
      });
    }
    return { status: response.status, headers: response.headers, body: parsed };
  }

  return Object.freeze({
    region: credentials.region,
    readOnly,
    request,
    async get(service, region, path, query) {
      return (await request({ service, region, method: "GET", path, query })).body;
    },
    /** GET every page of a list, following Oracle's opc-next-page header. */
    async list(service, region, path, query = {}) {
      const items = [];
      let page;
      for (let count = 0; count < MAX_PAGES; count += 1) {
        const response = await request({ service, region, method: "GET", path, query: { ...query, page } });
        items.push(...(response.body ?? []));
        page = response.headers["opc-next-page"];
        if (!page) return items;
      }
      throw new Error(`OCI list ${path} did not end after ${MAX_PAGES} pages`);
    },
    async post(service, region, path, body, { retryToken } = {}) {
      return (await request({ service, region, method: "POST", path, body, retryToken })).body;
    },
    async put(service, region, path, body) {
      return (await request({ service, region, method: "PUT", path, body })).body;
    },
  });
}

/**
 * What a failed request means for an Always Free account. Out-of-capacity and limit errors are reported as
 * they are: they are never retried here, and never answered by a paid shape or an upgrade.
 * @returns {"OUT_OF_CAPACITY"|"LIMIT_EXCEEDED"|"NOT_AUTHENTICATED"|"NOT_AUTHORIZED_OR_NOT_FOUND"|"RATE_LIMITED"|"OTHER"}
 */
export function classifyOciError(error) {
  if (!(error instanceof OciError)) return "OTHER";
  const text = `${error.code} ${error.ociMessage}`;
  if (/out of (?:host )?capacity|OutOfHostCapacity/iu.test(text)) return "OUT_OF_CAPACITY";
  if (/LimitExceeded|QuotaExceeded|limits? (?:was|were) exceeded/iu.test(text)) return "LIMIT_EXCEEDED";
  if (error.status === 401) return "NOT_AUTHENTICATED";
  if (error.status === 404 || error.code === "NotAuthorizedOrNotFound" || error.status === 403) return "NOT_AUTHORIZED_OR_NOT_FOUND";
  if (error.status === 429) return "RATE_LIMITED";
  return "OTHER";
}
