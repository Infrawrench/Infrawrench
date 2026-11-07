import type { components } from "./api-types.gen.js";

/**
 * Crusoe's API payloads by the names this plugin reads them under, from the
 * published document (`plugingen.json`). The document marks far more required
 * than the plugin has ever relied on, so readers keep their `?.` and `??`.
 */

type Schemas = components["schemas"];

export type CrusoeEntity = Schemas["Entity"];
export type CrusoeProject = Schemas["Project"];
export type CrusoeOperation = Schemas["Operation"];
export type CrusoeAsyncResponse = Schemas["AsyncOperationResponse"];
export type CrusoeVm = Schemas["InstanceV1"];
export type CrusoeVmType = Schemas["Type"];
export type CrusoeImage = Schemas["Image"];
export type CrusoeDisk = Schemas["DiskV1"];
export type CrusoeSnapshot = Schemas["DiskSnapshot"];
export type CrusoeVpcNetwork = Schemas["VPCNetwork"];
export type CrusoeVpcSubnet = Schemas["VPCSubnet"];
export type CrusoeFirewallTarget = Schemas["FirewallRuleObject"];
export type CrusoeFirewallRule = Schemas["VPCFirewallRule"];
export type CrusoeSshKey = Schemas["SSHKey"];
export type CrusoeCluster = Schemas["KubernetesCluster"];
export type CrusoeNodePool = Schemas["KubernetesNodePool"];
export type CrusoeLoadBalancer = Schemas["ExternalLoadBalancer"];
export type CrusoeReservation = Schemas["Reservation"];
export type CrusoeBillingCost = Schemas["BillingCostDatum"];

/** The document has no `category`; the quota list has always looked for one. */
export type CrusoeQuota = Schemas["OrgQuota"] & { category?: string };
