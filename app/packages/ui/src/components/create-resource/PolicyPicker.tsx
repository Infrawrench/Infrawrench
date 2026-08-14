import { useState, useMemo } from "react";
import { useGT } from "gt-react";
import type { PolicyOption } from "@infrawrench/plugin-base";
import { useDataString } from "../../i18n/data-strings.js";

function parseSelection(value: string): string[] {
  if (!value) return [];
  try {
    const arr: unknown = JSON.parse(value);
    return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function serializeSelection(ids: string[]): string {
  return ids.length === 0 ? "" : JSON.stringify(ids);
}

export function PolicyPicker({
  policies,
  value,
  onChange,
}: {
  policies: PolicyOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const [search, setSearch] = useState("");

  const selectedIds = useMemo(() => parseSelection(value), [value]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const byId = useMemo(() => {
    const m = new Map<string, PolicyOption>();
    for (const p of policies) m.set(p.id, p);
    return m;
  }, [policies]);

  const categories = useMemo(() => {
    const map = new Map<string, PolicyOption[]>();
    for (const p of policies) {
      const cat = p.category ?? "Other";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(p);
    }
    return map;
  }, [policies]);

  const filtered = useMemo(() => {
    if (!search) return null;
    const q = search.toLowerCase();
    return policies.filter(
      (p) =>
        p.label.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        (p.description?.toLowerCase().includes(q) ?? false),
    );
  }, [policies, search]);

  function toggle(id: string) {
    const next = selectedSet.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id];
    onChange(serializeSelection(next));
  }

  function remove(id: string) {
    onChange(serializeSelection(selectedIds.filter((x) => x !== id)));
  }

  return (
    <div className="border border-border-strong rounded-lg overflow-hidden">
      {/* Selected chips */}
      {selectedIds.length > 0 && (
        <div className="px-3 py-2 border-b border-border-strong bg-surface-overlay/30 flex flex-wrap gap-1">
          {selectedIds.map((id) => {
            const p = byId.get(id);
            const label = p?.label ?? id;
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-accent-muted text-accent-on-muted text-xs"
              >
                <span className="truncate max-w-[240px]" title={p?.description ?? id}>
                  {gtData(label)}
                </span>
                <button
                  type="button"
                  onClick={() => remove(id)}
                  className="text-accent-on-muted/70 hover:text-accent-on-muted"
                  aria-label={gt("Remove {label}", { label: gtData(label) })}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Search */}
      <div className="px-3 py-2 border-b border-border-strong bg-surface-overlay/50 flex items-center gap-2">
        <input
          type="text"
          aria-label={gt("Search policies")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={gt("Search {count} policies…", { count: policies.length })}
          className="flex-1 bg-transparent text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none"
        />
        {selectedIds.length > 0 && (
          <span className="text-[11px] text-on-surface-faint">
            {gt("{count} selected", { count: selectedIds.length })}
          </span>
        )}
      </div>

      <div className="max-h-64 overflow-y-auto">
        {filtered ? (
          filtered.length === 0 ? (
            <p className="p-3 text-xs text-on-surface-faint">{gt("No matches")}</p>
          ) : (
            filtered.map((p) => (
              <PolicyRow
                key={p.id}
                policy={p}
                selected={selectedSet.has(p.id)}
                onToggle={() => toggle(p.id)}
              />
            ))
          )
        ) : (
          [...categories.entries()].map(([cat, catPolicies]) => (
            <div key={cat}>
              <div className="px-3 py-1 bg-surface-overlay/30 border-b border-border-strong/40 flex items-center justify-between">
                <span className="text-[10px] font-semibold text-on-surface-faint uppercase tracking-wide">
                  {cat}
                </span>
                <span className="text-[10px] text-on-surface-faint">{catPolicies.length}</span>
              </div>
              {catPolicies.map((p) => (
                <PolicyRow
                  key={p.id}
                  policy={p}
                  selected={selectedSet.has(p.id)}
                  onToggle={() => toggle(p.id)}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function BadgeChip({ badge }: { badge: string }) {
  const upper = badge.toUpperCase();
  const style =
    upper === "DEPRECATED"
      ? "bg-red-500/15 text-danger ring-red-500/30"
      : upper === "ALPHA"
        ? "bg-orange-500/15 text-severe ring-orange-500/30"
        : upper === "BETA"
          ? "bg-amber-500/15 text-warning ring-amber-500/30"
          : "bg-surface-overlay text-on-surface-tertiary ring-border-strong";
  return (
    <span
      className={`text-[10px] leading-none px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide ring-1 ring-inset flex-shrink-0 ${style}`}
    >
      {upper}
    </span>
  );
}

function PolicyRow({
  policy,
  selected,
  onToggle,
}: {
  policy: PolicyOption;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-start gap-2 border-b border-border-strong/20 cursor-pointer ${
        selected
          ? "bg-accent-muted text-accent-on-muted"
          : "text-on-surface-secondary hover:bg-surface-overlay"
      }`}
    >
      <input
        type="checkbox"
        aria-label={policy.label}
        checked={selected}
        onChange={onToggle}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className={`mt-0.5 w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center ${
          selected ? "border-blue-400 bg-blue-500" : "border-border-strong bg-surface-sunken"
        }`}
      >
        {selected && (
          <svg viewBox="0 0 12 12" className="size-2.5 text-white" fill="none">
            <path
              d="M2 6.5L5 9.5L10 3.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{policy.label}</span>
          {policy.badge && <BadgeChip badge={policy.badge} />}
        </span>
        {policy.description && (
          <span className="block text-[11px] text-on-surface-faint truncate mt-0.5">
            {policy.description}
          </span>
        )}
      </span>
    </label>
  );
}
