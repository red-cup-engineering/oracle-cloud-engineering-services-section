// The plan for one Always Free fleet node: pure functions from what discovery found to the exact calls to make.
//
// A step is {name, action, ...}. `reuse` steps carry what already exists; `create` and `update` steps carry
// the call (service, method, path, body). Ids that only exist after an earlier step are written {{step.field}}
// and filled in when the plan is applied, so the printed plan and the executed calls are the same data.
import { createHash } from "node:crypto";
import { ALWAYS_FREE } from "./always-free.mjs";
import { GROUP_TAG, NETWORK_ROLE, NODE_ROLE } from "./oci-tenancy.mjs";

export const NETWORK_NAME = "561-group-always-free";
const VCN_CIDR = "10.61.0.0/16";
const SUBNET_CIDR = "10.61.1.0/24";
const EVERYWHERE = "0.0.0.0/0";

const networkTags = Object.freeze({ group: GROUP_TAG, role: NETWORK_ROLE });
const pick = (object, names) => Object.fromEntries(names.filter((name) => object[name] !== undefined).map((name) => [name, object[name]]));
const summary = (object) => pick(object, ["id", "displayName", "lifecycleState", "defaultRouteTableId", "cidrBlock", "isEnabled"]);
const reuse = (name, object) => ({ name, action: "reuse", existing: summary(object), object });
const create = (name, service, path, body) => ({ name, action: "create", service, method: "POST", path, body });

function routeStep(found) {
  const gatewayId = found.internetGateway?.id ?? "{{internet-gateway.id}}";
  const rules = found.routeTable?.routeRules ?? [];
  const covered = rules.some((rule) => rule.destination === EVERYWHERE && rule.networkEntityId === gatewayId);
  if (covered) return { name: "route-rule", action: "reuse", existing: { id: found.routeTable.id }, object: found.routeTable };
  return {
    name: "route-rule", action: "update", service: "iaas", method: "PUT", path: `/20160918/routeTables/${found.routeTable?.id ?? "{{vcn.defaultRouteTableId}}"}`,
    body: { routeRules: [...rules, { destination: EVERYWHERE, destinationType: "CIDR_BLOCK", networkEntityId: gatewayId, description: "Outbound to the internet" }] },
  };
}

/** The network a node needs: a VCN with an internet gateway and a default route, a security list with all egress and no ingress (or SSH from one CIDR), and one regional subnet. */
export function networkSteps({ found, compartmentId, sshCidr }) {
  const base = { compartmentId, freeformTags: networkTags };
  const vcnRef = found.vcn?.id ?? "{{vcn.id}}";
  const securityRules = {
    egressSecurityRules: [{ destination: EVERYWHERE, destinationType: "CIDR_BLOCK", protocol: "all", isStateless: false }],
    ingressSecurityRules: sshCidr
      ? [{ source: sshCidr, sourceType: "CIDR_BLOCK", protocol: "6", isStateless: false, tcpOptions: { destinationPortRange: { min: 22, max: 22 } } }]
      : [],
  };
  return [
    found.vcn ? reuse("vcn", found.vcn) : create("vcn", "iaas", "/20160918/vcns", { ...base, cidrBlocks: [VCN_CIDR], displayName: `${NETWORK_NAME}-vcn` }),
    found.internetGateway
      ? reuse("internet-gateway", found.internetGateway)
      : create("internet-gateway", "iaas", "/20160918/internetGateways", { ...base, vcnId: vcnRef, isEnabled: true, displayName: `${NETWORK_NAME}-gateway` }),
    routeStep(found),
    found.securityList
      ? reuse("security-list", found.securityList)
      : create("security-list", "iaas", "/20160918/securityLists", { ...base, vcnId: vcnRef, displayName: `${NETWORK_NAME}-egress-only`, ...securityRules }),
    found.subnet
      ? reuse("subnet", found.subnet)
      : create("subnet", "iaas", "/20160918/subnets", {
        ...base, vcnId: vcnRef, cidrBlock: SUBNET_CIDR, displayName: `${NETWORK_NAME}-subnet`,
        routeTableId: found.vcn?.defaultRouteTableId ?? "{{vcn.defaultRouteTableId}}",
        securityListIds: [found.securityList?.id ?? "{{security-list.id}}"], prohibitPublicIpOnVnic: false,
      }),
  ];
}

/** The launch of the one node. Every size in it has passed admitAlwaysFreeRequest; the VPU setting is the free default, written out. */
export function launchStep({ compartmentId, nodeId, shape, ocpus, memoryGb, bootVolumeGb, imageId, sshPublicKey }) {
  return {
    name: "launch-instance", action: "create", service: "iaas", method: "POST", path: "/20160918/instances",
    body: {
      availabilityDomain: "{{availabilityDomain}}",
      compartmentId,
      displayName: nodeId,
      shape,
      // A fixed shape (E2.1.Micro) takes no shapeConfig; only the flexible A1 shape does.
      ...(ocpus === undefined ? {} : { shapeConfig: { ocpus, memoryInGBs: memoryGb } }),
      sourceDetails: { sourceType: "image", imageId, bootVolumeSizeInGBs: bootVolumeGb, bootVolumeVpusPerGB: ALWAYS_FREE.storage.vpusPerGb },
      createVnicDetails: { subnetId: "{{subnet.id}}", assignPublicIp: true, displayName: `${nodeId}-vnic` },
      metadata: { user_data: "{{user-data}}", ...(sshPublicKey ? { ssh_authorized_keys: sshPublicKey } : {}) },
      freeformTags: { group: GROUP_TAG, role: NODE_ROLE, node: nodeId },
    },
  };
}

/** Oracle replays a launch carrying the same token for 24 hours, so two runs at once cannot make two nodes. */
export const retryTokenOf = ({ tenancy, compartmentId, nodeId, availabilityDomain }) =>
  createHash("sha256").update([tenancy, compartmentId, nodeId, availabilityDomain].join("|")).digest("hex").slice(0, 48);

/** Fill {{name}} and {{name.field}} from the results of earlier steps (a bare name means its id). */
export function resolveTemplate(value, scope) {
  if (typeof value === "string") {
    return value.replace(/\{\{([a-zA-Z0-9-]+)(?:\.([a-zA-Z]+))?\}\}/gu, (token, name, field) => {
      const found = scope[name];
      const filled = typeof found === "string" ? found : found?.[field ?? "id"];
      if (typeof filled !== "string") throw new Error(`plan refers to ${token}, which no earlier step produced`);
      return filled;
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplate(item, scope));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplate(item, scope)]));
  return value;
}

/** A plan as plain data for printing: the objects `reuse` steps carry for the apply stage are left out. */
export const printable = (steps) => steps.map(({ object, ...step }) => step);
