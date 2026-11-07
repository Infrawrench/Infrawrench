import type { components } from "./api-types.gen.js";

/**
 * Lambda Cloud's API payloads by the names this plugin reads them under, from
 * the published document (`plugingen.json`). The document marks more required
 * than the plugin has ever relied on, so readers keep their `?.` and `??`.
 */

type Schemas = components["schemas"];

export type LRegion = Schemas["Region"];
export type LInstance = Schemas["Instance"];
export type LInstanceTypeItem = Schemas["InstanceTypesItem"];
export type LFilesystem = Schemas["Filesystem"];
export type LImage = Schemas["Image"];
export type LSshKey = Schemas["SSHKey"];
export type LFirewallRule = Schemas["FirewallRule"];
export type LFirewallRuleset = Schemas["FirewallRuleset"];

/** A regional ruleset or the global singleton, which has no region, date or instance list. */
export type LAnyFirewallRuleset = Pick<LFirewallRuleset, "id" | "name" | "rules"> &
  Partial<Pick<LFirewallRuleset, "region" | "created" | "instance_ids">>;
