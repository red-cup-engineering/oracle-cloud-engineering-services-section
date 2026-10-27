// Everything the provisioner learns from Oracle before it changes anything. Every call here is a GET.
import { ALWAYS_FREE, alwaysFreeUsageOf } from "./always-free.mjs";

export const GROUP_TAG = "561-group";
export const NODE_ROLE = "always-free-fleet-node";
export const NETWORK_ROLE = "always-free-fleet-network";

const isLive = (item) => item.lifecycleState !== "TERMINATED" && item.lifecycleState !== "TERMINATING";
const tagged = (item, role) => item.freeformTags?.group === GROUP_TAG && item.freeformTags?.role === role;

export class ProvisionRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProvisionRefusal";
    this.code = code;
  }
}

export const OPERATING_SYSTEMS = Object.freeze({
  "oracle-linux": Object.freeze({ operatingSystem: "Oracle Linux", defaultVersion: "9" }),
  ubuntu: Object.freeze({ operatingSystem: "Canonical Ubuntu", defaultVersion: "24.04" }),
});

const ARM = /aarch64|arm64/iu;

/** The newest platform image for the shape's architecture ("arm" or "x86"): not a GPU, minimal or hardened variant. */
export function chooseImage(images, architecture) {
  return images
    .filter((image) => ARM.test(image.displayName ?? "") === (architecture === "arm") && !/gpu|minimal|hardened|stig|(?:^|[-_ ])cis(?:[-_ ]|$)/iu.test(image.displayName ?? ""))
    .sort((a, b) => String(b.timeCreated).localeCompare(String(a.timeCreated)))[0];
}

/** The tenancy's home region. Always Free compute exists only there, whatever region the API key names. */
export async function homeRegionOf(client, credentials) {
  const subscriptions = await client.list("identity", credentials.region, `/20160918/tenancies/${credentials.tenancy}/regionSubscriptions`);
  const home = subscriptions.find((subscription) => subscription.isHomeRegion);
  if (!home) throw new ProvisionRefusal("NO_HOME_REGION", "the tenancy reports no home region");
  if (home.status !== "READY") throw new ProvisionRefusal("HOME_REGION_NOT_READY", `the home region ${home.regionName} is ${home.status}, not READY`);
  return home.regionName;
}

/** The first availability domain that offers `shape` (E2.1.Micro is offered in only one), or the one the operator named if it does. */
export async function availabilityDomainOffering({ client, region, compartmentId, availabilityDomains, shape, named }) {
  const candidates = named ? [named] : availabilityDomains;
  if (named && !availabilityDomains.includes(named)) {
    throw new ProvisionRefusal("AVAILABILITY_DOMAIN_NOT_FOUND", `--availability-domain is not one of: ${availabilityDomains.join(", ")}`);
  }
  for (const availabilityDomain of candidates) {
    const shapes = await client.list("iaas", region, "/20160918/shapes", { compartmentId, availabilityDomain });
    if (shapes.some((offered) => offered.shape === shape)) return availabilityDomain;
  }
  return null;
}

async function compartmentsOf(client, credentials, region, { compartmentId, compartmentName }) {
  const all = await client.list("identity", region, "/20160918/compartments", {
    compartmentId: credentials.tenancy, compartmentIdInSubtree: true, accessLevel: "ACCESSIBLE", lifecycleState: "ACTIVE",
  });
  let chosen;
  if (compartmentId) {
    if (compartmentId !== credentials.tenancy && !all.some((compartment) => compartment.id === compartmentId)) {
      throw new ProvisionRefusal("COMPARTMENT_NOT_FOUND", "the compartment named by --compartment is not an active compartment of this tenancy");
    }
    chosen = { id: compartmentId, source: "--compartment" };
  } else {
    const named = all.find((compartment) => compartment.compartmentId === credentials.tenancy && compartment.name === compartmentName);
    chosen = named ? { id: named.id, name: named.name, source: "named compartment" } : { id: credentials.tenancy, name: "(tenancy root)", source: "tenancy root" };
  }
  return { chosen, scanned: [credentials.tenancy, ...all.map((compartment) => compartment.id)] };
}

