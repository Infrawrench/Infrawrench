import type { ResourceInstance } from "@infrawrench/plugin-base";
import type {
  BasetenAutoscaling,
  BasetenChain,
  BasetenDeployment,
  BasetenEnvironment,
  BasetenInstanceType,
  BasetenInstanceTypePrice,
  BasetenModel,
  BasetenModelApi,
  BasetenSecret,
  BasetenTrainingJob,
  BasetenTrainingProject,
  Decimal,
} from "./types.js";

/** Pure mapping from Baseten payloads to host resource instances. */

export const PLUGIN_ID = "baseten";

/** Hours in an average month, the convention every monthly figure here uses. */
export const HOURS_PER_MONTH = 730;

type Fields = ResourceInstance["fields"];

export function makeInstance(opts: {
  accountId: string;
  typeId: string;
  externalId: string;
  displayName: string;
  fields: Fields;
  outputs?: Record<string, string>;
  parentResourceId?: string;
  createdAt?: string;
}): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: `${opts.accountId}:${opts.typeId}:${opts.externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: opts.typeId,
    accountId: opts.accountId,
    displayName: opts.displayName,
    fields: opts.fields,
    resolvedOutputs: opts.outputs ?? {},
    secretStates: [],
    externalId: opts.externalId,
    ...(opts.parentResourceId ? { parentResourceId: opts.parentResourceId } : {}),
    createdAt: opts.createdAt || now,
    updatedAt: now,
    lastSyncedAt: now,
  };
}

/** Bare externalId of a host resource id (`account:type:external`). */
export function externalOf(resourceId: string): string {
  return resourceId.includes(":") ? resourceId.split(":").slice(2).join(":") : resourceId;
}

/** Split a `<scope>/<id>` externalId (or full host resource id) into its parts. */
export function parseScopedId(resourceIdOrExternal: string): { scope: string; id: string } {
  const external = externalOf(resourceIdOrExternal);
  const slash = external.indexOf("/");
  if (slash <= 0 || slash === external.length - 1) {
    throw new Error(`Baseten plugin: cannot parse resource id "${resourceIdOrExternal}"`);
  }
  return { scope: external.slice(0, slash), id: external.slice(slash + 1) };
}

/** Baseten decimals arrive as number or numeric string. Non-numeric → 0. */
export function money(v: Decimal | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Round to cents (or finer for per-minute prices) without float noise. */
export function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function setIf(fields: Fields, key: string, v: unknown): void {
  if (v === undefined || v === null || v === "") return;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") fields[key] = v;
}

export function predictBase(modelId: string): string {
  return `https://model-${modelId}.api.baseten.co`;
}

/** Instance types keyed by both id and display name: deployments report the name. */
export type InstanceTypeIndex = Map<string, { type: BasetenInstanceType; pricePerMinute?: number }>;

export function indexInstanceTypes(
  types: BasetenInstanceType[],
  prices: BasetenInstanceTypePrice[],
): InstanceTypeIndex {
  const index: InstanceTypeIndex = new Map();
  for (const t of types) {
    index.set(t.id, { type: t });
    if (t.name) index.set(t.name, { type: t });
  }
  for (const p of prices) {
    const t = p.instance_type;
    if (!t?.id) continue;
    const entry = {
      type: t,
      ...(typeof p.price === "number" ? { pricePerMinute: p.price } : {}),
    };
    index.set(t.id, entry);
    if (t.name) index.set(t.name, entry);
  }
  return index;
}

export function mapInstanceType(
  t: BasetenInstanceType,
  pricePerMinute: number | undefined,
  accountId: string,
): ResourceInstance {
  const fields: Fields = { name: t.name || t.id };
  setIf(fields, "gpuType", t.gpu_type);
  setIf(fields, "gpuCount", t.gpu_count ?? 0);
  if (t.gpu_memory_limit_mib) fields["gpuMemoryGib"] = round(t.gpu_memory_limit_mib / 1024, 1);
  if (t.millicpu_limit) fields["vcpus"] = round(t.millicpu_limit / 1000, 2);
  if (t.memory_limit_mib) fields["memoryGib"] = round(t.memory_limit_mib / 1024, 1);
  if (pricePerMinute !== undefined) {
    fields["pricePerMinute"] = round(pricePerMinute, 5);
    fields["pricePerHour"] = round(pricePerMinute * 60, 4);
  }
  return makeInstance({
    accountId,
    typeId: "instance-type",
    externalId: t.id,
    displayName: t.name || t.id,
    fields,
  });
}

