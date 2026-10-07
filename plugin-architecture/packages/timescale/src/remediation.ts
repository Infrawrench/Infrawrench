import {
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

/**
 * Remediation for Tiger Cloud (Timescale) savings findings.
 *
 * - A service on a sleep schedule is stopped and started with the official
 *   `tiger` CLI (`tiger service stop|start <id>`), which acts in the project
 *   it is logged in to.
 * - An exporter no service sends data through has no CLI command, so it is
 *   `curl` against `DELETE /projects/{project_id}/exporters/{exporter_id}`
 *   with the project's client credentials as HTTP Basic, the route the
 *   plugin's own delete calls.
 *
 * External ids are `<projectId>/<serviceId>` and `<projectId>/<exporterId>`.
 *
 * References: github.com/timescale/tiger-cli (`internal/cmd/service_stop.go`,
 * `internal/cmd/service_start.go`, and `openapi.yaml` for the exporter route).
 */
export function timescaleRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan" && finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  const externalId = (resource.externalId ?? "").trim();
  const slash = externalId.indexOf("/");
  if (slash <= 0 || slash === externalId.length - 1) return [];
  const project = externalId.slice(0, slash);
  const id = externalId.slice(slash + 1);

  if (finding.kind === "sleep-schedule" && resource.resourceTypeId === T.service) {
    return [
      {
        tool: "tiger",
        command: `tiger service stop ${shellQuote(id)}`,
        description: "Stop the service; compute stops billing while storage is kept.",
        destructive: false,
      },
      {
        tool: "tiger",
        command: `tiger service start ${shellQuote(id)}`,
        description: "Start the service again.",
        destructive: false,
      },
    ];
  }

  if (finding.kind === "orphan" && resource.resourceTypeId === T.exporter) {
    const url = `${API}/projects/${encodeURIComponent(project)}/exporters/${encodeURIComponent(id)}`;
    return [
      {
        tool: "curl",
        command: `curl -sS -X DELETE ${shellQuote(url)} -u "$TIGER_PUBLIC_KEY:$TIGER_SECRET_KEY"`,
        description: "Delete the exporter, which no service sends metrics or logs through.",
        destructive: true,
        placeholders: PLACEHOLDERS,
      },
    ];
  }

  return [];
}

const API = "https://console.cloud.tigerdata.com/public/api/v1";

const PLACEHOLDERS: RemediationPlaceholder[] = [
  {
    name: "TIGER_PUBLIC_KEY",
    description: "Public key of a Tiger Cloud client credential for this project",
  },
  { name: "TIGER_SECRET_KEY", description: "Secret key of that client credential" },
];
