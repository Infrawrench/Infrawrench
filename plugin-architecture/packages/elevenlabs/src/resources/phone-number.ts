import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A phone number imported into ElevenAgents (Twilio, SIP trunk or Exotel)
 * and optionally assigned to an agent. Listed from
 * `GET /v1/convai/phone-numbers`; the label is editable via `PATCH`.
 * https://elevenlabs.io/docs/api-reference/phone-numbers/list
 * https://elevenlabs.io/docs/api-reference/phone-numbers/update
 */
export const PhoneNumberResourceType = rt({
  name: "Phone Number",
  id: "phone-number",
  description: "A phone number connected to ElevenAgents for inbound and outbound calls",
  fields: [
    f("phoneNumber", "Number", { editable: false }),
    f("label", "Label", { required: false }),
    f("phoneNumberId", "Phone Number ID", { required: false, editable: false }),
    f("provider", "Provider", { required: false, editable: false }),
    f("agentId", "Agent ID", { required: false, editable: false }),
    f("agentName", "Agent", { required: false, editable: false }),
  ],
  outputs: [o("phoneNumber", "Phone Number"), o("phoneNumberId", "Phone Number ID")],
  dependsOn: [{ fieldKey: "agentId", targetTypeId: "agent", label: "answered by" }],
  iconKey: "phone",
  supportsUpdate: true,
});
