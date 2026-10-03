/**
 * Logs tab for the Azure container runtimes.
 *
 * - Container Instances: the ARM `containers/{name}/logs` operation returns
 *   the tail of one container's stdout/stderr as a single string.
 * - Container Apps: the same log stream `az containerapp logs show` reads. A
 *   short-lived token from `getAuthToken` authorizes a GET against the
 *   regional host in the app's `eventStreamEndpoint`; `follow=false` makes it
 *   answer with the tail and close. Console logs are per replica container;
 *   system logs (scaling, revision provisioning, probe failures) come from the
 *   app's `eventstream`.
 * - Container Apps environments: the environment-wide system `eventstream`.
 *
 * No Log Analytics query, so no extra role or token audience: the service
 * principal's ARM access is enough.
 */
import type { LogsFetchParams, LogsFetchResult } from "@infrawrench/plugin-base";
import { azureRequest } from "./http.js";
import { ARM, AZURE_ARM_SPECS, type AzureHttpContext } from "./shared.js";

export const AZURE_LOG_TYPES = new Set([
  "azure-container-instance",
  "azure-container-app",
  "azure-container-app-environment",
]);

/** Dropdown entry for a Container App's (or environment's) system events. */
export const SYSTEM_LOGS = "System events";

/** The log stream API's documented tail ceiling (`az containerapp logs show --tail`). */
const LOGSTREAM_MAX_TAIL = 300;
/** ACI has no documented ceiling; cap it so a chatty container stays readable. */
const ACI_MAX_TAIL = 5000;

export async function fetchAzureLogs(
  ctx: AzureHttpContext,
  typeId: string,
  resourceId: string,
  params: LogsFetchParams,
): Promise<LogsFetchResult> {
  const { resourceGroup, name } = parseExternalId(resourceId);
  if (!resourceGroup || !name) throw new Error(`Azure plugin: malformed resource id ${resourceId}`);
  const spec = AZURE_ARM_SPECS[typeId];
  if (!AZURE_LOG_TYPES.has(typeId) || !spec) {
    throw new Error(`Azure plugin: getLogs is not supported for ${typeId}`);
  }
  const armPath =
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}` +
    `/providers/${spec.provider}/${encodeURIComponent(name)}`;
  const apiVersion = `api-version=${spec.apiVersion}`;

  if (typeId === "azure-container-instance") {
    return containerInstanceLogs(ctx, armPath, apiVersion, params);
  }
  if (typeId === "azure-container-app") {
    return containerAppLogs(ctx, armPath, apiVersion, resourceGroup, name, params);
  }
  return environmentLogs(ctx, armPath, apiVersion, resourceGroup, name, params);
}

/** `account:type:rg/name` → its resource group and name. */
function parseExternalId(resourceId: string): { resourceGroup: string; name: string } {
  const externalId = resourceId.split(":").slice(2).join(":");
  const [resourceGroup = "", ...rest] = externalId.split("/");
  return { resourceGroup, name: rest.at(-1) ?? "" };
}

function tailOf(params: LogsFetchParams, max: number): number {
  return Math.max(1, Math.min(params.tailLines ?? 200, max));
}

function withTrailingNewline(text: string): string {
  return text && !text.endsWith("\n") ? `${text}\n` : text;
}

// ─── Container Instances ─────────────────────────────────────────────────

interface ContainerGroup {
  properties?: { containers?: Array<{ name?: string }> };
}

async function containerInstanceLogs(
  ctx: AzureHttpContext,
  armPath: string,
  apiVersion: string,
  params: LogsFetchParams,
): Promise<LogsFetchResult> {
  const group = await ctx.get<ContainerGroup>(`${armPath}?${apiVersion}`);
  const containers = (group.properties?.containers ?? [])
    .map((c) => String(c.name ?? ""))
    .filter(Boolean);
  const active =
    params.container && containers.includes(params.container)
      ? params.container
      : (containers[0] ?? "");
  if (!active)
    return { text: "This container group has no containers.\n", containers, activeContainer: "" };

  const logs = await ctx.get<{ content?: string }>(
    `${armPath}/containers/${encodeURIComponent(active)}/logs?${apiVersion}` +
      `&tail=${tailOf(params, ACI_MAX_TAIL)}&timestamps=true`,
  );
  const text =
    withTrailingNewline(logs.content ?? "") ||
    "No log output yet. Logs are only kept while the container group is running.\n";
  return { text, containers, activeContainer: active };
}

// ─── Container Apps ──────────────────────────────────────────────────────

interface ContainerAppBody {
  location?: string;
  properties?: { eventStreamEndpoint?: string; latestRevisionName?: string };
}

interface ReplicaList {
  value?: Array<{
    name?: string;
    properties?: { containers?: Array<{ name?: string }> };
  }>;
}

async function containerAppLogs(
  ctx: AzureHttpContext,
  armPath: string,
  apiVersion: string,
  resourceGroup: string,
  name: string,
  params: LogsFetchParams,
): Promise<LogsFetchResult> {
  const app = await ctx.get<ContainerAppBody>(`${armPath}?${apiVersion}`);
  const base = streamBase(app, ctx.subscriptionId);
  const appPath = `/subscriptions/${ctx.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/containerApps/${encodeURIComponent(name)}`;

  // Console logs are addressed per replica container of a revision. The
  // latest revision is what single-revision apps run, and what a
  // multi-revision app last deployed.
  const revision = app.properties?.latestRevisionName ?? "";
  const targets: string[] = [];
  if (revision) {
    try {
      const replicas = await ctx.get<ReplicaList>(
        `${armPath}/revisions/${encodeURIComponent(revision)}/replicas?${apiVersion}`,
      );
      for (const replica of replicas.value ?? []) {
        for (const container of replica.properties?.containers ?? []) {
          if (replica.name && container.name) targets.push(`${replica.name}/${container.name}`);
        }
      }
    } catch {
      // No replicas endpoint answer (revision deprovisioning, say): system
      // events still work.
    }
  }
  const containers = [...targets, SYSTEM_LOGS];
  const active =
    params.container && containers.includes(params.container)
      ? params.container
      : (targets[0] ?? SYSTEM_LOGS);

  const token = await authToken(ctx, `${armPath}/getAuthToken?${apiVersion}`);
  const tail = tailOf(params, LOGSTREAM_MAX_TAIL);
  let url: string;
  if (active === SYSTEM_LOGS) {
    url = `${base}${appPath}/eventstream`;
  } else {
    const [replica = "", container = ""] = active.split("/");
    url =
      `${base}${appPath}/revisions/${encodeURIComponent(revision)}` +
      `/replicas/${encodeURIComponent(replica)}/containers/${encodeURIComponent(container)}/logstream`;
  }
  const lines = await readStream(ctx, url, token, tail);
  const empty =
    active === SYSTEM_LOGS && !targets.length
      ? "No running replicas (the app may be scaled to zero) and no recent system events.\n"
      : "No log output in the stream's recent window.\n";
  return { text: lines || empty, containers, activeContainer: active };
}

async function environmentLogs(
  ctx: AzureHttpContext,
  armPath: string,
  apiVersion: string,
  resourceGroup: string,
  name: string,
  params: LogsFetchParams,
): Promise<LogsFetchResult> {
  const env = await ctx.get<ContainerAppBody>(`${armPath}?${apiVersion}`);
  // The environment's endpoint already names its own eventstream; older
  // environments omit it, and the CLI rebuilds it from the region.
  const url =
    env.properties?.eventStreamEndpoint ||
    `https://${regionHost(env.location)}.azurecontainerapps.dev/subscriptions/${ctx.subscriptionId}` +
      `/resourceGroups/${encodeURIComponent(resourceGroup)}/managedEnvironments/${encodeURIComponent(name)}/eventstream`;
  const token = await authToken(ctx, `${armPath}/getAuthToken?${apiVersion}`);
  const lines = await readStream(ctx, url, token, tailOf(params, LOGSTREAM_MAX_TAIL), false);
  return {
    text: lines || "No recent system events in this environment.\n",
    containers: [SYSTEM_LOGS],
    activeContainer: SYSTEM_LOGS,
  };
}

