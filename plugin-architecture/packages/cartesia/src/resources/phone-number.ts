import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A phone number routed to Cartesia agents: Cartesia-provisioned, imported
 * from Twilio, or on a SIP trunk. Listed from `GET /agents/phone-numbers`.
 * https://docs.cartesia.ai/api-reference/agents/phone-numbers/list
 */
export const PhoneNumberResourceType = rt({
  name: "Phone Number",
  id: "phone-number",
  description: "A phone number connected to a Cartesia agent for inbound and outbound calls",
  fields: [
    f("number", "Number"),
    f("label", "Label", { required: false }),
    f("phoneNumberId", "Phone Number ID", { required: false }),
    f("agentId", "Agent ID", { required: false }),
    f("agentName", "Agent", { required: false }),
    f("providerType", "Provider", { required: false }),
    f("providerLabel", "Provider Account", { required: false }),
    f("region", "Region", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("phoneNumber", "Phone Number"), o("phoneNumberId", "Phone Number ID")],
  dependsOn: [{ fieldKey: "agentId", targetTypeId: "agent", label: "answered by" }],
  iconKey: "phone",
  supportsDelete: false,
});
