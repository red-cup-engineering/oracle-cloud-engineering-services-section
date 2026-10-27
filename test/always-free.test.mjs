import assert from "node:assert/strict";
import { test } from "node:test";
import { ALWAYS_FREE, ALWAYS_FREE_DOCUMENTATION_URL, NO_USAGE, admitAlwaysFreeRequest, alwaysFreeUsageOf } from "../src/always-free.mjs";

const A1 = ALWAYS_FREE.ampereA1.shape;
const MICRO = ALWAYS_FREE.microAmd.shape;
const codes = (admission) => admission.refusals.map((refusal) => refusal.code);

test("the envelope states Oracle's current Always Free amounts, with the page it came from", () => {
  assert.equal(ALWAYS_FREE_DOCUMENTATION_URL, "https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm");
  assert.equal(ALWAYS_FREE.documentation, ALWAYS_FREE_DOCUMENTATION_URL);
  assert.equal(ALWAYS_FREE.readOn, "2026-10-27");
  assert.deepEqual([ALWAYS_FREE.ampereA1.ocpuHoursPerMonth, ALWAYS_FREE.ampereA1.memoryGbHoursPerMonth], [1500, 9000]);
  assert.deepEqual([ALWAYS_FREE.ampereA1.ocpusTotal, ALWAYS_FREE.ampereA1.memoryGbTotal], [2, 12]);
  assert.equal(ALWAYS_FREE.microAmd.maxInstances, 2);
  assert.equal(ALWAYS_FREE.microAmd.memoryGb, 1);
  assert.equal(ALWAYS_FREE.microAmd.ocpuBaseline, 0.125);
  assert.equal(ALWAYS_FREE.storage.totalGb, 200);
  assert.equal(ALWAYS_FREE.egressTbPerMonth, 10);
  assert.equal(ALWAYS_FREE.homeRegionOnly, true);
  assert.deepEqual(ALWAYS_FREE.idleReclamation, { days: 7, cpuP95Percent: 20, networkPercent: 20, memoryPercent: 20 });
  assert.throws(() => { "use strict"; ALWAYS_FREE.ampereA1.ocpusTotal = 4; }, TypeError);
});

test("the whole A1 allowance, one micro node, and the default boot volume are admitted", () => {
  assert.equal(admitAlwaysFreeRequest({ shape: A1, ocpus: 2, memoryGb: 12, bootVolumeGb: 50 }).admitted, true);
  assert.equal(admitAlwaysFreeRequest({ shape: MICRO, bootVolumeGb: 50 }).admitted, true);
  assert.equal(admitAlwaysFreeRequest({ shape: MICRO, count: 2, bootVolumeGb: 47 }).admitted, true);
});

test("a shape outside the two Always Free shapes is refused", () => {
  for (const shape of ["VM.Standard.E4.Flex", "VM.Standard.A2.Flex", "BM.Standard.A1.160", "VM.Standard.E2.1", undefined, ""]) {
    assert.deepEqual(codes(admitAlwaysFreeRequest({ shape, ocpus: 1, memoryGb: 6, bootVolumeGb: 50 })), ["SHAPE_NOT_ALWAYS_FREE"], String(shape));
  }
});

test("4 OCPU / 24 GB is refused: the page says 2 OCPU / 12 GB", () => {
  const four = admitAlwaysFreeRequest({ shape: A1, ocpus: 4, memoryGb: 24, bootVolumeGb: 50 });
  assert.equal(four.admitted, false);
  assert.deepEqual(codes(four), ["A1_OCPUS_EXCEEDED", "A1_MEMORY_EXCEEDED"]);
  assert.deepEqual(codes(admitAlwaysFreeRequest({ shape: A1, ocpus: 2, memoryGb: 13, bootVolumeGb: 50 })), ["A1_MEMORY_EXCEEDED"]);
  assert.deepEqual(codes(admitAlwaysFreeRequest({ shape: A1, ocpus: 3, memoryGb: 12, bootVolumeGb: 50 })), ["A1_OCPUS_EXCEEDED"]);
});

test("counts are limited: two A1 of one OCPU, never three; two micros, never three", () => {
  assert.equal(admitAlwaysFreeRequest({ shape: A1, count: 2, ocpus: 1, memoryGb: 6, bootVolumeGb: 50 }).admitted, true);
  assert.ok(codes(admitAlwaysFreeRequest({ shape: A1, count: 3, ocpus: 1, memoryGb: 4, bootVolumeGb: 47 })).includes("A1_INSTANCES_EXCEEDED"));
  assert.deepEqual(codes(admitAlwaysFreeRequest({ shape: MICRO, count: 3, bootVolumeGb: 47 })), ["MICRO_INSTANCES_EXCEEDED"]);
  assert.deepEqual(codes(admitAlwaysFreeRequest({ shape: MICRO, count: 0, bootVolumeGb: 50 })), ["COUNT_INVALID"]);
});

