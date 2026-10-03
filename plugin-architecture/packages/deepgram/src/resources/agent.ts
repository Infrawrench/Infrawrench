import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A stored Voice Agent configuration: an `agent` block saved once and
 * referenced by `agent_id` from a Settings message. The block itself is
 * immutable; only its metadata labels can change.
 *
 * Docs: https://developers.deepgram.com/reference/voice-agent/agent-configurations/create-agent-configuration
 */
export const AgentConfigResourceType = rt({
  name: "Agent Configuration",
  id: "agent-config",
  description:
    "A saved Deepgram Voice Agent configuration (listen, think and speak providers, prompt and greeting) that sessions reference by id instead of sending the whole agent block.",
  fields: [
    f("labels", "Labels", {
      required: false,
      description: "Metadata as comma-separated key=value pairs. The only editable part.",
    }),
    f("agentId", "Agent ID", { required: false, editable: false }),
    f("listen", "Listen", { required: false, editable: false }),
    f("think", "Think", { required: false, editable: false }),
    f("speak", "Speak", { required: false, editable: false }),
    f("greeting", "Greeting", { required: false, editable: false }),
    f("prompt", "Prompt", { required: false, editable: false }),
    f("functionCount", "Functions", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("agentId", "Agent ID", {
      description: "Pass as `agent` in a Voice Agent Settings message to reuse this configuration.",
    }),
  ],
  parentTypeId: "project",
  showInSidebar: true,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "voice",
});

/**
 * A `DG_<NAME>` template variable substituted into agent configurations when a
 * session starts. The value can be any JSON.
 *
 * Docs: https://developers.deepgram.com/reference/voice-agent/agent-variables/create-agent-variable
 */
export const AgentVariableResourceType = rt({
  name: "Agent Variable",
  id: "agent-variable",
  description:
    "A DG_-prefixed template variable that Deepgram substitutes into Voice Agent configurations, holding any JSON value.",
  fields: [
    f("value", "Value", {
      required: false,
      description:
        "Plain text, or any JSON value. Changing it affects sessions started afterwards.",
    }),
    f("key", "Name", { required: false, editable: false }),
    f("variableId", "Variable ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("variableId", "Variable ID"), o("key", "Name")],
  parentTypeId: "project",
  showInSidebar: true,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "sliders",
});

/**
 * A purchase order on the project: the credit grants behind its balances.
 * Read-only.
 *
 * Docs: https://developers.deepgram.com/reference/manage/billing/purchases/get
 */
export const PurchaseResourceType = rt({
  name: "Purchase",
  id: "purchase",
  description:
    "A purchase order on a Deepgram project (prepaid, promotional or otherwise), with its amount and expiry. Read-only.",
  fields: [
    f("amount", "Amount", { kind: "number", editable: false }),
    f("units", "Units", { required: false, editable: false }),
    f("orderType", "Order Type", { required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
    f("expiration", "Expires", { required: false, editable: false }),
    f("orderId", "Order ID", { required: false, editable: false }),
  ],
  outputs: [o("orderId", "Order ID"), o("amount", "Amount")],
  parentTypeId: "project",
  showInSidebar: true,
  supportsDelete: false,
  iconKey: "dashboard",
});

/**
 * Registry credentials for pulling Deepgram's self-hosted container images.
 * Only projects with self-hosted access have any.
 *
 * Docs: https://developers.deepgram.com/reference/self-hosted/distribution-credentials/list
 */
export const DistributionCredentialResourceType = rt({
  name: "Distribution Credential",
  id: "distribution-credential",
  description:
    "Container registry credentials for pulling Deepgram self-hosted images. Listed and revoked here; only projects with self-hosted access have any.",
  fields: [
    f("comment", "Comment", { required: false, editable: false }),
    f("provider", "Provider", { required: false, editable: false }),
    f("scopes", "Scopes", { required: false, editable: false }),
    f("memberEmail", "Created By", { required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
    f("credentialId", "Credential ID", { required: false, editable: false }),
  ],
  outputs: [o("credentialId", "Credential ID")],
  dependsOn: [
    { fieldKey: "memberEmail", targetTypeId: "member", targetKey: "email", label: "created by" },
  ],
  parentTypeId: "project",
  showInSidebar: true,
  iconKey: "key",
});
