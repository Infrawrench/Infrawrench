import {
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

/**
 * Remediation for Northflank savings findings, written for the official
 * `northflank` CLI. A service or addon on a sleep schedule is paused (scaled
 * to zero) and resumed, the same `/pause` and `/resume` routes the plugin's
 * own actions call. A service resumes with its stored instance count when the
 * row was synced while it was running.
 *
 * The CLI acts in its current team context, so no team id is needed.
 *
 * References:
 * https://northflank.com/docs/v1/api/project/services/pause-service
 * https://northflank.com/docs/v1/api/project/services/resume-service
 * https://northflank.com/docs/v1/api/project/addons/pause-addon
 * https://northflank.com/docs/v1/api/project/addons/resume-addon
 */
export function northflankRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  const kind =
    resource.resourceTypeId === T.service
      ? "service"
      : resource.resourceTypeId === T.addon
        ? "addon"
        : "";
  if (!kind) return [];
  const externalId = (resource.externalId ?? "").trim();
  const slash = externalId.indexOf("/");
  if (slash <= 0 || slash === externalId.length - 1) return [];
  const project = externalId.slice(0, slash);
  const id = externalId.slice(slash + 1);
  const target = `--projectId ${shellQuote(project)} --${kind}Id ${shellQuote(id)}`;

  const stored = Number(resource.fields["instances"]);
  const input =
    kind === "service" && Number.isInteger(stored) && stored > 0
      ? ` --input ${shellQuote(JSON.stringify({ instances: stored }))}`
      : "";
  return [
    {
      tool: "northflank",
      command: `northflank pause ${kind} ${target}`,
      description:
        kind === "service"
          ? "Pause the service; it scales to zero instances and stops billing for compute."
          : "Pause the addon; its compute stops billing while its storage is kept.",
      destructive: false,
    },
    {
      tool: "northflank",
      command: `northflank resume ${kind} ${target}${input}`,
      description: input
        ? `Resume it with ${stored} instance${stored === 1 ? "" : "s"}.`
        : "Resume it.",
      destructive: false,
    },
  ];
}
