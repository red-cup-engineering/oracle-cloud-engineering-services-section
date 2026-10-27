// Provision the Group's one Always Free fleet node. Idempotent: it finds what exists and makes only what is missing.
//
//   admit      the request is checked against the Always Free envelope before anything is read from Oracle
//   discover   read-only calls: home region, availability domains, compartment, usage, this node if it exists, shape offer, image, network
//   plan       the exact calls that would be made (printable data)
//   apply      those calls, in order, once each; never in a dry run
//
// There is no retry, no polling and no timer. "Out of host capacity" and limit errors are reported as refusals;
// the node is launched in one availability domain, and trying another is the operator's decision. Nothing
// here waits for capacity: a refusal is the answer, and running the command again later is the operator's act.
import { readFileSync } from "node:fs";
import { ALWAYS_FREE, ALWAYS_FREE_DOCUMENTATION_URL, NO_USAGE, admitAlwaysFreeRequest } from "./always-free.mjs";
import { cloudConfigOf, describeCloudConfig, userDataOf } from "./cloud-init.mjs";
import { launchStep, networkSteps, printable, resolveTemplate, retryTokenOf } from "./node-plan.mjs";
import { classifyOciError } from "./oci-request.mjs";
import { OPERATING_SYSTEMS, ProvisionRefusal, discoverTenancy } from "./oci-tenancy.mjs";

// The default node is the small AMD micro VM, which can launch now. Ampere A1 is launched only when asked for,
// with --shape VM.Standard.A1.Flex, and then takes the whole A1 allowance unless a smaller size is given.
export const DEFAULTS = Object.freeze({
  shape: ALWAYS_FREE.microAmd.shape,
  a1: Object.freeze({ ocpus: ALWAYS_FREE.ampereA1.ocpusTotal, memoryGb: ALWAYS_FREE.ampereA1.memoryGbTotal }),
  bootVolumeGb: 50,
  os: "oracle-linux",
  compartmentName: "561-group",
  failureDomain: "oracle-free-tier",
  power: "mains",
  network: "always-on",
});

const installerSource = () => readFileSync(new URL("../scripts/install-linux-node.sh", import.meta.url), "utf8");

/** The request the envelope is asked about. Sizes are the A1's alone: the micro shape is fixed, so a size given for it is refused. */
export function requestOf(options, region, homeRegion) {
  const shape = options.shape ?? DEFAULTS.shape;
  const flexible = shape === ALWAYS_FREE.ampereA1.shape;
  return {
    shape, count: 1, bootVolumeGb: options.bootVolumeGb, region, homeRegion,
    ocpus: options.ocpus ?? (flexible ? DEFAULTS.a1.ocpus : undefined),
    memoryGb: options.memoryGb ?? (flexible ? DEFAULTS.a1.memoryGb : undefined),
  };
}

const refusedEnvelope = (admission) => ({ status: "refused-envelope", documentation: ALWAYS_FREE_DOCUMENTATION_URL, refusals: admission.refusals });

const instanceSummary = (instance) => ({
  id: instance.id, displayName: instance.displayName, lifecycleState: instance.lifecycleState, availabilityDomain: instance.availabilityDomain,
  shape: instance.shape, shapeConfig: instance.shapeConfig,
});

async function apply({ client, credentials, plan, userData, retryToken, region }) {
  const scope = { "user-data": userData, availabilityDomain: plan.node.availabilityDomain };
  const completed = [];
  for (const step of plan.steps) {
    if (step.action === "reuse") { scope[step.name] = step.object; continue; }
    const path = resolveTemplate(step.path, scope);
    const body = resolveTemplate(step.body, scope);
    try {
      scope[step.name] = step.method === "PUT"
        ? await client.put(step.service, region, path, body)
        : await client.post(step.service, region, path, body, step.name === "launch-instance" ? { retryToken } : {});
    } catch (error) {
      const kind = classifyOciError(error);
      if (kind === "OUT_OF_CAPACITY" || kind === "LIMIT_EXCEEDED") {
        return {
          status: "refused-capacity", reason: kind, step: step.name, message: error.ociMessage, opcRequestId: error.opcRequestId, completed,
          next: kind === "OUT_OF_CAPACITY"
            ? "Oracle has no Ampere A1 capacity in this availability domain right now. Nothing was retried. Run the same command later, or name another domain with --availability-domain."
            : "The account is at a service limit for this step. Stay on Free Tier: do not upgrade to Pay As You Go to get past it.",
        };
      }
      error.completedSteps = completed;
      throw error;
    }
    completed.push(step.name);
  }
  const instance = scope["launch-instance"];
  if (instance.lifecycleState === "TERMINATED" || instance.lifecycleState === "TERMINATING") {
    return {
      status: "refused-capacity", reason: "RETRY_TOKEN_REPLAY", step: "launch-instance", completed,
      message: "Oracle replayed an earlier launch of this node that has since been terminated (launch tokens last 24 hours).",
      next: "Run the same command again after 24 hours.",
    };
  }
  return { status: "launched", instance: instanceSummary(instance), completed, next: "Run the same command again to read the instance's state and public address; it will find this node and change nothing." };
}

