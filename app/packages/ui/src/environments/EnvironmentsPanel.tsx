import { useCallback, useEffect, useState } from "react";
import { useGT } from "gt-react";
import {
  ENVIRONMENT_LIMITS,
  formatTimeRemaining,
  instanceIsLive,
  normalizeEnvironmentSettings,
  parseTtlDraft,
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

function statusLabel(status: EnvironmentInstanceStatus, gt: ReturnType<typeof useGT>): string {
  switch (status) {
    case "creating":
      return gt("Creating");
    case "active":
      return gt("Running");
    case "partial":
      return gt("Partially created");
    case "tearing-down":
      return gt("Tearing down");
    case "deleted":
      return gt("Torn down");
    case "failed":
      return gt("Failed");
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
  const gt = useGT();
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
              title={statusLabel(instance.status, gt)}
            />
            <span className="truncate text-sm font-medium text-on-surface">{instance.name}</span>
            <span className="text-xs text-on-surface-faint">
              {gt("from {name}", { name: instance.templateName })}
            </span>
            {instance.status === "partial" && (
              <span className="text-xs text-warning">{gt("partially created")}</span>
            )}
          </div>
          <p className="truncate text-xs text-on-surface-secondary">
            {statusLabel(instance.status, gt)} ·{" "}
            {gt("{created}/{total} resources", {
              created: instance.members.filter((m) => m.status === "created").length,
              total: instance.members.length,
            })}
            {live && gt(" · expires in {time}", { time: formatTimeRemaining(instance.expiresAt) })}
          </p>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {Boolean(client.teardown) && live && (
            <button
              type="button"
              onClick={onTearDown}
              disabled={busy}
              className="rounded-lg px-2 py-1 text-xs text-danger transition-colors hover:bg-surface-sunken disabled:opacity-50"
            >
              {busy ? gt("Working…") : gt("Tear down")}
            </button>
          )}
          {client.forget && !live && (
            <button
              type="button"
              onClick={onForget}
              disabled={busy}
              className="rounded-lg px-2 py-1 text-xs text-on-surface-secondary transition-colors hover:bg-surface-sunken disabled:opacity-50"
            >
              {gt("Forget")}
            </button>
          )}
        </div>
      </div>

      {instance.error && <p className="mt-2 text-xs text-warning">{instance.error}</p>}

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
                  className="text-on-surface underline hover:text-info"
                >
                  {member.displayName}
                </button>
              ) : (
                <span className="text-on-surface">{member.displayName}</span>
              )}
              <span className="text-on-surface-faint">
                {member.pluginId}/{member.resourceTypeId}
              </span>
              {member.error && <span className="text-danger">{member.error}</span>}
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
  const gt = useGT();
  return (
    <li className="flex items-center gap-3 rounded-xl border border-border bg-surface-raised px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-on-surface">{template.name}</p>
        <p className="truncate text-xs text-on-surface-secondary">
          {gt("{count} resource{plural}", {
            count: template.members.length,
            plural: template.members.length === 1 ? "" : "s",
          })}{" "}
          ·{" "}
          {gt("{count} parameter{plural}", {
            count: template.parameters.length,
            plural: template.parameters.length === 1 ? "" : "s",
          })}
          {template.activeInstanceCount
            ? gt(" · {count} live", { count: template.activeInstanceCount })
            : ""}
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
            {gt("Stamp out")}
          </button>
        )}
        {client.deleteTemplate && (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="rounded-lg px-2 py-1 text-xs text-danger transition-colors hover:bg-surface-sunken disabled:opacity-50"
          >
            {gt("Delete")}
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
  const gt = useGT();
  const [maxDraft, setMaxDraft] = useState(String(settings.maxTtlHours));
  const [defaultDraft, setDefaultDraft] = useState(String(settings.defaultTtlHours));

  const maxTtlHours = parseTtlDraft(maxDraft);
  const defaultTtlHours = parseTtlDraft(defaultDraft);

  const save = () => {
    if (maxTtlHours === null || defaultTtlHours === null) return;
    void client
      .updateSettings?.({ ...settings, maxTtlHours, defaultTtlHours })
      .then((next) => {
        if (next) onSaved(next);
      })
      .catch((e: unknown) =>
        onError(e instanceof Error ? e.message : gt("Could not save the limits")),
      );
  };

  return (
    <section>
      <h2 className="text-base font-semibold text-on-surface">{gt("Limits")}</h2>
      <p className="text-xs text-on-surface-faint">
        {gt(
          "Environments spend real money, so they cannot be created without an expiry. This organization allows at most {max} hours, and pre-fills {def}. The hard ceiling is {hardMax} hours — an “ephemeral” environment that outlives a month is just infrastructure nobody owns.",
          {
            max: settings.maxTtlHours,
            def: settings.defaultTtlHours,
            hardMax: ENVIRONMENT_LIMITS.hardMaxTtlHours,
          },
        )}
      </p>
      {client.updateSettings && (
        <div className="mt-2 flex items-end gap-2">
          <label className="text-xs text-on-surface-secondary">
            {gt("Maximum TTL (hours)")}
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
            {gt("Default TTL (hours)")}
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
            {gt("Save limits")}
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
  const gt = useGT();
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
        throw new Error(gt("Failed to load templates"));
      }),
      client.listInstances().catch(() => {
        throw new Error(gt("Failed to load environments"));
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
  }, [client, gt]);

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
        gt(
          'Delete the template "{name}"? Environments already stamped out of it keep running and keep their TTL.',
          { name: template.name },
        ),
      )
    ) {
      return;
    }
    setBusyId(template.id);
    try {
      await client.deleteTemplate?.(template.id);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not delete the template"));
    } finally {
      setBusyId(null);
    }
  };

  const tearDown = async (instance: EnvironmentInstance) => {
    if (
      !window.confirm(
        gt('Tear down "{name}"? This deletes its {count} resource{plural}.', {
          name: instance.name,
          count: instance.members.length,
          plural: instance.members.length === 1 ? "" : "s",
        }),
      )
    ) {
      return;
    }
    setBusyId(instance.id);
    try {
      await client.teardown?.(instance.id);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Teardown failed"));
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
      setError(e instanceof Error ? e.message : gt("Could not remove the record"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-8">
      {error && (
        <p className="text-sm text-danger">
          {error}{" "}
          <button type="button" onClick={reload} className="underline hover:text-danger-strong">
            {gt("Retry")}
          </button>
        </p>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-on-surface">{gt("Environments")}</h2>
            <p className="text-xs text-on-surface-faint">
              {gt(
                "Copies stamped out of a template. Each one carries a lease on every resource it created, so it deletes itself when the countdown runs out.",
              )}
            </p>
          </div>
        </div>

        {instances === null && !error && (
          <p className="text-sm text-on-surface-faint">{gt("Loading environments…")}</p>
        )}
        {instances !== null && instances.length === 0 && (
          <p className="text-sm text-on-surface-faint">
            {gt("No environments yet. Capture a template below, then stamp one out.")}
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
            <h2 className="text-base font-semibold text-on-surface">{gt("Templates")}</h2>
            <p className="text-xs text-on-surface-faint">
              {gt(
                "A parameterised description of an environment you already have, built from each plugin's own create form. References between captured resources are kept as references.",
              )}
            </p>
          </div>
          {Boolean(client.createTemplate) && (
            <button
              type="button"
              onClick={() => setCapturing(true)}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-blue-500"
            >
              {gt("Capture template")}
            </button>
          )}
        </div>

        {templates === null && !error && (
          <p className="text-sm text-on-surface-faint">{gt("Loading templates…")}</p>
        )}
        {templates !== null && templates.length === 0 && (
          <p className="text-sm text-on-surface-faint">
            {gt("No templates yet. Capture one from an account you already have running.")}
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
