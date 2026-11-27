/**
 * A filterable list of choices under a trigger: labels, assignees, a
 * milestone, a filter. Arrow keys move from the filter box, Enter picks,
 * Escape closes. With `multiple` it stays open and each pick toggles.
 */
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "./icons";
import { Popover, type PopoverProps } from "./Menu";

export interface PickerOption {
  readonly value: string;
  readonly label: string;
  /** A second line, or text beside the label: a description, a full name. */
  readonly detail?: string | null | undefined;
  /** Drawn before the label: an avatar, a colour dot. */
  readonly leading?: ReactNode;
  /** Extra words the filter matches. */
  readonly keywords?: string;
}

export interface PickerProps {
  /** What is being picked, for the list's and the filter's accessible names: "Labels". */
  readonly label: string;
  readonly trigger: PopoverProps["trigger"];
  readonly options: ReadonlyArray<PickerOption>;
  readonly selected: ReadonlyArray<string>;
  readonly onChange: (selected: string[]) => void;
  readonly multiple?: boolean;
  readonly align?: "start" | "end";
  /** Shown while the options load. */
  readonly loading?: boolean;
  readonly emptyText?: string;
  /** Hides the filter box for a short fixed list. */
  readonly filterable?: boolean;
  /** Under the list: a link to manage what is listed. */
  readonly footer?: ReactNode;
  /** Called as the filter text changes, for a list that searches on the server. */
  readonly onFilter?: (text: string) => void;
}

export function Picker({
  label,
  trigger,
  options,
  selected,
  onChange,
  multiple = false,
  align = "start",
  loading = false,
  emptyText = "Nothing matches",
  filterable = true,
  footer,
  onFilter,
}: PickerProps) {
  const listId = useId();
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const words = filter.trim().toLowerCase();
  const shown =
    onFilter !== undefined
      ? options
      : options.filter((option) =>
          `${option.label} ${option.detail ?? ""} ${option.keywords ?? ""}`
            .toLowerCase()
            .includes(words),
        );
  const index = Math.min(active, Math.max(0, shown.length - 1));

  const pick = (value: string, close: () => void) => {
    if (multiple) {
      onChange(
        selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value],
      );
    } else {
      onChange(selected.includes(value) ? [] : [value]);
      close();
    }
  };

  const move = (event: KeyboardEvent<HTMLElement>, close: () => void) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (shown.length === 0) return;
      const next =
        event.key === "ArrowDown"
          ? (index + 1) % shown.length
          : (index - 1 + shown.length) % shown.length;
      setActive(next);
      list.current?.children[next]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" || (event.key === " " && !filterable)) {
      event.preventDefault();
      const option = shown[index];
      if (option) pick(option.value, close);
    }
  };

  return (
    <Popover
      align={align}
      className="w-64"
      trigger={trigger}
      onOpenChange={(open) => {
        if (open) {
          setFilter("");
          setActive(0);
          onFilter?.("");
          if (!filterable) requestAnimationFrame(() => list.current?.focus());
        }
      }}
    >
      {({ close }) => (
        <div>
          {filterable ? (
            <div className="border-b border-border p-2">
              <input
                autoFocus
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={shown[index] ? `${listId}-${index}` : undefined}
                aria-label={`Filter ${label.toLowerCase()}`}
                placeholder={`Filter ${label.toLowerCase()}`}
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value);
                  setActive(0);
                  onFilter?.(event.target.value);
                }}
                onKeyDown={(event) => move(event, close)}
                className="w-full rounded border border-border bg-surface px-2 py-1 text-xs text-on-surface placeholder:text-on-surface-faint focus:border-border-strong focus:outline-none"
              />
            </div>
          ) : null}
          <ul
            ref={list}
            id={listId}
            role="listbox"
            aria-label={label}
            aria-multiselectable={multiple || undefined}
            aria-activedescendant={!filterable && shown[index] ? `${listId}-${index}` : undefined}
            tabIndex={filterable ? undefined : 0}
            onKeyDown={filterable ? undefined : (event) => move(event, close)}
            className="max-h-64 overflow-y-auto py-1 focus:outline-none"
          >
            {shown.map((option, position) => {
              const chosen = selected.includes(option.value);
              return (
                <li
                  key={option.value}
                  id={`${listId}-${position}`}
                  role="option"
                  aria-selected={chosen}
                  onClick={() => pick(option.value, close)}
                  onMouseEnter={() => setActive(position)}
                  className={`flex cursor-pointer items-start gap-2 px-3 py-1.5 text-xs text-on-surface ${
                    position === index ? "bg-surface-sunken" : ""
                  }`}
                >
                  <Icon name="check" size={12} className={`mt-0.5 ${chosen ? "" : "invisible"}`} />
                  {option.leading !== undefined ? (
                    <span className="mt-0.5 flex shrink-0 items-center">{option.leading}</span>
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.label}</span>
                    {option.detail ? (
                      <span className="block truncate text-on-surface-muted">{option.detail}</span>
                    ) : null}
                  </span>
                </li>
              );
            })}
            {shown.length === 0 ? (
              <li role="presentation" className="px-3 py-3 text-xs text-on-surface-muted">
                {loading ? "Loading" : emptyText}
              </li>
            ) : null}
          </ul>
          {footer !== undefined ? (
            <div className="border-t border-border px-3 py-1.5 text-xs">{footer}</div>
          ) : null}
        </div>
      )}
    </Popover>
  );
}

/** The trigger most pickers in a filter bar use: a quiet button with a caret. */
export function PickerButton({
  children,
  active = false,
  ...props
}: {
  children: ReactNode;
  /** A filter that is narrowing the list. */
  active?: boolean;
  "aria-expanded": boolean;
  "aria-controls": string;
  onClick: () => void;
}) {
  return (
    <button
      {...props}
      type="button"
      aria-haspopup="listbox"
      className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-surface-sunken ${
        active ? "font-medium text-on-surface" : "text-on-surface-muted"
      }`}
    >
      {children}
      <Icon name="chevronDown" size={11} />
    </button>
  );
}
