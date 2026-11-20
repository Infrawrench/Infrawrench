import { useState } from "react";
import { useGT } from "gt-react";
import type {
  InfraenvDescribeResponse,
  InfraenvDocument,
  InfraenvEntry,
  InfraenvValue,
  InfraenvValueKind,
} from "@infrawrench/client-core";
import { useDataString } from "../i18n/data-strings.js";
import {
  overrideEntry,
  pickResource,
  putEntry,
  referenceState,
  removeEntry,
  rowProblem,
  rowsFor,
  scopeEntries,
  withKind,
  type EnvScope,
  type ReferenceState,
  type RowProblem,
} from "./document.js";
import { NewSecretModal } from "./NewSecretModal.js";
import { ResourcePickerModal } from "./ResourcePickerModal.js";
import { fieldClass, inputClass, quietButton, secondaryButton } from "./styles.js";
import type { EnvFilesClient, EnvFilesSecret } from "./types.js";

export interface VariablesTableProps {
  client: EnvFilesClient;
  doc: InfraenvDocument;
  scope: EnvScope;
  described: InfraenvDescribeResponse | null;
  /** Null while loading or when the list could not be read. */
  secrets: readonly EnvFilesSecret[] | null;
  onChange: (doc: InfraenvDocument) => void;
  onSecretCreated: (secret: EnvFilesSecret) => void;
}

const NEW_SECRET = "\u0000new";

function useMessages() {
  const gt = useGT();
  const kindLabel = (kind: InfraenvValueKind) =>
    kind === "literal" ? gt("Value") : kind === "resource" ? gt("Resource output") : gt("Secret");
  const rowMessage = (problem: RowProblem) => {
    switch (problem) {
      case "key-missing":
        return gt("Name the variable");
      case "key-invalid":
        return gt("Use letters, digits and _, not starting with a digit");
      case "key-duplicate":
        return gt("This variable is set twice here");
      case "resource-missing":
        return gt("Pick a resource output");
      case "secret-missing":
        return gt("Pick a secret");
    }
  };
  const referenceMessage = (state: ReferenceState) => {
    switch (state) {
      case "resource-not-found":
        return gt("The resource is not in this organization");
      case "output-unknown":
        return gt("The resource's type has no such output");
      case "secret-not-found":
        return gt("No organization secret has this name");
      case "secret-without-value":
        return gt("The secret has no value set");
      case "ok":
      case "unknown":
        return null;
    }
  };
  return { gt, kindLabel, rowMessage, referenceMessage };
}

/** One line describing where a value comes from, never a secret's value. */
function useValueSummary(described: InfraenvDescribeResponse | null) {
  const gt = useGT();
  const ds = useDataString();
  return (entry: InfraenvEntry): string => {
    const value = entry.value;
    switch (value.kind) {
      case "literal":
        return value.value === "" ? gt("(empty)") : value.value;
      case "secret":
        return value.name;
      case "resource": {
        const hit = described?.resources.find(
          (r) => r.resourceId === value.resourceId && r.output === value.output,
        );
        if (hit?.found && hit.displayName) {
          const parts = [
            hit.pluginName ? ds(hit.pluginName) : null,
            hit.displayName,
            hit.outputLabel ? ds(hit.outputLabel) : value.output,
          ];
          return parts.filter(Boolean).join(" · ");
        }
        return entry.comment ?? `${value.resourceId} · ${value.output}`;
      }
    }
  };
}

/**
 * The variables of one scope. In a named environment the shared rows it does
 * not override are listed read-only, with "Override" to copy one in.
 */
