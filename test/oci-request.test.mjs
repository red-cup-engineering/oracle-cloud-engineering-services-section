import assert from "node:assert/strict";
import { createHash, createPrivateKey, createVerify, generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  OciCredentialError, OciError, OciReadOnlyError, classifyOciError, createOciClient, fingerprintOf, loadOciCredentials, parseOciCredentials, signRequest,
} from "../src/oci-request.mjs";
import { TENANCY, USER, fingerprint, keyPair, privatePem, startFakeOci, workDirectory, writeCredentialFile } from "./fake-oci.mjs";

const work = workDirectory();
let fake;
before(async () => { fake = await startFakeOci(); });
after(async () => { await fake.close(); work.cleanup(); });

const credentials = () => loadOciCredentials(writeCredentialFile(work.directory));
const when = new Date("2026-10-27T12:00:00Z");
const verifies = (signingString, header) => createVerify("RSA-SHA256").update(signingString).verify(keyPair.publicKey, /signature="([^"]+)"/u.exec(header)[1], "base64");

test("a GET signs (request-target) date host, and the signature verifies", () => {
  const url = new URL("https://iaas.us-chicago-1.oraclecloud.com/20160918/instances?compartmentId=ocid1.tenancy.oc1..x");
  const { headers, signedHeaders, signingString } = signRequest({ credentials: credentials(), method: "GET", url, date: when });
  assert.deepEqual(signedHeaders, ["(request-target)", "date", "host"]);
  assert.equal(signingString, [
    "(request-target): get /20160918/instances?compartmentId=ocid1.tenancy.oc1..x",
    "date: Tue, 27 Oct 2026 12:00:00 GMT",
    "host: iaas.us-chicago-1.oraclecloud.com",
  ].join("\n"));
  assert.match(headers.authorization, new RegExp(`^Signature version="1",headers="\\(request-target\\) date host",keyId="${TENANCY}/${USER}/${fingerprint}",algorithm="rsa-sha256",signature="[A-Za-z0-9+/=]+"$`, "u"));
  assert.equal(verifies(signingString, headers.authorization), true);
  assert.equal(headers["x-content-sha256"], undefined);
});

test("a POST also signs x-content-sha256, content-type and content-length", () => {
  const body = JSON.stringify({ displayName: "café", n: 1 });
  const { headers, signedHeaders, signingString } = signRequest({ credentials: credentials(), method: "post", url: new URL("https://iaas.us-chicago-1.oraclecloud.com/20160918/vcns"), body, date: when });
  assert.deepEqual(signedHeaders, ["(request-target)", "date", "host", "x-content-sha256", "content-type", "content-length"]);
  assert.equal(headers["x-content-sha256"], createHash("sha256").update(body).digest("base64"));
  assert.equal(headers["content-length"], String(Buffer.byteLength(body)));
  assert.equal(headers["content-type"], "application/json");
  assert.ok(signingString.startsWith("(request-target): post /20160918/vcns\n"));
  assert.equal(verifies(signingString, headers.authorization), true);
});

test("the client's requests verify at the server, GET and PUT/POST alike, and carry the query as signed", async () => {
  const client = createOciClient({ credentials: credentials(), endpointFor: fake.endpointFor, now: () => when });
  const before = fake.log.length;
  await client.get("identity", "us-ashburn-1", "/20160918/availabilityDomains", { compartmentId: TENANCY });
  await client.post("iaas", "us-ashburn-1", "/20160918/vcns", { compartmentId: TENANCY, displayName: "ünïcode & spaces" });
  const [read, write] = fake.log.slice(before);
  assert.deepEqual(read.problems, []);
  assert.deepEqual(write.problems, []);
  assert.deepEqual(read.signedHeaders, ["(request-target)", "date", "host"]);
  assert.equal(write.signedHeaders.length, 6);
  assert.equal(read.headers.date, "Tue, 27 Oct 2026 12:00:00 GMT");
  assert.match(read.headers.host, /^127\.0\.0\.1:\d+$/u);
});

test("a list follows opc-next-page until Oracle stops sending it", async () => {
  const client = createOciClient({ credentials: credentials(), endpointFor: fake.endpointFor });
  const images = await client.list("iaas", "us-ashburn-1", "/20160918/images", { compartmentId: TENANCY, operatingSystem: "Oracle Linux", shape: "VM.Standard.E2.1.Micro" });
  assert.equal(images.length, fake.state.images.length);
});

test("a read-only client refuses to change anything before it touches the network", async () => {
  const client = createOciClient({ credentials: credentials(), readOnly: true, endpointFor: fake.endpointFor });
  const before = fake.log.length;
  await assert.rejects(client.post("iaas", "us-ashburn-1", "/20160918/instances", {}), OciReadOnlyError);
  await assert.rejects(client.put("iaas", "us-ashburn-1", "/20160918/routeTables/x", {}), OciReadOnlyError);
  assert.equal(fake.log.length, before);
});

