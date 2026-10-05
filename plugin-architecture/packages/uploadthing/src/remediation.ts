import {
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Remediation for UploadThing savings findings. UploadThing has no CLI, so
 * the command is `curl` against the REST API, authenticated with the
 * `x-uploadthing-api-key` header (every endpoint is a POST).
 *
 * Reference: https://api.uploadthing.com/openapi-spec.json (`POST /v6/deleteFiles`)
 */
export function uploadthingRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== "ut-file") return [];
  const key = remediationField(resource, "key") || remediationId(resource);
  if (!key) return [];
  return [
    {
      tool: "curl",
      command: `curl -sS -X POST https://api.uploadthing.com/v6/deleteFiles -H "x-uploadthing-api-key: $UPLOADTHING_API_KEY" -H 'Content-Type: application/json' -d ${shellQuote(JSON.stringify({ fileKeys: [key] }))}`,
      description:
        "Delete the upload that never completed; it cannot be served and only takes up the listing.",
      destructive: true,
      placeholders: [API_KEY],
    },
  ];
}

const API_KEY: RemediationPlaceholder = {
  name: "UPLOADTHING_API_KEY",
  description: "The UploadThing secret API key for this app (sk_live_...)",
};
