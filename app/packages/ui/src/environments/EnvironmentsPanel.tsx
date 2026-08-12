import { useCallback, useEffect, useState } from "react";
import {
  ENVIRONMENT_LIMITS,
  formatTimeRemaining,
  instanceIsLive,
  normalizeEnvironmentSettings,
  type EnvironmentInstance,
  type EnvironmentInstanceStatus,
} from "@infrawrench/client-core";
import { CaptureTemplateModal } from "./CaptureTemplateModal.js";
import { InstantiateModal } from "./InstantiateModal.js";
import type {
  EnvironmentAccount,
  EnvironmentSettings,
  EnvironmentTemplate,
  EnvironmentsClient,
} from "./types.js";

export interface EnvironmentsPanelProps {
  client: EnvironmentsClient;
}

function statusDotClass(status: EnvironmentInstanceStatus): string {
  switch (status) {
    case "active":
      return "bg-emerald-500";
    case "creating":
    case "tearing-down":
      return "bg-blue-500";
    case "partial":
      return "bg-amber-500";
    case "failed":
      return "bg-red-500";
    default:
      return "bg-neutral-500";
  }
}

function statusLabel(status: EnvironmentInstanceStatus): string {
  switch (status) {
    case "creating":
      return "Creating";
    case "active":
      return "Running";
    case "partial":
      return "Partially created";
    case "tearing-down":
      return "Tearing down";
    case "deleted":
      return "Torn down";
    case "failed":
      return "Failed";
  }
}

