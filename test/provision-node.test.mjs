import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { main } from "../scripts/provision-always-free-node.mjs";
import { fingerprintOf } from "../src/oci-request.mjs";
import { ADS, HOME, STORE_TOKEN, TENANCY, USER, startFakeOci, workDirectory, writeCredentialFile, writeProvisionFile } from "./fake-oci.mjs";

const MICRO = "VM.Standard.E2.1.Micro";
const A1 = "VM.Standard.A1.Flex";
const work = workDirectory();
after(() => work.cleanup());

let fake;
let credentials;
let provision;
beforeEach(() => {
  credentials = writeCredentialFile(work.directory);
  provision = writeProvisionFile(work.directory);
});
afterEach(async () => { await fake?.close(); fake = undefined; });

const capture = () => { let text = ""; return { write: (chunk) => { text += chunk; }, get text() { return text; } }; };

/** Run the command against the fake exactly as the executable would, over a local server. */
async function run(extra, { server = fake, provisionFile = provision, credentialFile = credentials } = {}) {
  const stdout = capture(), stderr = capture();
  const code = await main(["--credentials", credentialFile, "--provision", provisionFile, ...extra], { stdout, stderr, endpointFor: server?.endpointFor ?? (() => { throw new Error("a call was made to Oracle"); }), now: () => new Date("2026-10-27T12:00:00Z") });
  return { code, text: stdout.text, out: stdout.text ? JSON.parse(stdout.text) : undefined, err: stderr.text };
}
const launches = (server) => server.mutations().filter((entry) => entry.path === "/20160918/instances");
const writeProvision = (id) => {
  const path = join(work.directory, `provision-${id}.env`);
  writeFileSync(path, `NODE_JOB_NODE_ID=${id}\nNODE_JOB_STORE_URL=https://git.example/fleet.git\nNODE_JOB_STORE_USER=svc-user-7c1\nNODE_JOB_STORE_TOKEN=${STORE_TOKEN}\n`, { mode: 0o600 });
  return path;
};

test("--dry-run prints the exact plan, reads only, and makes no mutating call", async () => {
  fake = await startFakeOci();
  const { code, out, text } = await run(["--dry-run"]);
  assert.equal(code, 0);
  assert.equal(out.status, "dry-run");
  assert.deepEqual(fake.mutations(), []);
  assert.ok(fake.log.length > 8 && fake.log.every((entry) => entry.method === "GET" && entry.problems.length === 0));
  assert.deepEqual(out.plan.steps.map((step) => [step.name, step.action]), [
    ["vcn", "create"], ["internet-gateway", "create"], ["route-rule", "update"], ["security-list", "create"], ["subnet", "create"], ["launch-instance", "create"],
  ]);
  const launch = out.plan.steps.at(-1);
  assert.equal(launch.body.shape, MICRO);
  assert.equal(launch.body.shapeConfig, undefined);
  assert.equal(launch.body.availabilityDomain, "{{availabilityDomain}}");
  assert.equal(out.plan.node.availabilityDomain, ADS[1], "the micro shape is offered in only one availability domain, and the plan names it");
  assert.equal(out.plan.node.image.id, "ocid1.image.oc1..x86-newest", "newest x86 image, found on the third page, not the GPU or aarch64 ones");
  assert.deepEqual(out.plan.node.fleet, { failureDomain: "oracle-free-tier", power: "mains", network: "always-on", capacity: "1 GB and 1/8 OCPU (burstable), read from the machine by node-job-service" });
  assert.deepEqual(out.plan.envelope.usageAfter, { a1Instances: 0, a1Ocpus: 0, a1MemoryGb: 0, microInstances: 1, storageGb: 50 });
  assert.equal(out.plan.cloudInit.write_files[1].values.NODE_JOB_STORE_TOKEN, "<withheld>");
  assert.equal(out.plan.cloudInit.write_files[1].values.NODE_JOB_NODE_ID, "oracle-free-1");
  for (const secret of [STORE_TOKEN, "must-not-travel", "PRIVATE KEY", "svc-user-7c1"]) assert.ok(!text.includes(secret), `${secret} must not be printed`);
});

