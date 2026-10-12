import { useMemo, useState } from "react";
import { T, useGT } from "gt-react";
import {
  ALERT_SEVERITIES,
  EVENT_CATEGORY_LABELS,
  validateEventSubscriptionInput,
  type AlertSeverity,
  type EventCategory,
  type EventSubscription,
  type EventSubscriptionInput,
  type EventSubscriptionOptions,
  type EventTypeInfo,
} from "@infrawrench/client-core";
import { useDataString } from "../../i18n/data-strings.js";
import { Field, inputClass } from "../notifications/shared.js";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "../styles.js";

type Kind = "webhook" | "publish";

function initialInput(existing: EventSubscription | null): EventSubscriptionInput {
  if (existing) {
    return {
      name: existing.name,
      enabled: existing.enabled,
      destination: existing.destination,
      eventTypes: existing.eventTypes,
      minSeverity: existing.minSeverity,
      accountIds: existing.accountIds,
      environments: existing.environments,
    };
  }
  return {
    name: "",
    enabled: true,
    destination: { kind: "webhook", url: "" },
    eventTypes: [],
    minSeverity: null,
    accountIds: [],
    environments: [],
  };
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * Create or edit one subscription. Every choice is a picker (event types,
 * accounts, environments seen on resource tags, publish destinations from the
 * synced inventory); the only typed values are the name and a webhook URL.
 */
export function EventSubscriptionForm({
  existing,
  catalog,
  options,
  onSubmit,
  onCancel,
}: {
  existing: EventSubscription | null;
  catalog: EventTypeInfo[];
  options: EventSubscriptionOptions;
  onSubmit: (input: EventSubscriptionInput) => Promise<void>;
  onCancel: () => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const [input, setInput] = useState<EventSubscriptionInput>(() => initialInput(existing));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newEnv, setNewEnv] = useState("");
  const kind: Kind = input.destination.kind;

  const byCategory = useMemo(() => {
    const groups = new Map<EventCategory, EventTypeInfo[]>();
    for (const t of catalog) {
      const list = groups.get(t.category) ?? [];
      list.push(t);
      groups.set(t.category, list);
    }
    return [...groups.entries()];
  }, [catalog]);

  const environments = useMemo(
    () => [...new Set([...options.environments, ...input.environments])],
    [options.environments, input.environments],
  );

  const set = (patch: Partial<EventSubscriptionInput>) => setInput((i) => ({ ...i, ...patch }));
  const allEvents = input.eventTypes.length === 0;
  const allBlockedByCost = allEvents && !options.canSubscribeToCost;
  const selectedSink =
    input.destination.kind === "publish"
      ? `${input.destination.accountId}|${input.destination.resourceTypeId}|${input.destination.resourceId}`
      : "";

  const severityLabel = (s: AlertSeverity): string =>
    s === "info" ? gt("Info") : s === "warning" ? gt("Warning") : gt("Critical");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problem = validateEventSubscriptionInput(input);
    if (problem) {
      setError(gtData(problem));
      return;
    }
    if (allBlockedByCost) {
      setError(
        gt(
          "Receiving every event includes cost events, which needs the costs:read permission. Pick event types instead.",
        ),
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(input);
    } catch (err) {
      setError(err instanceof Error ? err.message : gt("Failed to save the subscription"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="space-y-5 border border-border rounded-xl p-5"
    >
      <h3 className="text-sm font-semibold text-on-surface-secondary">
        {existing ? gt("Edit subscription") : gt("New subscription")}
      </h3>

      <Field label={gt("Name")}>
        <input
          className={inputClass}
          value={input.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder={gt("e.g. Ops event bus")}
          maxLength={120}
        />
      </Field>

      <fieldset className="space-y-2">
        <legend className="block text-xs text-on-surface-tertiary mb-1">{gt("Destination")}</legend>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="event-destination-kind"
              checked={kind === "webhook"}
              disabled={Boolean(existing) && kind !== "webhook"}
              onChange={() => set({ destination: { kind: "webhook", url: "" } })}
            />
            {gt("HTTPS webhook")}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="event-destination-kind"
              checked={kind === "publish"}
              disabled={Boolean(existing) && kind !== "publish"}
              onChange={() =>
                set({
                  destination: {
                    kind: "publish",
                    accountId: "",
                    resourceTypeId: "",
                    resourceId: "",
                  },
                })
              }
            />
            {gt("Event bus or topic in a connected account")}
          </label>
        </div>
        {input.destination.kind === "webhook" ? (
          <Field
            label={gt("Webhook URL")}
            hint={gt(
              "Must be https. Every request is signed; the secret is shown once after you save.",
            )}
          >
            <input
              className={inputClass}
              value={input.destination.url}
              onChange={(e) => set({ destination: { kind: "webhook", url: e.target.value } })}
              placeholder="https://hooks.example.com/infrawrench"
              inputMode="url"
            />
          </Field>
        ) : (
          <Field
            label={gt("Publish to")}
            hint={
              options.sinks.length === 0
                ? gt(
                    "No EventBridge rules or Pub/Sub topics in your connected accounts yet. Connect an AWS or GCP account, or create one, and it appears here after the next sync.",
                  )
                : gt(
                    "EventBridge receives each event on the rule's bus with source infrawrench and the event type as detail-type. Pub/Sub messages carry eventType and eventId attributes.",
                  )
            }
          >
            <select
              className={inputClass}
              value={selectedSink}
              onChange={(e) => {
                const [accountId = "", resourceTypeId = "", resourceId = ""] =
                  e.target.value.split("|");
                set({ destination: { kind: "publish", accountId, resourceTypeId, resourceId } });
              }}
            >
              <option value="">{gt("Pick a destination…")}</option>
              {options.sinks.map((s) => (
                <option
                  key={`${s.accountId}|${s.resourceTypeId}|${s.resourceId}`}
                  value={`${s.accountId}|${s.resourceTypeId}|${s.resourceId}`}
                >
                  {`${gtData(s.pluginName)} · ${s.accountName} · ${gtData(s.resourceTypeName)}: ${s.resourceName}`}
                </option>
              ))}
            </select>
          </Field>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="block text-xs text-on-surface-tertiary mb-1">{gt("Events")}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allEvents}
            onChange={() =>
              set({
                eventTypes: allEvents
                  ? catalog
                      .filter((t) => options.canSubscribeToCost || !t.carriesCost)
                      .map((t) => t.type)
                  : [],
              })
            }
          />
          {gt("Every event, including types added later")}
        </label>
        {!allEvents && (
          <div className="grid gap-4 sm:grid-cols-2">
            {byCategory.map(([category, types]) => (
              <div key={category} className="space-y-1">
                <p className="text-xs font-medium text-on-surface-tertiary">
                  {gtData(EVENT_CATEGORY_LABELS[category])}
                </p>
                {types.map((t) => {
                  const blocked = t.carriesCost && !options.canSubscribeToCost;
                  return (
                    <label
                      key={t.type}
                      className="flex items-start gap-2 text-sm"
                      title={gtData(t.description)}
                    >
                      <input
                        type="checkbox"
                        className="mt-1"
                        disabled={blocked}
                        checked={input.eventTypes.includes(t.type)}
                        onChange={() => set({ eventTypes: toggle(input.eventTypes, t.type) })}
                      />
                      <span>
                        {gtData(t.label)}
                        <code className="ml-2 text-xs text-on-surface-faint">{t.type}</code>
                        {blocked && (
                          <span className="block text-xs text-on-surface-faint">
                            {gt("Needs costs:read")}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </fieldset>

      <Field label={gt("Minimum severity")} hint={gt("Events below this severity are not sent.")}>
        <select
          className={inputClass}
          value={input.minSeverity ?? ""}
          onChange={(e) =>
            set({ minSeverity: e.target.value === "" ? null : (e.target.value as AlertSeverity) })
          }
        >
          <option value="">{gt("Any severity")}</option>
          {ALERT_SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {severityLabel(s)}
            </option>
          ))}
        </select>
      </Field>

      <fieldset className="space-y-1">
        <legend className="block text-xs text-on-surface-tertiary mb-1">{gt("Accounts")}</legend>
        <T>
          <p className="text-xs text-on-surface-faint">
            Leave all unticked for every account. When any are ticked, events that are not about a
            single account (a drift window across several, a declared incident) are not sent.
          </p>
        </T>
        <div className="grid gap-1 sm:grid-cols-2 max-h-48 overflow-y-auto">
          {options.accounts.map((a) => (
            <label key={a.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={input.accountIds.includes(a.id)}
                onChange={() => set({ accountIds: toggle(input.accountIds, a.id) })}
              />
              {a.name}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-1">
        <legend className="block text-xs text-on-surface-tertiary mb-1">
          {gt("Environments")}
        </legend>
        <T>
          <p className="text-xs text-on-surface-faint">
            Matched against the env, environment or stage tag of the resource an event is about.
            Leave all unticked for every environment.
          </p>
        </T>
        <div className="flex flex-wrap gap-3">
          {environments.map((env) => (
            <label key={env} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={input.environments.includes(env)}
                onChange={() => set({ environments: toggle(input.environments, env) })}
              />
              {env}
            </label>
          ))}
        </div>
        <div className="flex gap-2 max-w-sm">
          <input
            className={inputClass}
            value={newEnv}
            onChange={(e) => setNewEnv(e.target.value)}
            placeholder={gt("Another environment name")}
            aria-label={gt("Another environment name")}
          />
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={!newEnv.trim()}
            onClick={() => {
              set({ environments: [...new Set([...input.environments, newEnv.trim()])] });
              setNewEnv("");
            }}
          >
            {gt("Add")}
          </button>
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={input.enabled}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        {gt("Enabled")}
      </label>

      {error && <p className="text-xs text-danger">{error}</p>}

      <div className="flex gap-2">
        <button type="submit" className={PRIMARY_BUTTON} disabled={saving}>
          {saving ? gt("Saving…") : existing ? gt("Save") : gt("Create subscription")}
        </button>
        <button type="button" className={SECONDARY_BUTTON} onClick={onCancel}>
          {gt("Cancel")}
        </button>
      </div>
    </form>
  );
}
