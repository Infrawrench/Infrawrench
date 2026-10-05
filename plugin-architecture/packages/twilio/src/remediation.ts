import {
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `twilio` CLI commands for savings findings. The CLI reads its
 * credentials from its own profile (`twilio login`). Numbers owned by a
 * subaccount name it with `--account-sid`, which the main account's
 * credentials are allowed to act on.
 *
 * Reference: https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource
 */
export function twilioRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== "phone-number") return [];
  const sid = remediationId(resource);
  if (!/^PN[0-9a-fA-F]{32}$/.test(sid)) return [];
  const sub = remediationField(resource, "subaccountSid");
  const account = sub ? ` --account-sid ${shellQuote(sub)}` : "";
  const number = remediationField(resource, "phoneNumber") || sid;
  return [
    {
      tool: "twilio",
      command: `twilio api:core:incoming-phone-numbers:fetch --sid ${shellQuote(sid)}${account}`,
      description: "Confirm nothing is configured to answer the number.",
      destructive: false,
    },
    {
      tool: "twilio",
      command: `twilio api:core:incoming-phone-numbers:remove --sid ${shellQuote(sid)}${account}`,
      description: `Release ${number}; Twilio stops billing it, and the number may not be available to buy back.`,
      destructive: true,
    },
  ];
}
