import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { main } from "../scripts/apply-always-free-quotas.mjs";
import { ALWAYS_FREE } from "../src/always-free.mjs";
import { ALLOWANCE_FAMILIES, allowanceStatements, quotaPoliciesOf } from "../src/always-free-quotas.mjs";
import { ADS, TENANCY, startFakeOci, workDirectory, writeCredentialFile } from "./fake-oci.mjs";

const work = workDirectory();
after(() => work.cleanup());
const EMAIL = "leader@example.org";

let fake, credentials;
beforeEach(() => { credentials = writeCredentialFile(work.directory); });
afterEach(async () => { await fake?.close(); fake = undefined; });

const capture = () => { let text = ""; return { write: (chunk) => { text += chunk; }, get text() { return text; } }; };
async function run(extra = []) {
  const stdout = capture(), stderr = capture();
  const code = await main(["--credentials", credentials, "--alert-email", EMAIL, ...extra], { stdout, stderr, endpointFor: fake.endpointFor, now: () => new Date("2026-10-27T12:00:00Z") });
  return { code, out: stdout.text ? JSON.parse(stdout.text) : undefined, err: stderr.text };
}
const statementsOf = (policies) => policies.flatMap((policy) => policy.statements);

test("the allowance sets exactly the Always Free amounts in one availability domain, and nothing above them", () => {
  const statements = allowanceStatements({ availabilityDomain: ADS[1] });
  const where = `in tenancy where request.ad = '${ADS[1]}'`;
  assert.ok(statements.includes(`set compute-core quota standard-a1-core-count to ${ALWAYS_FREE.ampereA1.ocpusTotal} ${where}`));
  assert.ok(statements.includes(`set compute-memory quota standard-a1-memory-count to ${ALWAYS_FREE.ampereA1.memoryGbTotal} ${where}`));
  assert.ok(statements.includes(`set compute quota vm-standard-e2-1-micro-count to ${ALWAYS_FREE.microAmd.maxInstances} ${where}`));
  assert.ok(statements.includes(`set block-storage quota total-storage-gb to ${ALWAYS_FREE.storage.totalGb} ${where}`));
  assert.ok(statements.includes(`set block-storage quota backup-count to ${ALWAYS_FREE.storage.volumeBackups} in tenancy`));
  // Every family is zeroed before anything is set in it, so the sets are an allowlist.
  for (const family of ["compute-core", "compute-memory", "compute", "block-storage", "vcn"]) {
    const zero = statements.indexOf(`zero ${family} quotas in tenancy`);
    const firstSet = statements.findIndex((statement) => statement.startsWith(`set ${family} `));
    assert.ok(zero >= 0 && zero < firstSet, `${family} is zeroed first`);
  }
  const limits = { "standard-a1-core-count": 2, "standard-a1-memory-count": 12, "standard-e2-micro-core-count": 2, "vm-standard-e2-1-micro-count": 2, "total-storage-gb": 200, "backup-count": 5, "vcn-count": 2 };
  for (const statement of statements.filter((item) => item.startsWith("set "))) {
    const [, name, value] = /^set \S+ quota (\S+) to (\d+) /u.exec(statement);
    assert.ok(name in limits && Number(value) <= limits[name], statement);
  }
});

test("every family the Limits service lists is zeroed, once, except the three the allowance states", () => {
  const policies = quotaPoliciesOf({ availabilityDomain: ADS[1], services: ["compute", "block-storage", "vcn", "database", "Load Balancer", "object-storage", "filesystem", "database"] });
  const zeroed = policies.slice(1).map((policy) => policy.statements);
  assert.deepEqual(zeroed.flat().sort(), [
    "zero auto-scaling quotas in tenancy", "zero compute-management quotas in tenancy", "zero database quotas in tenancy",
    "zero filesystem quotas in tenancy", "zero object-storage quotas in tenancy",
  ]);
  assert.ok(policies.slice(1).every((policy) => policy.statements.length === 1), "one family per policy, so an unknown family is refused alone");
  for (const family of ALLOWANCE_FAMILIES) assert.ok(!statementsOf(policies.slice(1)).some((statement) => statement.includes(` ${family} `)));
});

