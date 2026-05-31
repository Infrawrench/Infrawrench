import { useState, useEffect, lazy, Suspense } from "react";
import type { CreateFieldConfig, AssociationSource } from "@infrawrench/plugin-base";
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
import { JsonSchemaEditor } from "./JsonSchemaEditor.js";

// Monaco is heavy and browser-only; load it lazily so it splits out of the
// main bundle and only ships when a "code" field is actually rendered.
const Editor = lazy(() => import("@monaco-editor/react"));

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
    opts?: { regionHint?: string; crossAccount?: boolean },
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
        {actions.flatMap((a) =>
          a.formFields && a.formFields.length > 0
            ? [
                <ActionFormPanel
                  key={a.id}
                  action={a}
                  fieldKey={field.key}
                  runAction={fieldActionProps.runAction}
                  running={actionRunning}
                />,
              ]
            : [],
        )}
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
          <Suspense fallback={<p className="text-xs text-on-surface-faint p-3">Loading editor…</p>}>
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
          </Suspense>
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
            aria-label={field.label}
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
            aria-label={field.label}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder ?? field.label}
            className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500"
          />
        ))}

      {field.kind === "hostname" && (
        <HostnameField
          label={field.label}
          suffix={field.hostnameSuffix ?? ""}
          placeholder={field.placeholder}
          withPath={field.hostnamePath ?? false}
          value={value}
          onChange={onChange}
        />
      )}

      {field.kind === "password" && (
        <input
          type="password"
          aria-label={field.label}
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
          aria-label={field.label}
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
        <SizePicker
          sizes={field.sizes}
          value={value}
          onChange={onChange}
          {...(field.filterByFieldKey
            ? { filterValue: formValues?.[field.filterByFieldKey] ?? "" }
            : {})}
        />
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
            aria-label={field.label}
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
            referenceMode={field.referenceMode ?? false}
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

      {field.kind === "json-schema" && <JsonSchemaEditor value={value} onChange={onChange} />}

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
  referenceMode,
}: {
  sources: AssociationSource[];
  accountId: string;
  loadResources: (
    sources: AssociationSource[],
    accountId: string,
    opts?: { regionHint?: string; crossAccount?: boolean },
  ) => Promise<ResourcePickerOption[]>;
  value: string;
  onChange: (v: string) => void;
  /** Empty string disables scoping; the picker queries everywhere as before. */
  regionHint: string;
  /** Bumped by the form to force a refetch after a "+ Create new …" action. */
  refreshKey: number;
  /**
   * When true the picker emits live output references and searches across every
   * account whose plugin matches a source (not just the creating account).
   */
  referenceMode: boolean;
}) {
  // Re-run only when the *content* of `sources` changes — the array literal
  // is recreated every render in some callers, which would otherwise cause
  // an infinite reload loop.
  const sourcesKey = JSON.stringify(sources);
  // Identity of the current fetch: when any input changes, the stored result
  // no longer matches and the view derives loading/empty/no-error with no
  // synchronous setter in the effect.
  const fetchKey = JSON.stringify({ sourcesKey, accountId, regionHint, referenceMode, refreshKey });

  const [fetchState, setFetchState] = useState<{
    forKey: string;
    resources: ResourcePickerOption[];
    loading: boolean;
    error: string | null;
  }>({ forKey: fetchKey, resources: [], loading: true, error: null });

  const loading = fetchState.forKey !== fetchKey || fetchState.loading;
  const error = fetchState.forKey === fetchKey ? fetchState.error : null;
  const resources = fetchState.forKey === fetchKey ? fetchState.resources : [];

  useEffect(() => {
    let mounted = true;
    loadResources(sources, accountId, {
      ...(regionHint ? { regionHint } : {}),
      ...(referenceMode ? { crossAccount: true } : {}),
    })
      .then((opts) => {
        if (!mounted) return;
        setFetchState({ forKey: fetchKey, resources: opts, loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (!mounted) return;
        setFetchState({
          forKey: fetchKey,
          resources: [],
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    return () => {
      mounted = false;
    };
    // sourcesKey is the JSON-stringified content; loadResources/accountId are stable
    // references in their hosts. Listing sourcesKey instead of sources avoids
    // the new-array-each-render → infinite-load loop. regionHint and refreshKey
    // are primitives, so direct dep entries are fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesKey, accountId, loadResources, regionHint, refreshKey, referenceMode]);

  if (loading) {
    return <p className="text-xs text-on-surface-faint py-1">Loading resources…</p>;
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
        {referenceMode
          ? "No matching resources found across your accounts. Switch to a custom value."
          : "No matching resources found in this account."}
      </p>
    );
  }

  return (
    <ResourcePicker
      resources={resources}
      value={value}
      onChange={onChange}
      referenceMode={referenceMode}
    />
  );
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

/**
 * Subdomain input that shows a fixed `.<domain>` suffix and submits the full
 * hostname. The user types just the subdomain ("www"); an empty value means the
 * apex (submits the bare domain). When `suffix` is empty it degrades to a plain
 * text input.
 *
 * With `withPath`, a trailing path input is shown and the submitted value
 * becomes `<hostname><path>` (e.g. a Worker route pattern
 * `sub.example.com/api/*`), defaulting the path to `/*`.
 */
function HostnameField({
  label,
  suffix,
  placeholder,
  withPath,
  value,
  onChange,
}: {
  label: string;
  suffix: string;
  placeholder?: string | undefined;
  withPath: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  // Seed an untouched field with a valid default: the apex, plus "/*" when a
  // path is part of the value (route patterns require one). Runs unconditionally
  // (before any early return) so hook order stays stable; only seeds when a
  // suffix is present (the suffix branch below).
  useEffect(() => {
    if (suffix && value === "") onChange(withPath ? `${suffix}/*` : suffix);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // No domain to anchor to — behave as a normal text input.
  if (!suffix) {
    return (
      <input
        type="text"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? label}
        className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500"
      />
    );
  }

  // Split the full value into host + path (path = from the first "/").
  const slash = value.indexOf("/");
  const host = slash === -1 ? value : value.slice(0, slash);
  const path = slash === -1 ? "" : value.slice(slash);
  const dotted = `.${suffix}`;
  const sub = host === suffix ? "" : host.endsWith(dotted) ? host.slice(0, -dotted.length) : host;

  const compose = (nextSub: string, nextPath: string) => {
    const cleanSub = nextSub.trim().replace(/^\.+|\.+$/g, "");
    const newHost = cleanSub ? `${cleanSub}.${suffix}` : suffix;
    if (!withPath) return onChange(newHost);
    let p = nextPath.trim();
    if (p && !p.startsWith("/")) p = `/${p}`;
    onChange(`${newHost}${p}`);
  };

  return (
    <div className="flex items-stretch">
      <input
        type="text"
        aria-label={label}
        value={sub}
        onChange={(e) => compose(e.target.value, path)}
        placeholder={placeholder ?? "subdomain (blank = root)"}
        className="flex-1 min-w-0 bg-surface-overlay border border-border-strong rounded-l-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500"
      />
      <span
        className={`flex items-center px-3 border border-l-0 border-border-strong bg-surface-sunken text-sm text-on-surface-faint font-mono whitespace-nowrap ${
          withPath ? "" : "rounded-r-lg"
        }`}
      >
        .{suffix}
      </span>
      {withPath && (
        <input
          type="text"
          aria-label={`${label} path`}
          value={path}
          onChange={(e) => compose(sub, e.target.value)}
          placeholder="/*"
          className="w-32 flex-shrink-0 bg-surface-overlay border border-l-0 border-border-strong rounded-r-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500 font-mono"
        />
      )}
    </div>
  );
}
