import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ROUTER_BASE } from "./http.js";
import type {
  Compute,
  Endpoint,
  Job,
  MemberToken,
  RepoInfo,
  RouterModel,
  ScheduledJob,
  ServiceAccount,
  Vendors,
  Webhook,
} from "./wire.js";

export const PLUGIN_ID = "huggingface";

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, string | number | boolean>,
  extra: { createdAt?: string; resolvedOutputs?: Record<string, string> } = {},
): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    externalId,
    fields,
    resolvedOutputs: extra.resolvedOutputs ?? {},
    secretStates: [],
    createdAt: extra.createdAt || now,
    updatedAt: now,
  };
}

/** The part of an `{accountId}:{typeId}:{externalId}` id after the type. */
export function externalIdOf(resourceId: string, accountId: string, typeId: string): string {
  const prefix = `${accountId}:${typeId}:`;
  if (resourceId.startsWith(prefix)) return resourceId.slice(prefix.length);
  // Tolerate ids built against another account id (contract tests, peers).
  const marker = `:${typeId}:`;
  const at = resourceId.indexOf(marker);
  return at >= 0 ? resourceId.slice(at + marker.length) : resourceId;
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** Price per replica-hour for an endpoint's compute, from the provider catalogue. */
export function priceFor(vendors: Vendors | undefined, endpoint: Endpoint): number | undefined {
  const vendor = endpoint.provider?.vendor;
  const region = endpoint.provider?.region;
  const type = endpoint.compute?.instanceType;
  const size = endpoint.compute?.instanceSize;
  for (const v of vendors?.vendors ?? []) {
    if (v.name !== vendor) continue;
    for (const r of v.regions ?? []) {
      if (r.name !== region) continue;
      const hit = (r.computes ?? []).find(
        (c) => c.instanceType === type && c.instanceSize === size,
      );
      if (hit && typeof hit.pricePerHour === "number") return hit.pricePerHour;
    }
  }
  return undefined;
}

/** Computes offered in one vendor/region that can actually be picked. */
export function pickableComputes(
  vendors: Vendors | undefined,
  vendor: string,
  region: string,
): Compute[] {
  for (const v of vendors?.vendors ?? []) {
    if (v.name !== vendor) continue;
    for (const r of v.regions ?? []) {
      if (r.name !== region) continue;
      return (r.computes ?? []).filter(
        (c) => c.id && c.status !== "not_available" && c.status !== "deprecated",
      );
    }
  }
  return [];
}

export function computeLabel(c: Compute): string {
  const count = c.numAccelerators && c.numAccelerators > 1 ? `${c.numAccelerators}× ` : "";
  return `${count}${c.architecture ?? c.instanceType ?? "?"} (${c.instanceSize ?? "x1"})`;
}

export function computeDescription(c: Compute): string {
  const parts: string[] = [];
  if (c.numCpus) parts.push(`${c.numCpus} vCPU`);
  if (c.memoryGb) parts.push(`${c.memoryGb} GB RAM`);
  if (c.gpuMemoryGb) parts.push(`${c.gpuMemoryGb} GB VRAM`);
  if (typeof c.pricePerHour === "number") parts.push(`$${c.pricePerHour.toFixed(3)}/h`);
  if (c.status && c.status !== "available") parts.push(c.status.replace(/_/g, " "));
  return parts.join(" · ");
}

export function mapEndpoint(
  accountId: string,
  endpoint: Endpoint,
  vendors?: Vendors,
  namespace = "",
): ResourceInstance {
  const name = str(endpoint.name);
  const url = str(endpoint.status?.url);
  const scaling = endpoint.compute?.scaling ?? {};
  const price = priceFor(vendors, endpoint);
  return instance(
    accountId,
    "hf-inference-endpoint",
    name,
    name,
    {
      name,
      namespace,
      state: str(endpoint.status?.state),
      repository: str(endpoint.model?.repository),
      revision: str(endpoint.model?.revision),
      task: str(endpoint.model?.task),
      framework: str(endpoint.model?.framework),
      container: containerName(endpoint.model?.image),
      vendor: str(endpoint.provider?.vendor),
      region: str(endpoint.provider?.region),
      accelerator: str(endpoint.compute?.accelerator),
      instanceType: str(endpoint.compute?.instanceType),
      instanceSize: str(endpoint.compute?.instanceSize),
      minReplica: scaling.minReplica ?? 0,
      maxReplica: scaling.maxReplica ?? 0,
      scaleToZeroTimeout: scaling.scaleToZeroTimeout ?? "",
      type: str(endpoint.type),
      tags: (endpoint.tags ?? []).join(", "),
      url,
      readyReplica: endpoint.status?.readyReplica ?? 0,
      targetReplica: endpoint.status?.targetReplica ?? 0,
      pricePerHour: price ?? "",
      message: str(endpoint.status?.errorMessage || endpoint.status?.message),
      createdBy: str(endpoint.status?.createdBy?.name),
      createdAt: str(endpoint.status?.createdAt),
      updatedAt: str(endpoint.status?.updatedAt),
      lastUsedAt: str(endpoint.status?.lastUsedAt),
      inferenceMetrics: endpoint.status?.inferenceMetricsEnabled === true,
    },
    {
      createdAt: str(endpoint.status?.createdAt),
      resolvedOutputs: {
        ...(url
          ? { url, chatCompletionsUrl: `${url.replace(/\/+$/, "")}/v1/chat/completions` }
          : {}),
        name,
      },
    },
  );
}

/** The container kind: the single key of the `image` one-of (`tgi`, `vLLM`, …). */
export function containerName(image: Record<string, unknown> | undefined): string {
  if (!image) return "";
  const key = Object.keys(image)[0] ?? "";
  const labels: Record<string, string> = {
    huggingface: "Hugging Face Inference Toolkit",
    huggingfaceNeuron: "Hugging Face Inference Toolkit (Neuron)",
    tgi: "Text Generation Inference",
    tgiNeuron: "Text Generation Inference (Neuron)",
    tei: "Text Embeddings Inference",
    llamacpp: "llama.cpp",
    vLLM: "vLLM",
    vLLMOmni: "vLLM Omni",
    vLLMNeuron: "vLLM (Neuron)",
    sGLang: "SGLang",
    hfServe: "HF Serve",
    custom: "Custom container",
  };
  return labels[key] ?? key;
}

export type RepoKind = "model" | "dataset" | "space";

export function repoUrl(kind: RepoKind, repoId: string): string {
  const prefix = kind === "model" ? "" : `${kind}s/`;
  return `https://huggingface.co/${prefix}${repoId}`;
}

function gatedValue(gated: unknown): string {
  if (gated === "auto" || gated === "manual") return gated;
  return "off";
}

export function mapRepo(
  accountId: string,
  kind: "model" | "dataset",
  repo: RepoInfo,
): ResourceInstance {
  const repoId = str(repo.id);
  const typeId = kind === "model" ? "hf-model" : "hf-dataset";
  return instance(
    accountId,
    typeId,
    repoId,
    repoId,
    {
      repoId,
      visibility: repo.private ? "private" : "public",
      gated: gatedValue(repo.gated),
      disabled: repo.disabled === true,
      ...(kind === "model"
        ? { pipelineTag: str(repo.pipeline_tag), libraryName: str(repo.library_name) }
        : {}),
      downloads: repo.downloads ?? 0,
      likes: repo.likes ?? 0,
      usedStorage: repo.usedStorage ?? 0,
      lastModified: str(repo.lastModified),
      createdAt: str(repo.createdAt),
    },
    { createdAt: str(repo.createdAt), resolvedOutputs: { repoId, url: repoUrl(kind, repoId) } },
  );
}

export function mapSpace(accountId: string, repo: RepoInfo): ResourceInstance {
  const repoId = str(repo.id);
  const runtime = repo.runtime ?? {};
  const subdomain = str(repo.subdomain);
  const appUrl = subdomain ? `https://${subdomain}.hf.space` : "";
  return instance(
    accountId,
    "hf-space",
    repoId,
    repo.cardData?.title || repoId,
    {
      repoId,
      visibility: repo.private ? "private" : "public",
      sdk: str(repo.sdk),
      stage: str(runtime.stage),
      hardware: str(runtime.hardware?.current),
      requestedHardware: str(runtime.hardware?.requested),
      sleepTimeSeconds: runtime.gcTimeout ?? "",
      storage: str(runtime.storage),
      errorMessage: str(runtime.errorMessage),
      subdomain,
      likes: repo.likes ?? 0,
      usedStorage: repo.usedStorage ?? 0,
      lastModified: str(repo.lastModified),
      createdAt: str(repo.createdAt),
    },
    {
      createdAt: str(repo.createdAt),
      resolvedOutputs: { repoId, url: repoUrl("space", repoId), ...(appUrl ? { appUrl } : {}) },
    },
  );
}

/** Render an argv array as a shell-ish line for display. */
export function commandLine(command: string[] | undefined, args?: string[]): string {
  return [...(command ?? []), ...(args ?? [])]
    .map((part) => (/[\s"'$]/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

export function mapJob(accountId: string, job: Job): ResourceInstance {
  const id = str(job.id);
  return instance(
    accountId,
    "hf-job",
    id,
    job.dockerImage || job.spaceId ? `${id.slice(0, 12)} · ${job.dockerImage || job.spaceId}` : id,
    {
      jobId: id,
      stage: str(job.status?.stage),
      message: str(job.status?.message || job.status?.cancelReason),
      dockerImage: str(job.dockerImage),
      spaceId: str(job.spaceId),
      command: commandLine(job.command, job.arguments),
      flavor: str(job.flavor),
      timeoutSeconds: job.timeout ?? "",
      runningSecs: job.durations?.runningSecs ?? "",
      createdBy: str(job.createdBy?.name),
      createdAt: str(job.createdAt),
      startedAt: str(job.startedAt),
      finishedAt: str(job.finishedAt),
    },
    { createdAt: str(job.createdAt), resolvedOutputs: { jobId: id } },
  );
}

export function mapScheduledJob(
  accountId: string,
  job: ScheduledJob,
  namespace = "",
): ResourceInstance {
  const id = str(job.id);
  const spec = job.jobSpec ?? {};
  return instance(
    accountId,
    "hf-scheduled-job",
    id,
    `${job.schedule ?? ""} · ${spec.dockerImage || spec.spaceId || id}`,
    {
      scheduledJobId: id,
      namespace,
      schedule: str(job.schedule),
      suspended: job.suspend === true,
      suspendReason: str(job.suspendReason),
      concurrency: job.concurrency === true,
      dockerImage: str(spec.dockerImage || spec.spaceId),
      command: commandLine(spec.command),
      flavor: str(spec.flavor),
      lastJobId: str(job.status?.lastJob?.id),
      lastRunAt: str(job.status?.lastJob?.at),
      nextRunAt: str(job.status?.nextJobRunAt),
      createdAt: str(job.createdAt),
    },
    { createdAt: str(job.createdAt), resolvedOutputs: { scheduledJobId: id } },
  );
}

export function mapProviderModel(accountId: string, model: RouterModel): ResourceInstance {
  const id = str(model.id);
  const live = (model.providers ?? []).filter((p) => p.status !== "offline" && p.provider);
  const inputs = live
    .map((p) => p.pricing?.input)
    .filter((v): v is number => typeof v === "number");
  const outputs = live
    .map((p) => p.pricing?.output)
    .filter((v): v is number => typeof v === "number");
  const contexts = live
    .map((p) => p.context_length)
    .filter((v): v is number => typeof v === "number");
  return instance(
    accountId,
    "hf-provider-model",
    id,
    id,
    {
      modelId: id,
      ownedBy: str(model.owned_by),
      inputModalities: (model.architecture?.input_modalities ?? []).join(", "),
      outputModalities: (model.architecture?.output_modalities ?? []).join(", "),
      providers: live.map((p) => p.provider).join(", "),
      providerCount: live.length,
      cheapestInput: inputs.length ? Math.min(...inputs) : "",
      cheapestOutput: outputs.length ? Math.min(...outputs) : "",
      maxContextLength: contexts.length ? Math.max(...contexts) : "",
      providerDetails: JSON.stringify(model.providers ?? []),
    },
    {
      ...(model.created ? { createdAt: new Date(model.created * 1000).toISOString() } : {}),
      resolvedOutputs: { modelId: id, baseUrl: ROUTER_BASE },
    },
  );
}

export function mapServiceAccount(accountId: string, sa: ServiceAccount): ResourceInstance {
  const id = str(sa._id);
  return instance(
    accountId,
    "hf-service-account",
    id,
    sa.name || sa.user || id,
    {
      serviceAccountId: id,
      name: str(sa.name),
      username: str(sa.user),
      description: str(sa.description),
      email: str(sa.email),
      tokenCount: sa.accessTokens ? sa.accessTokens.length : "",
      createdAt: str(sa.createdAt),
    },
    { createdAt: str(sa.createdAt), resolvedOutputs: { username: str(sa.user) } },
  );
}

export function mapMemberToken(accountId: string, token: MemberToken): ResourceInstance {
  const id = str(token._id);
  const owner = str(token.owner?.name);
  return instance(
    accountId,
    "hf-member-token",
    id,
    [owner, token.displayName || (token.last4 ? `…${token.last4}` : id)]
      .filter(Boolean)
      .join(" · "),
    {
      tokenId: id,
      displayName: str(token.displayName),
      owner,
      role: str(token.role),
      last4: str(token.last4),
      status: str(token.authorization?.status),
      createdAt: str(token.createdAt),
      lastUsedAt: str(token.lastUsedAt),
    },
    { createdAt: str(token.createdAt) },
  );
}

export function mapWebhook(accountId: string, hook: Webhook): ResourceInstance {
  const id = str(hook.id);
  const watched = (hook.watched ?? []).map((w) => `${w.type}:${w.name}`).join(", ");
  const target = hook.url || (hook.job ? `Job: ${hook.job.dockerImage || hook.job.spaceId}` : "");
  return instance(
    accountId,
    "hf-webhook",
    id,
    target || id,
    {
      webhookId: id,
      url: str(target),
      watched,
      domains: (hook.domains ?? []).join(", "),
      disabled: hook.disabled === false || hook.disabled === undefined ? "" : String(hook.disabled),
      hasSecret: hook.hasSecret === true,
      lastTriggerAt: str(hook.lastTriggerAt),
    },
    { resolvedOutputs: { webhookId: id } },
  );
}
