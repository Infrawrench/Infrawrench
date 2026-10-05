/**
 * Remediation commands on savings findings: the wire types (re-exported
 * type-only from plugin-base, where plugins produce them) plus the pure
 * renderers the surfaces share: the Remediate panel's ordering and its
 * "copy all" script, and the section that goes into Jira/Linear issue bodies.
 *
 * Kept free of runtime plugin-base imports for the same reason as
 * `orphans.ts`: mobile imports this barrel.
 */
import type {
  FindingRemediation,
  RemediationCommand,
  RemediationTool,
} from "@infrawrench/plugin-base";

export type {
  FindingRemediation,
  IacAttributeChange,
  IacRemediationHint,
  RemediationCommand,
  RemediationCommitment,
  RemediationFinding,
  RemediationFindingKind,
  RemediationPlaceholder,
  RemediationResource,
  RemediationTool,
} from "@infrawrench/plugin-base";

/** Display names for the well-known tools; anything else renders as-is. */
const TOOL_LABELS: Record<string, string> = {
  "aws-cli": "AWS CLI",
  gcloud: "gcloud",
  az: "Azure CLI",
  doctl: "doctl",
  hcloud: "hcloud",
  scw: "Scaleway CLI",
  "linode-cli": "Linode CLI",
  oci: "OCI CLI",
  kubectl: "kubectl",
  terraform: "Terraform",
  confluent: "Confluent CLI",
  atlas: "Atlas CLI",
  gh: "GitHub CLI",
  twilio: "Twilio CLI",
  "snowflake-sql": "Snowflake SQL",
  anyscale: "Anyscale CLI",
  curl: "curl",
};

/** Human label for a tool id. */
export function remediationToolLabel(tool: RemediationTool): string {
  return TOOL_LABELS[tool] ?? tool;
}

/** True when there is anything to show: plugin commands or a Terraform hint. */
export function hasRemediation(remediation: FindingRemediation | null | undefined): boolean {
  return Boolean(
    remediation && (remediation.commands.length > 0 || (remediation.iac?.commands.length ?? 0) > 0),
  );
}

/**
 * The commands in the order a reader should consider them: the Terraform hint
 * first when the resource is IaC-managed (a CLI change would be reverted by
 * the next apply), then the plugin's commands in the order it wrote them,
 * which is the order they must run in.
 */
export function orderedRemediationCommands(
  remediation: FindingRemediation | null | undefined,
): RemediationCommand[] {
  if (!remediation) return [];
  return [...(remediation.iac?.commands ?? []), ...remediation.commands];
}

/**
 * The commands as bare lines, in {@link orderedRemediationCommands} order, for
 * a GitHub issue's `remediation` (which renders them as one shell block under
 * "Review before running"). Capped to what that route accepts: 20 commands of
 * at most 2,000 characters; a longer command is dropped rather than cut, since
 * half a command is worse than none.
 */
export function remediationCommandLines(
  remediation: FindingRemediation | null | undefined,
): string[] {
  return orderedRemediationCommands(remediation)
    .map((c) => c.command)
    .filter((c) => c.trim().length > 0 && c.length <= 2_000)
    .slice(0, 20);
}

/** Every command as one copyable shell script, comments included. */
export function remediationScript(remediation: FindingRemediation | null | undefined): string {
  if (!remediation) return "";
  const lines: string[] = [];
  for (const p of remediation.placeholders) {
    lines.push(`# export ${p.name}=...   # ${p.description}`);
  }
  if (remediation.iac) {
    lines.push(
      `# Managed by Terraform at ${remediation.iac.address}: change the configuration rather than running the CLI commands below.`,
    );
  }
  for (const c of orderedRemediationCommands(remediation)) {
    lines.push(`# ${c.destructive ? "[DESTRUCTIVE] " : ""}${c.description}`);
    lines.push(c.command);
  }
  return lines.join("\n");
}

/**
 * The remediation section of a Jira/Linear issue body. Tracker-neutral on
 * purpose: plain paragraphs (blank-line separated) plus a fenced block per
 * command. Linear renders the fences as markdown code blocks and the Jira
 * converter (`toAdf`, server-core) turns each fence into an ADF `codeBlock`,
 * so the command survives as one copyable unit in both. No other markdown
 * (headings, bold, inline code), which Jira would print literally.
 *
 * Empty string when there is nothing to say, so callers can append it
 * unconditionally.
 */
export function remediationIssueText(remediation: FindingRemediation | null | undefined): string {
  if (!hasRemediation(remediation) || !remediation) return "";
  const blocks: string[] = ["Remediation"];
  if (remediation.iac) {
    const lines = [
      `Managed by Terraform at ${remediation.iac.address}${
        remediation.iac.stateLabel ? ` (state: ${remediation.iac.stateLabel})` : ""
      }. Change the configuration instead of running the CLI commands, or the next apply reverts them.`,
    ];
    for (const change of remediation.iac.attributeChanges) {
      lines.push(
        `- ${change.attribute}: ${change.from ?? "(unset)"} -> ${change.to ?? "(remove)"}`,
      );
    }
    blocks.push(lines.join("\n"));
  }
  if (remediation.placeholders.length > 0) {
    blocks.push(
      ["Set first:", ...remediation.placeholders.map((p) => `- ${p.name}: ${p.description}`)].join(
        "\n",
      ),
    );
  }
  orderedRemediationCommands(remediation).forEach((c, i) => {
    blocks.push(
      `${i + 1}. ${c.destructive ? "Destructive: " : ""}${c.description} (${remediationToolLabel(c.tool)})`,
    );
    blocks.push(["```sh", c.command, "```"].join("\n"));
  });
  return blocks.join("\n\n");
}
