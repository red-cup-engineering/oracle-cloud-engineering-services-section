// One-time import of an existing OCI CLI profile into the credential shape this package reads.
//
// The Leader already has a profile in ~/.oci/config (user, fingerprint, tenancy, region, key_file). This turns
// that profile and its key into the single JSON document `bin/credentials put` takes on stdin. After the put,
// nothing reads ~/.oci again. Nothing here prints a value except the document the caller asked for.
import { homedir } from "node:os";
import { isAbsolute, resolve, dirname } from "node:path";
import { OciCredentialError, parseOciCredentials } from "./oci-request.mjs";

/** The `key=value` pairs of one `[PROFILE]` section of an OCI config file. */
export function profileFields(configText, profile) {
  let inProfile = false, found = false;
  const fields = {};
  for (const line of configText.split(/\r?\n/u)) {
    const section = /^\s*\[(.+?)\]\s*$/u.exec(line);
    if (section) { inProfile = section[1] === profile; found ||= inProfile; continue; }
    const pair = /^\s*([a-z_]+)\s*=\s*(.*?)\s*$/u.exec(line);
    if (inProfile && pair) fields[pair[1]] = pair[2];
  }
  if (!found) throw new OciCredentialError(`the config file has no profile [${profile}]`);
  return fields;
}

/**
 * @param {{configText: string, configPath: string, profile: string, readKeyFile: (path: string) => string}} input
 * @returns {string} the credential as JSON, checked as the client will check it (fingerprint against key included)
 */
export function credentialJsonFromProfile({ configText, configPath, profile, readKeyFile }) {
  const fields = profileFields(configText, profile);
  if (!fields.key_file) throw new OciCredentialError(`profile [${profile}] has no key_file`);
  const keyPath = fields.key_file.startsWith("~") ? resolve(homedir(), fields.key_file.slice(2)) : isAbsolute(fields.key_file) ? fields.key_file : resolve(dirname(configPath), fields.key_file);
  let privateKey;
  try { privateKey = readKeyFile(keyPath); } catch (error) { throw new OciCredentialError(`the profile's key_file cannot be read: ${error.code ?? "error"}`); }
  const credential = {
    tenancy: fields.tenancy, user: fields.user, fingerprint: fields.fingerprint, region: fields.region, privateKey,
    ...(fields.pass_phrase ? { passphrase: fields.pass_phrase } : {}),
  };
  const json = JSON.stringify(credential);
  parseOciCredentials(json);
  return json;
}
