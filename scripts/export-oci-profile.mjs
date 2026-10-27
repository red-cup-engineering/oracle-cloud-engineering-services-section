#!/usr/bin/env node
// Usage: export-oci-profile.mjs --config <OCI config file> --profile <name> | bin/credentials put compute.oracle-always-free --holders bare-cedar-fog
//
// Reads one profile of an existing OCI CLI config and its key_file, checks them (the fingerprint must match the
// key), and writes the credential JSON to stdout. Pipe it straight into the credential store; never redirect it
// to a file. The config path has no default: you name it, once, and then nothing reads it again.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { OciCredentialError } from "../src/oci-request.mjs";
import { credentialJsonFromProfile } from "../src/oci-profile.mjs";

export function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let values;
  try { ({ values } = parseArgs({ args: argv, options: { config: { type: "string" }, profile: { type: "string" } } })); } catch (error) { stderr.write(`export-oci-profile: ${error.message}\n`); return 2; }
  if (!values.config || !values.profile) { stderr.write("export-oci-profile: --config <file> and --profile <name> are required\n"); return 2; }
  try {
    const configText = readFileSync(values.config, "utf8");
    stdout.write(`${credentialJsonFromProfile({ configText, configPath: values.config, profile: values.profile, readKeyFile: (path) => readFileSync(path, "utf8") })}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof OciCredentialError) && error.code !== "ENOENT") throw error;
    stderr.write(`export-oci-profile: ${error instanceof OciCredentialError ? error.message : "the config file cannot be read"}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
