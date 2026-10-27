// The Oracle Cloud Always Free envelope as data, and the one gate every request passes through.
//
// The provisioner builds each launch request only from what `admitAlwaysFreeRequest` admitted, and the
// request it can express is a free one: a shape, size or count outside this file is refused here, before
// any call to Oracle is made. Zero charge is a property of this file, not of the operator's care.
//
// Everything below is Oracle's own statement at ALWAYS_FREE_DOCUMENTATION_URL, read on 2026-10-27. That page
// states the Ampere A1 allowance as the first 1,500 OCPU hours and 9,000 GB hours a month, "equivalent to
// 2 OCPUs and 12 GB of memory" for Always Free tenancies. An earlier figure of 4 OCPUs and 24 GB is not what
// the page says now, and an upgraded (Pay As You Go) tenancy is charged for anything above these limits,
// so the smaller figure is the only one that is free on every kind of account.

export const ALWAYS_FREE_DOCUMENTATION_URL =
  "https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm";

const freeze = (value) => Object.freeze(value);

export const ALWAYS_FREE = freeze({
  documentation: ALWAYS_FREE_DOCUMENTATION_URL,
  readOn: "2026-10-27",
  // Always Free compute and block volumes exist only in the tenancy's home region.
  homeRegionOnly: true,
  ampereA1: freeze({
    shape: "VM.Standard.A1.Flex",
    architecture: "aarch64",
    ocpuHoursPerMonth: 1500,
    memoryGbHoursPerMonth: 9000,
    ocpusTotal: 2,
    memoryGbTotal: 12,
    // Whole OCPUs; up to ocpusTotal instances of one OCPU each.
    maxInstances: 2,
    memoryGbPerOcpu: freeze({ min: 1, max: 64 }),
  }),
  microAmd: freeze({
    shape: "VM.Standard.E2.1.Micro",
    maxInstances: 2,
    // A fixed shape: it takes no shapeConfig. One-eighth of an OCPU baseline, with burst.
    ocpuBaseline: 0.125,
    memoryGb: 1,
  }),
  // Boot volumes and block volumes share one allowance.
  storage: freeze({
    totalGb: 200,
    // Oracle's page says 47 GB in one place and a 50 GB default in another; 47 is the floor it enforces.
    minBootVolumeGb: 47,
    // Balanced performance, the default; stated explicitly so a changed default cannot change the bill.
    vpusPerGb: 10,
    volumeBackups: 5,
  }),
  // Outbound transfer is metered by Oracle, not by a request: no launch parameter can exceed it.
  egressTbPerMonth: 10,
  // Oracle may reclaim an instance idle for 7 days: CPU 95th percentile below 20%, network below 20%,
  // and (A1 only) memory below 20%.
  idleReclamation: freeze({ days: 7, cpuP95Percent: 20, networkPercent: 20, memoryPercent: 20 }),
});

export const NO_USAGE = freeze({ a1Instances: 0, a1Ocpus: 0, a1MemoryGb: 0, microInstances: 0, storageGb: 0 });

const isCount = (value) => Number.isSafeInteger(value) && value >= 1;
const refusal = (code, message) => freeze({ code, message });

/**
 * Decide whether Oracle would charge for launching `request` on top of what the tenancy already uses.
 *
 * @param {{region?: string, homeRegion?: string, shape: string, count?: number, ocpus?: number,
 *   memoryGb?: number, bootVolumeGb: number, blockVolumeGbs?: number[]}} request What would be launched.
 * @param {typeof NO_USAGE} usage What the tenancy already uses (alwaysFreeUsageOf).
 * @returns {{admitted: boolean, refusals: readonly {code: string, message: string}[], request: object, usageAfter: object}}
 *   `admitted` is true only when no refusal applies. Nothing here reads a network, a clock or a file.
 */