/**
 * @param {{client: ReturnType<import("./oci-request.mjs").createOciClient>, credentials: object, provision: Record<string,string>,
 *   options: object, dryRun?: boolean}} input `options` are the CLI's options over DEFAULTS.
 * @returns {Promise<object>} {status: "dry-run"|"launched"|"reused"|"refused-envelope"|"refused-capacity", ...}
 */
export async function provisionAlwaysFreeNode({ client, credentials, provision, options, dryRun = false }) {
  if (!dryRun && client.readOnly) throw new TypeError("a real run needs a client that may change things");
  const settings = { ...DEFAULTS, ...options };
  const nodeId = provision.NODE_JOB_NODE_ID;
  if (!OPERATING_SYSTEMS[settings.os]) throw new ProvisionRefusal("OS_UNKNOWN", `--os is one of: ${Object.keys(OPERATING_SYSTEMS).join(", ")}`);

  // The envelope first, from the request alone: a size outside it is refused without a call to Oracle.
  const unplaced = admitAlwaysFreeRequest(requestOf(settings), NO_USAGE);
  if (!unplaced.admitted) return refusedEnvelope(unplaced);

  const found = await discoverTenancy({ client, credentials, options: settings, shape: unplaced.request.shape, nodeId });
  const { region } = found;

  if (found.existing) {
    return {
      status: "reused", region, compartment: found.compartment,
      instance: instanceSummary(found.existing.instance), publicIp: found.existing.publicIp, privateIp: found.existing.privateIp, alsoTagged: found.existing.alsoTagged,
      changed: [], next: `A node tagged for the 561 Group as ${nodeId} already exists, so nothing was created. A second node needs its own NODE_JOB_NODE_ID.`,
    };
  }

  const admission = admitAlwaysFreeRequest(requestOf(settings, region, region), found.usage);
  if (!admission.admitted) return { ...refusedEnvelope(admission), usageBefore: found.usage };

  const { availabilityDomain } = found;
  const { shape, ocpus, memoryGb } = admission.request;
  const config = cloudConfigOf({ installer: installerSource(), provision, failureDomain: settings.failureDomain, power: settings.power, network: settings.network });
  const steps = [
    ...networkSteps({ found: found.network, compartmentId: found.compartment.id, sshCidr: settings.sshCidr }),
    launchStep({ compartmentId: found.compartment.id, nodeId, shape, ocpus, memoryGb, bootVolumeGb: settings.bootVolumeGb, imageId: found.image.id, sshPublicKey: settings.sshPublicKey }),
  ];
  const plan = {
    kind: "oracle-always-free-node-plan/v1",
    tenancy: credentials.tenancy,
    region: { home: region, credential: credentials.region },
    compartment: found.compartment,
    node: {
      id: nodeId, availabilityDomain, availabilityDomains: found.availabilityDomains, shape,
      ocpus, memoryGb, bootVolumeGb: settings.bootVolumeGb,
      image: { id: found.image.id, displayName: found.image.displayName },
      fleet: { failureDomain: settings.failureDomain, power: settings.power, network: settings.network, capacity: shape === ALWAYS_FREE.ampereA1.shape ? `${ocpus} OCPU, ${memoryGb} GB, read from the machine by node-job-service` : "1 GB and 1/8 OCPU (burstable), read from the machine by node-job-service" },
    },
    envelope: { documentation: ALWAYS_FREE_DOCUMENTATION_URL, usageBefore: found.usage, usageAfter: admission.usageAfter, limits: { a1Ocpus: ALWAYS_FREE.ampereA1.ocpusTotal, a1MemoryGb: ALWAYS_FREE.ampereA1.memoryGbTotal, microInstances: ALWAYS_FREE.microAmd.maxInstances, storageGb: ALWAYS_FREE.storage.totalGb } },
    steps: printable(steps),
    cloudInit: describeCloudConfig(config),
  };
  if (dryRun) return { status: "dry-run", changed: [], plan };

  const retryToken = retryTokenOf({ tenancy: credentials.tenancy, compartmentId: found.compartment.id, nodeId, availabilityDomain });
  const outcome = await apply({ client, credentials, plan: { ...plan, steps }, userData: userDataOf(config), retryToken, region });
  return { ...outcome, region, plan: { node: plan.node, envelope: plan.envelope } };
}