test("--dry-run reads, prints every statement it would write, and writes nothing", async () => {
  fake = await startFakeOci();
  const { code, out } = await run(["--dry-run"]);
  assert.equal(code, 0);
  assert.equal(out.status, "dry-run");
  assert.deepEqual(fake.mutations(), []);
  assert.equal(out.plan.availabilityDomain, ADS[1], "the domain that offers the micro shape");
  assert.deepEqual(out.plan.quotaSteps.map((step) => step.action), Array(out.plan.quotaSteps.length).fill("create"));
  assert.equal(out.plan.quotaSteps[0].name, "always-free-allowance");
  assert.ok(out.plan.quotaSteps[0].body.statements.includes("zero compute-core quotas in tenancy"));
  assert.deepEqual(out.plan.budgetStep.body, { compartmentId: TENANCY, displayName: "always-free-zero-spend", description: "Always Free tenancy: any spend at all is a mistake", amount: 1, resetPeriod: "MONTHLY", targetType: "COMPARTMENT", targets: [TENANCY] });
  assert.deepEqual(out.plan.alertStep.body.threshold, 1);
  assert.equal(out.plan.alertStep.body.thresholdType, "PERCENTAGE");
  assert.equal(out.plan.alertStep.body.recipients, EMAIL);
});

test("applying writes the policies and the budget with its $0.01 alert; a second run changes nothing", async () => {
  fake = await startFakeOci();
  const first = await run();
  assert.equal(first.code, 0);
  assert.equal(first.out.status, "applied");
  assert.ok(fake.log.every((entry) => entry.problems.length === 0));
  const names = fake.state.quotas.map((quota) => quota.name);
  assert.equal(names[0], "always-free-allowance", "the allowance is written first");
  assert.ok(names.includes("always-free-zero-database") && names.includes("always-free-zero-compute-management"));
  assert.ok(!names.includes("always-free-zero-compute") && !names.includes("always-free-zero-vcn"));
  assert.ok(fake.state.quotas.every((quota) => quota.compartmentId === TENANCY), "quota policies live in the tenancy");
  assert.equal(fake.state.budgets.length, 1);
  assert.equal(fake.state.budgets[0].amount, 1);
  assert.deepEqual(fake.state.budgets[0].targets, [TENANCY]);
  assert.equal(fake.state.alertRules.length, 1);
  assert.equal(fake.state.alertRules[0].threshold * fake.state.budgets[0].amount / 100, 0.01, "1% of $1 is the first cent");

  const mutations = fake.mutations().length;
  const second = await run();
  assert.equal(second.out.status, "applied");
  assert.ok(second.out.results.every((result) => result.action === "reuse"));
  assert.equal(fake.mutations().length, mutations);
});

test("a policy whose statements drifted is updated in place, not duplicated", async () => {
  fake = await startFakeOci();
  await run();
  const quota = fake.state.quotas.find((item) => item.name === "always-free-allowance");
  quota.statements = quota.statements.map((statement) => statement.replace("to 200", "to 9999"));
  const before = fake.state.quotas.length;
  const { out } = await run();
  assert.equal(fake.state.quotas.length, before);
  assert.deepEqual(out.results.filter((result) => result.action === "update").map((result) => result.name), ["always-free-allowance"]);
  assert.ok(quota.statements.some((statement) => statement.includes("total-storage-gb to 200")));
});

test("a family Oracle's quota language refuses is reported alone; the rest still apply, and the exit code says so", async () => {
  fake = await startFakeOci({ rejectQuotaFamilies: ["filesystem"] });
  const { code, out } = await run();
  assert.equal(code, 1);
  assert.equal(out.status, "partly-applied");
  assert.deepEqual(out.failed.map((failure) => [failure.name, failure.ociCode]), [["always-free-zero-filesystem", "InvalidParameter"]]);
  assert.ok(fake.state.quotas.some((quota) => quota.name === "always-free-zero-database"));
  assert.equal(fake.state.budgets.length, 1, "the budget is still created");
});

test("if the allowance is refused no zero policy is written, so the tenancy is never left unable to create its free resources", async () => {
  fake = await startFakeOci({ rejectQuotaFamilies: ["compute-core"] });
  const { code, out } = await run();
  assert.equal(code, 1);
  assert.deepEqual(out.failed.map((failure) => failure.name), ["always-free-allowance"]);
  assert.deepEqual(fake.state.quotas, []);
});

test("an alert address is required, and the command never upgrades or changes the account", async () => {
  fake = await startFakeOci();
  const stdout = capture(), stderr = capture();
  assert.equal(await main(["--credentials", credentials], { stdout, stderr, endpointFor: fake.endpointFor }), 2);
  assert.match(stderr.text, /--alert-email/u);
  assert.deepEqual(fake.log, []);
  await run();
  assert.ok(fake.mutations().every((entry) => /^\/(20181025\/quotas|20190111\/budgets)/u.test(entry.path)), "only quotas and the budget are written");
});