export function mapModel(m: BasetenModel, accountId: string): ResourceInstance {
  const fields: Fields = { name: m.name || m.id };
  setIf(fields, "teamName", m.team_name);
  setIf(fields, "deploymentsCount", m.deployments_count);
  setIf(fields, "productionDeploymentId", m.production_deployment_id);
  setIf(fields, "developmentDeploymentId", m.development_deployment_id);
  setIf(fields, "instanceType", m.instance_type_name);
  setIf(fields, "createdAt", m.created_at);
  const outputs: Record<string, string> = { modelId: m.id };
  if (m.production_deployment_id) {
    outputs["productionUrl"] = `${predictBase(m.id)}/production/predict`;
  }
  return makeInstance({
    accountId,
    typeId: "model",
    externalId: m.id,
    displayName: m.name || m.id,
    fields,
    outputs,
    ...(m.created_at ? { createdAt: m.created_at } : {}),
  });
}

/** Autoscaling settings → host fields, shared by deployments and environments. */
export function autoscalingToFields(
  a: BasetenAutoscaling | null | undefined,
  fields: Fields,
): void {
  if (!a) return;
  setIf(fields, "minReplica", a.min_replica);
  setIf(fields, "maxReplica", a.max_replica);
  setIf(fields, "concurrencyTarget", a.concurrency_target);
  setIf(fields, "targetUtilization", a.target_utilization_percentage);
  setIf(fields, "autoscalingWindow", a.autoscaling_window);
  setIf(fields, "scaleDownDelay", a.scale_down_delay);
  setIf(fields, "targetInFlightTokens", a.target_in_flight_tokens);
}

function instanceFields(name: string | null | undefined, index: InstanceTypeIndex, fields: Fields) {
  if (!name) return undefined;
  fields["instanceType"] = name;
  const entry = index.get(name);
  if (!entry) return undefined;
  setIf(fields, "gpuType", entry.type.gpu_type);
  setIf(fields, "gpuCount", entry.type.gpu_count);
  return entry.pricePerMinute;
}

/** Per-deployment usage over the idle window, from the billing summary. */
export interface DeploymentUsage {
  requests: number;
  minutes: number;
  cost: number;
}

export function mapDeployment(
  d: BasetenDeployment,
  model: Pick<BasetenModel, "id" | "name">,
  accountId: string,
  index: InstanceTypeIndex,
  usage: Map<string, DeploymentUsage> | null,
): ResourceInstance {
  const modelId = d.model_id || model.id;
  const fields: Fields = {
    name: d.name || d.id,
    modelId,
    status: d.status || "",
    // Always written so `environment` is distinguishable from "not synced".
    environment: d.environment ?? "",
    isProduction: d.is_production === true,
    isDevelopment: d.is_development === true,
    activeReplicas: d.active_replica_count ?? 0,
  };
  setIf(fields, "modelName", model.name);
  autoscalingToFields(d.autoscaling_settings, fields);
  const pricePerMinute = instanceFields(d.instance_type_name, index, fields);
  if (pricePerMinute !== undefined) {
    fields["pricePerHour"] = round(pricePerMinute * 60, 4);
    const min = Number(fields["minReplica"] ?? 0);
    fields["minReplicaMonthlyCost"] = round(pricePerMinute * 60 * HOURS_PER_MONTH * min);
  }
  setIf(fields, "region", d.region?.display_name || d.region?.slug);
  setIf(fields, "backpressurePolicy", d.request_backpressure_settings?.policy);
  setIf(fields, "createdAt", d.created_at);
  // Usage fields only when billing was readable: a missing figure must never
  // read as "zero requests" and flag a busy deployment as idle.
  if (usage) {
    const u = usage.get(d.id) ?? { requests: 0, minutes: 0, cost: 0 };
    fields["requests7d"] = u.requests;
    fields["minutes7d"] = u.minutes;
    fields["cost7d"] = round(u.cost);
    const min = Number(fields["minReplica"] ?? 0);
    const switchedOn = d.status !== "INACTIVE" && d.status !== "DEACTIVATING";
    fields["idle"] = min > 0 && switchedOn && u.requests === 0 ? "yes" : "no";
  }
  const externalId = `${modelId}/${d.id}`;
  return makeInstance({
    accountId,
    typeId: "deployment",
    externalId,
    displayName: model.name ? `${model.name} / ${d.name || d.id}` : d.name || d.id,
    fields,
    outputs: { predictUrl: `${predictBase(modelId)}/deployment/${d.id}/predict` },
    parentResourceId: `${accountId}:model:${modelId}`,
    ...(d.created_at ? { createdAt: d.created_at } : {}),
  });
}

