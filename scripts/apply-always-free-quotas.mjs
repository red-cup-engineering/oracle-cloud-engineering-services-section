#!/usr/bin/env node
// Usage: apply-always-free-quotas.mjs --credentials <file> --alert-email <address> [--dry-run] [--availability-domain <name>]
//
// Writes compartment quota policies intended to cap compute, block storage and VCNs at
// exactly the Always Free amounts and every other family Oracle lists at zero, plus a budget of $1 with an
// alert at 1% of it ($0.01). This does not establish zero-cost protection for uncapped usage or unsupported
// quota families. Account-wide changes need their own authority; --dry-run reads from Oracle (GET only; the client
// refuses anything else) and prints every statement it would write.
//
// Exit codes: 0 done or dry run / 1 error or some policy refused by Oracle / 2 usage.
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { applyAlwaysFreeQuotas } from "../src/apply-quotas.mjs";
import { OciCredentialError, OciError, createOciClient, loadOciCredentials } from "../src/oci-request.mjs";
import { ProvisionRefusal } from "../src/oci-tenancy.mjs";

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, endpointFor, now } = {}) {
  const say = (value) => stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  const fail = (code, message) => { stderr.write(`apply-always-free-quotas: ${message}\n`); return code; };
  let values;
  try { ({ values } = parseArgs({ args: argv, options: { credentials: { type: "string" }, "alert-email": { type: "string" }, "dry-run": { type: "boolean", default: false }, "availability-domain": { type: "string" } } })); } catch (error) { return fail(2, error.message); }
  if (!values.credentials) return fail(2, "--credentials <file> is required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(values["alert-email"] ?? "")) return fail(2, "--alert-email <address> is required: where the $0.01 alert is sent");
  try {
    const credentials = loadOciCredentials(values.credentials);
    const client = createOciClient({ credentials, readOnly: values["dry-run"], ...(endpointFor ? { endpointFor } : {}), ...(now ? { now } : {}) });
    const result = await applyAlwaysFreeQuotas({ client, credentials, options: { alertEmail: values["alert-email"], availabilityDomain: values["availability-domain"] }, dryRun: values["dry-run"] });
    say(result);
    return result.status === "partly-applied" ? 1 : 0;
  } catch (error) {
    if (error instanceof OciCredentialError || error instanceof ProvisionRefusal) return fail(1, `${error.code ?? error.name}: ${error.message}`);
    if (error instanceof OciError) {
      say({ status: "error", ociStatus: error.status, ociCode: error.code, message: error.ociMessage, opcRequestId: error.opcRequestId });
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
