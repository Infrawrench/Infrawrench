/**
 * Typed wrappers over the Modal RPCs this plugin calls.
 *
 * Every request and response layout below is transcribed from
 * `modal_proto/api.proto` in github.com/modal-labs/modal-client (main,
 * 2026-10), the schema Modal's own SDKs are generated from. The comments name
 * the message and its field numbers so a schema change can be checked here
 * line by line. The calls themselves are the ones the documented SDK and CLI
 * surfaces make: `Workspace.billing.report()` / `summary()` / `rates()`,
 * `modal app list|info|history|stop`, `modal environment list|create|update|delete`,
 * `modal secret|volume|dict|queue list|delete`, `Function.get_current_stats()`.
 */

import type { ModalContext } from "./grpc.js";
import { serverStream, unary } from "./grpc.js";
import type { ProtoMessage } from "./proto.js";
import { ProtoWriter, decode } from "./proto.js";

const EMPTY = new Uint8Array();

async function rpc(ctx: ModalContext, method: string, req?: ProtoWriter): Promise<ProtoMessage> {
  return decode(await unary(ctx, method, req ? req.finish() : EMPTY));
}

/** Epoch seconds (`double created_at`) to milliseconds; 0 means unset. */
function secondsToMs(seconds: number): number | undefined {
  return seconds > 0 ? Math.round(seconds * 1000) : undefined;
}

