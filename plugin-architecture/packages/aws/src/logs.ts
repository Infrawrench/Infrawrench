import type { LogsFetchParams, LogsFetchResult, ResourceInstance } from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import { jsonCall } from "./client-transport.js";

/**
 * Logs tab backed by CloudWatch Logs `FilterLogEvents`.
 *
 * Every type here writes to a log group whose name we can derive without an
 * extra lookup, so one call per poll is enough. The "container" dropdown the
 * host renders maps to whatever split the service gives its logs: App Runner
 * has separate application and service groups, EKS writes each control plane
 * component to its own stream prefix, a plain log group lists its most
 * recently written streams.
 *
 * Verified against
 * https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_FilterLogEvents.html
 * `startFromHead: false` returns newest first, which is how we get a tail
 * rather than the head of the window; it requires a `startTime` on or after
 * 2024-01-01, which a lookback from now always satisfies.
 */

/** Types with a Logs tab. `renderDetail` keys the capability off this set. */
export const AWS_LOG_TYPES: ReadonlySet<string> = new Set([
  "cloudwatch-log-group",
  "lambda-function",
  "apprunner-service",
  "codebuild-project",
  "eks-cluster",
]);

/** How far back a tail looks. Quiet groups otherwise page through empty results. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TAIL = 200;
const MAX_TAIL = 1000;
/** Streams offered in a plain log group's dropdown, most recently written first. */
const MAX_STREAM_CHOICES = 20;
const ALL_STREAMS = "all streams";

/**
 * EKS control plane log types and their stream name prefixes, from
 * https://docs.aws.amazon.com/eks/latest/userguide/control-plane-logs.html
 * The API server prefix is also a prefix of the audit streams, so `api`
 * drops audit events after the fetch.
 */
const EKS_STREAM_PREFIXES: Record<string, string> = {
  api: "kube-apiserver-",
  audit: "kube-apiserver-audit-",
  authenticator: "authenticator-",
  controllerManager: "kube-controller-manager-",
  scheduler: "kube-scheduler-",
};
const EKS_ALL = "all components";

interface LogTarget {
  logGroupName: string;
  logStreamNamePrefix?: string;
  logStreamNames?: string[];
  /** Drop events from streams that match this prefix (EKS `api` vs `audit`). */
  excludeStreamPrefix?: string;
  /** Shown instead of the raw error when the group does not exist yet. */
  missingHint: string;
}

interface FilteredLogEvent {
  timestamp?: number;
  message?: string;
  logStreamName?: string;
}

/** Fetch the most recent `tailLines` events for a resource's log group. */
export async function getAwsLogs(
  creds: AwsCredentials,
  resource: ResourceInstance,
  typeId: string,
  params: LogsFetchParams,
): Promise<LogsFetchResult> {
  const { containers, active, target } = await resolveTarget(creds, resource, typeId, params);
  const tail = Math.max(1, Math.min(params.tailLines ?? DEFAULT_TAIL, MAX_TAIL));
  const now = Date.now();
  const body: Record<string, unknown> = {
    logGroupName: target.logGroupName,
    startTime: now - LOOKBACK_MS,
    endTime: now,
    startFromHead: false,
    limit: tail,
  };
  if (target.logStreamNamePrefix) body["logStreamNamePrefix"] = target.logStreamNamePrefix;
  if (target.logStreamNames?.length) body["logStreamNames"] = target.logStreamNames;

  let events: FilteredLogEvent[];
  try {
    const data = await jsonCall<{ events?: FilteredLogEvent[] }>(
      creds,
      "logs",
      "Logs_20140328.FilterLogEvents",
      body,
    );
    events = data.events ?? [];
  } catch (err) {
    if (err instanceof Error && err.message.includes("ResourceNotFoundException")) {
      return { text: target.missingHint, containers, activeContainer: active };
    }
    throw err;
  }

  const exclude = target.excludeStreamPrefix;
  const lines = events
    .filter((e) => !exclude || !(e.logStreamName ?? "").startsWith(exclude))
    // Newest first from the API; the Logs tab appends, so flip to oldest first.
    .reverse()
    .map((e) => formatEvent(e));
  return {
    text: lines.length > 0 ? lines.join("\n") : "No log events in the last 24 hours.",
    containers,
    activeContainer: active,
  };
}