export function mapEnvironment(
  e: BasetenEnvironment,
  model: Pick<BasetenModel, "id" | "name">,
  accountId: string,
  index: InstanceTypeIndex,
): ResourceInstance {
  const modelId = e.model_id || model.id;
  const fields: Fields = { name: e.name, modelId };
  setIf(fields, "modelName", model.name);
  const current = e.current_deployment;
  if (current) {
    fields["currentDeploymentId"] = current.id;
    setIf(fields, "currentDeploymentName", current.name);
    setIf(fields, "status", current.status);
    fields["activeReplicas"] = current.active_replica_count ?? 0;
  }
  setIf(fields, "candidateDeploymentName", e.candidate_deployment?.name);
  const promo = e.in_progress_promotion;
  if (promo) {
    setIf(fields, "promotionStatus", promo.status);
    setIf(fields, "trafficToCandidate", promo.percent_traffic_to_new_version);
  }
  autoscalingToFields(e.autoscaling_settings ?? current?.autoscaling_settings, fields);
  setIf(fields, "promotionCleanup", e.promotion_settings?.promotion_cleanup_strategy);
  if (typeof e.promotion_settings?.rolling_deploy === "boolean") {
    fields["rollingDeploy"] = e.promotion_settings.rolling_deploy;
  }
  setIf(
    fields,
    "backpressurePolicy",
    e.request_backpressure_settings?.policy ?? current?.request_backpressure_settings?.policy,
  );
  const typeName = e.instance_type?.name || current?.instance_type_name;
  instanceFields(typeName, index, fields);
  if (e.instance_type?.gpu_type) fields["gpuType"] = e.instance_type.gpu_type;
  fields["scheduleCount"] = e.autoscaling_schedules?.schedules?.length ?? 0;
  setIf(fields, "createdAt", e.created_at);
  const externalId = `${modelId}/${e.name}`;
  const url =
    e.name === "production"
      ? `${predictBase(modelId)}/production/predict`
      : `${predictBase(modelId)}/environments/${e.name}/predict`;
  return makeInstance({
    accountId,
    typeId: "environment",
    externalId,
    displayName: model.name ? `${model.name} / ${e.name}` : e.name,
    fields,
    outputs: { predictUrl: url },
    parentResourceId: `${accountId}:model:${modelId}`,
    ...(e.created_at ? { createdAt: e.created_at } : {}),
  });
}

export function mapChain(c: BasetenChain, accountId: string): ResourceInstance {
  const fields: Fields = { name: c.name || c.id };
  setIf(fields, "teamName", c.team_name);
  setIf(fields, "deploymentsCount", c.deployments_count);
  setIf(fields, "createdAt", c.created_at);
  return makeInstance({
    accountId,
    typeId: "chain",
    externalId: c.id,
    displayName: c.name || c.id,
    fields,
    ...(c.created_at ? { createdAt: c.created_at } : {}),
  });
}

