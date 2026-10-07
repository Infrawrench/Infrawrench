import {
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

/**
 * Remediation for Upstash savings findings: pausing and resuming a QStash
 * schedule or queue on a sleep schedule. The Upstash CLI does not cover
 * QStash, so the commands are `curl` against the QStash API, the same routes
 * the plugin's own pause/resume actions call.
 *
 * QStash is regional and a schedule row does not store its account's region,
 * so the base URL and token are the `QSTASH_URL` / `QSTASH_TOKEN` pair the
 * QStash console (and this plugin's secret export) hands out. Child external
 * ids are `<qstashId>/<scheduleId or queueName>`.
 *
 * References:
 * https://upstash.com/docs/qstash/api-reference/schedules/pause-a-schedule
 * https://upstash.com/docs/qstash/api-reference/schedules/resume-a-schedule
 * https://upstash.com/docs/qstash/api-reference/queues/pause-queue
 * https://upstash.com/docs/qstash/api-reference/queues/resume-queue
 */
export function upstashRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  const seg =
    resource.resourceTypeId === T.schedule
      ? "schedules"
      : resource.resourceTypeId === T.queue
        ? "queues"
        : "";
  if (!seg) return [];
  const externalId = (resource.externalId ?? "").trim();
  const slash = externalId.indexOf("/");
  const key = slash <= 0 ? "" : externalId.slice(slash + 1);
  if (!key) return [];
  const what = seg === "schedules" ? "schedule" : "queue";
  const path = `/v2/${seg}/${encodeURIComponent(key)}`;
  return [
    call(
      `${path}/pause`,
      seg === "schedules"
        ? "Pause the schedule; its cron triggers are skipped until it is resumed."
        : "Pause the queue; messages wait in it instead of being delivered.",
    ),
    call(`${path}/resume`, `Resume the ${what}.`),
  ];
}

const PLACEHOLDERS: RemediationPlaceholder[] = [
  {
    name: "QSTASH_URL",
    description:
      "The QStash API URL for this account's region, e.g. https://qstash-eu-central-1.upstash.io",
  },
  { name: "QSTASH_TOKEN", description: "The QStash token for that account" },
];

/** One POST. The base URL expands in double quotes; the path is encoded and quoted on its own. */
function call(path: string, description: string): RemediationCommand {
  return {
    tool: "curl",
    command: `curl -sS -X POST "$QSTASH_URL"${shellQuote(path)} -H "Authorization: Bearer $QSTASH_TOKEN"`,
    description,
    destructive: false,
    placeholders: PLACEHOLDERS,
  };
}
