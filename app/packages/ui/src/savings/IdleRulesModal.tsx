import { useCallback, useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  formatIdleValue,
  IDLE_FINDING_LIMITS,
  type IdleFindingSettings,
  type IdleFindingsOverview,
  type IdleRuleOverride,
  type IdleRuleThresholdView,
  type IdleRuleView,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { useDataString } from "../i18n/data-strings.js";
import { formatErrorMessage } from "../utils.js";
import type { IdleFindingsClient } from "./types.js";

export interface IdleRulesModalProps {
  client: IdleFindingsClient;
  onClose: () => void;
  /** Called after a save or a re-scan so the list can refresh. */
  onChanged?: (() => void) | undefined;
  /** Open a help link outside the app shell (desktop); anchors otherwise. */
  onOpenExternal?: ((url: string) => void) | undefined;
}

/**
 * Bytes thresholds are typed in megabytes: nobody thinks of "1 MB of NAT
 * traffic in two weeks" as 1000000. Everything else is typed as declared.
 */
const BYTES_PER_INPUT_UNIT = 1_000_000;

function toInput(t: Pick<IdleRuleThresholdView, "unit">, value: number): string {
  return t.unit === "bytes" ? String(value / BYTES_PER_INPUT_UNIT) : String(value);
}

function fromInput(t: Pick<IdleRuleThresholdView, "unit">, raw: string): number {
  const n = Number(raw);
  return t.unit === "bytes" ? Math.round(n * BYTES_PER_INPUT_UNIT) : n;
}

/** Draft of one rule: the switch and every threshold as typed. */
interface RuleDraft {
  enabled: boolean;
  thresholds: Record<string, string>;
}

function draftsFrom(rules: IdleRuleView[]): Record<string, RuleDraft> {
  const out: Record<string, RuleDraft> = {};
  for (const r of rules) {
    out[r.ruleKey] = {
      enabled: r.enabled,
      thresholds: Object.fromEntries(r.thresholds.map((t) => [t.key, toInput(t, t.value)])),
    };
  }
  return out;
}

/**
 * Tuning for the metric-based idle rules: the master switch, the lookback
 * window, each rule's switch and thresholds, and per-account collection
 * status (which is what explains an empty list: a credential that cannot
 * read metrics says so here). Saving stores only what differs from each
 * rule's declared default, so a default a plugin later improves reaches orgs
 * that never changed it.
 */
export function IdleRulesModal({
  client,
  onClose,
  onChanged,
  onOpenExternal,
}: IdleRulesModalProps) {
  const gt = useGT();
  const gtData = useDataString();
  const [overview, setOverview] = useState<IdleFindingsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [lookback, setLookback] = useState("14");
  const [drafts, setDrafts] = useState<Record<string, RuleDraft>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await client.overview();
      setOverview(next);
      setEnabled(next.settings.enabled);
      setLookback(String(next.settings.lookbackDays));
      setDrafts(draftsFrom(next.rules));
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const byPlugin = useMemo(() => {
    const groups = new Map<string, IdleRuleView[]>();
    for (const r of overview?.rules ?? []) {
      const list = groups.get(r.pluginName) ?? [];
      list.push(r);
      groups.set(r.pluginName, list);
    }
    return [...groups.entries()];
  }, [overview]);

  const lookbackValue = Number(lookback);
  const lookbackValid =
    Number.isInteger(lookbackValue) &&
    lookbackValue >= IDLE_FINDING_LIMITS.minLookbackDays &&
    lookbackValue <= IDLE_FINDING_LIMITS.maxLookbackDays;

  function thresholdError(t: IdleRuleThresholdView, raw: string): string | null {
    if (raw.trim() === "" || !Number.isFinite(Number(raw))) return gt("Enter a number");
    const v = fromInput(t, raw);
    if (v < t.min || v > t.max) {
      return gt("From {min} to {max}", {
        min: formatIdleValue(t.min, t.unit),
        max: formatIdleValue(t.max, t.unit),
      });
    }
    return null;
  }

  const invalid =
    !lookbackValid ||
    (overview?.rules ?? []).some((r) =>
      r.thresholds.some(
        (t) => thresholdError(t, drafts[r.ruleKey]?.thresholds[t.key] ?? "") !== null,
      ),
    );

  async function save() {
    if (!overview || invalid) return;
    const rules: Record<string, IdleRuleOverride> = {};
    for (const r of overview.rules) {
      const d = drafts[r.ruleKey];
      if (!d) continue;
      const entry: IdleRuleOverride = {};
      if (!d.enabled) entry.enabled = false;
      const thresholds: Record<string, number> = {};
      for (const t of r.thresholds) {
        const v = fromInput(t, d.thresholds[t.key] ?? "");
        if (v !== t.default) thresholds[t.key] = v;
      }
      if (Object.keys(thresholds).length > 0) entry.thresholds = thresholds;
      if (entry.enabled !== undefined || entry.thresholds) rules[r.ruleKey] = entry;
    }
    const settings: IdleFindingSettings = { enabled, lookbackDays: lookbackValue, rules };
    setSaving(true);
    setError(null);
    try {
      await client.save(settings);
      setNotice(gt("Saved. Every account is re-scanned on the next collection."));
      onChanged?.();
      await load();
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function rescan() {
    setError(null);
    try {
      await client.rescan();
      setNotice(gt("Re-scan scheduled. New findings appear after the next collection."));
      await load();
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  }

  function helpLink(url: string, label: string) {
    return onOpenExternal ? (
      <button
        type="button"
        onClick={() => onOpenExternal(url)}
        className="underline hover:text-on-surface"
      >
        {label}
      </button>
    ) : (
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="underline hover:text-on-surface"
      >
        {label}
      </a>
    );
  }

  return (
    <Modal onClose={onClose} ariaLabel={gt("Idle rules")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[min(720px,calc(100vw-32px))] max-h-[85vh] overflow-y-auto p-6 flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">{gt("Idle rules")}</h2>
          <p className="mt-1 text-xs text-on-surface-secondary">
            {gt(
              "Each rule reads the provider's metrics over the lookback window once a day and flags resources whose usage stays under its thresholds. The reads are billed to your own cloud accounts.",
            )}
          </p>
        </div>

        {error !== null && (
          <div role="alert" className="text-sm text-danger">
            {error}
          </div>
        )}
        {notice !== null && (
          <p role="status" className="text-xs text-on-surface-secondary">
            {notice}
          </p>
        )}
        {overview === null && error === null && (
          <p role="status" className="text-sm text-on-surface-faint">
            {gt("Loading idle rules…")}
          </p>
        )}

        {overview !== null && (
          <>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-on-surface">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                {gt("Run idle rules for this organization")}
              </label>
              <label className="flex items-center gap-2 text-sm text-on-surface">
                {gt("Lookback window")}
                <input
                  type="number"
                  min={IDLE_FINDING_LIMITS.minLookbackDays}
                  max={IDLE_FINDING_LIMITS.maxLookbackDays}
                  step={1}
                  value={lookback}
                  onChange={(e) => setLookback(e.target.value)}
                  aria-invalid={!lookbackValid}
                  className="w-20 rounded-lg border border-border bg-surface px-2 py-1 text-sm text-on-surface"
                />
                {gt("days")}
              </label>
              {!lookbackValid && (
                <span className="text-xs text-danger">
                  {gt("From {min} to {max} days", {
                    min: IDLE_FINDING_LIMITS.minLookbackDays,
                    max: IDLE_FINDING_LIMITS.maxLookbackDays,
                  })}
                </span>
              )}
            </div>

            {byPlugin.length === 0 && (
              <p className="text-sm text-on-surface-faint">
                {gt("None of the connected providers declare idle rules.")}
              </p>
            )}

            {byPlugin.map(([pluginName, rules]) => (
              <fieldset key={pluginName} className="flex flex-col gap-2" disabled={!enabled}>
                <legend className="text-xs font-medium uppercase tracking-wide text-on-surface-tertiary">
                  {gtData(pluginName)}
                </legend>
                {rules.map((rule) => {
                  const d = drafts[rule.ruleKey];
                  if (!d) return null;
                  return (
                    <div
                      key={rule.ruleKey}
                      className="rounded-lg border border-border p-3 flex flex-col gap-2"
                    >
                      <label className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={d.enabled}
                          onChange={(e) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [rule.ruleKey]: { ...d, enabled: e.target.checked },
                            }))
                          }
                        />
                        <span>
                          <span className="text-sm font-medium text-on-surface">
                            {gtData(rule.label)}
                          </span>
                          <span className="block text-xs text-on-surface-secondary">
                            {gtData(rule.description)}
                          </span>
                          {rule.resourceTypeNames.length > 0 && (
                            <span className="block text-xs text-on-surface-faint">
                              {rule.resourceTypeNames.map((n) => gtData(n)).join(", ")}
                            </span>
                          )}
                        </span>
                      </label>
                      {rule.thresholds.length > 0 && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pl-6">
                          {rule.thresholds.map((t) => {
                            const raw = d.thresholds[t.key] ?? "";
                            const problem = thresholdError(t, raw);
                            const inputId = `idle-${rule.ruleKey}-${t.key}`;
                            return (
                              <div key={t.key} className="flex flex-col gap-0.5">
                                <label
                                  htmlFor={inputId}
                                  className="text-xs text-on-surface-secondary"
                                >
                                  {gtData(t.label)}
                                  <span className="ml-1 text-on-surface-faint">
                                    {t.unit === "bytes"
                                      ? gt("(MB)")
                                      : t.unit === "percent"
                                        ? "(%)"
                                        : ""}
                                  </span>
                                </label>
                                <input
                                  id={inputId}
                                  type="number"
                                  step="any"
                                  value={raw}
                                  disabled={!d.enabled || !enabled}
                                  aria-invalid={problem !== null}
                                  title={t.description ? gtData(t.description) : undefined}
                                  onChange={(e) =>
                                    setDrafts((prev) => ({
                                      ...prev,
                                      [rule.ruleKey]: {
                                        ...d,
                                        thresholds: { ...d.thresholds, [t.key]: e.target.value },
                                      },
                                    }))
                                  }
                                  className="rounded-lg border border-border bg-surface px-2 py-1 text-sm text-on-surface"
                                />
                                <span
                                  className={`text-xs ${problem ? "text-danger" : "text-on-surface-faint"}`}
                                >
                                  {problem ??
                                    gt("Default {value}", {
                                      value: formatIdleValue(t.default, t.unit),
                                    })}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </fieldset>
            ))}

            {overview.accounts.length > 0 && (
              <div className="flex flex-col gap-1">
                <h3 className="text-xs font-medium uppercase tracking-wide text-on-surface-tertiary">
                  {gt("Collection")}
                </h3>
                <ul className="flex flex-col gap-1">
                  {overview.accounts.map((a) => (
                    <li key={a.accountId} className="text-xs text-on-surface-secondary">
                      <span className="text-on-surface">{a.accountName}</span>{" "}
                      <span className="text-on-surface-faint">{gtData(a.pluginName)}</span>
                      {" · "}
                      {a.lastPolledAt
                        ? gt("last read {date}, {count} flagged", {
                            date: new Date(a.lastPolledAt).toLocaleString(),
                            count: a.findingCount,
                          })
                        : gt("not read yet")}
                      {a.lastError && (
                        <span className="block text-danger">
                          {a.lastError}
                          {a.helpUrl && (
                            <> {helpLink(a.helpUrl, a.helpLabel ?? gt("How to fix"))}</>
                          )}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => void rescan()}
            disabled={overview === null}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
          >
            {gt("Re-scan now")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            {gt("Close")}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={overview === null || invalid || saving}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-50"
          >
            {saving ? gt("Saving…") : gt("Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
