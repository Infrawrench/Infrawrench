import { useCallback, useEffect, useState } from "react";
import { useGT } from "gt-react";
import type { CredentialFieldOption } from "@infrawrench/plugin-base";
import { formatErrorMessage } from "../utils.js";

export type { CredentialFieldOption };

/**
 * Loads the options for a credential field that declares `providerOptions`.
 * Hosts implement it against the plugin's `listCredentialOptions`: web through
 * `POST /accounts/credential-options`, desktop in-process.
 */
export type LoadCredentialOptions = (
  pluginId: string,
  fieldKey: string,
  credentials: Record<string, string>,
  bastionId: string | null,
) => Promise<CredentialFieldOption[]>;

interface ProviderOptionsFieldProps {
  fieldId: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  /** Leading option for an empty value, from `providerOptions.emptyLabel`. */
  emptyLabel?: string | undefined;
  /**
   * Fetches the options, or undefined while the fields it depends on are
   * still empty (or the host cannot load options at all).
   */
  load: (() => Promise<CredentialFieldOption[]>) | undefined;
  /** Changes whenever a dependency changes; a new value reloads the list. */
  reloadKey: string;
}

const inputClass =
  "w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong";

/**
 * A credential input that offers the provider's own list (accounts, projects,
 * teams) once the key it needs has been entered, so nobody has to look up an
 * id. Falls back to a plain text input while the key is missing, when loading
 * fails, or when the user chooses to type the value.
 */
export function ProviderOptionsField({
  fieldId,
  label,
  value,
  onChange,
  placeholder,
  emptyLabel,
  load,
  reloadKey,
}: ProviderOptionsFieldProps) {
  const gt = useGT();
  const [options, setOptions] = useState<CredentialFieldOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    setOptions(null);
    setError(null);
    if (!load) return;
    let cancelled = false;
    // Debounced so typing a key does not fire a request per keystroke.
    const timer = setTimeout(() => {
      setLoading(true);
      load()
        .then((loaded) => {
          if (cancelled) return;
          setOptions(loaded);
          // Pick the only choice outright; otherwise keep what is there.
          if (!value && !emptyLabel && loaded.length === 1) onChange(loaded[0]!.id);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(formatErrorMessage(e));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `value` and `onChange` are deliberately left out: a selection must not
    // refetch the list it was picked from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load === undefined, reloadKey, attempt]);

  const textInput = (
    <input
      id={fieldId}
      aria-label={label}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={inputClass}
    />
  );

  if (!load) {
    return (
      <>
        {textInput}
        <p className="text-xs text-on-surface-faint mt-1">
          {gt("Fill in the fields above to choose from a list.")}
        </p>
      </>
    );
  }

  if (manual || error) {
    return (
      <>
        {textInput}
        <div className="flex items-center gap-2 mt-1">
          {error && <p className="text-xs text-danger flex-1">{error}</p>}
          <button
            type="button"
            onClick={() => {
              setManual(false);
              if (error) retry();
            }}
            className="text-xs text-info hover:text-info-strong"
          >
            {error ? gt("Retry") : gt("Choose from list")}
          </button>
        </div>
      </>
    );
  }

  if (loading || options === null) {
    return (
      <select id={fieldId} aria-label={label} disabled className={inputClass}>
        <option>{gt("Loading…")}</option>
      </select>
    );
  }

  const known = options.some((o) => o.id === value);
  return (
    <>
      <select
        id={fieldId}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
      >
        {emptyLabel !== undefined ? (
          <option value="">{emptyLabel}</option>
        ) : (
          !value && (
            <option value="" disabled>
              {gt("Choose…")}
            </option>
          )
        )}
        {value && !known && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.description && o.description !== o.label ? `${o.label} (${o.description})` : o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => setManual(true)}
        className="text-xs text-info hover:text-info-strong mt-1"
      >
        {gt("Enter manually")}
      </button>
    </>
  );
}
