import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { main as exportProfile } from "../scripts/export-oci-profile.mjs";
import { USER_DATA_LIMIT_BYTES, cloudConfigOf, describeCloudConfig, readProvisionFile, userDataOf } from "../src/cloud-init.mjs";
import { parseOciCredentials } from "../src/oci-request.mjs";
import { STORE_TOKEN, TENANCY, USER, fingerprint, privatePem, workDirectory, writeProvisionFile } from "./fake-oci.mjs";

const work = workDirectory();
after(() => work.cleanup());
const installer = new URL("../scripts/install-linux-node.sh", import.meta.url).pathname;
const capture = () => { let text = ""; return { write: (chunk) => { text += chunk; }, get text() { return text; } }; };

test("the provisioning file carries four keys and drops the rest", () => {
  const values = readProvisionFile(writeProvisionFile(work.directory));
  assert.deepEqual(Object.keys(values).sort(), ["NODE_JOB_NODE_ID", "NODE_JOB_STORE_TOKEN", "NODE_JOB_STORE_URL", "NODE_JOB_STORE_USER"]);
});

test("the cloud-config is under Oracle's user_data limit, and its description withholds the credentials", () => {
  const provision = readProvisionFile(writeProvisionFile(work.directory));
  const config = cloudConfigOf({ installer: "#!/bin/sh\n", provision, failureDomain: "oracle-free-tier", power: "mains", network: "always-on" });
  assert.ok(userDataOf(config).length < USER_DATA_LIMIT_BYTES);
  const described = JSON.stringify(describeCloudConfig(config));
  assert.ok(!described.includes(STORE_TOKEN));
  assert.throws(() => cloudConfigOf({ installer: "", provision, failureDomain: "Bad Domain", power: "mains", network: "always-on" }), /failureDomain/u);
  assert.throws(() => userDataOf({ write_files: [{ content: "x".repeat(USER_DATA_LIMIT_BYTES) }] }), /user_data/u);
});

test("the installer script is valid sh and the real one fits in user_data", () => {
  assert.equal(spawnSync("sh", ["-n", installer]).status, 0);
  const provision = readProvisionFile(writeProvisionFile(work.directory));
  const text = spawnSync("cat", [installer], { encoding: "utf8" }).stdout;
  assert.ok(userDataOf(cloudConfigOf({ installer: text, provision, failureDomain: "oracle-free-tier", power: "mains", network: "always-on" })).length < USER_DATA_LIMIT_BYTES);
});

test("the installer refuses, before changing anything, without a provisioning file or with a bad one", () => {
  const run = (args, provisionPath) => spawnSync("sh", [installer, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, NODE_FLEET_PROVISION: provisionPath } });
  const good = ["--failure-domain", "oracle-free-tier", "--power", "mains", "--network", "always-on"];
  const provisionWith = (name, text) => { const path = join(work.directory, name); writeFileSync(path, text); return path; };

  const missing = run(good, join(work.directory, "absent.env"));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no provisioning file/u);

  assert.match(run(good, provisionWith("a.env", "NODE_JOB_NODE_ID=Bad_Id\nNODE_JOB_STORE_URL=https://git.example/f.git\n")).stderr, /NODE_JOB_NODE_ID must be lowercase/u);
  assert.match(run(good, provisionWith("b.env", "NODE_JOB_NODE_ID=a\nNODE_JOB_STORE_URL=http://git.example/f.git\n")).stderr, /https git URL/u);
  assert.match(run(good, provisionWith("c.env", `NODE_JOB_NODE_ID=a\nNODE_JOB_STORE_URL=https://u:${STORE_TOKEN}@git.example/f.git\n`)).stderr, /must not contain credentials/u);
  assert.ok(!run(good, provisionWith("c.env", `NODE_JOB_NODE_ID=a\nNODE_JOB_STORE_URL=https://u:${STORE_TOKEN}@git.example/f.git\n`)).stderr.includes(STORE_TOKEN));
  const valid = provisionWith("d.env", "NODE_JOB_NODE_ID=a\nNODE_JOB_STORE_URL=https://git.example/f.git\n");
  assert.match(run(["--failure-domain", "Bad", "--power", "mains", "--network", "x"], valid).stderr, /--failure-domain must be lowercase/u);
  assert.match(run(["--power", "mains", "--network", "x"], valid).stderr, /--failure-domain must be lowercase/u);
  assert.match(run([...good, "--surprise"], valid).stderr, /unknown argument/u);
  if (process.getuid() !== 0) assert.match(run(good, valid).stderr, /run as root/u);
});

test("an existing OCI CLI profile is exported to the credential shape, checked, and never to a file", () => {
  const keyPath = join(work.directory, "profile-key.pem");
  writeFileSync(keyPath, privatePem, { mode: 0o600 });
  const config = join(work.directory, "oci-config");
  writeFileSync(config, `[DEFAULT]\nuser=ocid1.user.oc1..someoneelse\nfingerprint=00:00\ntenancy=ocid1.tenancy.oc1..someoneelse\nregion=us-phoenix-1\nkey_file=/nope\n\n[BLUE_CORN_CREEK]\nuser=${USER}\nfingerprint=${fingerprint}\ntenancy=${TENANCY}\nregion=us-chicago-1\nkey_file=profile-key.pem\n`);
  const stdout = capture(), stderr = capture();
  assert.equal(exportProfile(["--config", config, "--profile", "BLUE_CORN_CREEK"], { stdout, stderr }), 0);
  assert.equal(stderr.text, "");
  const credentials = parseOciCredentials(stdout.text);
  assert.equal(credentials.region, "us-chicago-1");
  assert.equal(credentials.keyId, `${TENANCY}/${USER}/${fingerprint}`);
});

test("exporting refuses a missing profile, a missing key and a mismatched fingerprint, naming no value", () => {
  const config = join(work.directory, "oci-config-2");
  const write = (text) => writeFileSync(config, text);
  const attempt = (profile = "P") => { const stdout = capture(), stderr = capture(); const code = exportProfile(["--config", config, "--profile", profile], { stdout, stderr }); return { code, stdout: stdout.text, stderr: stderr.text }; };

  write(`[P]\nuser=${USER}\n`);
  assert.match(attempt("Q").stderr, /no profile \[Q\]/u);
  assert.match(attempt().stderr, /no key_file/u);
  write(`[P]\nuser=${USER}\nfingerprint=${fingerprint}\ntenancy=${TENANCY}\nregion=us-chicago-1\nkey_file=${join(work.directory, "absent.pem")}\n`);
  assert.match(attempt().stderr, /key_file cannot be read: ENOENT/u);
  const keyPath = join(work.directory, "profile-key.pem");
  write(`[P]\nuser=${USER}\nfingerprint=00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff\ntenancy=${TENANCY}\nregion=us-chicago-1\nkey_file=${keyPath}\n`);
  const mismatch = attempt();
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /does not match the private key/u);
  assert.equal(mismatch.stdout, "", "nothing is written to stdout on failure");
  assert.ok(!mismatch.stderr.includes("PRIVATE KEY") && !mismatch.stderr.includes(TENANCY));
  assert.equal(exportProfile([], { stdout: capture(), stderr: capture() }), 2);
});
