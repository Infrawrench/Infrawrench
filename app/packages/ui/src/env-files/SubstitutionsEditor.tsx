import { useGT } from "gt-react";
import type { InfraenvDocument } from "@infrawrench/client-core";
import {
  overrideVar,
  putVar,
  removeVar,
  scopeVars,
  varProblem,
  varRowsFor,
  type EnvScope,
  type VarProblem,
} from "./document.js";
import { fieldClass, inputClass, quietButton } from "./styles.js";

export interface SubstitutionsEditorProps {
  doc: InfraenvDocument;
  scope: EnvScope;
  onChange: (doc: InfraenvDocument) => void;
}

/**
 * The `${name}` substitutions of one scope: `[vars]` for Shared, and for a
 * named environment its `[vars.<name>]` laid over them, the shared ones it
 * does not override listed read-only with "Override".
 */
export function SubstitutionsEditor({ doc, scope, onChange }: SubstitutionsEditorProps) {
  const gt = useGT();
  const rows = varRowsFor(doc, scope);
  const own = scopeVars(doc, scope);
  const problemMessage = (problem: VarProblem) => {
    switch (problem) {
      case "key-missing":
        return gt("Name the substitution");
      case "key-invalid":
        return gt("Use letters, digits and _, not starting with a digit");
      case "key-duplicate":
        return gt("This substitution is set twice here");
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-on-surface-secondary">{gt("Substitutions")}</h3>
        <button
          type="button"
          className={quietButton}
          onClick={() => onChange(putVar(doc, scope, null, { key: "", value: "" }))}
        >
          {gt("Add substitution")}
        </button>
      </div>
      {rows.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface-raised">
          {rows.map((row) => {
            if (row.inherited) {
              return (
                <li key={`shared:${row.v.key}`} className="flex items-center gap-3 px-3 py-1.5">
                  <span className="w-40 shrink-0 truncate font-mono text-sm text-on-surface-secondary">
                    {row.v.key}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-on-surface-secondary">
                    {row.v.value}
                  </span>
                  <span className="shrink-0 text-xs text-on-surface-faint">{gt("Shared")}</span>
                  <button
                    type="button"
                    className={quietButton}
                    onClick={() => scope !== null && onChange(overrideVar(doc, scope, row.v))}
                  >
                    {gt("Override")}
                  </button>
                </li>
              );
            }
            const index = row.index!;
            const problem = varProblem(own, index);
            return (
              <li key={`own:${index}`} className="px-3 py-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    className={`${fieldClass} w-40 shrink-0 font-mono ${
                      problem && row.v.key !== "" ? "border-danger" : ""
                    }`}
                    value={row.v.key}
                    maxLength={256}
                    spellCheck={false}
                    onChange={(e) =>
                      onChange(putVar(doc, scope, index, { ...row.v, key: e.target.value }))
                    }
                    aria-label={gt("Substitution name")}
                    placeholder="stage"
                  />
                  <div className="min-w-[10rem] flex-1">
                    <input
                      type="text"
                      className={`${inputClass} font-mono`}
                      value={row.v.value}
                      spellCheck={false}
                      onChange={(e) =>
                        onChange(putVar(doc, scope, index, { ...row.v, value: e.target.value }))
                      }
                      aria-label={gt("Substitution value")}
                    />
                  </div>
                  {row.overrides && (
                    <span className="shrink-0 text-xs text-on-surface-faint">
                      {gt("Overrides shared")}
                    </span>
                  )}
                  <button
                    type="button"
                    className={`${quietButton} text-danger`}
                    onClick={() => onChange(removeVar(doc, scope, index))}
                    aria-label={gt("Remove {key}", { key: row.v.key || gt("substitution") })}
                  >
                    {row.overrides ? gt("Use shared") : gt("Remove")}
                  </button>
                </div>
                {problem && <p className="mt-1 text-xs text-danger">{problemMessage(problem)}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
