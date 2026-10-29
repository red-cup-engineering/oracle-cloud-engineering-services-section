# @red-cup-engineering/oracle-cloud-engineering-services-section

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Oracle Cloud Infrastructure for the 561 Group, on the Node standard library alone (no install, no dependency).

- `scripts/provision-always-free-node.mjs` gives the fleet an always-on node in a second failure domain, joined to
  the fleet by `@red-cup-engineering/node-job-service`. Idempotent; `--dry-run` prints the exact calls.
- `scripts/apply-always-free-quotas.mjs` applies resource quota policies and a budget alert at $0.01.
  These are separate controls; they do not establish a complete zero-cost billing boundary.
- `scripts/export-oci-profile.mjs` moves the existing OCI CLI profile into the credential store, once.

## What is already true

The account/profile and capacity statements in this section are retained source observations, not a fresh
authenticated reading. Read the current account tier, permissions, existing resources, eligible shapes and
remaining allowance before selecting a real operation. A held key or successful dry run does not prove them.

The tenancy exists (tenancy `emsenn`, home region `us-chicago-1`, CLI profile `BLUE_CORN_CREEK`, API key made
2026-09-26). **There is no signup.** No instance has ever been created (house record
`services/internal-services-section/data/records/listing-records/2026-10-25-oracle-cloud-attempts-consolidated.json`).
The Leader reports that Chicago has no Ampere A1 host capacity, and Always Free compute exists only in the home
region, which cannot change. So the default node is the **AMD micro VM** (`VM.Standard.E2.1.Micro`: 1 GB, 1/8 OCPU
burstable, two free), which can launch now. A1 is launched only if you ask (`--shape VM.Standard.A1.Flex`), and
"out of host capacity" is a reported refusal, never a wait or a retry.

## The envelope

`src/always-free.mjs` holds Oracle's Always Free amounts as data, with the page they come from
(<https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm>, read 2026-10-27):

| Resource | Always Free |
| --- | --- |
| Ampere A1 (`VM.Standard.A1.Flex`) | 1,500 OCPU-hours and 9,000 GB-hours a month: **2 OCPU / 12 GB** in total, as one VM or two of 1 OCPU |
| AMD micro (`VM.Standard.E2.1.Micro`) | two VMs, 1 GB and 1/8 OCPU each |
| Block storage | 200 GB in total, boot volumes included (a boot volume is at least 47 GB), 5 backups |
| Outbound data | 10 TB a month |
| Region | home region only |
| Idle reclamation | an instance idle for 7 days may be reclaimed (see below) |

An earlier figure of 4 OCPU / 24 GB is **not** what Oracle's page says now; this package refuses it.
`admitAlwaysFreeRequest` refuses any shape, size or count outside the envelope, counting what the tenancy already
runs, and every launch the provisioner builds passes through it first. Nothing in the package can express a paid
shape, a NAT gateway, a load balancer or a reserved IP; the public address is the free ephemeral one.

## Morning, in order

All paths are from `/home/emsenn/bare-cedar-fog`. `CRED=services/internal-services-section/services/internal-credential-services-section`.

### 1. Move the existing credential into custody

The credential store takes one value on stdin. This package reads it as one JSON object:

```json
{"tenancy": "ocid1.tenancy...", "user": "ocid1.user...", "fingerprint": "aa:bb:...:ff",
 "region": "us-chicago-1", "privateKey": "-----BEGIN PRIVATE KEY-----\n...", "passphrase": "(only if the key is encrypted)"}
```

