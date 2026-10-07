import {
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
  type RemediationResource,
} from "@infrawrench/plugin-base";
import { REGIONS } from "./api.js";
import { T } from "./resource-types.js";

/**
 * Remediation for InfluxDB Cloud (TSM) savings findings, written for the
 * official `influx` CLI (2.x). The host comes from the stored region; the
 * token is the `INFLUX_TOKEN` variable the CLI reads.
 *
 * - An inactive API token (orphan): delete it.
 * - A task on a sleep schedule: set its status inactive, then active.
 *
 * References:
 * https://docs.influxdata.com/influxdb/cloud/reference/cli/influx/auth/delete/
 * https://docs.influxdata.com/influxdb/cloud/reference/cli/influx/task/update/
 */
export function influxRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "orphan" && finding.resource.resourceTypeId === T.token) {
    const id = idOf(finding.resource, "tokenId");
    if (!id) return [];
    return [
      {
        tool: "influx",
        command: `influx auth delete${host(finding.resource)} --id ${shellQuote(id)}`,
        description: "Delete the inactive API token.",
        destructive: true,
        placeholders: PLACEHOLDERS,
      },
    ];
  }

  if (finding.kind === "sleep-schedule" && finding.resource.resourceTypeId === T.task) {
    const id = idOf(finding.resource, "taskId");
    if (!id) return [];
    const base = `influx task update${host(finding.resource)} --id ${shellQuote(id)}`;
    return [
      {
        tool: "influx",
        command: `${base} --status inactive`,
        description: "Disable the task so it stops running.",
        destructive: false,
        placeholders: PLACEHOLDERS,
      },
      {
        tool: "influx",
        command: `${base} --status active`,
        description: "Enable the task again.",
        destructive: false,
        placeholders: PLACEHOLDERS,
      },
    ];
  }

  return [];
}

const PLACEHOLDERS: RemediationPlaceholder[] = [
  { name: "INFLUX_TOKEN", description: "An InfluxDB Cloud API token for this organization" },
];

function idOf(resource: RemediationResource, key: string): string {
  return remediationField(resource, key) || (resource.externalId ?? "").trim();
}

/** ` --host https://…` for a known region; otherwise the CLI's own config or INFLUX_HOST. */
function host(resource: RemediationResource): string {
  const region = remediationField(resource, "region");
  const location = REGIONS.find((r) => r.id === region)?.location;
  return location ? ` --host ${shellQuote(`https://${location}`)}` : "";
}
