import { useCallback, useMemo, useRef, useState } from "react";
import type {
  PublishPanelCapability,
  PublishPanelField,
  PublishMessagePayload,
  PublishMessageResult,
} from "@infrawrench/plugin-base";

interface Props {
  capability: PublishPanelCapability;
  /**
   * Send one message. Host wraps this around an IPC call (NDJSON-free
   * single request/response — see actions.ts /publish-message). Plugins
   * may throw on validation/provider errors; the panel renders the
   * thrown message in a red banner.
   */
  onPublish: (payload: PublishMessagePayload) => Promise<PublishMessageResult>;
}

interface SendEntry {
  id: string;
  body: string;
  extras: Record<string, string | Record<string, string>>;
  status: "ok" | "error";
  message: string;
  at: number;
}

export function PublishPanel({ capability, onPublish }: Props) {
  const bodyFormat = capability.bodyFormat ?? "json";
  const submitLabel = capability.submitLabel ?? "Send";
  const extraFields = capability.extraFields ?? [];
  const disabled = !!capability.disabledReason;

  const [body, setBody] = useState(capability.defaultBody ?? "");
  const [extras, setExtras] = useState<Record<string, string | Record<string, string>>>(() => {
    const initial: Record<string, string | Record<string, string>> = {};
    for (const field of extraFields) {
      if (field.kind === "key-value-list") {
        initial[field.key] = {};
      } else {
        initial[field.key] = field.defaultValue ?? "";
      }
    }
    return initial;
  });
  const [history, setHistory] = useState<SendEntry[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entryIdRef = useRef(0);

  const validate = useCallback((): string | null => {
    if (!body.trim()) return "Message body is required.";
    if (bodyFormat === "json") {
      try {
        JSON.parse(body);
      } catch (e) {
        return e instanceof Error
          ? `Body is not valid JSON: ${e.message}`
          : "Body is not valid JSON.";
      }
    }
    for (const field of extraFields) {
      if (field.optional) continue;
      const value = extras[field.key];
      if (field.kind === "key-value-list") {
        // key-value lists are always optional in practice — pass.
        continue;
      }
      if (typeof value !== "string" || !value.trim()) {
        return `${field.label} is required.`;
      }
      if (field.kind === "number" && Number.isNaN(Number(value))) {
        return `${field.label} must be a number.`;
      }
    }
    return null;
  }, [body, bodyFormat, extras, extraFields]);

  const send = useCallback(async () => {
    if (sending || disabled) return;
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setSending(true);
    const snapshot = { body, extras: { ...extras } };
    try {
      const result = await onPublish({ body: snapshot.body, extras: snapshot.extras });
      const id = `${++entryIdRef.current}`;
      setHistory((prev) => [
        {
          id,
          body: snapshot.body,
          extras: snapshot.extras,
          status: "ok",
          message: result.summary ?? (result.id ? `Sent — id ${result.id}` : "Message sent."),
          at: Date.now(),
        },
        ...prev,
      ]);
    } catch (err) {
      const id = `${++entryIdRef.current}`;
      setHistory((prev) => [
        {
          id,
          body: snapshot.body,
          extras: snapshot.extras,
          status: "error",
          message: err instanceof Error ? err.message : String(err),
          at: Date.now(),
        },
        ...prev,
      ]);
    } finally {
      setSending(false);
    }
  }, [sending, disabled, validate, body, extras, onPublish]);

  const setExtra = useCallback((key: string, value: string | Record<string, string>) => {
    setExtras((prev) => ({ ...prev, [key]: value }));
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface shrink-0">
        <span className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
          {capability.tabLabel ?? "Publish"}
        </span>
        {capability.subtitle && (
          <span className="text-xs text-on-surface-tertiary truncate">{capability.subtitle}</span>
        )}
        {history.length > 0 && (
          <button
            type="button"
            onClick={() => setHistory([])}
            className="ml-auto px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded-md transition-colors"
          >
            Clear history
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-4">
        {disabled ? (
          <div className="text-sm text-on-surface-tertiary italic max-w-2xl">
            {capability.disabledReason}
          </div>
        ) : (
          <>
            {capability.helpText && (
              <p className="text-xs text-on-surface-muted">{capability.helpText}</p>
            )}

            {extraFields.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {extraFields.map((field) => (
                  <ExtraFieldInput
                    key={field.key}
                    field={field}
                    value={extras[field.key] ?? (field.kind === "key-value-list" ? {} : "")}
                    onChange={(value) => setExtra(field.key, value)}
                  />
                ))}
              </div>
            )}

            <label className="block">
              <span className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
                Message body{bodyFormat === "json" ? " (JSON)" : ""}
              </span>
              <textarea
                aria-label="Message body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={bodyFormat === "json" ? '{ "hello": "world" }' : "Message text…"}
                rows={10}
                spellCheck={false}
                className="mt-1 w-full resize-y bg-surface-overlay text-on-surface text-sm font-mono border border-border-strong rounded-md px-3 py-2 focus:outline-none focus:border-accent-blue placeholder:text-on-surface-faint"
              />
            </label>

            {error && (
              <div className="text-xs text-red-400 font-mono bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
                {error}
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void send()}
                disabled={sending}
                className="px-4 py-2 text-sm font-medium text-white bg-accent-blue rounded-md hover:bg-accent-blue/90 disabled:bg-surface-overlay disabled:text-on-surface-faint disabled:cursor-not-allowed transition-colors"
              >
                {sending ? "Sending…" : submitLabel}
              </button>
              <span className="text-[11px] text-on-surface-faint">
                {sending ? "Publishing…" : "One message per click"}
              </span>
            </div>

            {history.length > 0 && (
              <div className="pt-4 border-t border-border">
                <h3 className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide mb-2">
                  Recent sends
                </h3>
                <ul className="space-y-2">
                  {history.map((entry) => (
                    <SendHistoryRow key={entry.id} entry={entry} />
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface ExtraFieldInputProps {
  field: PublishPanelField;
  value: string | Record<string, string>;
  onChange: (value: string | Record<string, string>) => void;
}

function ExtraFieldInput({ field, value, onChange }: ExtraFieldInputProps) {
  if (field.kind === "key-value-list") {
    const obj = (value && typeof value === "object" ? value : {}) as Record<string, string>;
    return (
      <div className="col-span-full">
        {/* Caption, not a <label>: the key-value editor is a composite widget
            with several inputs, so there is no single control to associate. */}
        <span className="block text-xs font-semibold text-on-surface-muted uppercase tracking-wide mb-1">
          {field.label}
          {field.optional && (
            <span className="ml-2 text-[10px] text-on-surface-faint normal-case font-normal">
              optional
            </span>
          )}
        </span>
        <KeyValueListEditor value={obj} onChange={onChange} />
        {field.helpText && (
          <p className="text-[11px] text-on-surface-faint mt-1">{field.helpText}</p>
        )}
      </div>
    );
  }

  const stringValue = typeof value === "string" ? value : "";

  if (field.kind === "select") {
    return (
      <label className="block">
        <span className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
          {field.label}
          {field.optional && (
            <span className="ml-2 text-[10px] text-on-surface-faint normal-case font-normal">
              optional
            </span>
          )}
        </span>
        <select
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full bg-surface-overlay text-on-surface text-sm border border-border-strong rounded-md px-3 py-2 focus:outline-none focus:border-accent-blue"
        >
          {!stringValue && <option value="">Select…</option>}
          {(field.options ?? []).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {field.helpText && (
          <p className="text-[11px] text-on-surface-faint mt-1">{field.helpText}</p>
        )}
      </label>
    );
  }

  return (
    <label className="block">
      <span className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
        {field.label}
        {field.optional && (
          <span className="ml-2 text-[10px] text-on-surface-faint normal-case font-normal">
            optional
          </span>
        )}
      </span>
      <input
        type={field.kind === "number" ? "number" : "text"}
        value={stringValue}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        className="mt-1 w-full bg-surface-overlay text-on-surface text-sm border border-border-strong rounded-md px-3 py-2 focus:outline-none focus:border-accent-blue placeholder:text-on-surface-faint"
      />
      {field.helpText && <p className="text-[11px] text-on-surface-faint mt-1">{field.helpText}</p>}
    </label>
  );
}

interface KeyValueListEditorProps {
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
}

function KeyValueListEditor({ value, onChange }: KeyValueListEditorProps) {
  const entries = useMemo(() => Object.entries(value), [value]);

  const setKey = (oldKey: string, newKey: string) => {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) {
      next[k === oldKey ? newKey : k] = v;
    }
    onChange(next);
  };
  const setValue = (key: string, v: string) => {
    onChange({ ...value, [key]: v });
  };
  const remove = (key: string) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  };
  const add = () => {
    let candidate = "key";
    let n = 1;
    while (Object.prototype.hasOwnProperty.call(value, candidate)) {
      n += 1;
      candidate = `key${n}`;
    }
    onChange({ ...value, [candidate]: "" });
  };

  return (
    <div className="space-y-1">
      {entries.length === 0 && <p className="text-[11px] text-on-surface-faint">No entries.</p>}
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-2">
          <input
            type="text"
            value={k}
            onChange={(e) => setKey(k, e.target.value)}
            placeholder="name"
            aria-label="Entry name"
            className="flex-1 bg-surface-overlay text-on-surface text-xs border border-border-strong rounded-md px-2 py-1 focus:outline-none focus:border-accent-blue"
          />
          <input
            type="text"
            value={v}
            onChange={(e) => setValue(k, e.target.value)}
            placeholder="value"
            aria-label="Entry value"
            className="flex-1 bg-surface-overlay text-on-surface text-xs border border-border-strong rounded-md px-2 py-1 focus:outline-none focus:border-accent-blue"
          />
          <button
            type="button"
            onClick={() => remove(k)}
            className="text-xs text-on-surface-faint hover:text-red-400 px-2"
            aria-label={`Remove ${k}`}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="text-xs text-on-surface-faint hover:text-accent transition-colors"
      >
        + Add entry
      </button>
    </div>
  );
}

function SendHistoryRow({ entry }: { entry: SendEntry }) {
  const time = new Date(entry.at).toLocaleTimeString();
  return (
    <li
      className={`rounded-md border px-3 py-2 ${
        entry.status === "ok"
          ? "border-green-500/30 bg-green-500/5"
          : "border-red-500/30 bg-red-500/5"
      }`}
    >
      <div className="flex items-center gap-2 text-[11px] text-on-surface-tertiary">
        <span className={entry.status === "ok" ? "text-green-400" : "text-red-400"}>
          {entry.status === "ok" ? "✓" : "✕"}
        </span>
        <span>{time}</span>
        <span className="truncate flex-1">{entry.message}</span>
      </div>
      <pre className="mt-1 text-[11px] font-mono text-on-surface whitespace-pre-wrap break-all max-h-24 overflow-auto">
        {entry.body}
      </pre>
    </li>
  );
}
