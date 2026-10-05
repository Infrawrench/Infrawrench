import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface SectionTab<T extends string = string> {
  id: T;
  label: string;
  content: ReactNode;
}

export interface SectionTabsProps<T extends string> {
  tabs: ReadonlyArray<SectionTab<T>>;
  ariaLabel: string;
  /** Remembers the last tab per viewer. Omit for no memory. */
  storageKey?: string | undefined;
  /** Tab to open on, ahead of the remembered one (a deep link). */
  initialTab?: T | undefined;
  className?: string | undefined;
}

function readStored(key: string | undefined): string | null {
  if (!key) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string | undefined, value: string) {
  if (!key) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows and blocked storage: the tab just isn't remembered.
  }
}

/**
 * Splits a long page of stacked sections into tabs. A panel mounts the first
 * time it is opened and then stays mounted (hidden), so its fetches don't all
 * fire on page load and a half-filled form survives switching away.
 */
export function SectionTabs<T extends string>({
  tabs,
  ariaLabel,
  storageKey,
  initialTab,
  className,
}: SectionTabsProps<T>) {
  const uid = useId();
  const ids = tabs.map((t) => t.id);
  const [active, setActive] = useState<T>(() => {
    if (initialTab && ids.includes(initialTab)) return initialTab;
    const stored = readStored(storageKey);
    const match = tabs.find((t) => t.id === stored);
    return match ? match.id : tabs[0]!.id;
  });
  const [visited, setVisited] = useState<ReadonlySet<T>>(() => new Set([active]));
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // A tab can disappear when its data source goes away; fall back to the first.
  const current = ids.includes(active) ? active : tabs[0]!.id;

  const select = (id: T) => {
    setActive(id);
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    writeStored(storageKey, id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    const tab = tabs[next];
    if (!tab) return;
    select(tab.id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        className="flex border-b border-border overflow-x-auto mb-6"
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === current;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`${uid}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${uid}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(tab.id)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={`-mb-px px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                selected
                  ? "border-blue-500 text-on-surface"
                  : "border-transparent text-on-surface-muted hover:text-on-surface-secondary hover:border-border-strong"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) =>
        visited.has(tab.id) || tab.id === current ? (
          <div
            key={tab.id}
            role="tabpanel"
            id={`${uid}-panel-${tab.id}`}
            aria-labelledby={`${uid}-tab-${tab.id}`}
            hidden={tab.id !== current}
            className="flex flex-col gap-6"
          >
            {tab.content}
          </div>
        ) : null,
      )}
    </div>
  );
}
