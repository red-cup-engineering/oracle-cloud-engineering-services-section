// Compartment resource quota policies; not a complete billing guarantee.
//
// Quota statements (https://docs.oracle.com/en-us/iaas/Content/Quotas/Concepts/quota_policy_syntax.htm) refuse
// a create request that would pass them, whatever the account type. With these in force a Pay As You Go
// tenancy is intended to be capped at the configured compute and block storage amounts, with zero policies
// proposed for other listed families. Provider acceptance and policy readback remain separate evidence;
// unsupported quota families and usage charges are not covered. Quota names and families are from Oracle's quota pages for
// Compute, Block Volume and Networking, read 2026-10-27.
//
// Quotas on compute and block storage are per availability domain, so the allowance is stated in exactly one
// domain and every other domain keeps the zero. A statement later in a policy supersedes an earlier one for
// the same resource; the allowance is a family zeroed, then the free amounts set back.
import { ALWAYS_FREE } from "./always-free.mjs";

/** Families the allowance policy states in full, so no zero policy may touch them. */
export const ALLOWANCE_FAMILIES = Object.freeze(["compute", "compute-core", "compute-memory", "block-storage", "vcn"]);

/** Compute families a tenancy can use that the Limits service lists under other names. They are zeroed. */
export const EXTRA_ZERO_FAMILIES = Object.freeze(["compute-management", "auto-scaling"]);

export const ALLOWANCE_POLICY = "always-free-allowance";
export const ZERO_POLICY_PREFIX = "always-free-zero-";

/** The Always Free amounts, set in one availability domain, everything else in the compute, storage and network families zero. */
export function allowanceStatements({ availabilityDomain }) {
  const { ampereA1, microAmd, storage } = ALWAYS_FREE;
  const inDomain = `in tenancy where request.ad = '${availabilityDomain}'`;
  return [
    "zero compute-core quotas in tenancy",
    "zero compute-memory quotas in tenancy",
    "zero compute quotas in tenancy",
    `set compute-core quota standard-a1-core-count to ${ampereA1.ocpusTotal} ${inDomain}`,
    `set compute-memory quota standard-a1-memory-count to ${ampereA1.memoryGbTotal} ${inDomain}`,
    // One OCPU is the most a micro instance can count as; two instances.
    `set compute-core quota standard-e2-micro-core-count to ${microAmd.maxInstances} ${inDomain}`,
    `set compute quota vm-standard-e2-1-micro-count to ${microAmd.maxInstances} ${inDomain}`,
    "zero block-storage quotas in tenancy",
    `set block-storage quota total-storage-gb to ${storage.totalGb} ${inDomain}`,
    `set block-storage quota backup-count to ${storage.volumeBackups} in tenancy`,
    "zero vcn quotas in tenancy",
    "set vcn quota vcn-count to 2 in tenancy",
  ];
}

const ZERO_SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/u;

/**
 * Every quota policy to hold: the allowance, then one zero policy per other family. One policy per family, so a
 * family Oracle's quota language does not know is refused alone and the rest still apply.
 * @param {{availabilityDomain: string, services: string[]}} input `services` are the names the Limits service lists.
 */
export function quotaPoliciesOf({ availabilityDomain, services }) {
  const zeroed = [...new Set([...services, ...EXTRA_ZERO_FAMILIES])]
    .filter((family) => !ALLOWANCE_FAMILIES.includes(family) && ZERO_SAFE_NAME.test(family))
    .sort();
  return [
    {
      name: ALLOWANCE_POLICY,
      description: "Always Free amounts of compute, block storage and VCNs, in one availability domain; zero elsewhere",
      statements: allowanceStatements({ availabilityDomain }),
    },
    ...zeroed.map((family) => ({
      name: `${ZERO_POLICY_PREFIX}${family}`,
      description: `No ${family} resource can be created: it is not in the Always Free allowance`,
      statements: [`zero ${family} quotas in tenancy`],
    })),
  ];
}

/** A budget of one dollar with an alert at one percent of it: $0.01, the first cent the account is asked to pay. */
export const BUDGET = Object.freeze({
  displayName: "always-free-zero-spend",
  amount: 1,
  resetPeriod: "MONTHLY",
  alert: Object.freeze({ displayName: "always-free-first-cent", type: "ACTUAL", thresholdType: "PERCENTAGE", threshold: 1 }),
});
