import {
  remediationDateStamp,
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `doppler` CLI commands for savings findings. The only finding
 * is the orphan rule on branch configs that no application has ever fetched,
 * so the fix is a delete, preceded by a download of its secrets because a
 * deleted config cannot be restored. The CLI uses the token from
 * `doppler login` (or `DOPPLER_TOKEN`).
 *
 * References (flag definitions in the CLI source):
 * https://github.com/DopplerHQ/cli/blob/master/pkg/cmd/configs.go (configs delete: -p, -c, --yes)
 * https://github.com/DopplerHQ/cli/blob/master/pkg/cmd/secrets.go (secrets download: --no-file, --format)
 */
export function dopplerRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== "doppler-config") return [];
  const project = remediationField(resource, "project");
  const config = remediationField(resource, "name");
  if (!project || !config) return [];
  // Root configs back an environment and are never orphans; refuse to
  // generate a delete for one even if a finding says otherwise.
  if (resource.fields["root"] === true || remediationField(resource, "root") === "true") return [];
  const scope = `--project ${shellQuote(project)} --config ${shellQuote(config)}`;
  const backup = `${project}-${config}-${remediationDateStamp()}.json`;
  return [
    {
      tool: "doppler",
      command: `doppler secrets download ${scope} --no-file --format json > ${shellQuote(backup)}`,
      description:
        "Save the config's secrets first, as plaintext JSON: keep the file somewhere safe or delete it once you are sure.",
      destructive: false,
    },
    {
      tool: "doppler",
      command: `doppler configs delete ${scope} --yes`,
      description: "Delete the branch config that no application has ever fetched.",
      destructive: true,
    },
  ];
}