function InstanceItem({
  client,
  instance,
  expanded,
  busy,
  onToggle,
  onTearDown,
  onForget,
}: {
  client: EnvironmentsClient;
  instance: EnvironmentInstance;
  expanded: boolean;
  busy: boolean;
  onToggle(): void;
  onTearDown(): void;
  onForget(): void;
}) {
  const live = instanceIsLive(instance);
  return (
    <li className="rounded-xl border border-border bg-surface-raised px-4 py-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2 w-2 rounded-full ${statusDotClass(instance.status)}`}
              title={statusLabel(instance.status)}
            />
            <span className="truncate text-sm font-medium text-on-surface">{instance.name}</span>
            <span className="text-xs text-on-surface-faint">from {instance.templateName}</span>
            {instance.status === "partial" && (
              <span className="text-xs text-amber-400">partially created</span>
            )}
          </div>
          <p className="truncate text-xs text-on-surface-secondary">
            {statusLabel(instance.status)} ·{" "}
            {instance.members.filter((m) => m.status === "created").length}/
            {instance.members.length} resources
            {live && ` · expires in ${formatTimeRemaining(instance.expiresAt)}`}
          </p>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {Boolean(client.teardown) && live && (
            <button
              type="button"
              onClick={onTearDown}
              disabled={busy}
              className="rounded-lg px-2 py-1 text-xs text-red-400 transition-colors hover:bg-surface-sunken disabled:opacity-50"
            >
              {busy ? "Working…" : "Tear down"}
            </button>
          )}
          {client.forget && !live && (
            <button
              type="button"
              onClick={onForget}
              disabled={busy}
              className="rounded-lg px-2 py-1 text-xs text-on-surface-secondary transition-colors hover:bg-surface-sunken disabled:opacity-50"
            >
              Forget
            </button>
          )}
        </div>
      </div>

      {instance.error && <p className="mt-2 text-xs text-amber-400">{instance.error}</p>}

      {expanded && (
        <ul className="mt-3 space-y-1 border-t border-border pt-3">
          {instance.members.map((member) => (
            <li key={member.id} className="flex items-center gap-2 text-xs">
              <span className="text-on-surface-faint">{member.status}</span>
              {member.resourceId && client.openResource ? (
                <button
                  type="button"
                  onClick={() =>
                    client.openResource?.({
                      accountId: member.accountId,
                      resourceId: member.resourceId!,
                      pluginId: member.pluginId,
                      resourceTypeId: member.resourceTypeId,
                    })
                  }
                  className="text-on-surface underline hover:text-blue-400"
                >
                  {member.displayName}
                </button>
              ) : (
                <span className="text-on-surface">{member.displayName}</span>
              )}
              <span className="text-on-surface-faint">
                {member.pluginId}/{member.resourceTypeId}
              </span>
              {member.error && <span className="text-red-400">{member.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function TemplateItem({
  client,
  template,
  busy,
  onInstantiate,
  onDelete,
}: {
  client: EnvironmentsClient;
  template: EnvironmentTemplate;
  busy: boolean;
  onInstantiate(): void;
  onDelete(): void;
}) {
  return (
    <li className="flex items-center gap-3 rounded-xl border border-border bg-surface-raised px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-on-surface">{template.name}</p>
        <p className="truncate text-xs text-on-surface-secondary">
          {template.members.length} resource{template.members.length === 1 ? "" : "s"} ·{" "}
          {template.parameters.length} parameter
          {template.parameters.length === 1 ? "" : "s"}
          {template.activeInstanceCount ? ` · ${template.activeInstanceCount} live` : ""}
          {template.description ? ` · ${template.description}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {Boolean(client.instantiate) && (
          <button
            type="button"
            onClick={onInstantiate}
            className="rounded-lg bg-surface-sunken px-2.5 py-1 text-xs text-on-surface transition-colors hover:bg-surface"
          >
            Stamp out
          </button>
        )}
        {client.deleteTemplate && (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="rounded-lg px-2 py-1 text-xs text-red-400 transition-colors hover:bg-surface-sunken disabled:opacity-50"
          >
            Delete
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * The org's TTL ceilings, with an editor when the client can write them.
 *
 * The inputs are text drafts rather than the settings numbers themselves so a
 * cleared field stays cleared instead of coercing to 0 — the parent remounts
 * this (via `key`) when saved or freshly-loaded settings arrive, which is what
 * resets the drafts without an adjustment effect.
 */
function LimitsSection({
  client,
  settings,
  onSaved,
  onError,
}: {
  client: EnvironmentsClient;
  settings: EnvironmentSettings;
  onSaved(next: EnvironmentSettings): void;
  onError(message: string): void;
}) {
  const [maxDraft, setMaxDraft] = useState(String(settings.maxTtlHours));
  const [defaultDraft, setDefaultDraft] = useState(String(settings.defaultTtlHours));

  const parseDraft = (draft: string): number | null => {
    if (draft.trim() === "") return null;
    const parsed = Number(draft);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const maxTtlHours = parseDraft(maxDraft);
  const defaultTtlHours = parseDraft(defaultDraft);

  const save = () => {
    if (maxTtlHours === null || defaultTtlHours === null) return;
    void client
      .updateSettings?.({ ...settings, maxTtlHours, defaultTtlHours })
      .then((next) => {
        if (next) onSaved(next);
      })
      .catch((e: unknown) => onError(e instanceof Error ? e.message : "Could not save the limits"));
  };

  return (
    <section>
      <h2 className="text-base font-semibold text-on-surface">Limits</h2>
      <p className="text-xs text-on-surface-faint">
        Environments spend real money, so they cannot be created without an expiry. This
        organization allows at most {settings.maxTtlHours} hours, and pre-fills{" "}
        {settings.defaultTtlHours}. The hard ceiling is {ENVIRONMENT_LIMITS.hardMaxTtlHours} hours —
        an &ldquo;ephemeral&rdquo; environment that outlives a month is just infrastructure nobody
        owns.
      </p>
      {client.updateSettings && (
        <div className="mt-2 flex items-end gap-2">
          <label className="text-xs text-on-surface-secondary">
            Maximum TTL (hours)
            <input
              type="number"
              min={ENVIRONMENT_LIMITS.minTtlHours}
              max={ENVIRONMENT_LIMITS.hardMaxTtlHours}
              value={maxDraft}
              onChange={(e) => setMaxDraft(e.target.value)}
              className="mt-1 block w-24 rounded-lg border border-border bg-surface px-2 py-1 text-xs text-on-surface"
            />
          </label>
          <label className="text-xs text-on-surface-secondary">
            Default TTL (hours)
            <input
              type="number"
              min={ENVIRONMENT_LIMITS.minTtlHours}
              max={maxTtlHours ?? settings.maxTtlHours}
              value={defaultDraft}
              onChange={(e) => setDefaultDraft(e.target.value)}
              className="mt-1 block w-24 rounded-lg border border-border bg-surface px-2 py-1 text-xs text-on-surface"
            />
          </label>
          <button
            type="button"
            onClick={save}
            disabled={maxTtlHours === null || defaultTtlHours === null}
            className="rounded-lg bg-surface-sunken px-2.5 py-1 text-xs text-on-surface transition-colors hover:bg-surface disabled:opacity-50"
          >
            Save limits
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Ephemeral environments: the templates an org has captured, and the live
 * copies stamped out of them with their TTL counting down.
 *
 * Shared between web and desktop. Write actions are gated on the client
 * exposing the matching optional methods (the `ProbesPanel` convention), so a
 * read-only viewer sees the same page without the buttons rather than buttons
 * that fail.
 */
export function EnvironmentsPanel({ client }: EnvironmentsPanelProps) {
  // null = loading, [] = loaded-empty.
  const [templates, setTemplates] = useState<EnvironmentTemplate[] | null>(null);
  const [instances, setInstances] = useState<EnvironmentInstance[] | null>(null);
  const [accounts, setAccounts] = useState<EnvironmentAccount[]>([]);
  const [settings, setSettings] = useState<EnvironmentSettings>(() =>
    normalizeEnvironmentSettings(null),
  );
  const [capturing, setCapturing] = useState(false);
  const [instantiating, setInstantiating] = useState<EnvironmentTemplate | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Re-render once a minute so the countdowns move without a refetch.
  const [, setTick] = useState(0);

  const reload = useCallback(() => {
    setError(null);
    void Promise.all([
      client.listTemplates().catch(() => {
        throw new Error("Failed to load templates");
      }),
      client.listInstances().catch(() => {
        throw new Error("Failed to load environments");
      }),
    ])
      .then(([nextTemplates, nextInstances]) => {
        setTemplates(nextTemplates);
        setInstances(nextInstances);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    void client
      .listAccounts()
      .then(setAccounts)
      .catch(() => setAccounts([]));
    void client
      .getSettings()
      .then(setSettings)
      .catch(() => undefined);
  }, [client]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const removeTemplate = async (template: EnvironmentTemplate) => {
    if (
      !window.confirm(
        `Delete the template "${template.name}"? Environments already stamped out of it keep running and keep their TTL.`,
      )
    ) {
      return;
    }
    setBusyId(template.id);
    try {
      await client.deleteTemplate?.(template.id);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the template");
    } finally {
      setBusyId(null);
    }
  };

  const tearDown = async (instance: EnvironmentInstance) => {
    if (
      !window.confirm(
        `Tear down "${instance.name}"? This deletes its ${instance.members.length} resource${
          instance.members.length === 1 ? "" : "s"
        }.`,
      )
    ) {
      return;
    }
    setBusyId(instance.id);
    try {
      await client.teardown?.(instance.id);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Teardown failed");
    } finally {
      setBusyId(null);
    }
  };

  const forget = async (instance: EnvironmentInstance) => {
    setBusyId(instance.id);
    try {
      await client.forget?.(instance.id);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the record");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-8">
      {error && (
        <p className="text-sm text-red-400">
          {error}{" "}
          <button type="button" onClick={reload} className="underline hover:text-red-300">
            Retry
          </button>
        </p>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-on-surface">Environments</h2>
            <p className="text-xs text-on-surface-faint">
              Copies stamped out of a template. Each one carries a lease on every resource it
              created, so it deletes itself when the countdown runs out.
            </p>
          </div>
        </div>

        {instances === null && !error && (
          <p className="text-sm text-on-surface-faint">Loading environments…</p>
        )}
        {instances !== null && instances.length === 0 && (
          <p className="text-sm text-on-surface-faint">
            No environments yet. Capture a template below, then stamp one out.
          </p>
        )}

        {instances !== null && instances.length > 0 && (
          <ul className="space-y-2">
            {instances.map((instance) => (
              <InstanceItem
                key={instance.id}
                client={client}
                instance={instance}
                expanded={expandedId === instance.id}
                busy={busyId === instance.id}
                onToggle={() => setExpandedId(expandedId === instance.id ? null : instance.id)}
                onTearDown={() => void tearDown(instance)}
                onForget={() => void forget(instance)}
              />
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-on-surface">Templates</h2>
            <p className="text-xs text-on-surface-faint">
              A parameterised description of an environment you already have, built from each
              plugin&apos;s own create form. References between captured resources are kept as
              references.
            </p>
          </div>
          {Boolean(client.createTemplate) && (
            <button
              type="button"
              onClick={() => setCapturing(true)}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-blue-500"
            >
              Capture template
            </button>
          )}
        </div>

        {templates === null && !error && (
          <p className="text-sm text-on-surface-faint">Loading templates…</p>
        )}
        {templates !== null && templates.length === 0 && (
          <p className="text-sm text-on-surface-faint">
            No templates yet. Capture one from an account you already have running.
          </p>
        )}

        {templates !== null && templates.length > 0 && (
          <ul className="space-y-2">
            {templates.map((template) => (
              <TemplateItem
                key={template.id}
                client={client}
                template={template}
                busy={busyId === template.id}
                onInstantiate={() => setInstantiating(template)}
                onDelete={() => void removeTemplate(template)}
              />
            ))}
          </ul>
        )}
      </section>

      <LimitsSection
        key={`${settings.maxTtlHours}:${settings.defaultTtlHours}`}
        client={client}
        settings={settings}
        onSaved={setSettings}
        onError={setError}
      />

      {capturing && (
        <CaptureTemplateModal
          client={client}
          accounts={accounts}
          onClose={() => setCapturing(false)}
          onCreated={() => {
            setCapturing(false);
            reload();
          }}
        />
      )}
      {instantiating && (
        <InstantiateModal
          client={client}
          template={instantiating}
          settings={settings}
          onClose={() => setInstantiating(null)}
          onCreated={() => {
            setInstantiating(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