export function admitAlwaysFreeRequest(request, usage = NO_USAGE) {
  const refusals = [];
  const refuse = (code, message) => refusals.push(refusal(code, message));
  const { shape, count = 1, ocpus, memoryGb, bootVolumeGb, blockVolumeGbs = [], region, homeRegion } = request ?? {};

  if (ALWAYS_FREE.homeRegionOnly && region !== undefined && region !== homeRegion) {
    refuse("REGION_NOT_HOME", `Always Free resources exist only in the home region (${homeRegion}); ${region} would be charged.`);
  }
  if (!isCount(count)) refuse("COUNT_INVALID", `count must be a whole number of at least 1, not ${JSON.stringify(count)}.`);
  if (!isCount(bootVolumeGb)) refuse("BOOT_VOLUME_INVALID", `bootVolumeGb must be a whole number of GB, not ${JSON.stringify(bootVolumeGb)}.`);
  else if (bootVolumeGb < ALWAYS_FREE.storage.minBootVolumeGb) {
    refuse("BOOT_VOLUME_TOO_SMALL", `A boot volume is at least ${ALWAYS_FREE.storage.minBootVolumeGb} GB; ${bootVolumeGb} GB cannot be launched.`);
  }
  if (!Array.isArray(blockVolumeGbs) || !blockVolumeGbs.every(isCount)) {
    refuse("BLOCK_VOLUME_INVALID", "blockVolumeGbs must be a list of whole numbers of GB.");
  }

  const a1 = ALWAYS_FREE.ampereA1;
  const micro = ALWAYS_FREE.microAmd;
  let a1Instances = usage.a1Instances, a1Ocpus = usage.a1Ocpus, a1MemoryGb = usage.a1MemoryGb, microInstances = usage.microInstances;

  if (shape === a1.shape) {
    if (!isCount(ocpus)) refuse("OCPUS_INVALID", `ocpus must be a whole number of at least 1, not ${JSON.stringify(ocpus)}.`);
    if (!isCount(memoryGb)) refuse("MEMORY_INVALID", `memoryGb must be a whole number of GB, not ${JSON.stringify(memoryGb)}.`);
    if (isCount(ocpus) && isCount(memoryGb)) {
      if (memoryGb < ocpus * a1.memoryGbPerOcpu.min || memoryGb > ocpus * a1.memoryGbPerOcpu.max) {
        refuse("MEMORY_RATIO", `${a1.shape} takes ${a1.memoryGbPerOcpu.min} to ${a1.memoryGbPerOcpu.max} GB per OCPU; ${memoryGb} GB for ${ocpus} OCPUs is outside that.`);
      }
      if (isCount(count)) {
        a1Instances += count;
        a1Ocpus += count * ocpus;
        a1MemoryGb += count * memoryGb;
      }
    }
  } else if (shape === micro.shape) {
    if (ocpus !== undefined || memoryGb !== undefined) refuse("SHAPE_NOT_FLEXIBLE", `${micro.shape} is a fixed shape and takes no ocpus or memoryGb.`);
    if (isCount(count)) microInstances += count;
  } else {
    refuse("SHAPE_NOT_ALWAYS_FREE", `${JSON.stringify(shape)} is not an Always Free shape; only ${a1.shape} and ${micro.shape} are.`);
  }

  if (a1Instances > a1.maxInstances) {
    refuse("A1_INSTANCES_EXCEEDED", `${a1Instances} Ampere A1 instances would exist (this request and the tenancy's existing ones); Always Free allows ${a1.maxInstances}.`);
  }
  if (a1Ocpus > a1.ocpusTotal) {
    refuse("A1_OCPUS_EXCEEDED", `${a1Ocpus} Ampere A1 OCPUs would be in use in total; Always Free allows ${a1.ocpusTotal}.`);
  }
  if (a1MemoryGb > a1.memoryGbTotal) {
    refuse("A1_MEMORY_EXCEEDED", `${a1MemoryGb} GB of Ampere A1 memory would be in use in total; Always Free allows ${a1.memoryGbTotal} GB.`);
  }
  if (microInstances > micro.maxInstances) {
    refuse("MICRO_INSTANCES_EXCEEDED", `${microInstances} ${micro.shape} instances would exist; Always Free allows ${micro.maxInstances}.`);
  }

  const requestedStorageGb = isCount(count) && isCount(bootVolumeGb) && Array.isArray(blockVolumeGbs) && blockVolumeGbs.every(isCount)
    ? count * bootVolumeGb + blockVolumeGbs.reduce((sum, size) => sum + size, 0)
    : 0;
  const storageGb = usage.storageGb + requestedStorageGb;
  if (storageGb > ALWAYS_FREE.storage.totalGb) {
    refuse("STORAGE_EXCEEDED", `${storageGb} GB of boot and block volumes would exist (${usage.storageGb} GB already used); Always Free allows ${ALWAYS_FREE.storage.totalGb} GB in total.`);
  }

  return freeze({
    admitted: refusals.length === 0,
    refusals: freeze(refusals),
    request: freeze({ ...request }),
    usageAfter: freeze({ a1Instances, a1Ocpus, a1MemoryGb, microInstances, storageGb }),
  });
}

const LIVE = (item) => item.lifecycleState !== "TERMINATED";

/**
 * What a tenancy already uses of the envelope, from Oracle's own listings. Terminated resources use nothing;
 * everything else (stopped, terminating) counts, because it can still hold the allowance.
 *
 * @param {{instances: object[], bootVolumes: object[], volumes: object[]}} listings Compute instances,
 *   boot volumes and block volumes across every compartment of the tenancy.
 */
export function alwaysFreeUsageOf({ instances, bootVolumes, volumes }) {
  const live = instances.filter(LIVE);
  const a1 = live.filter((instance) => instance.shape === ALWAYS_FREE.ampereA1.shape);
  return freeze({
    a1Instances: a1.length,
    a1Ocpus: a1.reduce((sum, instance) => sum + (instance.shapeConfig?.ocpus ?? 0), 0),
    a1MemoryGb: a1.reduce((sum, instance) => sum + (instance.shapeConfig?.memoryInGBs ?? 0), 0),
    microInstances: live.filter((instance) => instance.shape === ALWAYS_FREE.microAmd.shape).length,
    storageGb: [...bootVolumes, ...volumes].filter(LIVE).reduce((sum, volume) => sum + (volume.sizeInGBs ?? 0), 0),
  });
}