(The OCI console's config snippet with the downloaded PEM appended to it is read too.) Build it from the profile
and put it in the store in one pipe, so no plaintext copy is ever written:

```sh
node services/engineering-services-section/services/oracle-cloud-engineering-services-section/scripts/export-oci-profile.mjs \
  --config ~/.oci/config --profile BLUE_CORN_CREEK \
  | $CRED/bin/credentials put compute.oracle-always-free --holders bare-cedar-fog
```

The export checks the fingerprint against the key and refuses a mismatch, naming the field and never a value.
After this, nothing reads `~/.oci`: every command below takes the credential from the store.

### 2. Write the node's provisioning file

Outside any repository, mode 600, one per node (the node id is its fleet id and its identity here):

```
NODE_JOB_NODE_ID=oracle-free-1
NODE_JOB_STORE_URL=https://<the fleet store, as the other nodes use it>.git
NODE_JOB_STORE_USER=<git user for the store>
NODE_JOB_STORE_TOKEN=<a token scoped to the fleet store alone>
```

The file travels in the instance's `user_data`, which Oracle keeps as instance metadata: the tenancy's administrators
and the instance itself can read it. Use a token that can do nothing but the fleet store. The URL may not contain
credentials. Only these four keys are carried.

### 3. Review tenancy quota policies under explicit account-wide authority

The current Group authorization is card verification and free access with a $0 cash limit. Before an apply,
qualify the exact quota changes and their effect on every existing workload in the tenancy. Do not apply a
tenancy-wide zero policy to a contributor's unrelated resources merely because it was generated for this node.

```sh
CREDS="$CRED/bin/credentials get compute.oracle-always-free"
Q=services/engineering-services-section/services/oracle-cloud-engineering-services-section/scripts/apply-always-free-quotas.mjs
$CREDS | node $Q --credentials /dev/stdin --alert-email <your address> --dry-run     # read the statements
$CREDS | node $Q --credentials /dev/stdin --alert-email <your address>               # write them
```

This writes quota policies in the tenancy: compute, block storage and VCN families at exactly the Always Free
amounts (stated in one availability domain, because Oracle's compute and storage quotas are per domain, so every
other domain stays at zero), every other family the Limits service lists at zero, and a $1 budget with an alert at
1% of it, $0.01. Provider acceptance/readback and complete cost qualification are separate obligations.
They do not cap outbound data (10 TB free) or anything Oracle has no quota for. Oracle describes
[budgets as soft spending limits](https://docs.oracle.com/en-us/iaas/Content/Billing/Concepts/budgetsoverview.htm),
with periodic alerts; the $0.01 alert is detection after exposure, not a $0 spending cap. A family Oracle's quota language does not know is
reported in `failed` while the rest still apply; the allowance is written first, and if it is refused nothing else is.

**An account upgrade is outside the current Group authorization.** Keep the existing account state and verify its
actual provider-enforced restrictions. Free resource shapes and compartment quotas cannot by themselves prove that
an upgraded account, all usage dimensions and all attached services will cost $0. The provisioner does not consume
a quota-application receipt or a complete billing-admission proof before launching. Those are unresolved integration
obligations in the contributed cloud compute project, not guarantees supplied by the commands above. Out-of-capacity
remains a refusal; an upgrade does not establish available A1 capacity.

### 4. Dry run, then the real run

The real run is held until the current account, permissions, complete cost envelope and installed fleet consumer
are independently qualified. The commands are the existing supplier interface, not evidence that those gates passed.

```sh
P=services/engineering-services-section/services/oracle-cloud-engineering-services-section/scripts/provision-always-free-node.mjs
$CREDS | node $P --credentials /dev/stdin --provision ~/path/to/provision-oracle-free-1.env --dry-run
$CREDS | node $P --credentials /dev/stdin --provision ~/path/to/provision-oracle-free-1.env
```

The dry run reads from Oracle (the client refuses anything but GET) and prints the home region, the availability
domain that offers the shape, the compartment, the image, the usage so far against the envelope, every call it
would make in order with its body, and the cloud-init with every credential withheld. The real run makes those
calls once each and stops at the launch:

| Result | Exit | Meaning |
| --- | --- | --- |
| `launched` / `reused` / `dry-run` | 0 | `reused`: a node tagged for the 561 Group with this node id exists, nothing was made |
| `refused-envelope` | 3 | the request is outside the Always Free envelope; nothing was called |
| `refused-capacity` | 4 | Oracle has no host (`OUT_OF_CAPACITY`) or a limit is hit (`LIMIT_EXCEEDED`); nothing was retried |
| error | 1 | Oracle's code, message and `opc-request-id` are printed; the same command resumes |

A launch returns while the instance is still provisioning. Run the same command again to read its state and
public address; it finds the node and changes nothing. A second micro node is the same command with a provisioning
file whose `NODE_JOB_NODE_ID` differs (`oracle-free-2`); a third is refused. For A1, add `--shape VM.Standard.A1.Flex`
(it defaults to the whole 2 OCPU / 12 GB; `--ocpus` and `--memory-gb` take less). `--ssh-public-key <file>` adds a
key to the instance, and `--ssh-cidr <cidr>` opens port 22 to that address alone; with neither, the node is
egress-only and administered through the fleet.

### What the node does when it boots

cloud-init writes `scripts/install-linux-node.sh` and the provisioning file, and runs the installer, which mirrors
node-job-service's Termux installer: Node and git from the distro (Oracle Linux 9, the `nodejs:22` stream), a `fleet`
user whose systemd user manager runs from boot, `@red-cup-engineering/node-job-service` from
`https://registry.561.group`, a clone of the fleet store, and `node-job-fleet-join` with the capability tags
`failure-domain:oracle-free-tier`, `power:mains`, `network:always-on` and `arch:<detected>`. The package reads
the machine's real cores and memory into its fleet offer, which it publishes when it changes. The pin is `0.5.0`,
the release carrying failure domains, singleton leases and phone nodes; raise it in the
installer with each fleet release.

### The node must do real work

Oracle may reclaim an Always Free instance that stays idle for 7 days: CPU 95th percentile under 20%, network under
20% and, on A1, memory under 20%. A fleet worker that is only waiting does exactly that. Give the node jobs that use
it, or expect to launch it again.

## Not proven by the tests

The tests run the real code against an in-process fake OCI that verifies every signature with the public key and
checks required query parameters. It cannot prove that Oracle accepts these request bodies and statements, nor
the installer running on a real Oracle Linux image. See the report that accompanied this package for the list.

## Tests

`npm test` (`node --test test/*.test.mjs`) needs no network and no installed package.
