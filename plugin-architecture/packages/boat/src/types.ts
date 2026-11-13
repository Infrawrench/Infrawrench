import type { components } from "./api-types.gen.js";

/**
 * boat's API payloads by the names this plugin reads them under, from the
 * published document (`plugingen.json`). The document marks more required than
 * the plugin relies on, so readers keep their `?.` and `??`.
 */

type Schemas = components["schemas"];

export type BSandbox = Schemas["Sandbox"];
export type BSandboxType = NonNullable<BSandbox["type"]>;
export type BLimits = Schemas["LimitsResponse"];
export type BSavedSnapshot = Schemas["SavedSnapshot"];
export type BSavedSnapshotAllowance = Schemas["SavedSnapshotAllowance"];
export type BEnvironment = Schemas["SandboxEnvironment"];
export type BWebhook = Schemas["Webhook"];
export type BWebhookEvent = Schemas["WebhookEventType"];
export type BApiKey = Schemas["ApiKey"];
export type BOrg = Schemas["Org"];
export type BPromptProvider = Schemas["PromptRequest"]["provider"];