export function VariablesTable({
  client,
  doc,
  scope,
  described,
  secrets,
  onChange,
  onSecretCreated,
}: VariablesTableProps) {
  const { gt, kindLabel, rowMessage, referenceMessage } = useMessages();
  const summary = useValueSummary(described);
  const [pickerFor, setPickerFor] = useState<{ index: number | null } | null>(null);
  const [newSecretFor, setNewSecretFor] = useState<number | null>(null);

  const entries = scopeEntries(doc, scope);
  const rows = rowsFor(doc, scope);

  const update = (index: number, next: InfraenvEntry) =>
    onChange(putEntry(doc, scope, index, next));
  const setValue = (index: number, entry: InfraenvEntry, value: InfraenvValue) =>
    update(index, { ...entry, value });

  const secretNames = (secrets ?? []).map((s) => s.name);

  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p className="text-sm text-on-surface-faint">{gt("No variables yet.")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface-raised">
          {rows.map((row) => {
            const { entry } = row;
            const reference = referenceMessage(referenceState(entry.value, described));
            if (row.inherited) {
              return (
                <li key={`shared:${entry.key}`} className="px-3 py-2">
                  <div className="flex items-center gap-3">
                    <span className="w-48 shrink-0 truncate font-mono text-sm text-on-surface-secondary">
                      {entry.key}
                    </span>
                    <span className="w-32 shrink-0 text-xs text-on-surface-faint">
                      {kindLabel(entry.value.kind)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-on-surface-secondary">
                      {summary(entry)}
                    </span>
                    <span className="shrink-0 text-xs text-on-surface-faint">{gt("Shared")}</span>
                    <button
                      type="button"
                      className={quietButton}
                      onClick={() => scope !== null && onChange(overrideEntry(doc, scope, entry))}
                    >
                      {gt("Override")}
                    </button>
                  </div>
                  {reference && <p className="mt-1 text-xs text-warning">{reference}</p>}
                </li>
              );
            }

            const index = row.index!;
            const problem = rowProblem(entries, index);
            const local = problem ? rowMessage(problem) : null;
            const value = entry.value;
            const keyInvalid =
              problem === "key-invalid" || problem === "key-duplicate" || problem === "key-missing";
            return (
              <li key={`own:${index}`} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    className={`${fieldClass} w-56 shrink-0 font-mono ${
                      keyInvalid && entry.key !== "" ? "border-danger" : ""
                    }`}
                    value={entry.key}
                    maxLength={256}
                    spellCheck={false}
                    onChange={(e) => update(index, { ...entry, key: e.target.value })}
                    aria-label={gt("Variable name")}
                    placeholder="DATABASE_URL"
                  />
                  <select
                    className={`${fieldClass} w-40 shrink-0`}
                    value={value.kind}
                    aria-label={gt("Source")}
                    onChange={(e) => {
                      const kind = e.target.value as InfraenvValueKind;
                      update(index, withKind(entry, kind));
                      if (kind === "resource") setPickerFor({ index });
                    }}
                  >
                    {(["literal", "resource", "secret"] as const).map((kind) => (
                      <option key={kind} value={kind}>
                        {kindLabel(kind)}
                      </option>
                    ))}
                  </select>

                  <div className="min-w-[12rem] flex-1">
                    {value.kind === "literal" && (
                      <input
                        type="text"
                        className={`${inputClass} font-mono`}
                        value={value.value}
                        spellCheck={false}
                        onChange={(e) =>
                          setValue(index, entry, { kind: "literal", value: e.target.value })
                        }
                        aria-label={gt("Value")}
                      />
                    )}
                    {value.kind === "resource" && (
                      <button
                        type="button"
                        className={`${inputClass} truncate text-left`}
                        onClick={() => setPickerFor({ index })}
                      >
                        {value.resourceId ? (
                          summary(entry)
                        ) : (
                          <span className="text-on-surface-faint">
                            {gt("Pick a resource output…")}
                          </span>
                        )}
                      </button>
                    )}
                    {value.kind === "secret" &&
                      (secrets === null ? (
                        <input
                          type="text"
                          className={`${inputClass} font-mono`}
                          value={value.name}
                          spellCheck={false}
                          onChange={(e) =>
                            setValue(index, entry, { kind: "secret", name: e.target.value })
                          }
                          aria-label={gt("Secret name")}
                        />
                      ) : (
                        <select
                          className={inputClass}
                          value={value.name}
                          aria-label={gt("Secret")}
                          onChange={(e) => {
                            if (e.target.value === NEW_SECRET) setNewSecretFor(index);
                            else setValue(index, entry, { kind: "secret", name: e.target.value });
                          }}
                        >
                          <option value="" disabled>
                            {secrets.length === 0 ? gt("No secrets yet") : gt("Pick a secret…")}
                          </option>
                          {value.name !== "" && !secretNames.includes(value.name) && (
                            <option value={value.name}>
                              {gt("{name} (missing)", { name: value.name })}
                            </option>
                          )}
                          {secrets.map((s) => (
                            <option key={s.id} value={s.name}>
                              {s.hasValue ? s.name : gt("{name} (no value)", { name: s.name })}
                            </option>
                          ))}
                          {client.createSecret && (
                            <option value={NEW_SECRET}>{gt("New secret…")}</option>
                          )}
                        </select>
                      ))}
                  </div>

                  {row.overrides && (
                    <span className="shrink-0 text-xs text-on-surface-faint">
                      {gt("Overrides shared")}
                    </span>
                  )}
                  <button
                    type="button"
                    className={`${quietButton} text-danger`}
                    onClick={() => onChange(removeEntry(doc, scope, index))}
                    aria-label={gt("Remove {key}", { key: entry.key || gt("variable") })}
                  >
                    {row.overrides ? gt("Use shared") : gt("Remove")}
                  </button>
                </div>
                {(local ?? reference) && (
                  <p className={`mt-1 text-xs ${local ? "text-danger" : "text-warning"}`}>
                    {local ?? reference}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={secondaryButton}
          onClick={() =>
            onChange(putEntry(doc, scope, null, { key: "", value: { kind: "literal", value: "" } }))
          }
        >
          {gt("Add variable")}
        </button>
        <button
          type="button"
          className={secondaryButton}
          onClick={() => setPickerFor({ index: null })}
        >
          {gt("Add resource output")}
        </button>
      </div>

      {pickerFor && (
        <ResourcePickerModal
          client={client}
          onClose={() => setPickerFor(null)}
          onPick={(source, output) => {
            const entry = pickResource(entries, pickerFor.index, source, output);
            onChange(putEntry(doc, scope, pickerFor.index, entry));
            setPickerFor(null);
          }}
        />
      )}
      {newSecretFor !== null && client.createSecret && (
        <NewSecretModal
          createSecret={client.createSecret}
          defaultName={entries[newSecretFor]?.key ?? ""}
          taken={secretNames}
          onClose={() => setNewSecretFor(null)}
          onCreated={(secret) => {
            const entry = entries[newSecretFor];
            if (entry) setValue(newSecretFor, entry, { kind: "secret", name: secret.name });
            onSecretCreated(secret);
            setNewSecretFor(null);
          }}
        />
      )}
    </div>
  );
}