/** `2026-10-03T12:00:00.000Z [stream] message`, with the trailing newline trimmed. */
export function formatEvent(e: FilteredLogEvent): string {
  const ts = typeof e.timestamp === "number" ? new Date(e.timestamp).toISOString() : "";
  const stream = e.logStreamName ? ` [${e.logStreamName}]` : "";
  const message = (e.message ?? "").replace(/\r?\n$/, "");
  return `${ts}${stream} ${message}`;
}

async function resolveTarget(
  creds: AwsCredentials,
  resource: ResourceInstance,
  typeId: string,
  params: LogsFetchParams,
): Promise<{ containers: string[]; active: string; target: LogTarget }> {
  const f = resource.fields;
  switch (typeId) {
    case "cloudwatch-log-group": {
      const logGroupName = String(f["logGroupName"] ?? resource.externalId ?? "");
      if (!logGroupName) throw new Error("Log group is missing a name");
      const streams = await recentStreams(creds, logGroupName).catch(() => [] as string[]);
      const containers = [ALL_STREAMS, ...streams];
      const requested = params.container;
      const active = requested && containers.includes(requested) ? requested : ALL_STREAMS;
      return {
        containers,
        active,
        target: {
          logGroupName,
          ...(active !== ALL_STREAMS ? { logStreamNames: [active] } : {}),
          missingHint: `Log group ${logGroupName} no longer exists.`,
        },
      };
    }
    case "lambda-function": {
      const name = String(f["name"] ?? resource.externalId ?? "");
      const logGroupName = String(f["logGroup"] || `/aws/lambda/${name}`);
      return {
        containers: ["function"],
        active: "function",
        target: {
          logGroupName,
          missingHint: `No logs yet: ${logGroupName} is created the first time the function writes a log line.`,
        },
      };
    }
    case "apprunner-service": {
      const name = String(f["serviceName"] ?? resource.externalId ?? "");
      const serviceId = String(f["serviceId"] ?? "");
      if (!name || !serviceId) throw new Error("App Runner service is missing its name or id");
      // https://docs.aws.amazon.com/apprunner/latest/dg/monitor-cwl.html
      const containers = ["application", "service"];
      const active = params.container === "service" ? "service" : "application";
      const logGroupName = `/aws/apprunner/${name}/${serviceId}/${active}`;
      return {
        containers,
        active,
        target: {
          logGroupName,
          missingHint: `No ${active} logs yet: ${logGroupName} does not exist.`,
        },
      };
    }
    case "codebuild-project": {
      const name = String(f["name"] ?? resource.externalId ?? "");
      // The lister records the project's configured group; CodeBuild's
      // default when none is set is /aws/codebuild/<project>.
      const logGroupName = String(f["_logGroupName"] || `/aws/codebuild/${name}`);
      const prefix = String(f["_logStreamPrefix"] ?? "");
      return {
        containers: ["builds"],
        active: "builds",
        target: {
          logGroupName,
          ...(prefix ? { logStreamNamePrefix: prefix } : {}),
          missingHint: `No build logs in ${logGroupName}. CloudWatch logging may be disabled for this project, or it has not built yet.`,
        },
      };
    }
    case "eks-cluster": {
      const name = String(f["name"] ?? resource.externalId ?? "");
      const logGroupName = `/aws/eks/${name}/cluster`;
      const containers = [EKS_ALL, ...Object.keys(EKS_STREAM_PREFIXES)];
      const requested = params.container;
      const active = requested && containers.includes(requested) ? requested : EKS_ALL;
      const prefix = active === EKS_ALL ? undefined : EKS_STREAM_PREFIXES[active];
      return {
        containers,
        active,
        target: {
          logGroupName,
          ...(prefix ? { logStreamNamePrefix: prefix } : {}),
          ...(active === "api" ? { excludeStreamPrefix: EKS_STREAM_PREFIXES["audit"] } : {}),
          missingHint:
            "Control plane logging is off for this cluster. Turn on the log types you need in the EKS console (Observability, Control plane logging) and they arrive in a few minutes.",
        },
      };
    }
    default:
      throw new Error(`AWS plugin: getLogs is not supported for ${typeId}`);
  }
}

/** The most recently written streams in a group, newest first. */
async function recentStreams(creds: AwsCredentials, logGroupName: string): Promise<string[]> {
  const data = await jsonCall<{ logStreams?: Array<{ logStreamName?: string }> }>(
    creds,
    "logs",
    "Logs_20140328.DescribeLogStreams",
    { logGroupName, orderBy: "LastEventTime", descending: true, limit: MAX_STREAM_CHOICES },
  );
  return (data.logStreams ?? []).map((s) => s.logStreamName ?? "").filter((n) => n.length > 0);
}