test("a real run creates the network and one micro node whose cloud-init joins the fleet", async () => {
  fake = await startFakeOci();
  const { code, out } = await run([]);
  assert.equal(code, 0);
  assert.equal(out.status, "launched");
  assert.deepEqual(fake.mutations().map((entry) => `${entry.method} ${entry.path}`), [
    "POST /20160918/vcns", "POST /20160918/internetGateways", `PUT /20160918/routeTables/${fake.state.routeTables[0].id}`,
    "POST /20160918/securityLists", "POST /20160918/subnets", "POST /20160918/instances",
  ]);
  assert.ok(fake.log.every((entry) => entry.problems.length === 0), "every request carried a valid signature");

  const [vcn] = fake.state.vcns, [gateway] = fake.state.gateways, [securityList] = fake.state.securityLists, [subnet] = fake.state.subnets;
  assert.deepEqual(fake.state.routeTables[0].routeRules.map((rule) => [rule.destination, rule.networkEntityId]), [["0.0.0.0/0", gateway.id]]);
  assert.deepEqual(securityList.ingressSecurityRules, []);
  assert.equal(securityList.egressSecurityRules[0].protocol, "all");
  assert.equal(subnet.routeTableId, vcn.defaultRouteTableId);
  assert.deepEqual(subnet.securityListIds, [securityList.id]);
  assert.equal(subnet.prohibitPublicIpOnVnic, false);

  const [launch] = launches(fake);
  const body = launch.body;
  assert.equal(body.shape, MICRO);
  assert.equal(body.shapeConfig, undefined);
  assert.equal(body.availabilityDomain, ADS[1]);
  assert.equal(body.displayName, "oracle-free-1");
  assert.deepEqual(body.sourceDetails, { sourceType: "image", imageId: "ocid1.image.oc1..x86-newest", bootVolumeSizeInGBs: 50, bootVolumeVpusPerGB: 10 });
  assert.deepEqual(body.createVnicDetails, { subnetId: subnet.id, assignPublicIp: true, displayName: "oracle-free-1-vnic" });
  assert.deepEqual(body.freeformTags, { group: "561-group", role: "always-free-fleet-node", node: "oracle-free-1" });
  assert.match(launch.retryToken, /^[0-9a-f]{48}$/u);

  const config = JSON.parse(Buffer.from(body.metadata.user_data, "base64").toString("utf8").replace(/^#cloud-config\n/u, ""));
  const [installer, provisionFile] = config.write_files.map((file) => Buffer.from(file.content, "base64").toString("utf8"));
  assert.equal(installer, readFileSync(new URL("../scripts/install-linux-node.sh", import.meta.url), "utf8"));
  assert.equal(provisionFile, `NODE_JOB_NODE_ID=oracle-free-1\nNODE_JOB_STORE_URL=https://git.example/fleet.git\nNODE_JOB_STORE_USER=svc-user-7c1\nNODE_JOB_STORE_TOKEN=${STORE_TOKEN}\n`);
  assert.deepEqual(config.runcmd, [["/usr/local/sbin/install-linux-node.sh", "--failure-domain", "oracle-free-tier", "--power", "mains", "--network", "always-on"]]);
  assert.deepEqual(config.write_files.map((file) => [file.path, file.permissions]), [["/usr/local/sbin/install-linux-node.sh", "0755"], ["/etc/node-fleet/provision.env", "0600"]]);
});

test("running it again finds the tagged node and changes nothing", async () => {
  fake = await startFakeOci();
  await run([]);
  const mutations = fake.mutations().length;
  const { code, out } = await run([]);
  assert.equal(code, 0);
  assert.equal(out.status, "reused");
  assert.equal(out.instance.displayName, "oracle-free-1");
  assert.equal(out.publicIp, "203.0.113.10");
  assert.equal(fake.mutations().length, mutations);
  assert.equal(fake.state.instances.length, 1);
  const dry = await run(["--dry-run"]);
  assert.equal(dry.out.status, "reused");
});

test("runs racing for the same node carry one retry token, which Oracle replays instead of launching twice", async () => {
  fake = await startFakeOci();
  await Promise.all([run([]), run([])]);
  assert.ok(launches(fake).length >= 1);
  const tokens = new Set(launches(fake).map((entry) => entry.retryToken));
  assert.equal(tokens.size, 1, "concurrent runs carry the same retry token, which Oracle replays instead of launching twice");
});

test("a second node gets its own micro VM on the same network; a third is refused by the envelope", async () => {
  fake = await startFakeOci();
  await run([]);
  const afterFirst = fake.mutations().length;
  const second = await run([], { provisionFile: writeProvision("oracle-free-2") });
  assert.equal(second.out.status, "launched");
  assert.deepEqual(fake.mutations().slice(afterFirst).map((entry) => `${entry.method} ${entry.path}`), ["POST /20160918/instances"], "the network was reused");
  assert.equal(fake.state.vcns.length, 1);
  const afterSecond = fake.mutations().length;
  const third = await run([], { provisionFile: writeProvision("oracle-free-3") });
  assert.equal(third.code, 3);
  assert.deepEqual(third.out.refusals.map((refusal) => refusal.code), ["MICRO_INSTANCES_EXCEEDED"]);
  assert.equal(fake.mutations().length, afterSecond);
});

test("with the node gone, a run reuses the network it made and only launches", async () => {
  fake = await startFakeOci();
  await run([]);
  fake.state.instances.length = 0;
  const before = fake.mutations().length;
  const { out } = await run([]);
  assert.equal(out.status, "launched");
  assert.deepEqual(fake.mutations().slice(before).map((entry) => entry.path), ["/20160918/instances"]);
  assert.equal(fake.state.vcns.length, 1);
});

test("Ampere A1 is launched only when asked, at the 2 OCPU / 12 GB the page allows", async () => {
  fake = await startFakeOci();
  const { code, out } = await run(["--shape", A1]);
  assert.equal(code, 0);
  assert.equal(out.status, "launched");
  const body = launches(fake)[0].body;
  assert.equal(body.shape, A1);
  assert.deepEqual(body.shapeConfig, { ocpus: 2, memoryInGBs: 12 });
  assert.equal(body.sourceDetails.imageId, "ocid1.image.oc1..newest", "the newest aarch64 image, not the GPU one");
  assert.equal(body.availabilityDomain, ADS[0]);
});

test("a request outside the envelope is refused before any file is read or any call is made", async () => {
  const never = join(work.directory, "does-not-exist");
  const cases = [
    [["--shape", A1, "--ocpus", "4", "--memory-gb", "24"], ["A1_OCPUS_EXCEEDED", "A1_MEMORY_EXCEEDED"]],
    [["--shape", "VM.Standard.E4.Flex"], ["SHAPE_NOT_ALWAYS_FREE"]],
    [["--shape", MICRO, "--ocpus", "1"], ["SHAPE_NOT_FLEXIBLE"]],
    [["--boot-volume-gb", "300"], ["STORAGE_EXCEEDED"]],
    [["--boot-volume-gb", "10"], ["BOOT_VOLUME_TOO_SMALL"]],
    [["--shape", A1, "--ocpus", "2", "--memory-gb", "abc"], ["MEMORY_INVALID"]],
  ];
  for (const [args, expected] of cases) {
    const result = await run(args, { server: undefined, provisionFile: never, credentialFile: never });
    assert.equal(result.code, 3, args.join(" "));
    assert.deepEqual(result.out.refusals.map((refusal) => refusal.code), expected, args.join(" "));
    assert.equal(result.out.documentation, "https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm");
  }
});

test("what the tenancy already runs counts: with 2 A1 OCPUs in use, an A1 is refused and nothing is changed", async () => {
  fake = await startFakeOci();
  fake.state.instances.push({ id: "ocid1.instance.oc1..foreign", compartmentId: TENANCY, shape: A1, shapeConfig: { ocpus: 2, memoryInGBs: 12 }, lifecycleState: "RUNNING", freeformTags: {} });
  const refused = await run(["--shape", A1]);
  assert.equal(refused.code, 3);
  assert.deepEqual(refused.out.refusals.map((refusal) => refusal.code), ["A1_OCPUS_EXCEEDED", "A1_MEMORY_EXCEEDED"]);
  assert.deepEqual(fake.mutations(), []);
  const micro = await run([]);
  assert.equal(micro.out.status, "launched", "the micro allowance is separate from the A1's");
});

for (const [name, launchError, reason, needle] of [
  ["out of host capacity", { status: 500, code: "InternalError", message: "Out of host capacity." }, "OUT_OF_CAPACITY", /Nothing was retried/u],
  ["a service limit", { status: 400, code: "LimitExceeded", message: "The following service limits were exceeded: standard-a1-core-count" }, "LIMIT_EXCEEDED", /do not upgrade/u],
]) {
  test(`${name} is reported as a refusal after exactly one attempt, never retried`, async () => {
    fake = await startFakeOci({ launchError });
    const { code, out } = await run(["--shape", A1]);
    assert.equal(code, 4);
    assert.equal(out.status, "refused-capacity");
    assert.equal(out.reason, reason);
    assert.equal(out.step, "launch-instance");
    assert.match(out.next, needle);
    assert.match(out.opcRequestId, /^req-/u);
    assert.equal(launches(fake).length, 1, "one attempt");
    assert.equal(fake.log.at(-1).path, "/20160918/instances", "nothing was asked of Oracle after the refusal");
    assert.deepEqual(out.completed, ["vcn", "internet-gateway", "route-rule", "security-list", "subnet"]);
    // Asking again is the operator's act; the network it made is found, not made twice.
    const before = fake.state.vcns.length;
    const again = await run(["--shape", A1]);
    assert.equal(again.code, 4);
    assert.equal(fake.state.vcns.length, before);
    assert.equal(launches(fake).length, 2);
  });
}

test("the micro default is also reported, not retried, when Oracle has no host", async () => {
  fake = await startFakeOci({ launchError: { status: 500, code: "InternalError", message: "Out of host capacity." } });
  const { code, out } = await run([]);
  assert.equal(code, 4);
  assert.equal(out.reason, "OUT_OF_CAPACITY");
  assert.equal(launches(fake).length, 1);
});

test("Always Free lives in the home region, whichever region the API key names", async () => {
  fake = await startFakeOci();
  const elsewhere = writeCredentialFile(work.directory, { region: "eu-frankfurt-1" });
  const { code } = await run([], { credentialFile: elsewhere });
  assert.equal(code, 0);
  const regions = (service) => [...new Set(fake.regionsAsked.filter((asked) => asked.service === service).map((asked) => asked.region))];
  assert.deepEqual(regions("identity"), ["eu-frankfurt-1", HOME]);
  assert.deepEqual(regions("iaas"), [HOME]);
});

test("a shape no availability domain offers, or a bad domain name, is refused with nothing changed", async () => {
  fake = await startFakeOci();
  for (const domain of ADS) fake.state.shapesByAd[domain] = [];
  const none = await run([]);
  assert.equal(none.code, 1);
  assert.match(none.err, /SHAPE_NOT_OFFERED/u);
  assert.deepEqual(fake.mutations(), []);
  const named = await run(["--availability-domain", "nowhere"]);
  assert.match(named.err, /AVAILABILITY_DOMAIN_NOT_FOUND/u);
});

test("a request Oracle does not authenticate is reported with its request id, and nothing is created", async () => {
  fake = await startFakeOci();
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const path = join(work.directory, "stranger.json");
  writeFileSync(path, JSON.stringify({ tenancy: TENANCY, user: USER, region: HOME, privateKey: other.export({ type: "pkcs8", format: "pem" }), fingerprint: fingerprintOf(other) }), { mode: 0o600 });
  const { code, out } = await run([], { credentialFile: path });
  assert.equal(code, 1);
  assert.equal(out.status, "error");
  assert.equal(out.ociStatus, 401);
  assert.deepEqual(fake.mutations(), []);
});

test("a provisioning file that would put the store credential in the URL, or omit the node, is refused without a call", async () => {
  const bad = (name, text) => { const path = join(work.directory, name); writeFileSync(path, text, { mode: 0o600 }); return path; };
  const cases = [
    ["inline.env", `NODE_JOB_NODE_ID=a\nNODE_JOB_STORE_URL=https://user:${STORE_TOKEN}@git.example/fleet.git\n`, /must not contain credentials/u],
    ["http.env", "NODE_JOB_NODE_ID=a\nNODE_JOB_STORE_URL=http://git.example/fleet.git\n", /https git URL/u],
    ["noid.env", "NODE_JOB_STORE_URL=https://git.example/fleet.git\n", /NODE_JOB_NODE_ID/u],
    ["half.env", "NODE_JOB_NODE_ID=a\nNODE_JOB_STORE_URL=https://git.example/fleet.git\nNODE_JOB_STORE_USER=x\n", /go together/u],
  ];
  for (const [name, text, message] of cases) {
    const result = await run([], { server: undefined, provisionFile: bad(name, text) });
    assert.equal(result.code, 1, name);
    assert.match(result.err, message, name);
    assert.ok(!result.err.includes(STORE_TOKEN), "the token is never echoed");
  }
});

test("the command refuses to run without its two files", async () => {
  const stdout = capture(), stderr = capture();
  assert.equal(await main([], { stdout, stderr }), 2);
  assert.match(stderr.text, /--credentials/u);
  assert.equal(await main(["--credentials", "x"], { stdout, stderr }), 2);
  assert.equal(await main(["--bogus"], { stdout, stderr }), 2);
});
