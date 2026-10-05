import { useEffect, useId, useState } from "react";
import { useGT } from "gt-react";
import {
  COST_ANOMALY_FEEDBACK_LIMITS,
  COST_ANOMALY_FEEDBACK_REASONS,
  COST_ANOMALY_RECURRENCES,
  COST_ANOMALY_SUPPRESSION_SCOPES,
  costAnomalySuppressionInputError,
  defaultSuppressionExpiry,
  upcomingSuppressedDays,
  type CostAnomalyFeedbackReason,
  type CostAnomalyRecurrence,
  type CostAnomalySuppression,
  type CostAnomalySuppressionInput,
  type CostAnomalySuppressionScope,
} from "@infrawrench/client-core";

import { Modal } from "../components/Modal.js";
import {
  formatFeedbackDay,
  todayIsoDay,
  useAnomalyFeedbackLabels,
} from "./anomaly-feedback-labels.js";
import type { CostsClient } from "./types.js";

const fieldClass =
  "rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500 disabled:opacity-60";

interface Option {
  value: string;
  label: string;
}

/**
 * Options for one scope's value picker: providers, services, accounts and tag
 * values come from the cost dimensions the org actually has; cost centres from
 * the org's centre list. Null while loading, and an empty list when the host
 * cannot list them, in which case the field falls back to free text.
 */
