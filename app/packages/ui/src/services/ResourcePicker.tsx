import { useEffect, useId, useMemo, useState } from "react";
import { useGT } from "gt-react";
import type { ServiceMember } from "@infrawrench/client-core";
import { SearchIcon } from "../components/icons/ChromeIcons.js";
import { ResourceTypeIcon, inferIconKey } from "../components/icons/ResourceTypeIcon.js";
import { useDataString } from "../i18n/data-strings.js";
import { errorMessage } from "./shared.js";
import type { ServiceResourceOption, ServicesClient } from "./types.js";

/** The search answers at most this many resources (the `/search` resource cap). */
export const RESOURCE_SEARCH_LIMIT = 50;

/** How a row shows in a picker list. */
export interface PickerRowState {
  checked: boolean;
  /** A short tag beside the name: "Rule 2", "New", "Excluded". */
  badge?: { text: string; tone: "accent" | "neutral" | "danger" } | undefined;
  /** Why the row cannot be toggled; set, the row renders disabled. */
  lockedReason?: string | undefined;
}

/** A service member in the picker's row shape. */
export function memberAsOption(m: ServiceMember): ServiceResourceOption {
  return {
    id: m.resourceId,
    displayName: m.resourceName,
    pluginId: m.pluginId,
    resourceTypeId: m.resourceTypeId,
    accountId: m.accountId,
    accountName: m.accountName ?? undefined,
  };
}

/** The resource type's icon, with the provider's logo in its corner when there is one. */
export function ResourceMark({
  logoSvg,
  resourceTypeId,
}: {
  logoSvg?: string | undefined;
  resourceTypeId: string;
}) {
  return (
    <span
      aria-hidden="true"
      className="relative flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-on-surface-secondary"
    >
      <ResourceTypeIcon iconKey={inferIconKey(resourceTypeId)} size={15} />
      {logoSvg ? (
        <span
          className="absolute -bottom-1 -right-1 flex size-[18px] items-center justify-center rounded-md border border-border bg-surface-raised p-[2px] [&>svg]:h-full [&>svg]:w-full"
          // Bundled provider metadata from trusted plugin manifests, never user input.
          dangerouslySetInnerHTML={{ __html: logoSvg }}
        />
      ) : null}
    </span>
  );
}

const BADGE_TONES = {
  accent: "border-accent/40 bg-accent/10 text-accent",
  neutral: "border-border bg-surface-sunken text-on-surface-secondary",
  danger: "border-danger/40 bg-danger/10 text-danger",
} as const;

/** One resource in a picker list: a checkbox, its mark, name, type and account. */
export function ResourceRow({
  row,
  state,
  logoSvg,
  onToggle,
}: {
  row: ServiceResourceOption;
  state: PickerRowState;
  /** Overrides the row's own logo, for rows (members) that carry none. */
  logoSvg?: string | undefined;
  onToggle: (row: ServiceResourceOption) => void;
}) {
  const dataString = useDataString();
  const locked = state.lockedReason !== undefined;
  const details = [
    row.resourceTypeLabel ? dataString(row.resourceTypeLabel) : null,
    row.accountName,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li>
      <label
        title={state.lockedReason}
        className={`flex items-center gap-3 px-3 py-2 text-sm transition-colors ${
          locked
            ? "opacity-60"
            : state.checked
              ? "cursor-pointer bg-accent/5 hover:bg-accent/10"
              : "cursor-pointer hover:bg-surface-sunken"
        }`}
      >
        <input
          type="checkbox"
          className="size-4 shrink-0 accent-accent"
          disabled={locked}
          checked={state.checked}
          onChange={() => onToggle(row)}
        />
        <ResourceMark logoSvg={logoSvg ?? row.pluginLogoSvg} resourceTypeId={row.resourceTypeId} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium text-on-surface">{row.displayName}</span>
            {state.badge && (
              <span
                className={`shrink-0 rounded-md border px-1.5 py-px text-[10px] font-medium ${BADGE_TONES[state.badge.tone]}`}
              >
                {state.badge.text}
              </span>
            )}
          </span>
          {details && (
            <span className="block truncate text-xs text-on-surface-faint">{details}</span>
          )}
        </span>
        <span className="hidden shrink-0 text-xs text-on-surface-secondary sm:block">
          {row.pluginDisplayName ?? dataString(row.pluginId)}
        </span>
      </label>
    </li>
  );
}

export interface ResourcePickerProps {
  client: ServicesClient;
  stateOf: (row: ServiceResourceOption) => PickerRowState;
  onToggle: (row: ServiceResourceOption) => void;
  /** "Select all": every shown row that can be checked and is not. */
  onSelectMany: (rows: ServiceResourceOption[]) => void;
  /** Every answer the search gives, so the caller can learn provider logos. */
  onResults?: ((rows: ServiceResourceOption[]) => void) | undefined;
  autoFocus?: boolean | undefined;
}

