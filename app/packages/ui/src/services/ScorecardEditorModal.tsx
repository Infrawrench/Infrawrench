import { useId, useState } from "react";
import { useGT } from "gt-react";
import {
  SCORECARD_CHECK_TYPES,
  SCORECARD_LIMITS,
  SCORECARD_SEVERITIES,
  SERVICE_TIERS,
  defaultScorecardInput,
  defaultScorecardParams,
  normalizeScorecardInput,
  scorecardCheckTypeDef,
  validateScorecardInput,
  type Scorecard,
  type ScorecardCheck,
  type ScorecardCheckType,
  type ScorecardInput,
  type ScorecardLevel,
  type ScorecardParamDef,
  type ScorecardSeverity,
  type ServiceTier,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { useDataString } from "../i18n/data-strings.js";
import {
  errorMessage,
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
  smallButtonClass,
  useTierLabel,
} from "./shared.js";
import type { ServicesClient } from "./types.js";

export interface ScorecardEditorModalProps {
  client: ServicesClient;
  /** Existing scorecard to edit, or null to create one. */
  existing: Scorecard | null;
  onSaved: (scorecard: Scorecard | null) => void;
  onClose: () => void;
}

type Gt = ReturnType<typeof useGT>;

function severityLabel(severity: ScorecardSeverity, gt: Gt): string {
  switch (severity) {
    case "critical":
      return gt("Critical");
    case "high":
      return gt("High");
    case "medium":
      return gt("Medium");
    case "low":
      return gt("Low");
  }
}

/** A check id unique within the scorecard: the type, then type-2, type-3… */
function nextCheckId(type: ScorecardCheckType, checks: readonly ScorecardCheck[]): string {
  const taken = new Set(checks.map((c) => c.id));
  if (!taken.has(type)) return type;
  for (let n = 2; ; n++) {
    const id = `${type}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** A level key derived from its name: "Gold tier" → "gold-tier". */
function levelKeyFrom(name: string, levels: readonly ScorecardLevel[], self: number): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "level";
  const taken = new Set(levels.filter((_, i) => i !== self).map((l) => l.key));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function ParamInput({
  def,
  value,
  onChange,
}: {
  def: ScorecardParamDef;
  value: number | string[] | undefined;
  onChange: (value: number | string[]) => void;
}) {
  const gt = useGT();
  const dataString = useDataString();
  const id = useId();
  const label = dataString(def.label);
  if (def.kind === "number") {
    return (
      <div>
        <label className={labelClass} htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          type="number"
          className={inputClass}
          min={def.min}
          max={def.max}
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
        />
        <p className="mt-0.5 text-[11px] text-on-surface-faint">{dataString(def.description)}</p>
      </div>
    );
  }
  const list = Array.isArray(value) ? value : [];
  if (def.kind === "severity_list") {
    return (
      <fieldset>
        <legend className={labelClass}>{label}</legend>
        <div className="flex flex-wrap gap-3">
          {SCORECARD_SEVERITIES.map((s) => (
            <label key={s} className="flex items-center gap-1.5 text-sm text-on-surface">
              <input
                type="checkbox"
                checked={list.includes(s)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? SCORECARD_SEVERITIES.filter((x) => x === s || list.includes(x))
                      : list.filter((x) => x !== s),
                  )
                }
              />
              {severityLabel(s, gt)}
            </label>
          ))}
        </div>
        <p className="mt-0.5 text-[11px] text-on-surface-faint">{dataString(def.description)}</p>
      </fieldset>
    );
  }
  return (
    <div>
      <label className={labelClass} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        className={inputClass}
        aria-describedby={`${id}-hint`}
        placeholder={gt("Comma-separated, e.g. {example}", { example: "owner, env" })}
        value={list.join(", ")}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean),
          )
        }
      />
      <p id={`${id}-hint`} className="mt-0.5 text-[11px] text-on-surface-faint">
        {dataString(def.description)}
      </p>
    </div>
  );
}

function CheckEditor({
  check,
  onChange,
  onRemove,
}: {
  check: ScorecardCheck;
  onChange: (check: ScorecardCheck) => void;
  onRemove: () => void;
}) {
  const gt = useGT();
  const dataString = useDataString();
  const headingId = useId();
  const nameId = useId();
  const weightId = useId();
  const def = scorecardCheckTypeDef(check.type);
  const typeLabel = def ? dataString(def.label) : check.type;
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="rounded-lg border border-border bg-surface-raised p-2.5 space-y-2"
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div id={headingId} className="text-sm font-medium text-on-surface">
            {typeLabel}
          </div>
          {def && <p className="text-xs text-on-surface-faint">{dataString(def.description)}</p>}
        </div>
        <button
          type="button"
          onClick={onRemove}
          className={`${smallButtonClass} text-danger shrink-0`}
          aria-label={gt("Remove check {name}", { name: typeLabel })}
        >
          {gt("Remove")}
        </button>
      </div>
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <div>
          <label className={labelClass} htmlFor={nameId}>
            {gt("Name override (optional)")}
          </label>
          <input
            id={nameId}
            type="text"
            className={inputClass}
            maxLength={SCORECARD_LIMITS.checkNameMaxLength}
            placeholder={typeLabel}
            value={check.name ?? ""}
            onChange={(e) => onChange({ ...check, name: e.target.value || null })}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor={weightId}>
            {gt("Weight")}
          </label>
          <input
            id={weightId}
            type="number"
            className={inputClass}
            min={SCORECARD_LIMITS.minWeight}
            max={SCORECARD_LIMITS.maxWeight}
            step={1}
            value={Number.isFinite(check.weight) ? check.weight : ""}
            onChange={(e) =>
              onChange({
                ...check,
                weight: e.target.value === "" ? Number.NaN : Number(e.target.value),
              })
            }
          />
        </div>
      </div>
      {(def?.params ?? []).map((p) => (
        <ParamInput
          key={p.key}
          def={p}
          value={check.params[p.key]}
          onChange={(v) => onChange({ ...check, params: { ...check.params, [p.key]: v } })}
        />
      ))}
    </div>
  );
}

function LevelRow({
  level,
  index,
  levels,
  onChange,
  onRemove,
}: {
  level: ScorecardLevel;
  index: number;
  levels: readonly ScorecardLevel[];
  onChange: (level: ScorecardLevel) => void;
  onRemove: () => void;
}) {
  const gt = useGT();
  const n = index + 1;
  return (
    <div className="grid grid-cols-[1fr_8rem_5rem_auto_auto] items-center gap-2">
      <input
        type="text"
        aria-label={gt("Level {n} name", { n })}
        className={inputClass}
        maxLength={SCORECARD_LIMITS.levelNameMaxLength}
        placeholder={gt("Gold")}
        value={level.name}
        onChange={(e) => onChange({ ...level, name: e.target.value })}
        // A new level's key is derived from its name once it is typed. An
        // existing key is never rewritten: alerts and history store it.
        onBlur={() => {
          if (!level.key) onChange({ ...level, key: levelKeyFrom(level.name, levels, index) });
        }}
      />
      <input
        type="text"
        aria-label={gt("Level {n} key", { n })}
        className={`${inputClass} font-mono`}
        maxLength={40}
        placeholder={gt("key")}
        value={level.key}
        onChange={(e) => onChange({ ...level, key: e.target.value.toLowerCase() })}
      />
      <input
        type="number"
        aria-label={gt("Level {n} minimum score", { n })}
        className={inputClass}
        min={0}
        max={100}
        value={Number.isFinite(level.minScore) ? level.minScore : ""}
        onChange={(e) =>
          onChange({
            ...level,
            minScore: e.target.value === "" ? Number.NaN : Number(e.target.value),
          })
        }
      />
      <span className="flex items-center gap-1">
        <input
          type="color"
          aria-label={gt("Level {n} colour", { n })}
          className="h-8 w-8 rounded border border-border bg-surface-sunken"
          value={level.color ?? "#9aa4ad"}
          onChange={(e) => onChange({ ...level, color: e.target.value })}
        />
        {level.color && (
          <button
            type="button"
            className={smallButtonClass}
            onClick={() => onChange({ ...level, color: null })}
            aria-label={gt("Clear level {n} colour", { n })}
          >
            {gt("Clear")}
          </button>
        )}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className={`${smallButtonClass} text-danger`}
        aria-label={gt("Remove level {n}", { n })}
      >
        {gt("Remove")}
      </button>
    </div>
  );
}

/**
 * The scorecard editor: checks from the shared registry (each with its weight
 * and the parameters its type defines), the level ladder, which tiers the
 * scorecard applies to, and whether a level drop alerts.
 */
export function ScorecardEditorModal({
  client,
  existing,
  onSaved,
  onClose,
}: ScorecardEditorModalProps) {
  const gt = useGT();
  const dataString = useDataString();
  const tierLabel = useTierLabel();
  const nameId = useId();
  const descriptionId = useId();
  const addCheckId = useId();
  const levelsId = useId();
  const checksId = useId();
  const initial: ScorecardInput = existing
    ? {
        name: existing.name,
        description: existing.description,
        checks: existing.checks,
        levels: existing.levels,
        applicableTiers: existing.applicableTiers,
        alertOnLevelDrop: existing.alertOnLevelDrop,
        enabled: existing.enabled,
      }
    : { ...defaultScorecardInput(), name: "" };
  const [draft, setDraft] = useState<ScorecardInput>(initial);
  const [addType, setAddType] = useState<ScorecardCheckType>(
    SCORECARD_CHECK_TYPES[0]?.type ?? "has_owner",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<ScorecardInput>) => setDraft((d) => ({ ...d, ...patch }));

  const toggleTier = (tier: ServiceTier, on: boolean) =>
    set({
      applicableTiers: on
        ? SERVICE_TIERS.filter((t) => t === tier || draft.applicableTiers.includes(t))
        : draft.applicableTiers.filter((t) => t !== tier),
    });

  const addCheck = () => {
    const def = scorecardCheckTypeDef(addType);
    if (!def) return;
    set({
      checks: [
        ...draft.checks,
        {
          id: nextCheckId(addType, draft.checks),
          type: addType,
          name: null,
          weight: def.defaultWeight,
          params: defaultScorecardParams(addType),
        },
      ],
    });
  };

  const save = async () => {
    const levels = draft.levels.map((l, i) =>
      l.key ? l : { ...l, key: levelKeyFrom(l.name, draft.levels, i) },
    );
    const input = normalizeScorecardInput({ ...draft, levels });
    const problem = validateScorecardInput(input);
    if (problem) {
      setError(problem);
      return;
    }
    if (existing ? !client.updateScorecard : !client.createScorecard) {
      setError(gt("Editing scorecards isn't available here."));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = existing
        ? await client.updateScorecard!(existing.id, input)
        : await client.createScorecard!(input);
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(errorMessage(e, gt("Failed to save the scorecard")));
    } finally {
      setSaving(false);
    }
  };

  const dismiss = () => {
    if (!saving) onClose();
  };

  return (
    <Modal onClose={dismiss} ariaLabel={existing ? gt("Edit scorecard") : gt("New scorecard")}>
      <div className="w-[42rem] max-w-[94vw] max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-xl">
        <h2 className="text-sm font-semibold text-on-surface">
          {existing ? gt("Edit scorecard") : gt("New scorecard")}
        </h2>
        <p className="mt-1 text-xs text-on-surface-secondary">
          {gt(
            "A service's score is the weight of its passing checks over the weight of the checks that apply to it. A check with nothing to judge is left out rather than failed.",
          )}
        </p>

        <div className="mt-4 flex flex-col gap-3">
          <div>
            <label className={labelClass} htmlFor={nameId}>
              {gt("Name")}
            </label>
            <input
              id={nameId}
              type="text"
              className={inputClass}
              maxLength={SCORECARD_LIMITS.nameMaxLength}
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder={gt("Production readiness")}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={descriptionId}>
              {gt("Description (optional)")}
            </label>
            <textarea
              id={descriptionId}
              rows={2}
              className={inputClass}
              maxLength={SCORECARD_LIMITS.descriptionMaxLength}
              value={draft.description ?? ""}
              onChange={(e) => set({ description: e.target.value || null })}
            />
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-sm text-on-surface">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => set({ enabled: e.target.checked })}
              />
              {gt("Enabled")}
            </label>
            <label className="flex items-center gap-2 text-sm text-on-surface">
              <input
                type="checkbox"
                checked={draft.alertOnLevelDrop}
                onChange={(e) => set({ alertOnLevelDrop: e.target.checked })}
              />
              {gt("Alert when a service drops a level")}
            </label>
          </div>

          <fieldset>
            <legend className={labelClass}>{gt("Applies to")}</legend>
            <div className="flex flex-wrap gap-3">
              {SERVICE_TIERS.map((t) => (
                <label key={t} className="flex items-center gap-1.5 text-sm text-on-surface">
                  <input
                    type="checkbox"
                    checked={draft.applicableTiers.includes(t)}
                    onChange={(e) => toggleTier(t, e.target.checked)}
                  />
                  {tierLabel(t)}
                </label>
              ))}
            </div>
            <p className="mt-0.5 text-xs text-on-surface-faint">
              {draft.applicableTiers.length === 0
                ? gt("No tier ticked: every service, tiered or not.")
                : gt("Only services in the ticked tiers.")}
            </p>
          </fieldset>

          <div role="group" aria-labelledby={checksId}>
            <span id={checksId} className={labelClass}>
              {gt("Checks")}
            </span>
            <div className="space-y-2">
              {draft.checks.map((check, i) => (
                <CheckEditor
                  key={check.id}
                  check={check}
                  onChange={(next) =>
                    set({ checks: draft.checks.map((c, j) => (j === i ? next : c)) })
                  }
                  onRemove={() => set({ checks: draft.checks.filter((_, j) => j !== i) })}
                />
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label className="sr-only" htmlFor={addCheckId}>
                {gt("Check to add")}
              </label>
              <select
                id={addCheckId}
                className={`${inputClass} flex-1`}
                value={addType}
                onChange={(e) => setAddType(e.target.value as ScorecardCheckType)}
              >
                {SCORECARD_CHECK_TYPES.map((d) => (
                  <option key={d.type} value={d.type}>
                    {dataString(d.label)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={draft.checks.length >= SCORECARD_LIMITS.maxChecks}
                onClick={addCheck}
              >
                {gt("Add check")}
              </button>
            </div>
          </div>

          <div role="group" aria-labelledby={levelsId}>
            <div className="flex items-center justify-between mb-1">
              <span id={levelsId} className="text-xs font-medium text-on-surface-secondary">
                {gt("Levels")}
              </span>
              <button
                type="button"
                className={smallButtonClass}
                disabled={draft.levels.length >= SCORECARD_LIMITS.maxLevels}
                onClick={() =>
                  set({
                    levels: [...draft.levels, { key: "", name: "", minScore: 100, color: null }],
                  })
                }
              >
                {gt("Add level")}
              </button>
            </div>
            <p className="text-xs text-on-surface-faint mb-1.5">
              {gt(
                "Name, key, minimum score (0 to 100) and colour. A service reaches the highest level whose minimum its score meets.",
              )}
            </p>
            <div className="space-y-1.5">
              {draft.levels.map((level, i) => (
                <LevelRow
                  key={i}
                  level={level}
                  index={i}
                  levels={draft.levels}
                  onChange={(next) =>
                    set({ levels: draft.levels.map((l, j) => (j === i ? next : l)) })
                  }
                  onRemove={() => set({ levels: draft.levels.filter((_, j) => j !== i) })}
                />
              ))}
            </div>
          </div>

          {error !== null && (
            <div role="alert" className="text-sm text-danger">
              {error}
            </div>
          )}

          <div className="mt-1 flex justify-end gap-2">
            <button type="button" onClick={dismiss} disabled={saving} className={secondaryButtonClass}>
              {gt("Cancel")}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className={primaryButtonClass}
            >
              {saving ? gt("Saving…") : existing ? gt("Save") : gt("Create scorecard")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
