// A fake OCI over a local, in-process http server. It checks what real OCI checks first: the signature.
// Every request is verified with the public half of the test key, rebuilding the signing string from the
// headers the request actually carried, and is logged for the tests to read.
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintOf } from "../src/oci-request.mjs";

export const TENANCY = "ocid1.tenancy.oc1..aaaatesttenancy";
export const USER = "ocid1.user.oc1..aaaatestuser";
export const HOME = "us-ashburn-1";
export const ADS = ["Uocm:US-ASHBURN-AD-1", "Uocm:US-ASHBURN-AD-2", "Uocm:US-ASHBURN-AD-3"];

const here = dirname(fileURLToPath(import.meta.url));
export const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const privatePem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" });
export const fingerprint = fingerprintOf(keyPair.privateKey);

/** A scratch directory inside this package, removed by `cleanup()`. */
export function workDirectory() {
  mkdirSync(join(here, ".work"), { recursive: true });
  const directory = mkdtempSync(join(here, ".work", "run-"));
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

export function writeCredentialFile(directory, { region = HOME } = {}) {
  const path = join(directory, "oci-credential.json");
  writeFileSync(path, JSON.stringify({ tenancy: TENANCY, user: USER, fingerprint, region, privateKey: privatePem }), { mode: 0o600 });
  return path;
}

export const STORE_TOKEN = "test-store-token-8f3a";
export function writeProvisionFile(directory) {
  const path = join(directory, "provision.env");
  writeFileSync(path, `NODE_JOB_NODE_ID=oracle-free-1\nNODE_JOB_STORE_URL=https://git.example/fleet.git\nNODE_JOB_STORE_USER=svc-user-7c1\nNODE_JOB_STORE_TOKEN=${STORE_TOKEN}\nUNRELATED_SECRET=must-not-travel\n`, { mode: 0o600 });
  return path;
}

function verifySignature(request, body) {
  const header = request.headers.authorization ?? "";
  const field = (name) => new RegExp(`${name}="([^"]*)"`, "u").exec(header)?.[1];
  const listed = (field("headers") ?? "").split(" ");
  const problems = [];
  if (!header.startsWith('Signature version="1"')) problems.push("not a version 1 Signature");
  if (field("algorithm") !== "rsa-sha256") problems.push("algorithm is not rsa-sha256");
  if (field("keyId") !== `${TENANCY}/${USER}/${fingerprint}`) problems.push("keyId is not tenancy/user/fingerprint");
  const bodyMethod = ["POST", "PUT", "PATCH"].includes(request.method);
  const expected = bodyMethod ? "(request-target) date host x-content-sha256 content-type content-length" : "(request-target) date host";
  if (listed.join(" ") !== expected) problems.push(`signed headers are "${listed.join(" ")}", OCI documents "${expected}"`);
  if (bodyMethod) {
    if (request.headers["x-content-sha256"] !== createHash("sha256").update(body).digest("base64")) problems.push("x-content-sha256 is not the body's SHA-256");
    if (request.headers["content-length"] !== String(body.length)) problems.push("content-length is not the body's length");
  }
  const signingString = listed.map((name) => (name === "(request-target)" ? `(request-target): ${request.method.toLowerCase()} ${request.url}` : `${name}: ${request.headers[name]}`)).join("\n");
  const valid = createVerify("RSA-SHA256").update(signingString).verify(keyPair.publicKey, field("signature") ?? "", "base64");
  if (!valid) problems.push("signature does not verify");
  return { problems, signedHeaders: listed };
}

const ocid = (kind, n) => `ocid1.${kind}.oc1.${HOME}.fake${n}`;

/**
 * @param {{launchError?: {status: number, code: string, message: string}}} [scenario]
 */
export async function startFakeOci(scenario = {}) {
  const state = {
    quotas: [], budgets: [], alertRules: [], rejectQuotaFamilies: scenario.rejectQuotaFamilies ?? [],
    services: ["compute", "block-storage", "vcn", "database", "load-balancer", "object-storage", "filesystem"],
    // E2.1.Micro is offered in one availability domain only, as Oracle's page says.
    shapesByAd: { [ADS[0]]: ["VM.Standard.A1.Flex"], [ADS[1]]: ["VM.Standard.A1.Flex", "VM.Standard.E2.1.Micro"], [ADS[2]]: ["VM.Standard.A1.Flex"] },
    compartments: [], instances: [], bootVolumes: [], volumes: [], vcns: [], gateways: [], securityLists: [], subnets: [], routeTables: [], launchError: scenario.launchError,
    images: [
      { id: "ocid1.image.oc1..old", displayName: "Oracle-Linux-9.4-aarch64-2026.01.01-0", timeCreated: "2026-01-01T00:00:00Z" },
      { id: "ocid1.image.oc1..gpu", displayName: "Oracle-Linux-9.5-aarch64-GPU-2026.09.01-0", timeCreated: "2026-09-01T00:00:00Z" },
      { id: "ocid1.image.oc1..newest", displayName: "Oracle-Linux-9.5-aarch64-2026.08.15-0", timeCreated: "2026-08-15T00:00:00Z" },
      { id: "ocid1.image.oc1..x86-old", displayName: "Oracle-Linux-9.4-2026.01.01-0", timeCreated: "2026-01-01T00:00:00Z" },
      { id: "ocid1.image.oc1..x86-newest", displayName: "Oracle-Linux-9.5-2026.08.15-0", timeCreated: "2026-08-15T00:00:00Z" },
    ],
  };
  const log = [];
  let counter = 0;
  const next = () => (counter += 1);

  const send = (response, status, body, headers = {}) => {
    response.writeHead(status, { "content-type": "application/json", "opc-request-id": `req-${log.length}`, ...headers });
    response.end(body === undefined ? "" : JSON.stringify(body));
  };
  const needs = (query, ...names) => names.filter((name) => !query.get(name));

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url, "http://fake");
      const { problems, signedHeaders } = verifySignature(request, body);
      const entry = { method: request.method, path: url.pathname, query: url.searchParams, body: body.length ? JSON.parse(body) : undefined, signedHeaders, problems, headers: request.headers };
      log.push(entry);
      if (problems.length > 0) return send(response, 401, { code: "NotAuthenticated", message: problems.join("; ") });
      const route = `${request.method} ${url.pathname.replace(/\/budgets\/ocid1\.[^/]+\//u, "/budgets/:id/").replace(/\/ocid1\.[^/]+$/u, "/:id").replace(/\/tenancies\/[^/]+/u, "/tenancies/:t")}`;
      const q = url.searchParams;
      const missing = (...names) => { const absent = needs(q, ...names); if (absent.length) { send(response, 400, { code: "MissingParameter", message: `missing ${absent.join(", ")}` }); return true; } return false; };
      const inCompartment = (items) => items.filter((item) => item.compartmentId === q.get("compartmentId") && (!q.get("vcnId") || item.vcnId === q.get("vcnId")));
      const make = (kind, list, extra = {}) => {
        const created = { id: ocid(kind, next()), lifecycleState: "AVAILABLE", ...entry.body, ...extra };
        list.push(created);
        return created;
      };

      switch (route) {
        case "GET /20160918/tenancies/:t/regionSubscriptions":
          return send(response, 200, [{ regionKey: "FRA", regionName: "eu-frankfurt-1", isHomeRegion: false, status: "READY" }, { regionKey: "IAD", regionName: HOME, isHomeRegion: true, status: "READY" }]);
        case "GET /20160918/availabilityDomains": return missing("compartmentId") || send(response, 200, ADS.map((name) => ({ name })));
        case "GET /20160918/compartments": return missing("compartmentId") || send(response, 200, state.compartments);
        case "GET /20160918/instances": return missing("compartmentId") || send(response, 200, inCompartment(state.instances));
        case "GET /20160918/volumes": return missing("compartmentId") || send(response, 200, inCompartment(state.volumes));
        case "GET /20160918/bootVolumes": return missing("compartmentId", "availabilityDomain") || send(response, 200, inCompartment(state.bootVolumes).filter((v) => v.availabilityDomain === q.get("availabilityDomain")));
        case "GET /20160918/images": {
          if (missing("compartmentId", "operatingSystem", "shape")) return undefined;
          // Pages of two, to prove the client follows opc-next-page.
          const from = (Number(q.get("page") ?? 1) - 1) * 2;
          const more = from + 2 < state.images.length;
          return send(response, 200, state.images.slice(from, from + 2), more ? { "opc-next-page": String(Number(q.get("page") ?? 1) + 1) } : {});
        }
        case "GET /20160918/vcns": return missing("compartmentId") || send(response, 200, inCompartment(state.vcns));
        case "GET /20160918/internetGateways": return missing("compartmentId", "vcnId") || send(response, 200, inCompartment(state.gateways));
        case "GET /20160918/securityLists": return missing("compartmentId", "vcnId") || send(response, 200, inCompartment(state.securityLists));
        case "GET /20160918/subnets": return missing("compartmentId", "vcnId") || send(response, 200, inCompartment(state.subnets));
        case "GET /20160918/routeTables/:id": return send(response, 200, state.routeTables.find((table) => url.pathname.endsWith(table.id)));
        case "GET /20160918/vnicAttachments": return missing("compartmentId", "instanceId") || send(response, 200, [{ vnicId: "ocid1.vnic.oc1..fakevnic", lifecycleState: "ATTACHED" }]);
        case "GET /20160918/vnics/:id": return send(response, 200, { publicIp: "203.0.113.10", privateIp: "10.61.1.5" });
        case "GET /20160918/shapes": return missing("compartmentId", "availabilityDomain") || send(response, 200, (state.shapesByAd[q.get("availabilityDomain")] ?? []).map((shape) => ({ shape })));
        case "GET /20190729/services": return missing("compartmentId") || send(response, 200, state.services.map((name) => ({ name })));
        case "GET /20181025/quotas": return missing("compartmentId") || send(response, 200, state.quotas.map(({ id, name, lifecycleState }) => ({ id, name, lifecycleState })));
        case "GET /20181025/quotas/:id": return send(response, 200, state.quotas.find((quota) => url.pathname.endsWith(quota.id)));
        case "POST /20181025/quotas": {
          const bad = state.rejectQuotaFamilies.find((family) => entry.body.statements.some((statement) => statement.includes(` ${family} `)));
          if (bad) return send(response, 400, { code: "InvalidParameter", message: `unknown service family ${bad}` });
          return send(response, 200, make("quota", state.quotas));
        }
        case "PUT /20181025/quotas/:id": {
          const quota = state.quotas.find((candidate) => url.pathname.endsWith(candidate.id));
          Object.assign(quota, entry.body);
          return send(response, 200, quota);
        }
        case "GET /20190111/budgets": return missing("compartmentId") || send(response, 200, state.budgets);
        case "POST /20190111/budgets": return send(response, 200, make("budget", state.budgets));
        case "GET /20190111/budgets/:id/alertRules": return send(response, 200, state.alertRules.filter((rule) => url.pathname.includes(rule.budgetId)));
        case "POST /20190111/budgets/:id/alertRules": {
          const budgetId = url.pathname.split("/")[3];
          const rule = { id: ocid("alertrule", next()), budgetId, ...entry.body };
          state.alertRules.push(rule);
          return send(response, 200, rule);
        }
        case "POST /20160918/vcns": {
          const routeTable = { id: ocid("routetable", next()), routeRules: [] };
          state.routeTables.push(routeTable);
          return send(response, 200, make("vcn", state.vcns, { defaultRouteTableId: routeTable.id, defaultSecurityListId: ocid("securitylist", next()) }));
        }
        case "POST /20160918/internetGateways": return send(response, 200, make("internetgateway", state.gateways));
        case "PUT /20160918/routeTables/:id": {
          const table = state.routeTables.find((candidate) => url.pathname.endsWith(candidate.id));
          table.routeRules = entry.body.routeRules;
          return send(response, 200, table);
        }
        case "POST /20160918/securityLists": return send(response, 200, make("securitylist", state.securityLists));
        case "POST /20160918/subnets": return send(response, 200, make("subnet", state.subnets));
        case "POST /20160918/instances": {
          entry.retryToken = request.headers["opc-retry-token"];
          if (state.launchError) return send(response, state.launchError.status, { code: state.launchError.code, message: state.launchError.message });
          return send(response, 200, make("instance", state.instances, { lifecycleState: "PROVISIONING" }));
        }
        default: return send(response, 404, { code: "NotAuthorizedOrNotFound", message: `fake has no ${route}` });
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const regionsAsked = [];
  return {
    state, log, port, regionsAsked,
    endpointFor: (service, region) => { regionsAsked.push({ service, region }); return `http://127.0.0.1:${port}`; },
    mutations: () => log.filter((entry) => entry.method !== "GET"),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