/**
 * Search every account's resources and tick the ones you want. The query is
 * fuzzy over name, type, account and provider ("aws prod db" works), a
 * provider filter narrows what came back, and Enter in the search box ticks
 * the top row, so a service is typed together rather than clicked together.
 */
export function ResourcePicker({
  client,
  stateOf,
  onToggle,
  onSelectMany,
  onResults,
  autoFocus,
}: ResourcePickerProps) {
  const gt = useGT();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ServiceResourceOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResults(null);
    setError(null);
    const timer = setTimeout(() => {
      client.searchResources(query.trim()).then(
        (rows) => {
          if (cancelled) return;
          setResults(rows);
          onResults?.(rows);
        },
        (e) => {
          if (cancelled) return;
          setResults([]);
          setError(errorMessage(e, gt("Search failed")));
        },
      );
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `onResults` is a notification; a new function each render must not re-search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, query, gt]);

  const providers = useMemo(() => {
    const counts = new Map<string, { label: string; logo: string | undefined; count: number }>();
    for (const r of results ?? []) {
      const entry = counts.get(r.pluginId);
      if (entry) entry.count += 1;
      else
        counts.set(r.pluginId, {
          label: r.pluginDisplayName ?? r.pluginId,
          logo: r.pluginLogoSvg || undefined,
          count: 1,
        });
    }
    return [...counts].sort(
      (a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label),
    );
  }, [results]);

  // A provider the new answer no longer has would hide every row.
  const activeProvider = provider && providers.some(([id]) => id === provider) ? provider : null;
  const shown = (results ?? []).filter((r) => !activeProvider || r.pluginId === activeProvider);
  const selectable = shown.filter((r) => {
    const s = stateOf(r);
    return !s.checked && s.lockedReason === undefined;
  });

  const chip = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
      active
        ? "border-accent bg-accent/10 text-on-surface"
        : "border-border text-on-surface-secondary hover:border-border-strong hover:text-on-surface"
    }`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">
          {gt("Search resources")}
        </label>
        <SearchIcon
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-faint"
        />
        <input
          id={searchId}
          type="search"
          // The editor opens on its name field; the add dialog has nothing else to type.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocus}
          className="w-full rounded-lg border border-border bg-surface-sunken py-2 pl-8 pr-2.5 text-sm text-on-surface focus:border-accent-subtle focus:outline-none"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            const top = shown.find((r) => stateOf(r).lockedReason === undefined);
            if (top) onToggle(top);
          }}
          placeholder={gt("Search by name, type, account or provider")}
        />
      </div>

      {providers.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={gt("Filter by provider")}>
          <button
            type="button"
            aria-pressed={activeProvider === null}
            className={chip(activeProvider === null)}
            onClick={() => setProvider(null)}
          >
            {gt("All")}
            <span className="tabular-nums text-on-surface-faint">{results?.length ?? 0}</span>
          </button>
          {providers.map(([id, p]) => (
            <button
              key={id}
              type="button"
              aria-pressed={activeProvider === id}
              className={chip(activeProvider === id)}
              onClick={() => setProvider(activeProvider === id ? null : id)}
            >
              {p.logo && (
                <span
                  aria-hidden="true"
                  className="size-3.5 [&>svg]:h-full [&>svg]:w-full"
                  // Bundled provider metadata from trusted plugin manifests, never user input.
                  dangerouslySetInnerHTML={{ __html: p.logo }}
                />
              )}
              {p.label}
              <span className="tabular-nums text-on-surface-faint">{p.count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="min-h-[12rem] flex-1 overflow-y-auto rounded-xl border border-border bg-surface-raised">
        {results === null ? (
          <p role="status" className="p-4 text-sm text-on-surface-faint">
            {gt("Searching…")}
          </p>
        ) : shown.length === 0 ? (
          <p role="status" className="p-4 text-sm text-on-surface-faint">
            {error ?? gt("No resources match.")}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {shown.map((row) => (
              <ResourceRow key={row.id} row={row} state={stateOf(row)} onToggle={onToggle} />
            ))}
          </ul>
        )}
      </div>

      <div className="flex min-h-7 items-center gap-2 text-xs text-on-surface-faint">
        <span className="min-w-0 flex-1 truncate">
          {results !== null && results.length >= RESOURCE_SEARCH_LIMIT
            ? gt("Showing the best {count} matches; narrow the search to see others.", {
                count: RESOURCE_SEARCH_LIMIT,
              })
            : null}
        </span>
        {selectable.length > 1 && (
          <button
            type="button"
            className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
            onClick={() => onSelectMany(selectable)}
          >
            {gt("Select all {count}", { count: selectable.length })}
          </button>
        )}
      </div>
    </div>
  );
}
