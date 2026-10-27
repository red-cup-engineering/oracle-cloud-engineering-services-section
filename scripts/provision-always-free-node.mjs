#!/usr/bin/env node
// Usage: provision-always-free-node.mjs --credentials <file> --provision <file> [--dry-run]
//          [--shape VM.Standard.E2.1.Micro | VM.Standard.A1.Flex] [--boot-volume-gb 50]
//          [--ocpus 2] [--memory-gb 12]        (Ampere A1 only, and only when asked for)
//          [--os oracle-linux|ubuntu] [--os-version 9] [--compartment <ocid>] [--compartment-name 561-group]
//          [--availability-domain <name>] [--ssh-public-key <file>] [--ssh-cidr <cidr>]
//          [--failure-domain oracle-free-tier] [--power mains] [--network always-on]
//
// Gives the fleet one Always Free node as a second failure domain, or reports that it already has the node
// named by the provisioning file. The default is the small AMD micro VM (two are free), which can launch
// now; Ampere A1 is launched only with --shape VM.Standard.A1.Flex. Writes one JSON document to stdout. With --dry-run it reads from Oracle (GET only; the client refuses
// anything else) and prints the exact calls it would make.
//
// Exit codes: 0 done (launched, reused, or dry run) / 1 error / 2 usage / 3 outside the Always Free envelope
// / 4 Oracle has no capacity or the account is at a limit (nothing was retried).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { OciCredentialError, OciError, createOciClient, loadOciCredentials } from "../src/oci-request.mjs";
import { ProvisionFileError, readProvisionFile } from "../src/cloud-init.mjs";
import { ProvisionRefusal } from "../src/oci-tenancy.mjs";
import { DEFAULTS, provisionAlwaysFreeNode, requestOf } from "../src/provision-node.mjs";
import { ALWAYS_FREE_DOCUMENTATION_URL, admitAlwaysFreeRequest } from "../src/always-free.mjs";

const OPTIONS = {
  credentials: { type: "string" }, provision: { type: "string" }, "dry-run": { type: "boolean", default: false },
  shape: { type: "string" }, ocpus: { type: "string" }, "memory-gb": { type: "string" }, "boot-volume-gb": { type: "string" },
  os: { type: "string" }, "os-version": { type: "string" }, compartment: { type: "string" }, "compartment-name": { type: "string" },
  "availability-domain": { type: "string" }, "ssh-public-key": { type: "string" }, "ssh-cidr": { type: "string" },
  "failure-domain": { type: "string" }, power: { type: "string" }, network: { type: "string" },
};

const EXIT = { done: 0, error: 1, usage: 2, envelope: 3, capacity: 4 };

const whole = (text, fallback) => (text === undefined ? fallback : /^\d+$/u.test(text) ? Number(text) : Number.NaN);

/**
 * Run the command. `io` and `endpointFor` exist so a test can aim it at a local server; the executable passes neither.
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr, endpointFor, now } = {}) {
  const say = (value) => stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  const fail = (code, message) => { stderr.write(`provision-always-free-node: ${message}\n`); return code; };
  let values;
  try { ({ values } = parseArgs({ args: argv, options: OPTIONS })); } catch (error) { return fail(EXIT.usage, error.message); }
  if (!values.credentials) return fail(EXIT.usage, "--credentials <file> is required (the OCI credential; /dev/stdin works)");
  if (!values.provision) return fail(EXIT.usage, "--provision <file> is required (the node's fleet provisioning file)");

  const options = {
    shape: values.shape ?? DEFAULTS.shape, ocpus: whole(values.ocpus, undefined), memoryGb: whole(values["memory-gb"], undefined), bootVolumeGb: whole(values["boot-volume-gb"], DEFAULTS.bootVolumeGb),
    os: values.os ?? DEFAULTS.os, osVersion: values["os-version"], compartmentId: values.compartment, compartmentName: values["compartment-name"] ?? DEFAULTS.compartmentName,
    availabilityDomain: values["availability-domain"], sshCidr: values["ssh-cidr"],
    failureDomain: values["failure-domain"] ?? DEFAULTS.failureDomain, power: values.power ?? DEFAULTS.power, network: values.network ?? DEFAULTS.network,
  };

  // The envelope is checked before any file is read or any call is made.
  const admission = admitAlwaysFreeRequest(requestOf(options));
  if (!admission.admitted) { say({ status: "refused-envelope", documentation: ALWAYS_FREE_DOCUMENTATION_URL, refusals: admission.refusals }); return EXIT.envelope; }
  if (options.sshCidr !== undefined && !/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/u.test(options.sshCidr)) return fail(EXIT.usage, "--ssh-cidr must be an IPv4 CIDR such as 203.0.113.7/32");

  try {
    const provision = readProvisionFile(values.provision);
    if (values["ssh-public-key"]) {
      options.sshPublicKey = readFileSync(values["ssh-public-key"], "utf8").trim();
      if (!/^ssh-|^ecdsa-/u.test(options.sshPublicKey)) return fail(EXIT.usage, "--ssh-public-key must be a public key file (ssh-ed25519 ... or ssh-rsa ...), never the private key");
    }
    const credentials = loadOciCredentials(values.credentials);
    const client = createOciClient({ credentials, readOnly: values["dry-run"], ...(endpointFor ? { endpointFor } : {}), ...(now ? { now } : {}) });
    const result = await provisionAlwaysFreeNode({ client, credentials, provision, options, dryRun: values["dry-run"] });
    say(result);
    if (result.status === "refused-envelope") return EXIT.envelope;
    if (result.status === "refused-capacity") return EXIT.capacity;
    return EXIT.done;
  } catch (error) {
    if (error instanceof OciCredentialError || error instanceof ProvisionFileError || error instanceof ProvisionRefusal) {
      return fail(EXIT.error, `${error.code ?? error.name}: ${error.message}`);
    }
    if (error instanceof OciError) {
      say({ status: "error", ociStatus: error.status, ociCode: error.code, message: error.ociMessage, opcRequestId: error.opcRequestId, completed: error.completedSteps ?? [],
        next: "Fix the cause and run the same command again: it finds what was already made and continues." });
      return EXIT.error;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