test("an error response becomes an OciError carrying Oracle's code, message and request id", async () => {
  const client = createOciClient({ credentials: credentials(), endpointFor: fake.endpointFor });
  const error = await client.get("iaas", "us-ashburn-1", "/20160918/instances").catch((caught) => caught);
  assert.ok(error instanceof OciError);
  assert.equal(error.status, 400);
  assert.equal(error.code, "MissingParameter");
  assert.match(error.opcRequestId, /^req-/u);
});

test("a request signed with some other key is refused by the server", async () => {
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  const otherCredentials = parseOciCredentials(JSON.stringify({ tenancy: TENANCY, user: USER, region: "us-ashburn-1", privateKey: other, fingerprint: fingerprintOf(createPrivateKey(other)) }));
  const client = createOciClient({ credentials: otherCredentials, endpointFor: fake.endpointFor });
  const error = await client.get("identity", "us-ashburn-1", "/20160918/availabilityDomains", { compartmentId: TENANCY }).catch((caught) => caught);
  assert.equal(error.status, 401);
});

test("credentials load from JSON, or from the console's config text with the PEM appended", () => {
  const fromJson = loadOciCredentials(writeCredentialFile(work.directory));
  assert.equal(fromJson.keyId, `${TENANCY}/${USER}/${fingerprint}`);
  const text = `[DEFAULT]\nuser=${USER}\nfingerprint=${fingerprint.toUpperCase()}\ntenancy=${TENANCY}\nregion=us-chicago-1\nkey_file=/somewhere/else.pem\n${privatePem}`;
  const path = join(work.directory, "oci-config-and-key.txt");
  writeFileSync(path, text, { mode: 0o600 });
  const fromText = loadOciCredentials(path);
  assert.equal(fromText.region, "us-chicago-1");
  assert.equal(fromText.fingerprint, fingerprint);
});

test("a bad credential is refused by field name, and no error ever contains the key or the identifiers", () => {
  const good = { tenancy: TENANCY, user: USER, fingerprint, region: "us-chicago-1", privateKey: privatePem };
  const refused = (overrides) => { try { parseOciCredentials(JSON.stringify({ ...good, ...overrides })); } catch (error) { assert.ok(error instanceof OciCredentialError); return error.message; } return assert.fail("accepted"); };
  assert.match(refused({ tenancy: undefined }), /missing: tenancy/u);
  assert.match(refused({ privateKey: undefined, fingerprint: undefined }), /missing: fingerprint, private key/u);
  assert.match(refused({ tenancy: USER }), /tenancy is not a tenancy OCID/u);
  assert.match(refused({ user: TENANCY }), /user is not a user OCID/u);
  assert.match(refused({ region: "Chicago" }), /region/u);
  assert.match(refused({ fingerprint: "aa:bb" }), /fingerprint is not 16/u);
  assert.match(refused({ fingerprint: "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff" }), /does not match the private key/u);
  assert.match(refused({ privateKey: "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----" }), /private key could not be read/u);
  const messages = [refused({ tenancy: undefined }), refused({ fingerprint: "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff" }), refused({ privateKey: "garbage" })].join("\n");
  assert.ok(!messages.includes("PRIVATE KEY"));
  assert.ok(!messages.includes(TENANCY));
  assert.ok(!messages.includes(USER));
  assert.throws(() => loadOciCredentials(join(work.directory, "absent")), /cannot be read: ENOENT/u);
});

test("failures are classified so capacity and limit errors are never mistaken for retryable ones", () => {
  const error = (status, code, message) => new OciError({ status, code, message, method: "POST", path: "/x" });
  assert.equal(classifyOciError(error(500, "InternalError", "Out of host capacity.")), "OUT_OF_CAPACITY");
  assert.equal(classifyOciError(error(500, "OutOfHostCapacity", "x")), "OUT_OF_CAPACITY");
  assert.equal(classifyOciError(error(400, "LimitExceeded", "The following service limits were exceeded: standard-a1-core-count")), "LIMIT_EXCEEDED");
  assert.equal(classifyOciError(error(400, "QuotaExceeded", "x")), "LIMIT_EXCEEDED");
  assert.equal(classifyOciError(error(401, "NotAuthenticated", "x")), "NOT_AUTHENTICATED");
  assert.equal(classifyOciError(error(404, "NotAuthorizedOrNotFound", "x")), "NOT_AUTHORIZED_OR_NOT_FOUND");
  assert.equal(classifyOciError(error(429, "TooManyRequests", "x")), "RATE_LIMITED");
  assert.equal(classifyOciError(error(500, "InternalError", "boom")), "OTHER");
  assert.equal(classifyOciError(new Error("x")), "OTHER");
});