test("storage: boot and block volumes share 200 GB, and a boot volume is at least 47 GB", () => {
  assert.deepEqual(codes(admitAlwaysFreeRequest({ shape: MICRO, bootVolumeGb: 201 })), ["STORAGE_EXCEEDED"]);
  assert.deepEqual(codes(admitAlwaysFreeRequest({ shape: MICRO, bootVolumeGb: 100, blockVolumeGbs: [101] })), ["STORAGE_EXCEEDED"]);
  assert.equal(admitAlwaysFreeRequest({ shape: MICRO, bootVolumeGb: 100, blockVolumeGbs: [100] }).admitted, true);
  assert.deepEqual(codes(admitAlwaysFreeRequest({ shape: MICRO, bootVolumeGb: 46 })), ["BOOT_VOLUME_TOO_SMALL"]);
  assert.deepEqual(codes(admitAlwaysFreeRequest({ shape: MICRO, bootVolumeGb: 50.5 })), ["BOOT_VOLUME_INVALID"]);
});

test("the micro shape is fixed: any size given for it is refused", () => {
  assert.deepEqual(codes(admitAlwaysFreeRequest({ shape: MICRO, ocpus: 1, bootVolumeGb: 50 })), ["SHAPE_NOT_FLEXIBLE"]);
  assert.deepEqual(codes(admitAlwaysFreeRequest({ shape: MICRO, memoryGb: 1, bootVolumeGb: 50 })), ["SHAPE_NOT_FLEXIBLE"]);
});

test("A1 sizes must be whole and in the shape's memory ratio", () => {
  assert.ok(codes(admitAlwaysFreeRequest({ shape: A1, ocpus: 1.5, memoryGb: 6, bootVolumeGb: 50 })).includes("OCPUS_INVALID"));
  assert.ok(codes(admitAlwaysFreeRequest({ shape: A1, ocpus: 2, bootVolumeGb: 50 })).includes("MEMORY_INVALID"));
  assert.ok(codes(admitAlwaysFreeRequest({ shape: A1, ocpus: 2, memoryGb: 1, bootVolumeGb: 50 })).includes("MEMORY_RATIO"));
  assert.ok(codes(admitAlwaysFreeRequest({ shape: A1, ocpus: Number.NaN, memoryGb: 12, bootVolumeGb: 50 })).includes("OCPUS_INVALID"));
});

test("Always Free exists only in the home region", () => {
  assert.deepEqual(codes(admitAlwaysFreeRequest({ shape: MICRO, bootVolumeGb: 50, region: "us-phoenix-1", homeRegion: "us-chicago-1" })), ["REGION_NOT_HOME"]);
  assert.equal(admitAlwaysFreeRequest({ shape: MICRO, bootVolumeGb: 50, region: "us-chicago-1", homeRegion: "us-chicago-1" }).admitted, true);
});

test("what the tenancy already uses counts against the request", () => {
  const usage = alwaysFreeUsageOf({
    instances: [
      { shape: A1, shapeConfig: { ocpus: 1, memoryInGBs: 6 }, lifecycleState: "RUNNING" },
      { shape: MICRO, lifecycleState: "STOPPED" },
      { shape: A1, shapeConfig: { ocpus: 4, memoryInGBs: 24 }, lifecycleState: "TERMINATED" },
    ],
    bootVolumes: [{ sizeInGBs: 50, lifecycleState: "AVAILABLE" }, { sizeInGBs: 999, lifecycleState: "TERMINATED" }],
    volumes: [{ sizeInGBs: 100, lifecycleState: "AVAILABLE" }],
  });
  assert.deepEqual({ ...usage }, { a1Instances: 1, a1Ocpus: 1, a1MemoryGb: 6, microInstances: 1, storageGb: 150 });
  assert.deepEqual(codes(admitAlwaysFreeRequest({ shape: A1, ocpus: 2, memoryGb: 12, bootVolumeGb: 50 }, usage)), ["A1_OCPUS_EXCEEDED", "A1_MEMORY_EXCEEDED"]);
  assert.equal(admitAlwaysFreeRequest({ shape: A1, ocpus: 1, memoryGb: 6, bootVolumeGb: 50 }, usage).admitted, true);
  assert.deepEqual({ ...admitAlwaysFreeRequest({ shape: MICRO, bootVolumeGb: 50 }, usage).usageAfter }, { a1Instances: 1, a1Ocpus: 1, a1MemoryGb: 6, microInstances: 2, storageGb: 200 });
  assert.deepEqual({ ...NO_USAGE }, { a1Instances: 0, a1Ocpus: 0, a1MemoryGb: 0, microInstances: 0, storageGb: 0 });
});
