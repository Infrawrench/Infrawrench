import {
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `fly` (flyctl) commands for savings findings. flyctl reads its
 * token from its own login (`fly auth login`), so no placeholders are needed.
 *
 * References:
 * https://docs.fly.io/flyctl/machine-stop
 * https://docs.fly.io/flyctl/machine-start
 */
export function flyRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== "machine") return [];
  // externalId is `<app>/<machine id>`.
  const externalId = remediationId(resource);
  const slash = externalId.indexOf("/");
  const app =
    remediationField(resource, "appName") || (slash > 0 ? externalId.slice(0, slash) : "");
  const machine = slash >= 0 ? externalId.slice(slash + 1) : externalId;
  if (!app || !machine) return [];
  const args = `${shellQuote(machine)} --app ${shellQuote(app)}`;
  return [
    {
      tool: "fly",
      command: `fly machine stop ${args}`,
      description:
        "Stop the Machine; compute billing stops while its root filesystem storage keeps billing.",
      destructive: false,
    },
    {
      tool: "fly",
      command: `fly machine start ${args}`,
      description: "Start the Machine again (this also resumes a suspended Machine).",
      destructive: false,
    },
  ];
}
