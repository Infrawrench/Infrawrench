import { T, useGT } from "gt-react";
import {
  BACKUP_POLICY_LIMITS,
  type BackupPolicy,
  type BackupPolicyInput,
} from "@infrawrench/client-core";

type Gt = ReturnType<typeof useGT>;

export interface PolicyDraft {
  name: string;
  resourceTypeIds: string[];
  tagKey: string;
  tagValue: string;
  maxRpoHours: string;
  minRetentionDays: string;
}

export const EMPTY_DRAFT: PolicyDraft = {
  name: "",
  resourceTypeIds: [],
  tagKey: "",
  tagValue: "",
  maxRpoHours: "24",
  minRetentionDays: "",
};

export function draftToInput(draft: PolicyDraft): BackupPolicyInput {
  const rpo = draft.maxRpoHours.trim();
  const retention = draft.minRetentionDays.trim();
  return {
    name: draft.name,
    resourceTypeIds: draft.resourceTypeIds,
    tagKey: draft.tagKey.trim() === "" ? null : draft.tagKey.trim(),
    tagValue: draft.tagValue.trim() === "" ? null : draft.tagValue.trim(),
    maxRpoHours: rpo === "" ? null : Number(rpo),
    minRetentionDays: retention === "" ? null : Number(retention),
  };
}

export function policyToDraft(policy: BackupPolicy): PolicyDraft {
  return {
    name: policy.name,
    resourceTypeIds: [...policy.resourceTypeIds],
    tagKey: policy.tagKey ?? "",
    tagValue: policy.tagValue ?? "",
    maxRpoHours: policy.maxRpoHours == null ? "" : String(policy.maxRpoHours),
    minRetentionDays: policy.minRetentionDays == null ? "" : String(policy.minRetentionDays),
  };
}

export function PolicyEditor({
  draft,
  onChange,
  resourceTypeOptions,
  disabled,
}: {
  draft: PolicyDraft;
  onChange: (draft: PolicyDraft) => void;
  resourceTypeOptions: ReadonlyArray<{ id: string; label: string }>;
  disabled: boolean;
}) {
  const gt = useGT();
  const inputClass =
    "rounded-lg border border-border bg-surface-raised px-2 py-1 text-xs text-on-surface disabled:opacity-50";
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
        {gt("Name")}
        <input
          type="text"
          value={draft.name}
          disabled={disabled}
          maxLength={BACKUP_POLICY_LIMITS.maxNameLength}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder={gt("Production databases, daily")}
          className={inputClass}
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
          {gt("Maximum RPO (hours)")}
          <input
            type="number"
            min={BACKUP_POLICY_LIMITS.minRpoHours}
            max={BACKUP_POLICY_LIMITS.maxRpoHours}
            value={draft.maxRpoHours}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, maxRpoHours: e.target.value })}
            placeholder={gt("Leave empty for no RPO")}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
          {gt("Minimum retention (days)")}
          <input
            type="number"
            min={BACKUP_POLICY_LIMITS.minRetentionDays}
            max={BACKUP_POLICY_LIMITS.maxRetentionDays}
            value={draft.minRetentionDays}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, minRetentionDays: e.target.value })}
            placeholder={gt("Leave empty for no floor")}
            className={inputClass}
          />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
          {gt("Tag key (optional)")}
          <input
            type="text"
            value={draft.tagKey}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, tagKey: e.target.value })}
            placeholder="env"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
          {gt("Tag value (optional)")}
          <input
            type="text"
            value={draft.tagValue}
            disabled={disabled || draft.tagKey.trim() === ""}
            onChange={(e) => onChange({ ...draft, tagValue: e.target.value })}
            placeholder="production"
            className={inputClass}
          />
        </label>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs text-on-surface-tertiary">
          {gt("Resource types — none selected applies the policy to everything stateful")}
        </legend>
        {resourceTypeOptions.length === 0 ? (
          <T>
            <p className="text-xs text-on-surface-faint">
              No backup-aware resource types are synced yet, so this policy will apply to whatever
              appears once an account with them syncs.
            </p>
          </T>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {resourceTypeOptions.map((option) => {
              const selected = draft.resourceTypeIds.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={disabled}
                  aria-pressed={selected}
                  onClick={() =>
                    onChange({
                      ...draft,
                      resourceTypeIds: selected
                        ? draft.resourceTypeIds.filter((id) => id !== option.id)
                        : [...draft.resourceTypeIds, option.id],
                    })
                  }
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
                    selected
                      ? "border-transparent bg-surface-overlay text-on-surface"
                      : "border-border text-on-surface-tertiary hover:text-on-surface-secondary"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        )}
      </fieldset>
    </div>
  );
}