/** Scheme + host of the app's regional log stream service. */
function streamBase(app: ContainerAppBody, subscriptionId: string): string {
  const endpoint = app.properties?.eventStreamEndpoint ?? "";
  const cut = endpoint.indexOf("/subscriptions/");
  if (cut > 0) return endpoint.slice(0, cut);
  if (!subscriptionId || !app.location) {
    throw new Error("Azure plugin: the container app reports no log stream endpoint");
  }
  return `https://${regionHost(app.location)}.azurecontainerapps.dev`;
}

/** "East US" → "eastus", the form the regional host names use. */
function regionHost(location: string | undefined): string {
  return String(location ?? "")
    .toLowerCase()
    .replace(/\s+/g, "");
}

async function authToken(ctx: AzureHttpContext, url: string): Promise<string> {
  const res = await ctx.post<{ properties?: { token?: string } }>(url, {});
  const token = res.properties?.token;
  if (!token) throw new Error("Azure plugin: getAuthToken returned no token");
  return token;
}

/**
 * GET a non-following log stream and render its JSON lines as text. App
 * streams take the CLI's default `output=json` (a timestamp on every line);
 * the environment stream takes no `output` parameter, as in the CLI.
 */
async function readStream(
  ctx: AzureHttpContext,
  url: string,
  token: string,
  tail: number,
  json = true,
): Promise<string> {
  const query = `follow=false${json ? "&output=json" : ""}&tailLines=${tail}`;
  const res = await azureRequest(ctx.http, `${url}${url.includes("?") ? "&" : "?"}${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Azure log stream ${res.status}: ${await res.text()}`);
  const body = await res.text();
  const lines = body
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map(formatStreamLine);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/**
 * One stream line → display text. Console lines are `{TimeStamp, Log}`;
 * system events add `Type`, `Reason` and `Msg` (plus app/revision/replica
 * names, left out: the tab already says which resource it is).
 */
export function formatStreamLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  if (!parsed || typeof parsed !== "object") return line;
  const entry = parsed as Record<string, unknown>;
  const timestamp = String(entry["TimeStamp"] ?? "");
  const message = entry["Log"] ?? entry["Msg"];
  if (message === undefined) return line;
  const reason = [entry["Type"], entry["Reason"]]
    .filter((part) => typeof part === "string" && part)
    .join(" ");
  const replica = entry["ReplicaName"] ? ` (${String(entry["ReplicaName"])})` : "";
  return [timestamp, reason ? `[${reason}]` : "", `${String(message)}${reason ? replica : ""}`]
    .filter(Boolean)
    .join(" ");
}