function useScopeOptions(
  client: CostsClient,
  scope: CostAnomalySuppressionScope,
  tagKey: string,
): Option[] | null {
  const [options, setOptions] = useState<Option[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setOptions(null);
    void (async () => {
      try {
        let next: Option[] = [];
        if (scope === "cost_centre") {
          const centres = client.listCostCentres ? await client.listCostCentres() : [];
          next = centres.map((c) => ({ value: c.id, label: c.name }));
        } else if (scope === "tag") {
          next = tagKey ? await client.loadDimensionValues("tag", tagKey) : [];
        } else {
          next = await client.loadDimensionValues(scope);
        }
        if (!cancelled) setOptions(next);
      } catch {
        if (!cancelled) setOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, scope, tagKey]);
  return options;
}

function useTagKeys(client: CostsClient, enabled: boolean): Option[] | null {
  const [keys, setKeys] = useState<Option[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await client.loadDimensionValues("tag-keys");
        if (!cancelled) setKeys(next);
      } catch {
        if (!cancelled) setKeys([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, enabled]);
  return keys;
}

/** A select over `options` that keeps an unknown current value selectable. */
function PickerOrText({
  id,
  value,
  options,
  placeholder,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  options: Option[] | null;
  placeholder: string;
  disabled?: boolean | undefined;
  onChange: (value: string) => void;
}) {
  const gt = useGT();
  if (options === null) {
    return (
      <select id={id} disabled className={fieldClass}>
        <option>{gt("Loading…")}</option>
      </select>
    );
  }
  if (options.length === 0) {
    return (
      <input
        id={id}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={fieldClass}
      />
    );
  }
  const known = options.some((o) => o.value === value);
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={fieldClass}
    >
      <option value="">{placeholder}</option>
      {!known && value !== "" && <option value={value}>{value}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export interface ScopeValue {
  scope: CostAnomalySuppressionScope;
  scopeKey: string;
  tagKey: string;
}

/**
 * What a suppression covers: a scope kind and a value picked from what the
 * org actually has, so nobody types an account id or a plugin slug.
 */
export function SuppressionScopeFields({
  client,
  value,
  onChange,
  disabled,
}: {
  client: CostsClient;
  value: ScopeValue;
  onChange: (next: ScopeValue) => void;
  disabled?: boolean;
}) {
  const gt = useGT();
  const labels = useAnomalyFeedbackLabels();
  const uid = useId();
  const options = useScopeOptions(client, value.scope, value.tagKey);
  const tagKeys = useTagKeys(client, value.scope === "tag");
  const scopes = COST_ANOMALY_SUPPRESSION_SCOPES.filter(
    (s) => s !== "cost_centre" || Boolean(client.listCostCentres),
  );

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1" htmlFor={`${uid}-scope`}>
        <span className="text-xs text-on-surface-secondary">{gt("Covers")}</span>
        <select
          id={`${uid}-scope`}
          value={value.scope}
          disabled={disabled}
          onChange={(e) =>
            onChange({
              scope: e.target.value as CostAnomalySuppressionScope,
              scopeKey: "",
              tagKey: "",
            })
          }
          className={fieldClass}
        >
          {scopes.map((s) => (
            <option key={s} value={s}>
              {labels.scope(s)}
            </option>
          ))}
        </select>
      </label>
      {value.scope === "tag" && (
        <label className="flex flex-col gap-1" htmlFor={`${uid}-tagkey`}>
          <span className="text-xs text-on-surface-secondary">{gt("Tag key")}</span>
          <PickerOrText
            id={`${uid}-tagkey`}
            value={value.tagKey}
            options={tagKeys}
            placeholder={gt("Choose a tag key")}
            disabled={disabled}
            onChange={(tagKey) => onChange({ ...value, tagKey, scopeKey: "" })}
          />
        </label>
      )}
      <label className="flex flex-col gap-1" htmlFor={`${uid}-key`}>
        <span className="text-xs text-on-surface-secondary">
          {value.scope === "tag" ? gt("Tag value") : labels.scope(value.scope)}
        </span>
        <PickerOrText
          id={`${uid}-key`}
          value={value.scopeKey}
          options={value.scope === "tag" && !value.tagKey ? [] : options}
          placeholder={gt("Choose…")}
          disabled={disabled || (value.scope === "tag" && !value.tagKey)}
          onChange={(scopeKey) => onChange({ ...value, scopeKey })}
        />
      </label>
    </div>
  );
}

/** "Covers next: Oct 6, Oct 13, Oct 20", or nothing once it has expired. */
export function UpcomingDaysLine({
  pattern,
}: {
  pattern: Pick<CostAnomalySuppression, "recurrence" | "anchorDay" | "startsOn" | "expiresOn">;
}) {
  const gt = useGT();
  const days = upcomingSuppressedDays(pattern, todayIsoDay(), 3);
  if (days.length === 0) {
    return <p className="text-[11px] text-on-surface-faint">{gt("Covers no future days.")}</p>;
  }
  return (
    <p className="text-[11px] text-on-surface-faint">
      {gt("Next covered: {days}", { days: days.map(formatFeedbackDay).join(", ") })}
    </p>
  );
}

/**
 * Create or edit a suppression by hand: the same fields an `expected` verdict
 * fills in for you, all editable.
 */
export function SuppressionEditorModal({
  client,
  existing,
  onSaved,
  onClose,
}: {
  client: CostsClient;
  existing: CostAnomalySuppression | null;
  onSaved: (saved: CostAnomalySuppression) => void;
  onClose: () => void;
}) {
  const gt = useGT();
  const labels = useAnomalyFeedbackLabels();
  const uid = useId();
  const today = todayIsoDay();
  const [scope, setScope] = useState<ScopeValue>({
    scope: existing?.scope ?? "service",
    scopeKey: existing?.scopeKey ?? "",
    tagKey: existing?.tagKey ?? "",
  });
  const [recurrence, setRecurrence] = useState<CostAnomalyRecurrence>(
    existing?.recurrence ?? "one_off",
  );
  const [anchorDay, setAnchorDay] = useState(existing?.anchorDay ?? today);
  const [startsOn, setStartsOn] = useState(existing?.startsOn ?? today);
  const [expiresOn, setExpiresOn] = useState(
    existing?.expiresOn ?? defaultSuppressionExpiry("one_off", today),
  );
  const [reason, setReason] = useState<CostAnomalyFeedbackReason | "">(existing?.reason ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const input: CostAnomalySuppressionInput = {
    scope: scope.scope,
    scopeKey: scope.scopeKey,
    ...(scope.scope === "tag" ? { tagKey: scope.tagKey } : {}),
    recurrence,
    anchorDay,
    startsOn,
    expiresOn,
    reason: reason || null,
    note: note.trim() || null,
  };
  const problem = costAnomalySuppressionInputError(input);
  const save = existing ? client.updateAnomalySuppression : client.createAnomalySuppression;

  async function submit() {
    if (!save || problem) return;
    setBusy(true);
    setError(null);
    try {
      const saved = existing
        ? await client.updateAnomalySuppression!(existing.id, input)
        : await client.createAnomalySuppression!(input);
      onSaved(saved);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={existing ? gt("Edit suppression") : gt("Add suppression")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[520px] max-w-full p-6 flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold text-on-surface mb-1">
            {existing ? gt("Edit suppression") : gt("Add suppression")}
          </h2>
          <p className="text-xs text-on-surface-faint">
            {gt(
              "On covered days, spend in this scope is ignored by detection. Spend beyond it still alerts.",
            )}
          </p>
        </div>

        {error !== null && (
          <div role="alert" className="text-sm text-danger">
            {error}
          </div>
        )}

        <SuppressionScopeFields client={client} value={scope} onChange={setScope} disabled={busy} />

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1" htmlFor={`${uid}-rec`}>
            <span className="text-xs text-on-surface-secondary">{gt("Repeats")}</span>
            <select
              id={`${uid}-rec`}
              value={recurrence}
              disabled={busy}
              onChange={(e) => setRecurrence(e.target.value as CostAnomalyRecurrence)}
              className={fieldClass}
            >
              {COST_ANOMALY_RECURRENCES.map((r) => (
                <option key={r} value={r}>
                  {labels.recurrence(r)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${uid}-anchor`}>
            <span className="text-xs text-on-surface-secondary">{gt("Pattern day")}</span>
            <input
              id={`${uid}-anchor`}
              type="date"
              value={anchorDay}
              disabled={busy}
              onChange={(e) => setAnchorDay(e.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${uid}-start`}>
            <span className="text-xs text-on-surface-secondary">{gt("Starts")}</span>
            <input
              id={`${uid}-start`}
              type="date"
              value={startsOn}
              disabled={busy}
              onChange={(e) => setStartsOn(e.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${uid}-expires`}>
            <span className="text-xs text-on-surface-secondary">{gt("Expires")}</span>
            <input
              id={`${uid}-expires`}
              type="date"
              value={expiresOn}
              disabled={busy}
              onChange={(e) => setExpiresOn(e.target.value)}
              className={fieldClass}
            />
          </label>
        </div>
        <UpcomingDaysLine pattern={{ recurrence, anchorDay, startsOn, expiresOn }} />

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1" htmlFor={`${uid}-reason`}>
            <span className="text-xs text-on-surface-secondary">{gt("Reason")}</span>
            <select
              id={`${uid}-reason`}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value as CostAnomalyFeedbackReason | "")}
              className={fieldClass}
            >
              <option value="">{gt("No reason")}</option>
              {COST_ANOMALY_FEEDBACK_REASONS.map((r) => (
                <option key={r} value={r}>
                  {labels.reason(r)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${uid}-note`}>
            <span className="text-xs text-on-surface-secondary">{gt("Note")}</span>
            <input
              id={`${uid}-note`}
              value={note}
              disabled={busy}
              maxLength={COST_ANOMALY_FEEDBACK_LIMITS.noteMaxLength}
              onChange={(e) => setNote(e.target.value)}
              className={fieldClass}
            />
          </label>
        </div>

        {problem && scope.scopeKey !== "" && <p className="text-xs text-danger">{problem}</p>}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            {gt("Cancel")}
          </button>
          <button
            type="button"
            disabled={busy || problem !== null || !save}
            onClick={() => void submit()}
            className="rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-sm text-white transition-colors disabled:opacity-50"
          >
            {busy ? gt("Saving…") : gt("Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
