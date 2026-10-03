import { useMemo, useState } from "react";
import { useGT } from "gt-react";
import type { SshInstallAccount } from "@infrawrench/plugin-base";
import { useDataString } from "../i18n/data-strings.js";

/**
 * Multi-select of accounts that install a service on the agent VM over SSH.
 * Laid out like `RegionPicker` (search header, bordered list, a dot per row)
 * so it reads as one of the provider's own create-form controls; the plugin
 * logo takes the flag's place and rows toggle instead of replacing.
 */
export function ServiceAccountPicker({
  accounts,
  value,
  onToggle,
}: {
  accounts: SshInstallAccount[];
  value: readonly string[];
  onToggle: (accountId: string, attached: boolean) => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q
      ? accounts.filter(
          (a) => a.displayName.toLowerCase().includes(q) || a.serviceName.toLowerCase().includes(q),
        )
      : accounts;
  }, [accounts, search]);
  const selected = accounts.filter((a) => value.includes(a.accountId));

  return (
    <div className="border border-border-strong rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-border-strong bg-surface-overlay/50 flex items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={gt("Search services…")}
          className="flex-1 bg-transparent text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none"
          aria-label={gt("Search services")}
        />
        {!search && (
          <span className="text-xs text-accent flex-shrink-0">
            {selected.length === 0
              ? gt("None attached")
              : selected.length === 1
                ? selected[0]!.serviceName
                : gt("{count} attached", { count: selected.length })}
          </span>
        )}
      </div>
      <div
        className="max-h-44 overflow-y-auto"
        role="listbox"
        aria-multiselectable="true"
        aria-label={gt("Services")}
      >
        {filtered.map((a) => {
          const on = value.includes(a.accountId);
          return (
            <button
              key={a.accountId}
              type="button"
              role="option"
              aria-selected={on}
              title={gtData(a.description)}
              onClick={() => onToggle(a.accountId, !on)}
              className={`w-full text-left px-3 py-2.5 transition-colors flex items-center gap-3 ${
                on ? "bg-accent-muted" : "hover:bg-surface-overlay"
              }`}
            >
              <span
                className={`size-2 rounded-full flex-shrink-0 ${on ? "bg-blue-400" : "bg-surface-sunken"}`}
              />
              {a.logoSvg && (
                <span
                  className={`size-4 flex-shrink-0 [&>svg]:size-full ${on ? "text-accent-on-muted" : "text-on-surface-secondary"}`}
                  aria-hidden="true"
                  // logoSvg is bundled provider metadata from trusted plugin manifests.
                  dangerouslySetInnerHTML={{ __html: a.logoSvg }}
                />
              )}
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-sm truncate ${on ? "text-accent-on-muted" : "text-on-surface-secondary"}`}
                >
                  {a.displayName}
                </span>
                <span
                  className={`block text-[11px] mt-0.5 ${on ? "text-accent/70" : "text-on-surface-faint"}`}
                >
                  {gtData(a.serviceName)}
                </span>
              </span>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <p className="p-3 text-xs text-on-surface-faint">{gt("No matches")}</p>
        )}
      </div>
    </div>
  );
}
