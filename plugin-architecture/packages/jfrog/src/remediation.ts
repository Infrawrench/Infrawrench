import {
  remediationDateStamp,
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationResource,
} from "@infrawrench/plugin-base";

/**
 * Remediation for JFrog savings findings, written for the official JFrog CLI
 * (`jf`). `jf api` calls any platform REST endpoint with the server and
 * credentials already configured (`jf config add`), so no token appears here.
 *
 * - An empty local repository (orphan): save its configuration, then delete it.
 * - An Xray policy no watch uses (orphan): save its definition, then delete it.
 *
 * References:
 * https://docs.jfrog.com/integrations/docs/use-api-endpoints-via-cli (jf api, -X DELETE)
 * https://docs.jfrog.com/artifactory/reference (GET|DELETE /artifactory/api/repositories/{key})
 * https://docs.jfrog.com/security/reference/delete-policy (DELETE /xray/api/v1/policies/{name})
 */
export function jfrogRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan") return [];
  const { resource } = finding;

  if (resource.resourceTypeId === "jfrog-repository") {
    const key = idOf(resource, "key");
    if (!key) return [];
    return backupThenDelete(
      `/artifactory/api/repositories/${encodeURIComponent(key)}`,
      backupFile(key, "repository"),
      "Save the repository's configuration so it can be recreated.",
      "Delete the empty local repository.",
    );
  }

  if (resource.resourceTypeId === "jfrog-xray-policy") {
    const name = idOf(resource, "name");
    if (!name) return [];
    return backupThenDelete(
      `/xray/api/v1/policies/${encodeURIComponent(name)}`,
      backupFile(name, "xray-policy"),
      "Save the policy's rules so it can be recreated.",
      "Delete the policy; no watch enforces it.",
    );
  }

  return [];
}

function idOf(resource: RemediationResource, key: string): string {
  return remediationField(resource, key) || (resource.externalId ?? "").trim();
}

function backupFile(id: string, what: string): string {
  return `${id.replace(/[^A-Za-z0-9_.-]/g, "_")}-${what}-${remediationDateStamp()}.json`;
}

function backupThenDelete(
  path: string,
  file: string,
  backupDescription: string,
  deleteDescription: string,
): RemediationCommand[] {
  return [
    {
      tool: "jf",
      command: `jf api ${shellQuote(path)} > ${shellQuote(file)}`,
      description: backupDescription,
      destructive: false,
    },
    {
      tool: "jf",
      command: `jf api ${shellQuote(path)} -X DELETE`,
      description: deleteDescription,
      destructive: true,
    },
  ];
}
