import { useState, useEffect } from "react";
import type { CreateFieldConfig, AssociationSource } from "@infrawrench/plugin-base";
import Editor from "@monaco-editor/react";
import { DatetimePicker } from "./DatetimePicker.js";
import { SelectPicker } from "./SelectPicker.js";
import { RegionPicker } from "./RegionPicker.js";
import { SizePicker } from "./SizePicker.js";
import { DiskSlider } from "./DiskSlider.js";
import { ImagePicker } from "./ImagePicker.js";
import { DiskPicker } from "./DiskPicker.js";
import {
  SshKeyPicker,
  type SshKeyEntry,
  type SystemSshKey,
  type AgentSshKey,
} from "./SshKeyPicker.js";
import { ResourcePicker, type ResourcePickerOption } from "./ResourcePicker.js";
import { PolicyPicker } from "./PolicyPicker.js";
import { KeyValueListPicker } from "./KeyValueListPicker.js";

export interface SshKeyPickerCallbacks {
  loadKeys: () => Promise<SshKeyEntry[]>;
  generateKey: (name: string) => Promise<SshKeyEntry & { privateKey?: string }>;
  deleteKey: (id: string) => Promise<void>;
  /** The current user's ID — used to determine which keys are deletable */
  currentUserId?: string;
  /** System-level keys (e.g. from ~/.ssh on desktop). Omit on web. */
  systemKeys?: SystemSshKey[];
  /** Public keys held by the 1Password SSH agent. Desktop-only. */
  onePasswordKeys?: AgentSshKey[];
  /** When false, shows a sign-in prompt instead of cloud keys. Defaults to true. */
  cloudEnabled?: boolean;
  /** When false, hides the cloud keys section entirely (e.g. desktop in local-only mode). Defaults to true. */
  showCloudSection?: boolean;
  /** Called when the user clicks "Sign in" in the cloud keys section. */
  onCloudSignIn?: () => void;
}

export interface ResourcePickerCallbacks {
  loadResources: (
    sources: AssociationSource[],
    accountId: string,
    opts?: { regionHint?: string },
  ) => Promise<ResourcePickerOption[]>;
  /** Account ID to load resources from */
  accountId?: string;
}

export interface FieldActionCallbacks {
  /**
   * Invoked when the user clicks one of `field.actions`. `actionFields`
   * carries the values from the action's inline form panel (when
   * `FieldAction.formFields` is declared); omit for plain one-click actions.
   */
  runAction: (
    fieldKey: string,
    actionId: string,
    actionFields?: Record<string, string>,
  ) => Promise<void>;
  /** Whether an action on this field is currently in flight */
  runningByKey: Record<string, boolean>;
  /** Latest error message for an action on this field, if any */
  errorByKey: Record<string, string | null>;
  /**
   * Per-field refresh counter — bumped on each successful action. Lets the
   * resource picker re-fetch after an inline-create action mints a new
   * resource so the newly-minted resource shows up immediately.
   */
  refreshKeyByKey?: Record<string, number>;
}

export interface FieldRendererProps {
  field: CreateFieldConfig;
  value: string;
  onChange: (v: string) => void;
  /** Cloud-managed + optional system SSH key callbacks. If omitted, falls back to a plain textarea. */
  sshKeyProps?: SshKeyPickerCallbacks;
  /** Resource picker callbacks for association fields */
  resourcePickerProps?: ResourcePickerCallbacks;
  /** Action button callbacks for `field.actions`. Omit to hide the actions. */
  fieldActionProps?: FieldActionCallbacks;
  /**
   * Snapshot of all field values from the surrounding form. Used by the
   * resource-picker so a field with `scopeFromFieldKey: "region"` can read the
   * currently-selected region and pass it as a `regionHint` to the host,
   * which avoids loading resources from every region.
   */
  formValues?: Record<string, string>;
}

