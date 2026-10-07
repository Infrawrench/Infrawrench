import {
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationResource,
} from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

/**
 * Ready-to-run `avn` (Aiven CLI) commands for savings findings. Both are
 * sleep schedules: powering a service off and on, and pausing and resuming a
 * Kafka connector. avn takes its token from `avn user login` and the project
 * from `--project`. Services store `{project}/{service}` external ids and
 * connectors `{project}/{service}/{connector}`.
 *
 * References:
 * https://aiven.io/docs/tools/cli/service-cli (`avn service update --power-off|--power-on`)
 * https://aiven.io/docs/tools/cli/service/connector (`avn service connector pause|resume`)
 * https://github.com/aiven/aiven-client/blob/main/aiven/client/cli.py (`--project` on both)
 */
export function aivenRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;

  if (resource.resourceTypeId === T.service) {
    const [project, service] = segments(resource, 2, ["project", "name"]);
    if (!project || !service) return [];
    const base = `avn service update --project ${shellQuote(project)} ${shellQuote(service)}`;
    return [
      avn(
        `${base} --power-off`,
        "Power the service off to stop billing it. Its backups are kept, but a service with no backups (such as Kafka) loses all its data, and Aiven deletes a service left powered off for 180 days.",
      ),
      avn(
        `${base} --power-on`,
        "Power the service back on; it is restored from its latest backup.",
      ),
    ];
  }

  if (resource.resourceTypeId === T.connector) {
    const [project, service, connector] = segments(resource, 3, ["project", "serviceName", "name"]);
    if (!project || !service || !connector) return [];
    const args = `--project ${shellQuote(project)} ${shellQuote(service)} ${shellQuote(connector)}`;
    return [
      avn(`avn service connector pause ${args}`, "Pause the Kafka connector."),
      avn(`avn service connector resume ${args}`, "Resume the connector."),
    ];
  }

  return [];
}

/** The external id's `/` segments, each falling back to a stored field. */
function segments(resource: RemediationResource, count: number, fieldKeys: string[]): string[] {
  const parts = (resource.externalId ?? "").trim().split("/");
  const fromId = parts.length === count ? parts : [];
  return fieldKeys.map((key, i) => remediationField(resource, key) || (fromId[i] ?? "").trim());
}

function avn(command: string, description: string): RemediationCommand {
  return { tool: "avn", command, description, destructive: false };
}