async function usageOf(client, region, scanned, availabilityDomains) {
  const instances = [], bootVolumes = [], volumes = [];
  for (const compartmentId of scanned) {
    instances.push(...await client.list("iaas", region, "/20160918/instances", { compartmentId }));
    volumes.push(...await client.list("iaas", region, "/20160918/volumes", { compartmentId }));
    for (const availabilityDomain of availabilityDomains) {
      bootVolumes.push(...await client.list("iaas", region, "/20160918/bootVolumes", { compartmentId, availabilityDomain }));
    }
  }
  return { instances, usage: alwaysFreeUsageOf({ instances, bootVolumes, volumes }) };
}

async function networkOf(client, region, compartmentId) {
  const vcn = (await client.list("iaas", region, "/20160918/vcns", { compartmentId })).find((item) => isLive(item) && tagged(item, NETWORK_ROLE));
  if (!vcn) return {};
  const inVcn = { compartmentId, vcnId: vcn.id };
  const [gateways, securityLists, subnets, routeTable] = await Promise.all([
    client.list("iaas", region, "/20160918/internetGateways", inVcn),
    client.list("iaas", region, "/20160918/securityLists", inVcn),
    client.list("iaas", region, "/20160918/subnets", inVcn),
    client.get("iaas", region, `/20160918/routeTables/${vcn.defaultRouteTableId}`),
  ]);
  return {
    vcn,
    internetGateway: gateways.find((item) => isLive(item) && tagged(item, NETWORK_ROLE)),
    securityList: securityLists.find((item) => isLive(item) && tagged(item, NETWORK_ROLE)),
    subnet: subnets.find((item) => isLive(item) && tagged(item, NETWORK_ROLE)),
    routeTable,
  };
}

async function addressesOf(client, region, instance) {
  const attachments = await client.list("iaas", region, "/20160918/vnicAttachments", { compartmentId: instance.compartmentId, instanceId: instance.id });
  const attached = attachments.find((attachment) => attachment.lifecycleState === "ATTACHED");
  if (!attached) return { publicIp: null, privateIp: null };
  const vnic = await client.get("iaas", region, `/20160918/vnics/${attached.vnicId}`);
  return { publicIp: vnic.publicIp ?? null, privateIp: vnic.privateIp ?? null };
}

/**
 * Read the tenancy: home region, availability domains, the compartment to use, what the envelope already
 * holds, this node if the Group already launched it, and (only when it has not) the image, availability
 * domain and network to use.
 */
export async function discoverTenancy({ client, credentials, options, shape, nodeId }) {
  const region = await homeRegionOf(client, credentials);
  const availabilityDomains = (await client.list("identity", region, "/20160918/availabilityDomains", { compartmentId: credentials.tenancy })).map((domain) => domain.name);
  if (availabilityDomains.length === 0) throw new ProvisionRefusal("NO_AVAILABILITY_DOMAIN", "the home region lists no availability domain");
  const { chosen: compartment, scanned } = await compartmentsOf(client, credentials, region, options);
  const { instances, usage } = await usageOf(client, region, scanned, availabilityDomains);

  const nodes = instances.filter((instance) => isLive(instance) && tagged(instance, NODE_ROLE) && instance.freeformTags.node === nodeId);
  if (nodes.length > 0) {
    const [existing, ...others] = nodes;
    return { region, availabilityDomains, compartment, usage, existing: { instance: existing, ...await addressesOf(client, region, existing), alsoTagged: others.map((instance) => instance.id) } };
  }

  const availabilityDomain = await availabilityDomainOffering({ client, region, compartmentId: compartment.id, availabilityDomains, shape, named: options.availabilityDomain });
  if (availabilityDomain === null) {
    throw new ProvisionRefusal("SHAPE_NOT_OFFERED", `${shape} is offered in none of the home region's availability domains for this tenancy`);
  }
  const family = OPERATING_SYSTEMS[options.os];
  const images = await client.list("iaas", region, "/20160918/images", {
    compartmentId: credentials.tenancy,
    operatingSystem: family.operatingSystem,
    operatingSystemVersion: options.osVersion ?? family.defaultVersion,
    shape,
    lifecycleState: "AVAILABLE",
    sortBy: "TIMECREATED",
    sortOrder: "DESC",
  });
  const image = chooseImage(images, shape === ALWAYS_FREE.ampereA1.shape ? "arm" : "x86");
  if (!image) {
    throw new ProvisionRefusal("NO_IMAGE", `no ${family.operatingSystem} ${options.osVersion ?? family.defaultVersion} image is offered for ${shape} in ${region}`);
  }
  return { region, availabilityDomains, availabilityDomain, compartment, usage, image, network: await networkOf(client, region, compartment.id) };
}
