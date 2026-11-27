import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { Markdown } from "./Markdown";
import { inputClass } from "./forms";

export interface MarkdownEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** The textarea's accessible name: "Comment", "Description". */
  readonly label: string;
  readonly placeholder?: string;
  readonly rows?: number;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
  /** Ctrl or Cmd with Enter. */
  readonly onSubmit?: () => void;
  readonly maxLength?: number;
  /** The buttons under the box, right-aligned. */
  readonly actions?: ReactNode;
  readonly resolveLink?: (href: string) => string | null;
}

/** A Markdown box with Write and Preview tabs. The preview is what the comment will look like. */
export function MarkdownEditor({
  value,
  onChange,
  label,
  placeholder,
  rows = 6,
  disabled = false,
  autoFocus = false,
  onSubmit,
  maxLength,
  actions,
  resolveLink,
}: MarkdownEditorProps) {
  const id = useId();
  const [tab, setTab] = useState<"write" | "preview">("write");
  const tabs = ["write", "preview"] as const;

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = tab === "write" ? "preview" : "write";
    setTab(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  };

  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface-raised">
      <div
        role="tablist"
        aria-label={`${label} editor`}
        onKeyDown={onTabKey}
        className="flex border-b border-border bg-surface-inset px-2"
      >
        {tabs.map((name) => (
          <button
            key={name}
            id={`${id}-tab-${name}`}
            type="button"
            role="tab"
            aria-selected={tab === name}
            aria-controls={`${id}-panel-${name}`}
            tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)}
            className={`-mb-px border-b-2 px-2.5 py-1.5 text-xs font-medium ${
              tab === name
                ? "border-accent text-on-surface"
                : "border-transparent text-on-surface-muted hover:text-on-surface"
            }`}
          >
            {name === "write" ? "Write" : "Preview"}
          </button>
        ))}
      </div>
      <div
        id={`${id}-panel-write`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-write`}
        hidden={tab !== "write"}
        className="p-2"
      >
        <textarea
          aria-label={label}
          value={value}
          rows={rows}
          disabled={disabled}
          autoFocus={autoFocus}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && onSubmit) {
              event.preventDefault();
              onSubmit();
            }
          }}
          className={`${inputClass} block min-h-24 resize-y font-mono leading-5`}
        />
      </div>
      <div
        id={`${id}-panel-preview`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-preview`}
        hidden={tab !== "preview"}
        className="min-h-24 px-3 py-2.5"
      >
        {tab !== "preview" ? null : value.trim() === "" ? (
          <p className="text-xs text-on-surface-muted">Nothing to preview</p>
        ) : (
          <Markdown source={value} {...(resolveLink ? { resolveLink } : {})} />
        )}
      </div>
      {actions !== undefined ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-2 py-2">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
