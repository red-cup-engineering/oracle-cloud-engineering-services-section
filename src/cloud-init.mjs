// The cloud-init that makes a new Linux VM a fleet worker node, and the provisioning file it carries.
//
// Mirrors node-job-service's Termux installer: the operator supplies a provisioning file, the node installs
// the pinned @red-cup-engineering/node-job-service from the Group registry and joins the fleet. Nothing here
// holds a credential; the file's values are read at provisioning time and travel only in the instance's
// user_data. Oracle stores user_data as instance metadata, so the store token must be one scoped to the
// fleet store alone.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Oracle's limit on the base64 user_data of a launch request. */
export const USER_DATA_LIMIT_BYTES = 32 * 1024;

export const INSTALLER_PATH_ON_NODE = "/usr/local/sbin/install-linux-node.sh";
export const PROVISION_PATH_ON_NODE = "/etc/node-fleet/provision.env";

const NODE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const FACT = /^[a-z0-9][a-z0-9-]*$/u;
const KEYS = ["NODE_JOB_NODE_ID", "NODE_JOB_STORE_URL", "NODE_JOB_STORE_USER", "NODE_JOB_STORE_TOKEN"];

export class ProvisionFileError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProvisionFileError";
  }
}

/**
 * Read the operator's provisioning file: KEY=value lines naming this node and its fleet store.
 *   NODE_JOB_NODE_ID=oracle-free-1       lowercase letters, digits, hyphens
 *   NODE_JOB_STORE_URL=https://...       the fleet store (its fleet-facts branch); no credentials inside the URL
 *   NODE_JOB_STORE_USER=... NODE_JOB_STORE_TOKEN=...   optional git credentials for the store
 * Only these four keys are carried; anything else in the file stays on the operator's machine.
 */
export function readProvisionFile(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch (error) { throw new ProvisionFileError(`provisioning file cannot be read: ${error.code ?? "error"}`); }
  const values = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([A-Z_]+)=(.*)$/u.exec(line);
    if (match && KEYS.includes(match[1]) && values[match[1]] === undefined) values[match[1]] = match[2];
  }
  if (!NODE_ID.test(values.NODE_JOB_NODE_ID ?? "")) throw new ProvisionFileError("NODE_JOB_NODE_ID must be lowercase letters, digits and hyphens");
  let store;
  try { store = new URL(values.NODE_JOB_STORE_URL ?? ""); } catch { throw new ProvisionFileError("NODE_JOB_STORE_URL must be an https git URL"); }
  if (store.protocol !== "https:") throw new ProvisionFileError("NODE_JOB_STORE_URL must be an https git URL");
  if (store.username !== "" || store.password !== "") throw new ProvisionFileError("NODE_JOB_STORE_URL must not contain credentials; put them in NODE_JOB_STORE_USER and NODE_JOB_STORE_TOKEN");
  if ((values.NODE_JOB_STORE_USER === undefined) !== (values.NODE_JOB_STORE_TOKEN === undefined)) {
    throw new ProvisionFileError("NODE_JOB_STORE_USER and NODE_JOB_STORE_TOKEN go together or not at all");
  }
  return Object.freeze(values);
}

const provisionText = (values) => KEYS.filter((key) => values[key] !== undefined).map((key) => `${key}=${values[key]}\n`).join("");
const base64 = (text) => Buffer.from(text).toString("base64");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * The cloud-config for a node: the installer, the provisioning file, and the one command that runs the installer.
 * @param {{installer: string, provision: Record<string,string>, failureDomain: string, power: string, network: string}} input
 */
export function cloudConfigOf({ installer, provision, failureDomain, power, network }) {
  for (const [name, value] of Object.entries({ failureDomain, power, network })) {
    if (!FACT.test(value)) throw new TypeError(`${name} must be lowercase letters, digits and hyphens`);
  }
  return Object.freeze({
    write_files: [
      { path: INSTALLER_PATH_ON_NODE, permissions: "0755", owner: "root:root", encoding: "b64", content: base64(installer) },
      { path: PROVISION_PATH_ON_NODE, permissions: "0600", owner: "root:root", encoding: "b64", content: base64(provisionText(provision)) },
    ],
    runcmd: [[INSTALLER_PATH_ON_NODE, "--failure-domain", failureDomain, "--power", power, "--network", network]],
  });
}

/** The user_data for a launch request: base64 of "#cloud-config" followed by the config as JSON (valid YAML). */
export function userDataOf(config) {
  const encoded = Buffer.from(`#cloud-config\n${JSON.stringify(config, null, 2)}\n`).toString("base64");
  if (encoded.length > USER_DATA_LIMIT_BYTES) throw new RangeError(`user_data is ${encoded.length} bytes; Oracle accepts ${USER_DATA_LIMIT_BYTES}`);
  return encoded;
}

/** The same config for a person to read: file contents summarised, every provisioning value but the node id and store URL withheld. */
export function describeCloudConfig(config) {
  const decode = (file) => Buffer.from(file.content, "base64").toString("utf8");
  const [installer, provision] = config.write_files;
  const keys = Object.fromEntries(decode(provision).split("\n").filter(Boolean).map((line) => {
    const [key, ...rest] = line.split("=");
    return [key, key === "NODE_JOB_NODE_ID" || key === "NODE_JOB_STORE_URL" ? rest.join("=") : "<withheld>"];
  }));
  return {
    write_files: [
      { path: installer.path, permissions: installer.permissions, lines: decode(installer).split("\n").length - 1, sha256: sha256(decode(installer)) },
      { path: provision.path, permissions: provision.permissions, values: keys },
    ],
    runcmd: config.runcmd,
  };
}
