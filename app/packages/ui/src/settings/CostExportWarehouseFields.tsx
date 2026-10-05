import { useEffect, useState } from "react";
import { T, Var, useGT } from "gt-react";
import type {
  CostExportWarehouseDestination,
  CostExportWarehouseOption,
  CostExportWarehouseSetup,
  CostExportWarehouseSink,
  CostExportWarehouseTargetField,
} from "@infrawrench/client-core";
import { useDataString } from "../i18n/data-strings.js";
import { useSettingsHost } from "./host.js";
import { INPUT, LABEL, SECONDARY_BUTTON } from "./styles.js";

/**
 * A warehouse destination (Snowflake, Databricks): pick a connected account,
 * then each of the plugin's target fields from live pickers, and show the
 * least-privilege GRANT statements for what was picked.
 *
 * Everything here is driven by the sink description the server returns; the
 * component has no idea which warehouse it is talking to. A picker that cannot
 * list (a missing grant, a stopped warehouse) falls back to a text input and
 * says why, so the form is never a dead end.
 */
export function WarehouseDestinationFields({
  sink,
  destination,
  onChange,
}: {
  sink: CostExportWarehouseSink;
  destination: CostExportWarehouseDestination;
  onChange: (destination: CostExportWarehouseDestination) => void;
}) {
  const gt = useGT();
  const gtData = useDataString();

  if (sink.accounts.length === 0) {
    return (
      <T>
        <p className="text-xs text-warning/90">
          No <Var>{sink.displayName}</Var> account is connected yet. Add one under Accounts, then
          come back to pick its table.
        </p>
      </T>
    );
  }

  function setTarget(key: string, value: string, field: CostExportWarehouseTargetField) {
    const target = { ...destination.target, [key]: value };
    // A field that depends on this one no longer means anything once it changes.
    for (const other of sink.targetFields) {
      if (other.key !== field.key && other.dependsOn.includes(key)) delete target[other.key];
    }
    if (!value) delete target[key];
    onChange({ ...destination, target });
  }

  return (
    <div className="space-y-3">
      {sink.description && (
        <p className="text-xs text-on-surface-muted">{gtData(sink.description)}</p>
      )}
      <label className="block">
        <span className={LABEL}>{gt("Account")}</span>
        <select
          value={destination.accountId}
          onChange={(e) => onChange({ ...destination, accountId: e.target.value, target: {} })}
          className={INPUT}
        >
          <option value="">{gt("Choose an account…")}</option>
          {sink.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>

      {destination.accountId && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {sink.targetFields.map((field) => (
            <TargetFieldPicker
              key={`${destination.accountId}:${field.key}`}
              accountId={destination.accountId}
              field={field}
              target={destination.target}
              onChange={(value) => setTarget(field.key, value, field)}
            />
          ))}
        </div>
      )}

      {destination.accountId && (
        <WarehouseSetupPanel accountId={destination.accountId} target={destination.target} />
      )}
    </div>
  );
}

function TargetFieldPicker({
  accountId,
  field,
  target,
  onChange,
}: {
  accountId: string;
  field: CostExportWarehouseTargetField;
  target: Record<string, string>;
  onChange: (value: string) => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const { orgId, api } = useSettingsHost();
  const value = target[field.key] ?? "";
  const ready = field.dependsOn.every((k) => !!target[k]);
  const depsKey = field.dependsOn.map((k) => target[k] ?? "").join("\u0000");
  const [options, setOptions] = useState<CostExportWarehouseOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) {
      setOptions(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const deps: Record<string, string> = {};
    for (const k of field.dependsOn) deps[k] = target[k] ?? "";
    api
      .post<{ options: CostExportWarehouseOption[] }>(
        `/api/org/${orgId}/cost-exports/warehouse-options`,
        { accountId, field: field.key, target: deps },
      )
      .then((res) => {
        if (!cancelled) setOptions(res.options);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setOptions(null);
        setError(e instanceof Error ? e.message : gt("Could not list options"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `target` is read through `depsKey`; re-listing on unrelated edits would
    // hit the provider for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, orgId, accountId, field.key, ready, depsKey, gt]);

  const label = gtData(field.label);
  const listId = `wh-${field.key}-options`;
  // A closed list renders as a select; a field that accepts new names (the
  // table), or one whose options could not be listed, is a text input with
  // the options as suggestions.
  const asSelect = options !== null && !field.allowCustom;

  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      {asSelect ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT}
          disabled={!ready}
        >
          <option value="">
            {field.optional && field.emptyLabel
              ? gtData(field.emptyLabel)
              : gt("Choose {label}…", { label: label.toLowerCase() })}
          </option>
          {/* A stored value the provider no longer lists stays selectable. */}
          {value && !options.some((o) => o.id === value) && <option value={value}>{value}</option>}
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.description ? `${o.label} (${o.description})` : o.label}
            </option>
          ))}
        </select>
      ) : (
        <>
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            list={options ? listId : undefined}
            disabled={!ready}
            placeholder={
              !ready
                ? gt("Choose the fields above first")
                : field.placeholder
                  ? gtData(field.placeholder)
                  : undefined
            }
            className={INPUT}
          />
          {options && (
            <datalist id={listId}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.description ? `${o.label} (${o.description})` : o.label}
                </option>
              ))}
            </datalist>
          )}
        </>
      )}
      {loading && (
        <span className="block text-xs text-on-surface-faint mt-1">{gt("Loading…")}</span>
      )}
      {error && (
        <span className="block text-xs text-warning/90 mt-1 break-words">
          {gt("Could not list options ({error}). Type the name instead.", { error })}
        </span>
      )}
      {field.description && !error && (
        <span className="block text-xs text-on-surface-faint mt-1">
          {gtData(field.description)}
        </span>
      )}
    </label>
  );
}

/** The GRANT statements for the chosen target, fetched on demand. */
function WarehouseSetupPanel({
  accountId,
  target,
}: {
  accountId: string;
  target: Record<string, string>;
}) {
  const gt = useGT();
  const { orgId, api } = useSettingsHost();
  const [setup, setSetup] = useState<CostExportWarehouseSetup | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setSetup(
        await api.post<CostExportWarehouseSetup>(`/api/org/${orgId}/cost-exports/warehouse-setup`, {
          accountId,
          target,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not build the setup statements"));
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard refused (insecure context); the statements are selectable.
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className={SECONDARY_BUTTON}
        >
          {loading
            ? gt("Loading…")
            : setup
              ? gt("Refresh setup statements")
              : gt("Show least-privilege setup")}
        </button>
        {setup && (
          <button type="button" onClick={() => void copy()} className={SECONDARY_BUTTON}>
            {copied ? gt("Copied") : gt("Copy")}
          </button>
        )}
      </div>
      <T>
        <p className="text-xs text-on-surface-muted">
          The connected account loads the rows with its own credentials. Run these grants once as an
          administrator so it can create the table, stage each run and replace the periods it
          exports, and nothing more.
        </p>
      </T>
      {error && <p className="text-xs text-danger break-words">{error}</p>}
      {setup && (
        <>
          <pre className="text-xs bg-surface-overlay rounded-lg p-3 overflow-x-auto whitespace-pre">
            {setup.sql}
          </pre>
          {setup.notes.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-on-surface-muted space-y-1">
              {setup.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