/** A decimal string from the API to a number; empty means zero. */
export function money(raw: string): number {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/** `WorkspaceNameLookup(Empty) -> WorkspaceNameLookupResponse { workspace_name = 1; username = 2; }` */
export async function workspaceName(ctx: ModalContext): Promise<string> {
  const res = await rpc(ctx, "WorkspaceNameLookup");
  return res.string(2) || res.string(1);
}

/** `WorkspaceDashboardUrlGet(WorkspaceDashboardUrlRequest { environment_name = 1; }) -> { url = 1; }` */
export async function dashboardUrl(ctx: ModalContext, environmentName = ""): Promise<string> {
  const res = await rpc(
    ctx,
    "WorkspaceDashboardUrlGet",
    new ProtoWriter().string(1, environmentName),
  );
  return res.string(1);
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export interface ModalEnvironment {
  id: string;
  name: string;
  isDefault: boolean;
  isManaged: boolean;
  webhookSuffix: string;
  createdAt?: number;
  maxConcurrentTasks?: number;
  maxConcurrentGpus?: number;
  currentConcurrentTasks: number;
  currentConcurrentGpus: number;
  /** Set by a workspace manager; absent means no budget. */
  cycleBudget?: number;
  effectiveSpendLimit: number;
  currentCycleUsage: number;
  spendLimitReached: boolean;
}

/**
 * `EnvironmentListItem { name = 1; webhook_suffix = 2; double created_at = 3;
 * bool default = 4; bool is_managed = 5; environment_id = 6;
 * optional int32 max_concurrent_tasks = 7; optional int32 max_concurrent_gpus = 8;
 * int32 current_concurrent_tasks = 9; int32 current_concurrent_gpus = 10;
 * optional double cycle_budget_dollars = 11; double effective_cycle_spend_limit = 12;
 * double current_cycle_usage = 13; bool spend_limit_reached = 14; }`
 */
export function decodeEnvironment(m: ProtoMessage): ModalEnvironment {
  return {
    id: m.string(6),
    name: m.string(1),
    isDefault: m.bool(4),
    isManaged: m.bool(5),
    webhookSuffix: m.string(2),
    ...(secondsToMs(m.double(3)) !== undefined ? { createdAt: secondsToMs(m.double(3))! } : {}),
    ...(m.has(7) ? { maxConcurrentTasks: m.int(7) } : {}),
    ...(m.has(8) ? { maxConcurrentGpus: m.int(8) } : {}),
    currentConcurrentTasks: m.int(9),
    currentConcurrentGpus: m.int(10),
    ...(m.has(11) ? { cycleBudget: m.double(11) } : {}),
    effectiveSpendLimit: m.double(12),
    currentCycleUsage: m.double(13),
    spendLimitReached: m.bool(14),
  };
}

/** `EnvironmentList(Empty) -> EnvironmentListResponse { repeated EnvironmentListItem items = 2; }` */
export async function listEnvironments(ctx: ModalContext): Promise<ModalEnvironment[]> {
  const res = await rpc(ctx, "EnvironmentList");
  return res.messages(2).map(decodeEnvironment);
}

/** `EnvironmentCreate(EnvironmentCreateRequest { name = 1; }) -> Empty` */
export async function createEnvironment(ctx: ModalContext, name: string): Promise<void> {
  await rpc(ctx, "EnvironmentCreate", new ProtoWriter().string(1, name));
}

/**
 * `EnvironmentUpdate(EnvironmentUpdateRequest { current_name = 1;
 * StringValue name = 2; StringValue web_suffix = 3; optional int32 max_concurrent_tasks = 4;
 * optional int32 max_concurrent_gpus = 5; }) -> EnvironmentListItem`
 */
export async function updateEnvironment(
  ctx: ModalContext,
  currentName: string,
  patch: {
    name?: string;
    webhookSuffix?: string;
    maxConcurrentTasks?: number;
    maxConcurrentGpus?: number;
  },
): Promise<ModalEnvironment> {
  const req = new ProtoWriter()
    .string(1, currentName)
    .stringValue(2, patch.name)
    .stringValue(3, patch.webhookSuffix)
    .int(4, patch.maxConcurrentTasks, true)
    .int(5, patch.maxConcurrentGpus, true);
  return decodeEnvironment(await rpc(ctx, "EnvironmentUpdate", req));
}

/** `EnvironmentDelete(EnvironmentDeleteRequest { name = 1; }) -> Empty` */
export async function deleteEnvironment(ctx: ModalContext, name: string): Promise<void> {
  await rpc(ctx, "EnvironmentDelete", new ProtoWriter().string(1, name));
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

/** `enum AppState`. */
export const APP_STATES: Record<number, string> = {
  0: "unspecified",
  1: "ephemeral",
  2: "detached",
  3: "deployed",
  4: "stopping",
  5: "stopped",
  6: "initializing",
  7: "disabled",
  8: "detached-disconnected",
  9: "derived",
};

export interface ModalApp {
  appId: string;
  name: string;
  description: string;
  state: string;
  environment: string;
  createdAt?: number;
  stoppedAt?: number;
  runningTasks: number;
  createdBy?: string;
  deployedAt?: number;
  deployedBy?: string;
  stoppedBy?: string;
  version?: number;
}

/**
 * `AppLifecycle { AppState app_state = 1; double created_at = 2; string created_by = 3;
 * double deployed_at = 4; string deployed_by = 5; int32 version = 6;
 * double stopped_at = 7; string stopped_by = 8; }`
 */
function lifecycleFields(l: ProtoMessage | undefined): Partial<ModalApp> {
  if (!l) return {};
  const out: Partial<ModalApp> = {};
  if (l.string(3)) out.createdBy = l.string(3);
  const deployedAt = secondsToMs(l.double(4));
  if (deployedAt !== undefined) out.deployedAt = deployedAt;
  if (l.string(5)) out.deployedBy = l.string(5);
  if (l.int(6) > 0) out.version = l.int(6);
  if (l.string(8)) out.stoppedBy = l.string(8);
  return out;
}

/**
 * `AppListRequest { environment_name = 1; }` ->
 * `AppListResponse { repeated AppListItem apps = 1; }` with
 * `AppListItem { app_id = 1; description = 3; AppState state = 4; double created_at = 5;
 * double stopped_at = 6; int32 n_running_tasks = 8; name = 10; AppHandleMetadata metadata = 11; }`
 * and `AppHandleMetadata { description = 1; app_id = 2; environment_name = 3; AppLifecycle lifecycle = 4; }`.
 */
export async function listApps(ctx: ModalContext, environmentName: string): Promise<ModalApp[]> {
  const res = await rpc(ctx, "AppList", new ProtoWriter().string(1, environmentName));
  return res.messages(1).map((item) => {
    const meta = item.message(11);
    const createdAt = secondsToMs(item.double(5));
    const stoppedAt = secondsToMs(item.double(6));
    return {
      appId: item.string(1),
      name: item.string(10) || item.string(3),
      description: item.string(3),
      state: APP_STATES[item.uint(4)] ?? "unspecified",
      environment: meta?.string(3) || environmentName,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(stoppedAt !== undefined ? { stoppedAt } : {}),
      runningTasks: item.int(8),
      ...lifecycleFields(meta?.message(4)),
    };
  });
}

export interface ModalGpu {
  type: string;
  count: number;
}

export interface ModalSchedule {
  /** Human-readable: "cron 0 * * * * (UTC)" or "every 1h 30m". */
  description: string;
  kind: "cron" | "period";
  cron?: string;
  timezone?: string;
}

export interface ModalFunctionSummary {
  functionId: string;
  tag: string;
  isServer: boolean;
  gpus: ModalGpu[];
  schedule?: ModalSchedule;
  webFunction: boolean;
  requiresProxyAuth?: boolean;
  isSessioned: boolean;
}

export interface ModalAppInfo {
  appId: string;
  description: string;
  environment: string;
  functions: ModalFunctionSummary[];
  lifecycle: Partial<ModalApp> & { state?: string };
}

/** Legacy `enum GPUType`, for functions deployed by old clients that set no `gpu_type` string. */
const LEGACY_GPU_TYPES: Record<number, string> = {
  1: "T4",
  2: "A100",
  3: "A10G",
  4: "any",
  8: "A100-80GB",
  9: "L4",
  10: "H100",
  11: "L40S",
  12: "H200",
};

/** `GPUConfig { GPUType type = 1; uint32 count = 2; string gpu_type = 4; }` */
export function decodeGpu(m: ProtoMessage): ModalGpu | undefined {
  const type = m.string(4) || LEGACY_GPU_TYPES[m.uint(1)] || "";
  if (!type) return undefined;
  return { type, count: Math.max(1, m.uint(2)) };
}

/**
 * `Schedule { oneof { Cron cron = 1; Period period = 2; } }` with
 * `Cron { cron_string = 1; timezone = 2; }` and
 * `Period { int32 years = 1; months = 2; weeks = 3; days = 4; hours = 5; minutes = 6; float seconds = 7; }`.
 */
export function decodeSchedule(m: ProtoMessage | undefined): ModalSchedule | undefined {
  if (!m) return undefined;
  const cron = m.message(1);
  if (cron && cron.string(1)) {
    const tz = cron.string(2) || "UTC";
    return {
      kind: "cron",
      cron: cron.string(1),
      timezone: tz,
      description: `cron ${cron.string(1)} (${tz})`,
    };
  }
  const period = m.message(2);
  if (period) {
    const parts: string[] = [];
    const units: Array<[number, string]> = [
      [period.int(1), "y"],
      [period.int(2), "mo"],
      [period.int(3), "w"],
      [period.int(4), "d"],
      [period.int(5), "h"],
      [period.int(6), "m"],
      [Math.round(period.float(7) * 1000) / 1000, "s"],
    ];
    for (const [value, unit] of units) if (value > 0) parts.push(`${value}${unit}`);
    if (parts.length > 0) return { kind: "period", description: `every ${parts.join(" ")}` };
  }
  return undefined;
}

/**
 * `AppGetInfo(AppGetInfoRequest { app_id = 1; })` ->
 * `AppGetInfoResponse { AppHandleMetadata info = 1; map<string, FunctionInfoSummary> function_info_summaries = 2; }`
 * where `AppHandleMetadata { ...; map<string,string> functions = 5; map<string,string> servers = 6; }`
 * (tag to function id) and `FunctionInfoSummary { repeated GPUConfig gpu_config = 1;
 * Schedule schedule = 2; bool web_function = 3; optional bool requires_proxy_auth = 4; bool is_sessioned = 5; }`.
 * This is what `modal app info` prints.
 */
export async function getAppInfo(ctx: ModalContext, appId: string): Promise<ModalAppInfo> {
  const res = await rpc(ctx, "AppGetInfo", new ProtoWriter().string(1, appId));
  const info = res.message(1);
  const summaries = res.messageMap(2);
  const lifecycle = info?.message(4);
  const functions: ModalFunctionSummary[] = [];
  const add = (map: Record<string, string>, isServer: boolean) => {
    for (const [tag, functionId] of Object.entries(map)) {
      const s = summaries[functionId];
      const schedule = decodeSchedule(s?.message(2));
      functions.push({
        functionId,
        tag,
        isServer,
        gpus: (s?.messages(1) ?? []).map(decodeGpu).filter((g): g is ModalGpu => !!g),
        ...(schedule ? { schedule } : {}),
        webFunction: s?.bool(3) ?? false,
        ...(s?.has(4) ? { requiresProxyAuth: s.bool(4) } : {}),
        isSessioned: s?.bool(5) ?? false,
      });
    }
  };
  add(info?.stringMap(5) ?? {}, false);
  add(info?.stringMap(6) ?? {}, true);
  functions.sort((a, b) => a.tag.localeCompare(b.tag));
  return {
    appId: info?.string(2) || appId,
    description: info?.string(1) ?? "",
    environment: info?.string(3) ?? "",
    functions,
    lifecycle: {
      ...lifecycleFields(lifecycle),
      ...(lifecycle ? { state: APP_STATES[lifecycle.uint(1)] ?? "unspecified" } : {}),
    },
  };
}

/** `AppGetTags(AppGetTagsRequest { app_id = 1; }) -> AppGetTagsResponse { map<string,string> tags = 1; }` */
export async function getAppTags(
  ctx: ModalContext,
  appId: string,
): Promise<Record<string, string>> {
  const res = await rpc(ctx, "AppGetTags", new ProtoWriter().string(1, appId));
  return res.stringMap(1);
}

export interface ModalDeployment {
  version: number;
  deployedAt?: number;
  deployedBy: string;
  clientVersion: string;
  tag: string;
  rollbackVersion: number;
}

/**
 * `AppDeploymentHistory(AppDeploymentHistoryRequest { app_id = 1; })` ->
 * `{ repeated AppDeploymentHistory app_deployment_histories = 1; uint32 production_app_version = 2; }`
 * with `AppDeploymentHistory { app_id = 1; uint32 version = 2; client_version = 3;
 * double deployed_at = 4; deployed_by = 5; tag = 6; uint32 rollback_version = 7; }`.
 */
export async function getDeploymentHistory(
  ctx: ModalContext,
  appId: string,
): Promise<{ deployments: ModalDeployment[]; productionVersion: number }> {
  const res = await rpc(ctx, "AppDeploymentHistory", new ProtoWriter().string(1, appId));
  const deployments = res.messages(1).map((d) => {
    const deployedAt = secondsToMs(d.double(4));
    return {
      version: d.uint(2),
      ...(deployedAt !== undefined ? { deployedAt } : {}),
      deployedBy: d.string(5),
      clientVersion: d.string(3),
      tag: d.string(6),
      rollbackVersion: d.uint(7),
    };
  });
  deployments.sort((a, b) => b.version - a.version);
  return { deployments, productionVersion: res.uint(2) };
}

/** `AppStop(AppStopRequest { app_id = 1; AppStopSource source = 2; }) -> Empty` */
export async function stopApp(ctx: ModalContext, appId: string): Promise<void> {
  await rpc(ctx, "AppStop", new ProtoWriter().string(1, appId));
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export interface ModalFunctionDetail {
  functionId: string;
  appId: string;
  name: string;
  module: string;
  isClass: boolean;
  isServer: boolean;
  timeoutSecs: number;
  startupTimeoutSecs: number;
  webUrl: string;
  routingRegion: string;
  schedule?: ModalSchedule;
  minContainers?: number;
  maxContainers?: number;
  bufferContainers?: number;
  scaleupWindowSecs?: number;
  scaledownWindowSecs?: number;
  targetConcurrency?: number;
  /** Hardware choices in preference order (more than one means GPU fallbacks). */
  hardware: Array<{
    gpus: ModalGpu[];
    milliCpu: number;
    milliCpuMax: number;
    memoryMb: number;
    memoryMbMax: number;
    ephemeralDiskMb: number;
    maxConcurrentInputs: number;
    targetConcurrentInputs: number;
    cloud: string;
    batchMaxSize: number;
    secretCount: number;
    volumeCount: number;
  }>;
}

/**
 * `FunctionGetById(FunctionGetByIdRequest { function_id = 1; })` ->
 * `FunctionGetByIdResponse { FunctionData function = 1; }`.
 *
 * `FunctionData { module_name = 1; function_name = 2; uint32 warm_pool_size = 4;
 * uint32 concurrency_limit = 5; uint32 task_idle_timeout_secs = 6; uint32 timeout_secs = 8;
 * web_url = 9; bool is_class = 13; repeated RankedFunction ranked_functions = 18;
 * Schedule schedule = 20; AutoscalerSettings autoscaler_settings = 31;
 * uint32 startup_timeout_secs = 36; bool is_server = 41; routing_region = 42; }`,
 * `RankedFunction { uint32 rank = 1; Function function = 2; }`,
 * `Function { Resources resources = 9; repeated string secret_ids = 10;
 * repeated VolumeMount volume_mounts = 33; uint32 max_concurrent_inputs = 34;
 * uint32 batch_max_size = 60; uint32 target_concurrent_inputs = 64; string cloud_provider_str = 77; }`,
 * `Resources { uint32 memory_mb = 2; uint32 milli_cpu = 3; GPUConfig gpu_config = 4;
 * uint32 memory_mb_max = 5; uint32 ephemeral_disk_mb = 6; uint32 milli_cpu_max = 7; }`,
 * `AutoscalerSettings { optional uint32 min_containers = 1; max_containers = 2;
 * buffer_containers = 3; scaleup_window = 4; scaledown_window = 5; optional double target_concurrency_float = 9; }`.
 *
 * The legacy top-level `warm_pool_size` / `concurrency_limit` / `task_idle_timeout_secs`
 * fill in when a function predates `autoscaler_settings`.
 */
export async function getFunction(
  ctx: ModalContext,
  functionId: string,
): Promise<ModalFunctionDetail> {
  const res = await rpc(ctx, "FunctionGetById", new ProtoWriter().string(1, functionId));
  const data = res.message(1);
  if (!data) throw new Error(`Modal function ${functionId} returned no definition`);
  const auto = data.message(31);
  const schedule = decodeSchedule(data.message(20));
  const pick = (field: number, legacy: number): number | undefined =>
    auto?.has(field) ? auto.uint(field) : legacy > 0 ? legacy : undefined;
  const minContainers = pick(1, data.uint(4));
  const maxContainers = pick(2, data.uint(5));
  const scaledown = pick(5, data.uint(6));
  const ranked = data
    .messages(18)
    .map((r) => ({ rank: r.uint(1), fn: r.message(2) }))
    .sort((a, b) => a.rank - b.rank);
  return {
    functionId,
    // `FunctionGetByIdResponse.handle_metadata = 2`, `FunctionHandleMetadata.app_id = 52`.
    appId: res.message(2)?.string(52) ?? "",
    name: data.string(2),
    module: data.string(1),
    isClass: data.bool(13),
    isServer: data.bool(41),
    timeoutSecs: data.uint(8),
    startupTimeoutSecs: data.uint(36),
    webUrl: data.string(9),
    routingRegion: data.string(42),
    ...(schedule ? { schedule } : {}),
    ...(minContainers !== undefined ? { minContainers } : {}),
    ...(maxContainers !== undefined ? { maxContainers } : {}),
    ...(auto?.has(3) ? { bufferContainers: auto.uint(3) } : {}),
    ...(auto?.has(4) ? { scaleupWindowSecs: auto.uint(4) } : {}),
    ...(scaledown !== undefined ? { scaledownWindowSecs: scaledown } : {}),
    ...(auto?.has(9) ? { targetConcurrency: auto.double(9) } : {}),
    hardware: ranked
      .filter((r) => r.fn)
      .map(({ fn }) => {
        const res9 = fn!.message(9);
        const gpu = res9?.message(4);
        const decoded = gpu ? decodeGpu(gpu) : undefined;
        return {
          gpus: decoded ? [decoded] : [],
          milliCpu: res9?.uint(3) ?? 0,
          milliCpuMax: res9?.uint(7) ?? 0,
          memoryMb: res9?.uint(2) ?? 0,
          memoryMbMax: res9?.uint(5) ?? 0,
          ephemeralDiskMb: res9?.uint(6) ?? 0,
          maxConcurrentInputs: fn!.uint(34),
          targetConcurrentInputs: fn!.uint(64),
          cloud: fn!.string(77),
          batchMaxSize: fn!.uint(60),
          secretCount: fn!.strings(10).length,
          volumeCount: fn!.messages(33).length,
        };
      }),
  };
}

export interface ModalFunctionStats {
  backlog: number;
  totalTasks: number;
  runningInputs: number;
  inputHeadroom: number;
}

/**
 * `FunctionGetCurrentStats(FunctionGetCurrentStatsRequest { function_id = 1; })` ->
 * `FunctionStats { uint32 backlog = 1; uint32 num_total_tasks = 3; uint32 num_running_inputs = 4; uint32 input_headroom = 5; }`
 */
export async function getFunctionCurrentStats(
  ctx: ModalContext,
  functionId: string,
): Promise<ModalFunctionStats> {
  const res = await rpc(ctx, "FunctionGetCurrentStats", new ProtoWriter().string(1, functionId));
  return {
    backlog: res.uint(1),
    totalTasks: res.uint(3),
    runningInputs: res.uint(4),
    inputHeadroom: res.uint(5),
  };
}

export interface ModalPercentiles {
  unit: string;
  /** Basis points (5000 = p50) to value. */
  values: Record<number, number>;
}

export interface ModalTimeRangeStats {
  succeeded: number;
  failed: number;
  timedOut: number;
  containersStarted: number;
  containerErrors: number;
  inputPercentiles: Record<string, ModalPercentiles>;
  containerPercentiles: Record<string, ModalPercentiles>;
}

/** `StatsPercentileDistribution { unit = 1; repeated StatsPercentile percentiles = 2; }`, `StatsPercentile { uint32 percentile_basis_points = 1; double value = 2; }` */
function decodePercentiles(map: Record<string, ProtoMessage>): Record<string, ModalPercentiles> {
  const out: Record<string, ModalPercentiles> = {};
  for (const [name, dist] of Object.entries(map)) {
    const values: Record<number, number> = {};
    for (const p of dist.messages(2)) values[p.uint(1)] = p.double(2);
    out[name] = { unit: dist.string(1), values };
  }
  return out;
}

/**
 * `FunctionGetTimeRangeStats(FunctionGetTimeRangeStatsRequest { function_id = 1;
 * Timestamp since = 2; Timestamp until = 3; bool rollup = 4; })` ->
 * `{ uint64 input_success_count = 3; input_failure_count = 4; input_timeout_count = 5;
 * map<string, StatsPercentileDistribution> input_percentile_stats = 7;
 * uint64 container_started_count = 8; container_error_count = 9;
 * map<string, StatsPercentileDistribution> container_percentile_stats = 11; }`
 */
export async function getFunctionTimeRangeStats(
  ctx: ModalContext,
  functionId: string,
  sinceMs: number,
  untilMs: number,
): Promise<ModalTimeRangeStats> {
  const res = await rpc(
    ctx,
    "FunctionGetTimeRangeStats",
    new ProtoWriter()
      .string(1, functionId)
      .timestamp(2, sinceMs)
      .timestamp(3, untilMs)
      .int(4, true),
  );
  return {
    succeeded: res.uint(3),
    failed: res.uint(4),
    timedOut: res.uint(5),
    containersStarted: res.uint(8),
    containerErrors: res.uint(9),
    inputPercentiles: decodePercentiles(res.messageMap(7)),
    containerPercentiles: decodePercentiles(res.messageMap(11)),
  };
}

// ---------------------------------------------------------------------------
// Named objects: secrets, volumes, dicts, queues
// ---------------------------------------------------------------------------

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/**
 * Page a `*List` RPC with `ListPagination { int32 max_objects = 1; double created_before = 2; }`,
 * the way the SDKs do: ask for a page, then for everything created before the
 * oldest item seen, until a short page.
 */
async function paged<T extends { createdAt?: number }>(
  ctx: ModalContext,
  method: string,
  build: (pagination: ProtoWriter) => ProtoWriter,
  itemsField: number,
  decodeItem: (m: ProtoMessage) => T,
): Promise<T[]> {
  const out: T[] = [];
  let before: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const pagination = new ProtoWriter()
      .int(1, PAGE_SIZE)
      .double(2, before !== undefined ? before / 1000 : undefined);
    const res = await rpc(ctx, method, build(pagination));
    const batch = res.messages(itemsField).map(decodeItem);
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    const oldest = Math.min(...batch.map((b) => b.createdAt ?? Number.POSITIVE_INFINITY));
    if (!Number.isFinite(oldest) || (before !== undefined && oldest >= before)) break;
    before = oldest;
  }
  return out;
}

/** `CreationInfo { double created_at = 1; string created_by = 2; }` */
function creation(m: ProtoMessage | undefined, fallbackSeconds: number) {
  const createdAt = secondsToMs(m?.double(1) || fallbackSeconds);
  const createdBy = m?.string(2) ?? "";
  return {
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(createdBy ? { createdBy } : {}),
  };
}

export interface ModalSecret {
  secretId: string;
  name: string;
  environment: string;
  keys: string[];
  createdAt?: number;
  createdBy?: string;
  lastUsedAt?: number;
}

/**
 * `SecretList(SecretListRequest { environment_name = 1; ListPagination pagination = 2; })` ->
 * `{ repeated SecretListItem items = 1; }`, `SecretListItem { label = 1; double created_at = 2;
 * double last_used_at = 3; secret_id = 5; SecretMetadata metadata = 6; }`,
 * `SecretMetadata { name = 1; CreationInfo creation_info = 2; repeated string keys = 3; }`.
 * Only names reach the plugin: the list carries key names, never values.
 */
export function listSecrets(ctx: ModalContext, environmentName: string): Promise<ModalSecret[]> {
  return paged(
    ctx,
    "SecretList",
    (p) => new ProtoWriter().string(1, environmentName).message(2, p),
    1,
    (m) => {
      const meta = m.message(6);
      const lastUsedAt = secondsToMs(m.double(3));
      return {
        secretId: m.string(5),
        name: meta?.string(1) || m.string(1),
        environment: environmentName,
        keys: meta?.strings(3) ?? [],
        ...creation(meta?.message(2), m.double(2)),
        ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
      };
    },
  );
}

export interface ModalVolume {
  volumeId: string;
  name: string;
  environment: string;
  version: string;
  createdAt?: number;
  createdBy?: string;
}

/**
 * `VolumeList(VolumeListRequest { environment_name = 1; ListPagination pagination = 2; })` ->
 * `{ repeated VolumeListItem items = 1; }`, `VolumeListItem { label = 1; volume_id = 2;
 * double created_at = 3; VolumeMetadata metadata = 4; }`,
 * `VolumeMetadata { VolumeFsVersion version = 1; name = 2; CreationInfo creation_info = 3; }`.
 */
export function listVolumes(ctx: ModalContext, environmentName: string): Promise<ModalVolume[]> {
  return paged(
    ctx,
    "VolumeList",
    (p) => new ProtoWriter().string(1, environmentName).message(2, p),
    1,
    (m) => {
      const meta = m.message(4);
      const v = meta?.uint(1) ?? 0;
      return {
        volumeId: m.string(2),
        name: meta?.string(2) || m.string(1),
        environment: environmentName,
        version: v === 2 ? "v2" : v === 1 ? "v1" : "",
        ...creation(meta?.message(3), m.double(3)),
      };
    },
  );
}

export interface ModalDict {
  dictId: string;
  name: string;
  environment: string;
  createdAt?: number;
  createdBy?: string;
}

/**
 * `DictList(DictListRequest { environment_name = 1; ListPagination pagination = 2; })` ->
 * `{ repeated DictInfo dicts = 1; }`, `DictInfo { name = 1; double created_at = 2; dict_id = 3;
 * DictMetadata metadata = 4; }`, `DictMetadata { name = 1; CreationInfo creation_info = 2; }`.
 */
export function listDicts(ctx: ModalContext, environmentName: string): Promise<ModalDict[]> {
  return paged(
    ctx,
    "DictList",
    (p) => new ProtoWriter().string(1, environmentName).message(2, p),
    1,
    (m) => {
      const meta = m.message(4);
      return {
        dictId: m.string(3),
        name: meta?.string(1) || m.string(1),
        environment: environmentName,
        ...creation(meta?.message(2), m.double(2)),
      };
    },
  );
}

export interface ModalQueue {
  queueId: string;
  name: string;
  environment: string;
  partitions: number;
  totalSize: number;
  createdAt?: number;
  createdBy?: string;
}

/** Cap on partitions Modal inspects to size a queue ("checking them is costly"). */
const QUEUE_SIZE_LIMIT = 100_000;

/**
 * `QueueList(QueueListRequest { environment_name = 1; int32 total_size_limit = 2;
 * ListPagination pagination = 3; })` -> `{ repeated QueueInfo queues = 1; }`,
 * `QueueInfo { name = 1; double created_at = 2; int32 num_partitions = 3; int32 total_size = 4;
 * queue_id = 5; QueueMetadata metadata = 6; }`.
 */
export function listQueues(ctx: ModalContext, environmentName: string): Promise<ModalQueue[]> {
  return paged(
    ctx,
    "QueueList",
    (p) => new ProtoWriter().string(1, environmentName).int(2, QUEUE_SIZE_LIMIT).message(3, p),
    1,
    (m) => {
      const meta = m.message(6);
      return {
        queueId: m.string(5),
        name: meta?.string(1) || m.string(1),
        environment: environmentName,
        partitions: m.int(3),
        totalSize: m.int(4),
        ...creation(meta?.message(2), m.double(2)),
      };
    },
  );
}

/** `SecretDelete { secret_id = 1; }`, `VolumeDelete { volume_id = 1; }`, `DictDelete { dict_id = 1; }`, `QueueDelete { queue_id = 1; }` */
export async function deleteObject(
  ctx: ModalContext,
  kind: "secret" | "volume" | "dict" | "queue",
  id: string,
): Promise<void> {
  const method = {
    secret: "SecretDelete",
    volume: "VolumeDelete",
    dict: "DictDelete",
    queue: "QueueDelete",
  }[kind];
  await rpc(ctx, method, new ProtoWriter().string(1, id));
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export interface BillingReportItem {
  objectId: string;
  description: string;
  environment: string;
  intervalStartMs: number;
  cost: number;
  costByResource: Record<string, number>;
  tags: Record<string, string>;
}

/**
 * `WorkspaceBillingReport(WorkspaceBillingReportRequest { Timestamp start_timestamp = 1;
 * Timestamp end_timestamp = 2; string resolution = 3; repeated string tag_names = 4;
 * repeated string environment_ids = 5; repeated string app_ids = 6; })`, server-streaming
 * `WorkspaceBillingReportItem { object_id = 1; description = 2; environment_name = 3;
 * Timestamp interval = 4; string cost = 5; map<string,string> tags = 6;
 * map<string,string> cost_by_resource = 8; }`.
 *
 * The backing call of `Workspace.billing.report()` and `modal billing report`
 * (Team and Enterprise plans). Costs are before credits and other adjustments.
 */
export async function billingReport(
  ctx: ModalContext,
  opts: {
    startMs: number;
    endMs: number;
    resolution: "d" | "h";
    allTags?: boolean;
    environmentIds?: string[];
    appIds?: string[];
  },
): Promise<BillingReportItem[]> {
  const req = new ProtoWriter()
    .timestamp(1, opts.startMs)
    .timestamp(2, opts.endMs)
    .string(3, opts.resolution)
    .strings(4, opts.allTags ? ["*"] : [])
    .strings(5, opts.environmentIds)
    .strings(6, opts.appIds);
  const messages = await serverStream(ctx, "WorkspaceBillingReport", req.finish());
  return messages.map((bytes) => {
    const m = decode(bytes);
    const costByResource: Record<string, number> = {};
    for (const [k, v] of Object.entries(m.stringMap(8))) costByResource[k] = money(v);
    return {
      objectId: m.string(1),
      description: m.string(2),
      environment: m.string(3),
      intervalStartMs: m.timestampMs(4) ?? 0,
      cost: money(m.string(5)),
      costByResource,
      tags: m.stringMap(6),
    };
  });
}

export interface BillingSummary {
  startMs?: number;
  endMs?: number;
  metered: number;
  /** Absent for an environment summary, where adjustments do not apply. */
  billed?: number;
  breakdown: Record<string, number>;
  adjustments: Record<string, number>;
}

function moneyMap(map: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(map)) out[k] = money(v);
  return out;
}

/**
 * `WorkspaceBillingSummary(WorkspaceBillingSummaryRequest { Timestamp start_timestamp = 1; })` ->
 * `{ Timestamp start_timestamp = 1; Timestamp end_timestamp = 2; string metered_cost = 3;
 * string billed_cost = 4; map<string,string> metered_cost_breakdown = 5; map<string,string> adjustments = 6; }`.
 * One billing cycle (a calendar month) starting at `cycleStartMs`.
 */
export async function billingSummary(
  ctx: ModalContext,
  cycleStartMs: number,
): Promise<BillingSummary> {
  const res = await rpc(
    ctx,
    "WorkspaceBillingSummary",
    new ProtoWriter().timestamp(1, cycleStartMs),
  );
  const startMs = res.timestampMs(1);
  const endMs = res.timestampMs(2);
  return {
    ...(startMs !== undefined ? { startMs } : {}),
    ...(endMs !== undefined ? { endMs } : {}),
    metered: money(res.string(3)),
    billed: money(res.string(4)),
    breakdown: moneyMap(res.stringMap(5)),
    adjustments: moneyMap(res.stringMap(6)),
  };
}

/**
 * `EnvironmentBillingSummary(EnvironmentBillingSummaryRequest { Timestamp start_timestamp = 1;
 * string environment_id = 3; })` -> `{ Timestamp start_timestamp = 1; Timestamp end_timestamp = 2;
 * string metered_cost = 3; map<string,string> metered_cost_breakdown = 4; }`.
 */
export async function environmentBillingSummary(
  ctx: ModalContext,
  cycleStartMs: number,
  environmentId: string,
): Promise<BillingSummary> {
  const res = await rpc(
    ctx,
    "EnvironmentBillingSummary",
    new ProtoWriter().timestamp(1, cycleStartMs).string(3, environmentId),
  );
  const startMs = res.timestampMs(1);
  const endMs = res.timestampMs(2);
  return {
    ...(startMs !== undefined ? { startMs } : {}),
    ...(endMs !== undefined ? { endMs } : {}),
    metered: money(res.string(3)),
    breakdown: moneyMap(res.stringMap(4)),
    adjustments: {},
  };
}

export interface BillingRates {
  /** Compute rates are per unit per hour; storage is per GiB-month. */
  rates: Record<string, number>;
  formatted: string;
}

/**
 * `WorkspaceBillingRates(WorkspaceBillingRatesRequest {})` ->
 * `{ map<string,string> rates = 1; map<string,string> deprecation_warnings = 2;
 * map<string,string> deprecation_errors = 3; string formatted = 4; }`.
 * Deprecated keys are dropped, as the SDK's mapping does.
 */
export async function billingRates(ctx: ModalContext): Promise<BillingRates> {
  const res = await rpc(ctx, "WorkspaceBillingRates");
  const deprecated = new Set([...Object.keys(res.stringMap(2)), ...Object.keys(res.stringMap(3))]);
  const rates: Record<string, number> = {};
  for (const [k, v] of Object.entries(res.stringMap(1)))
    if (!deprecated.has(k)) rates[k] = money(v);
  return { rates, formatted: res.string(4) };
}