export function FieldRenderer({
  field,
  value,
  onChange,
  sshKeyProps,
  resourcePickerProps,
  fieldActionProps,
  formValues,
}: FieldRendererProps) {
  const actions = field.actions ?? [];
  const actionRunning = fieldActionProps?.runningByKey[field.key] ?? false;
  const actionError = fieldActionProps?.errorByKey[field.key] ?? null;
  const actionsBar =
    actions.length > 0 && fieldActionProps ? (
      <div className="mt-2 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {actions.map((a) =>
            a.formFields && a.formFields.length > 0 ? null : (
              <button
                key={a.id}
                type="button"
                disabled={actionRunning}
                onClick={() => void fieldActionProps.runAction(field.key, a.id)}
                title={a.description}
                className="px-3 py-1.5 rounded-md text-xs font-medium border border-border-strong bg-surface-overlay/50 hover:border-blue-500 hover:bg-accent-muted hover:text-accent-on-muted text-on-surface-tertiary transition-colors disabled:opacity-50 disabled:cursor-wait"
              >
                {actionRunning ? "Working…" : a.label}
              </button>
            ),
          )}
          {actionError && (
            <span className="text-xs text-red-400 leading-tight" title={actionError}>
              {actionError.length > 80 ? `${actionError.slice(0, 80)}…` : actionError}
            </span>
          )}
        </div>
        {actions
          .filter((a) => a.formFields && a.formFields.length > 0)
          .map((a) => (
            <ActionFormPanel
              key={a.id}
              action={a}
              fieldKey={field.key}
              runAction={fieldActionProps.runAction}
              running={actionRunning}
            />
          ))}
      </div>
    ) : null;
  // The "code" kind takes over the side pane in split-pane mode and renders
  // edge-to-edge — its container styling differs from regular fields.
  if (field.kind === "code") {
    return (
      <div className="flex flex-col h-full min-h-0">
        <div className="flex items-baseline justify-between px-3 py-2 border-b border-border bg-surface flex-shrink-0">
          <label className="text-xs font-medium text-on-surface-tertiary">
            {field.label}
            {field.required && <span className="text-red-400 ml-1">*</span>}
          </label>
          {field.description && (
            <p className="text-[11px] text-on-surface-faint ml-3 truncate">{field.description}</p>
          )}
        </div>
        <div className="flex-1 min-h-0">
          <Editor
            language={field.codeLanguage ?? "plaintext"}
            value={value}
            theme="vs-dark"
            onChange={(v) => onChange(v ?? "")}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              wordWrap: "on",
              automaticLayout: true,
              tabSize: 2,
              renderWhitespace: "boundary",
              bracketPairColorization: { enabled: true },
              padding: { top: 8 },
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <label className="block text-xs font-medium text-on-surface-tertiary mb-2">
        {field.label}
        {field.required && <span className="text-red-400 ml-1">*</span>}
      </label>
      {field.description && (
        <p className="text-xs text-on-surface-faint mb-2">{field.description}</p>
      )}

      {field.kind === "text" &&
        (field.multiline ? (
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder ?? field.label}
            rows={8}
            spellCheck={false}
            className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-xs font-mono text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500 resize-y"
          />
        ) : (
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder ?? field.label}
            className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500"
          />
        ))}

      {field.kind === "password" && (
        <input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder ?? field.label}
          autoComplete="new-password"
          spellCheck={false}
          className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500"
        />
      )}

      {field.kind === "datetime" && (
        <DatetimePicker
          value={value}
          onChange={onChange}
          mode={field.datetimeMode ?? "datetime"}
          placeholder={field.placeholder}
        />
      )}

      {field.kind === "number" && (
        <input
          type="number"
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.label}
          min={field.minValue}
          max={field.maxValue}
          step={field.stepValue ?? 1}
          className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500"
        />
      )}

      {field.kind === "select" &&
        field.options &&
        (field.options.length <= 4 &&
        Math.max(...field.options.map((opt) => opt.label.length)) < 28 ? (
          <div className="flex gap-2 flex-wrap">
            {field.options.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => onChange(opt.id)}
                className={`px-4 py-2 rounded-lg border text-sm transition-all ${
                  value === opt.id
                    ? "border-blue-500 bg-accent-muted text-accent-on-muted"
                    : "border-border-strong bg-surface-overlay/50 text-on-surface-tertiary hover:border-border-strong"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        ) : (
          <SelectPicker options={field.options} value={value} onChange={onChange} />
        ))}

      {field.kind === "region-picker" && field.regions && (
        <RegionPicker
          regions={field.regions}
          value={value}
          onChange={onChange}
          {...(field.filterByFieldKey
            ? { filterValue: formValues?.[field.filterByFieldKey] ?? "" }
            : {})}
        />
      )}

      {field.kind === "size-picker" && field.sizes && (
        <SizePicker sizes={field.sizes} value={value} onChange={onChange} />
      )}

      {field.kind === "disk-slider" && (
        <DiskSlider
          value={Number(value) || field.defaultGb || field.minGb || 10}
          min={field.minGb ?? 10}
          max={field.maxGb ?? 2000}
          step={field.stepGb ?? 10}
          onChange={(n) => onChange(String(n))}
        />
      )}

      {field.kind === "image-picker" && field.images && (
        <ImagePicker images={field.images} value={value} onChange={onChange} />
      )}

      {field.kind === "disk-picker" && field.disks && (
        <DiskPicker disks={field.disks} value={value} onChange={onChange} />
      )}

      {field.kind === "ssh-key-picker" &&
        (sshKeyProps ? (
          <SshKeyPicker
            value={value}
            onChange={onChange}
            loadKeys={sshKeyProps.loadKeys}
            generateKey={sshKeyProps.generateKey}
            deleteKey={sshKeyProps.deleteKey}
            currentUserId={sshKeyProps.currentUserId}
            systemKeys={sshKeyProps.systemKeys}
            onePasswordKeys={sshKeyProps.onePasswordKeys}
            cloudEnabled={sshKeyProps.cloudEnabled}
            showCloudSection={sshKeyProps.showCloudSection}
            onCloudSignIn={sshKeyProps.onCloudSignIn}
          />
        ) : (
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Paste SSH public key..."
            rows={3}
            className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-xs text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500 font-mono resize-none"
          />
        ))}

      {field.kind === "resource-picker" &&
        field.associationSources &&
        resourcePickerProps &&
        resourcePickerProps.accountId && (
          <ResourcePickerResolver
            sources={field.associationSources}
            accountId={resourcePickerProps.accountId}
            loadResources={resourcePickerProps.loadResources}
            value={value}
            onChange={onChange}
            regionHint={
              field.scopeFromFieldKey ? (formValues?.[field.scopeFromFieldKey] ?? "") : ""
            }
            refreshKey={fieldActionProps?.refreshKeyByKey?.[field.key] ?? 0}
          />
        )}

      {field.kind === "resource-picker" &&
        (!field.associationSources || !resourcePickerProps || !resourcePickerProps.accountId) && (
          <p className="text-xs text-on-surface-faint">Resource picker not available</p>
        )}

      {field.kind === "policy-picker" && field.policies && (
        <PolicyPicker policies={field.policies} value={value} onChange={onChange} />
      )}

      {field.kind === "key-value-list" && field.entryValueOptions && (
        <KeyValueListPicker
          value={value}
          onChange={onChange}
          options={field.entryValueOptions}
          {...(field.entryKeyName ? { keyName: field.entryKeyName } : {})}
          {...(field.entryValueName ? { valueName: field.entryValueName } : {})}
          {...(field.entryKeyLabel ? { keyLabel: field.entryKeyLabel } : {})}
          {...(field.entryKeyPlaceholder ? { keyPlaceholder: field.entryKeyPlaceholder } : {})}
          {...(field.entryValueLabel ? { valueLabel: field.entryValueLabel } : {})}
          {...(field.entryValueDefault ? { valueDefault: field.entryValueDefault } : {})}
          {...(field.addLabel ? { addLabel: field.addLabel } : {})}
          {...(field.minEntries !== undefined ? { minEntries: field.minEntries } : {})}
          {...(field.maxEntries !== undefined ? { maxEntries: field.maxEntries } : {})}
        />
      )}

      {actionsBar}
    </div>
  );
}

function ResourcePickerResolver({
  sources,
  accountId,
  loadResources,
  value,
  onChange,
  regionHint,
  refreshKey,
}: {
  sources: AssociationSource[];
  accountId: string;
  loadResources: (
    sources: AssociationSource[],
    accountId: string,
    opts?: { regionHint?: string },
  ) => Promise<ResourcePickerOption[]>;
  value: string;
  onChange: (v: string) => void;
  /** Empty string disables scoping; the picker queries everywhere as before. */
  regionHint: string;
  /** Bumped by the form to force a refetch after a "+ Create new …" action. */
  refreshKey: number;
}) {
  const [resources, setResources] = useState<ResourcePickerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Re-run only when the *content* of `sources` changes — the array literal
  // is recreated every render in some callers, which would otherwise cause
  // an infinite reload loop.
  const sourcesKey = JSON.stringify(sources);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    loadResources(sources, accountId, regionHint ? { regionHint } : undefined)
      .then((opts) => {
        if (!mounted) return;
        setResources(opts);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!mounted) return;
        setError(e instanceof Error ? e.message : String(e));
        setResources([]);
        setLoading(false);
      });
    return () => {
      mounted = false;
    };
    // sourcesKey is the JSON-stringified content; loadResources/accountId are stable
    // references in their hosts. Listing sourcesKey instead of sources avoids
    // the new-array-each-render → infinite-load loop. regionHint and refreshKey
    // are primitives, so direct dep entries are fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesKey, accountId, loadResources, regionHint, refreshKey]);

  if (loading) {
    return <p className="text-xs text-on-surface-faint py-1">Loading resources...</p>;
  }

  if (error) {
    return (
      <p className="text-xs text-red-400 py-1" title={error}>
        Couldn&apos;t load options: {error}
      </p>
    );
  }

  if (resources.length === 0) {
    return (
      <p className="text-xs text-on-surface-faint py-1">
        No matching resources found in this account.
      </p>
    );
  }

  return <ResourcePicker resources={resources} value={value} onChange={onChange} />;
}

/**
 * Inline mini-form attached to a `FieldAction` that declares `formFields`.
 * Collapsed until the user toggles it open. On submit, the panel's values are
 * passed to the host as `actionFields` — kept separate from the outer create
 * form so the two namespaces can't collide (a "name" field on the action
 * doesn't clobber a "name" field on the resource being created).
 */
function ActionFormPanel({
  action,
  fieldKey,
  runAction,
  running,
}: {
  action: NonNullable<CreateFieldConfig["actions"]>[number];
  fieldKey: string;
  runAction: (
    fieldKey: string,
    actionId: string,
    actionFields?: Record<string, string>,
  ) => Promise<void>;
  running: boolean;
}) {
  const formFields = action.formFields ?? [];
  const initialValues = (): Record<string, string> => {
    const init: Record<string, string> = {};
    for (const f of formFields) init[f.key] = f.defaultValue ?? "";
    return init;
  };
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(initialValues);

  const setValue = (key: string, v: string) => setValues((prev) => ({ ...prev, [key]: v }));

  const isValid = formFields.every((f) => {
    if (!f.required) return true;
    const v = values[f.key];
    return typeof v === "string" && v.trim().length > 0;
  });

  const submit = async () => {
    await runAction(fieldKey, action.id, values);
    setOpen(false);
    setValues(initialValues());
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={running}
        title={action.description}
        className="px-3 py-1.5 rounded-md text-xs font-medium border border-border-strong bg-surface-overlay/50 hover:border-blue-500 hover:bg-accent-muted hover:text-accent-on-muted text-on-surface-tertiary transition-colors disabled:opacity-50 disabled:cursor-wait"
      >
        {action.label}
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-border-strong bg-surface-overlay/30 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-on-surface-tertiary">{action.label}</p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-on-surface-faint hover:text-on-surface-secondary text-xs"
          aria-label="Close"
        >
          &times;
        </button>
      </div>
      {action.description && (
        <p className="text-[11px] text-on-surface-faint leading-snug">{action.description}</p>
      )}
      {formFields.map((f) => (
        <FieldRenderer
          key={f.key}
          field={f}
          value={values[f.key] ?? ""}
          onChange={(v) => setValue(f.key, v)}
        />
      ))}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={running}
          className="px-3 py-1.5 text-xs text-on-surface-tertiary hover:text-on-surface-secondary bg-surface-overlay hover:bg-surface-sunken rounded-md transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={running || !isValid}
          className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-md transition-colors"
        >
          {running ? "Working…" : (action.submitLabel ?? "Create")}
        </button>
      </div>
    </div>
  );
}
