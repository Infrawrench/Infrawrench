import type { ResourceInstance } from "@infrawrench/plugin-base";
import { type CloudflareApi, withCloudflareErrors } from "./shared.js";
import { toFile } from "cloudflare";
import {
  buildWorkerSettingDescriptors,
  applyWorkerSettingChanges,
  type WorkerSettings,
} from "./worker-settings-meta.js";

export async function listWorkers(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const account_id = await api.getAccountId();
  const out: ResourceInstance[] = [];
  for await (const s of api.cf.workers.scripts.list({ account_id })) {
    const name = s.id ?? "";
    // `tail_consumers` names the Workers this one streams its logs to. It is on
    // the list response already, so surfacing it costs nothing and gives the
    // dependency graph a worker → worker edge.
    const tailConsumers = (s.tail_consumers ?? [])
      .map((t) => t.service)
      .filter(Boolean)
      .join(", ");
    out.push({
      id: `${accountId}:worker:${name}`,
      pluginId: "cloudflare",
      resourceTypeId: "worker",
      accountId,
      displayName: name,
      fields: {
        name,
        createdOn: s.created_on ?? "",
        modifiedOn: s.modified_on ?? "",
        compatibilityDate: s.compatibility_date ?? "",
        routes: "",
        tailConsumers,
      },
      resolvedOutputs: { workerName: name },
      secretStates: [],
      externalId: name,
      createdAt: s.created_on ?? new Date().toISOString(),
      updatedAt: s.modified_on ?? new Date().toISOString(),
    });
  }
  return out;
}

export async function createWorker(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const name = fields["name"] ?? "";
  const script =
    fields["script"] ?? 'export default { async fetch() { return new Response("Hello"); } };';
  const compatibilityDate =
    fields["compatibilityDate"] ?? new Date().toISOString().split("T")[0] ?? "";

  const file = await toFile(Buffer.from(script), "worker.js", {
    type: "application/javascript+module",
  });
  await api.cf.workers.scripts.update(name, {
    account_id,
    metadata: {
      main_module: "worker.js",
      compatibility_date: compatibilityDate,
    },
    files: [file],
  });

  const now = new Date().toISOString();
  return {
    id: `${accountId}:worker:${name}`,
    pluginId: "cloudflare",
    resourceTypeId: "worker",
    accountId,
    displayName: name,
    fields: {
      name,
      createdOn: now,
      modifiedOn: now,
      compatibilityDate,
      routes: "",
      tailConsumers: "",
    },
    resolvedOutputs: { workerName: name },
    secretStates: [],
    externalId: name,
    createdAt: now,
    updatedAt: now,
  };
}

export async function deleteWorker(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.workers.scripts.delete(externalId, { account_id });
}

/**
 * Build the Worker "Settings" form. Reads the rich script-and-version settings
 * (compatibility, usage model, placement, limits, bindings, observability,
 * logpush, tags, tail consumers), plus the workers.dev subdomain state and cron
 * triggers (each a separate endpoint), and returns labeled `SettingDescriptor`s
 * so the host renders a settings form (settingsEditor capability) instead of a
 * raw JSON editor. The subdomain/cron lookups are best-effort — a missing scope
 * shouldn't blank the whole form.
 */
export async function getWorkerManifest(api: CloudflareApi, externalId: string): Promise<string> {
  return withCloudflareErrors(async () => {
    const account_id = await api.getAccountId();
    const raw = await api.cf.workers.scripts.scriptAndVersionSettings.get(externalId, {
      account_id,
    });
    const settings: WorkerSettings = {
      logpush: raw.logpush ?? false,
      observability: raw.observability
        ? {
            enabled: raw.observability.enabled,
            head_sampling_rate: raw.observability.head_sampling_rate ?? null,
          }
        : null,
      placement: raw.placement && "mode" in raw.placement ? { mode: raw.placement.mode } : null,
      tags: raw.tags ?? [],
      usage_model: raw.usage_model ?? "",
      tail_consumers: (raw.tail_consumers ?? []).map((t) => ({
        service: t.service,
        ...(t.environment !== undefined ? { environment: t.environment } : {}),
        ...(t.namespace !== undefined ? { namespace: t.namespace } : {}),
      })),
      compatibility_date: raw.compatibility_date ?? "",
      compatibility_flags: raw.compatibility_flags ?? [],
      limits: raw.limits?.cpu_ms != null ? { cpu_ms: raw.limits.cpu_ms } : null,
      bindings: raw.bindings ?? [],
    };

    let subdomainEnabled: boolean | undefined;
    try {
      const sub = await api.cf.workers.scripts.subdomain.get(externalId, { account_id });
      subdomainEnabled = sub.enabled ?? false;
    } catch {
      subdomainEnabled = undefined;
    }

    let crons: string[] = [];
    try {
      const sched = await api.cf.workers.scripts.schedules.get(externalId, { account_id });
      crons = (sched.schedules ?? []).map((s) => s.cron);
    } catch {
      crons = [];
    }

    const descriptors = buildWorkerSettingDescriptors({
      settings,
      crons,
      ...(subdomainEnabled !== undefined ? { subdomainEnabled } : {}),
    });
    return JSON.stringify({ settings: descriptors });
  });
}

/**
 * Apply changed Worker settings rows. The form sends back a JSON array of
 * changed `{ id, value }` pairs; we route each to its endpoint — script settings
 * (logpush/observability/tags), the workers.dev subdomain toggle, and cron
 * triggers. Read-only deployment fields never produce changes here.
 */
export async function applyWorkerManifest(
  api: CloudflareApi,
  externalId: string,
  manifest: string,
): Promise<void> {
  const changed = JSON.parse(manifest) as Array<{ id: string; value: string }>;
  if (!Array.isArray(changed))
    throw new Error("Worker settings must be an array of {id, value} objects");

  await withCloudflareErrors(async () => {
    const account_id = await api.getAccountId();
    const current = (await api.cf.workers.scripts.settings.get(externalId, {
      account_id,
    })) as WorkerSettings;
    const apply = applyWorkerSettingChanges(current, changed);

    if (apply.settings) {
      // SettingEditParams takes these as top-level body params; this endpoint
      // only accepts logpush/observability/tags (the others are deploy-time).
      await api.cf.workers.scripts.settings.edit(externalId, {
        account_id,
        logpush: apply.settings.logpush,
        tags: apply.settings.tags,
        observability: apply.settings.observability,
      });
    }
    if (apply.subdomainEnabled !== undefined) {
      await api.cf.workers.scripts.subdomain.create(externalId, {
        account_id,
        enabled: apply.subdomainEnabled,
      });
    }
    if (apply.crons !== undefined) {
      await api.cf.workers.scripts.schedules.update(externalId, {
        account_id,
        body: apply.crons.map((cron) => ({ cron })),
      });
    }
  });
}