/** Secrets are addressed by name within a team, hence `<team>/<name>`. */
export function secretExternalId(s: Pick<BasetenSecret, "name" | "team_name">): string {
  return `${s.team_name || "default"}/${s.name}`;
}

export function mapSecret(s: BasetenSecret, accountId: string): ResourceInstance {
  const fields: Fields = { name: s.name };
  setIf(fields, "teamName", s.team_name);
  setIf(fields, "createdAt", s.created_at);
  return makeInstance({
    accountId,
    typeId: "secret",
    externalId: secretExternalId(s),
    displayName: s.name,
    fields,
    ...(s.created_at ? { createdAt: s.created_at } : {}),
  });
}

/** `TRAINING_JOB_RUNNING` → `running`. */
export function normalizeTrainingStatus(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw.replace(/^TRAINING_JOB_/, "").toLowerCase();
}

export function mapTrainingProject(p: BasetenTrainingProject, accountId: string): ResourceInstance {
  const fields: Fields = { name: p.name || p.id };
  setIf(fields, "teamName", p.team_name);
  if (p.latest_job) {
    fields["latestJobId"] = p.latest_job.id;
    setIf(fields, "latestJobStatus", normalizeTrainingStatus(p.latest_job.current_status));
  }
  setIf(fields, "createdAt", p.created_at);
  setIf(fields, "updatedAt", p.updated_at);
  return makeInstance({
    accountId,
    typeId: "training-project",
    externalId: p.id,
    displayName: p.name || p.id,
    fields,
    ...(p.created_at ? { createdAt: p.created_at } : {}),
  });
}

export function mapTrainingJob(j: BasetenTrainingJob, accountId: string): ResourceInstance {
  const projectId = j.training_project_id || j.training_project?.id || "";
  const fields: Fields = {
    status: normalizeTrainingStatus(j.current_status),
    projectId,
  };
  setIf(fields, "name", j.name);
  setIf(fields, "projectName", j.training_project?.name);
  const t = j.instance_type;
  if (t) {
    setIf(fields, "instanceType", t.name || t.id);
    setIf(fields, "gpuType", t.gpu_type);
    setIf(fields, "gpuCount", t.gpu_count);
  }
  const nodes = j.node_count ?? 1;
  fields["nodeCount"] = nodes;
  if (t?.gpu_count) fields["totalGpus"] = t.gpu_count * nodes;
  setIf(fields, "availability", j.availability_model);
  setIf(fields, "priority", j.priority);
  setIf(fields, "createdBy", j.user?.email);
  setIf(fields, "errorMessage", j.error_message);
  setIf(fields, "createdAt", j.created_at);
  setIf(fields, "updatedAt", j.updated_at);
  return makeInstance({
    accountId,
    typeId: "training-job",
    externalId: j.id,
    displayName: j.name || j.id,
    fields,
    ...(projectId ? { parentResourceId: `${accountId}:training-project:${projectId}` } : {}),
    ...(j.created_at ? { createdAt: j.created_at } : {}),
  });
}

export function mapModelApi(m: BasetenModelApi, accountId: string): ResourceInstance {
  const fields: Fields = { name: m.name };
  setIf(fields, "displayName", m.display_name);
  setIf(fields, "family", m.model_family);
  setIf(fields, "contextLength", m.context_length);
  if (m.cost_per_million_input_tokens != null) {
    fields["inputPricePerMillion"] = money(m.cost_per_million_input_tokens);
  }
  if (m.cost_per_million_output_tokens != null) {
    fields["outputPricePerMillion"] = money(m.cost_per_million_output_tokens);
  }
  setIf(fields, "releaseDate", m.release_date);
  setIf(fields, "addedAt", m.org_details?.added_at);
  setIf(fields, "lastUsedAt", m.org_details?.last_used_at);
  return makeInstance({
    accountId,
    typeId: "model-api",
    externalId: m.name,
    displayName: m.display_name || m.name,
    fields,
    outputs: m.invoke_url ? { invokeUrl: m.invoke_url } : {},
  });
}
