import {
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Pinecone savings findings, written for the official `pc`
 * CLI. The only finding is a backup whose source index has been deleted; the
 * fix is deleting the backup. Restoring it into a new index first is the way
 * to keep its records, so the description says so rather than adding a
 * command that would create (and bill) a new index.
 *
 * Reference: https://docs.pinecone.io/reference/cli/command-reference
 * (`pc index backup delete --id <backup-id> --skip-confirmation`)
 */
export function pineconeRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== "backup") return [];
  const id = remediationId(resource, "backupId");
  if (!id) return [];
  return [
    {
      tool: "pc",
      command: `pc index backup delete --id ${shellQuote(id)} --skip-confirmation`,
      description:
        "Delete the backup of the deleted index; its records are gone for good unless you restore it into a new index first.",
      destructive: true,
      placeholders: [
        {
          name: "PINECONE_API_KEY",
          description: "A Pinecone API key for this project (or run pc login first)",
        },
      ],
    },
  ];
}
