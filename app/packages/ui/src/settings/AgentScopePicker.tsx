import { useGT } from "gt-react";
import { useDataString } from "../i18n/data-strings.js";
import type { ApiKeyScopeGroup } from "./api-key-scopes.js";

/**
 * Grouped scope checkboxes for agent links: the ceiling on the approval page
 * and an agent's scopes in Settings → Agents. Shared so both pickers name and
 * group permissions exactly as the API Keys dialog does. The groups arrive
 * already narrowed (to what the person may grant, or to a link's ceiling).
 */
export function AgentScopePicker({
  groups,
  selected,
  onChange,
  disabled = false,
}: {
  groups: readonly ApiKeyScopeGroup[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
}) {
  const gt = useGT();
  const gtData = useDataString();

  if (groups.length === 0) {
    return (
      <p className="text-xs text-on-surface-tertiary">
        {gt("There is nothing here you can grant.")}
      </p>
    );
  }

  function toggle(value: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(value);
    else next.delete(value);
    onChange(next);
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <fieldset key={group.title}>
          <legend className="text-xs font-medium text-on-surface-secondary mb-1">
            {gtData(group.title)}
          </legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
            {group.scopes.map((scope) => (
              <label key={scope.value} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={selected.has(scope.value)}
                  disabled={disabled}
                  onChange={(e) => toggle(scope.value, e.target.checked)}
                />
                <span>{gtData(scope.label)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
