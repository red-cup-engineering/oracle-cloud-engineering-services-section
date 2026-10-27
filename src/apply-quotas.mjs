// Put the tenancy-level guarantee in force: quota policies at exactly the Always Free amounts and zero
// elsewhere, and a budget that alerts at $0.01. Idempotent: it reads what exists and writes what differs.
//
// With quotas in force the tenancy cannot create a billable resource, even if it is later upgraded to Pay As
// You Go. The upgrade itself is the Leader's decision and nothing here performs it.
import { BUDGET, ZERO_POLICY_PREFIX, ALLOWANCE_POLICY, quotaPoliciesOf } from "./always-free-quotas.mjs";
import { ALWAYS_FREE } from "./always-free.mjs";
import { OciError } from "./oci-request.mjs";
import { availabilityDomainOffering, homeRegionOf } from "./oci-tenancy.mjs";

const QUOTAS = "/20181025/quotas";
const BUDGETS = "/20190111/budgets";
const sameStatements = (a, b) => a.length === b.length && a.every((statement, index) => statement.toLowerCase() === b[index].toLowerCase());

async function existingPolicies(client, region, tenancy) {
  const summaries = (await client.list("limits", region, QUOTAS, { compartmentId: tenancy }))
    .filter((quota) => quota.name === ALLOWANCE_POLICY || quota.name.startsWith(ZERO_POLICY_PREFIX));
  const byName = new Map();
  for (const summary of summaries) byName.set(summary.name, await client.get("limits", region, `${QUOTAS}/${summary.id}`));
  return byName;
}

async function existingBudget(client, region, tenancy) {
  const budget = (await client.list("usage", region, BUDGETS, { compartmentId: tenancy, targetType: "ALL" })).find((item) => item.displayName === BUDGET.displayName);
  if (!budget) return {};
  return { budget, alerts: await client.list("usage", region, `${BUDGETS}/${budget.id}/alertRules`) };
}

function planOf({ tenancy, policies, existing, budgetFound, alertEmail }) {
  const quotaSteps = policies.map((policy) => {
    const found = existing.get(policy.name);
    if (found && sameStatements(found.statements ?? [], policy.statements)) return { name: policy.name, action: "reuse", id: found.id };
    if (found) return { name: policy.name, action: "update", method: "PUT", id: found.id, body: { description: policy.description, statements: policy.statements } };
    return { name: policy.name, action: "create", method: "POST", body: { compartmentId: tenancy, name: policy.name, description: policy.description, statements: policy.statements } };
  });
  const budgetStep = budgetFound.budget
    ? { name: BUDGET.displayName, action: "reuse", id: budgetFound.budget.id, ...(budgetFound.budget.amount === BUDGET.amount ? {} : { warning: `the existing budget is ${budgetFound.budget.amount}, not ${BUDGET.amount}; it was left as it is` }) }
    : {
      name: BUDGET.displayName, action: "create", method: "POST",
      body: { compartmentId: tenancy, displayName: BUDGET.displayName, description: "Always Free tenancy: any spend at all is a mistake", amount: BUDGET.amount, resetPeriod: BUDGET.resetPeriod, targetType: "COMPARTMENT", targets: [tenancy] },
    };
  const { alert } = BUDGET;
  const alertExists = (budgetFound.alerts ?? []).some((rule) => rule.thresholdType === alert.thresholdType && rule.threshold === alert.threshold && rule.type === alert.type && String(rule.recipients ?? "").includes(alertEmail));
  const alertStep = alertExists
    ? { name: alert.displayName, action: "reuse" }
    : {
      name: alert.displayName, action: "create", method: "POST",
      body: { displayName: alert.displayName, type: alert.type, thresholdType: alert.thresholdType, threshold: alert.threshold, recipients: alertEmail, message: "Spend has reached $0.01 on a tenancy that should spend nothing. Check what was created." },
    };
  return { quotaSteps, budgetStep, alertStep };
}

/**
 * @param {{client: object, credentials: object, options: {alertEmail: string, availabilityDomain?: string}, dryRun?: boolean}} input
 * @returns {Promise<{status: "dry-run"|"applied"|"partly-applied", plan: object, results?: object[], failed?: object[]}>}
 */
export async function applyAlwaysFreeQuotas({ client, credentials, options, dryRun = false }) {
  if (!dryRun && client.readOnly) throw new TypeError("a real run needs a client that may change things");
  const tenancy = credentials.tenancy;
  const region = await homeRegionOf(client, credentials);
  const availabilityDomains = (await client.list("identity", region, "/20160918/availabilityDomains", { compartmentId: tenancy })).map((domain) => domain.name);
  const availabilityDomain = (await availabilityDomainOffering({
    client, region, compartmentId: tenancy, availabilityDomains, shape: ALWAYS_FREE.microAmd.shape, named: options.availabilityDomain,
  })) ?? availabilityDomains[0];
  const services = (await client.list("limits", region, "/20190729/services", { compartmentId: tenancy })).map((service) => service.name);

  const policies = quotaPoliciesOf({ availabilityDomain, services });
  const existing = await existingPolicies(client, region, tenancy);
  const budgetFound = await existingBudget(client, region, tenancy);
  const steps = planOf({ tenancy, policies, existing, budgetFound, alertEmail: options.alertEmail });
  const plan = { kind: "oracle-always-free-quotas-plan/v1", tenancy, region, availabilityDomain, ...steps };
  if (dryRun) return { status: "dry-run", changed: [], plan };

  const results = [], failed = [];
  const attempt = async (step, call) => {
    if (step.action === "reuse") { results.push({ name: step.name, action: "reuse" }); return true; }
    try { await call(); results.push({ name: step.name, action: step.action }); return true; } catch (error) {
      if (!(error instanceof OciError)) throw error;
      failed.push({ name: step.name, ociStatus: error.status, ociCode: error.code, message: error.ociMessage, opcRequestId: error.opcRequestId });
      return false;
    }
  };
  const write = (step) => () => (step.method === "PUT"
    ? client.put("limits", region, `${QUOTAS}/${step.id}`, step.body)
    : client.post("limits", region, QUOTAS, step.body));

  // The allowance goes first and alone: if it is refused, no zero policy is written, so the tenancy is never left able to create nothing.
  const [allowance, ...zeroes] = steps.quotaSteps;
  if (await attempt(allowance, write(allowance))) {
    for (const step of zeroes) await attempt(step, write(step));
  }
  const budget = steps.budgetStep;
  let budgetId = budget.id;
  const budgetMade = await attempt(budget, async () => { budgetId = (await client.post("usage", region, BUDGETS, budget.body)).id; });
  if (budgetMade) await attempt(steps.alertStep, () => client.post("usage", region, `${BUDGETS}/${budgetId}/alertRules`, steps.alertStep.body));

  return { status: failed.length === 0 ? "applied" : "partly-applied", results, failed, plan: { tenancy, region, availabilityDomain } };
}
