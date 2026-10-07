import {
  remediationDateStamp,
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Buildkite savings findings, written for the official
 * Buildkite CLI (`bk`), which works against the organization it is configured
 * for (`bk configure`).
 *
 * - An archived pipeline (orphan): save its definition, then delete it. The CLI
 *   has no `pipeline delete`, so the delete goes through `bk api`, which calls
 *   the REST API relative to the configured organization.
 * - A queue on a sleep schedule: pause dispatch, resume dispatch.
 *
 * References:
 * https://buildkite.com/docs/platform/cli/reference/pipeline (bk pipeline view)
 * https://buildkite.com/docs/platform/cli/reference/api (bk api --method)
 * https://buildkite.com/docs/apis/rest-api/pipelines (DELETE /pipelines/{slug})
 * https://buildkite.com/docs/platform/cli/reference/queue (bk queue pause|resume)
 */
export function buildkiteRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "orphan" && finding.resource.resourceTypeId === "pipeline") {
    const slug =
      remediationField(finding.resource, "slug") || (finding.resource.externalId ?? "").trim();
    if (!slug) return [];
    const backup = `${slug.replace(/[^A-Za-z0-9_.-]/g, "_")}-pipeline-${remediationDateStamp()}.json`;
    return [
      {
        tool: "bk",
        command: `bk pipeline view ${shellQuote(slug)} -o json > ${shellQuote(backup)}`,
        description: "Save the pipeline's definition and steps to a file.",
        destructive: false,
      },
      {
        tool: "bk",
        command: `bk api --method DELETE ${shellQuote(`/pipelines/${encodeURIComponent(slug)}`)}`,
        description: "Delete the archived pipeline and its build history.",
        destructive: true,
      },
    ];
  }

  if (finding.kind === "sleep-schedule" && finding.resource.resourceTypeId === "queue") {
    const [idCluster = "", idQueue = ""] = (finding.resource.externalId ?? "").split("/");
    const cluster = remediationField(finding.resource, "clusterId") || idCluster.trim();
    const queue = remediationField(finding.resource, "queueId") || idQueue.trim();
    if (!cluster || !queue) return [];
    const args = `${shellQuote(cluster)} ${shellQuote(queue)}`;
    return [
      {
        tool: "bk",
        command: `bk queue pause ${args} --note 'Sleep schedule'`,
        description: "Pause dispatch: queued jobs wait and no new jobs reach agents.",
        destructive: false,
      },
      {
        tool: "bk",
        command: `bk queue resume ${args}`,
        description: "Resume dispatch to the queue's agents.",
        destructive: false,
      },
    ];
  }

  return [];
}
