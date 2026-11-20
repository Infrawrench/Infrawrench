/**
 * Pure edits on an `.infraenv` document for the environment files panel.
 * Every function returns a new document; nothing here touches React, the
 * network or translations, so the panel's behaviour is testable on its own.
 *
 * A "scope" is where a variable lives: `null` for `[env]` (shared by every
 * environment), or the name of an `[env.<name>]` section.
 */
import {
  INFRAENV_LIMITS,
  isInfraenvEnvironmentName,
  isInfraenvKey,
  suggestInfraenvKey,
  type InfraenvDescribeResponse,
  type InfraenvDocument,
  type InfraenvEntry,
  type InfraenvSource,
  type InfraenvSourceOutput,
  type InfraenvValue,
  type InfraenvValueKind,
} from "@infrawrench/client-core";

export type EnvScope = string | null;

export function scopeEntries(doc: InfraenvDocument, scope: EnvScope): readonly InfraenvEntry[] {
  if (scope === null) return doc.shared;
  return doc.environments.find((e) => e.name === scope)?.entries ?? [];
}

function withScopeEntries(
  doc: InfraenvDocument,
  scope: EnvScope,
  entries: readonly InfraenvEntry[],
): InfraenvDocument {
  if (scope === null) return { ...doc, shared: entries };
  return {
    ...doc,
    environments: doc.environments.map((e) => (e.name === scope ? { ...e, entries } : e)),
  };
}

/** An entry as the editor holds it: no source line, since it no longer has one. */
function edited(entry: InfraenvEntry): InfraenvEntry {
  const { line: _line, ...rest } = entry;
  return rest;
}

/** Replace the entry at `index` in `scope`, or append it when `index` is null. */
export function putEntry(
  doc: InfraenvDocument,
  scope: EnvScope,
  index: number | null,
  entry: InfraenvEntry,
): InfraenvDocument {
  const entries = [...scopeEntries(doc, scope)];
  if (index === null || index >= entries.length) entries.push(edited(entry));
  else entries[index] = edited(entry);
  return withScopeEntries(doc, scope, entries);
}

export function removeEntry(
  doc: InfraenvDocument,
  scope: EnvScope,
  index: number,
): InfraenvDocument {
  return withScopeEntries(
    doc,
    scope,
    scopeEntries(doc, scope).filter((_, i) => i !== index),
  );
}

/** A blank value of one kind, for switching a row's source. */
export function blankValue(kind: InfraenvValueKind): InfraenvValue {
  switch (kind) {
    case "literal":
      return { kind: "literal", value: "" };
    case "resource":
      return { kind: "resource", resourceId: "", output: "" };
    case "secret":
      return { kind: "secret", name: "" };
  }
}

/**
 * Switch an entry's source kind. A resource comment describes the resource it
 * pointed at, so it goes when the reference does.
 */
export function withKind(entry: InfraenvEntry, kind: InfraenvValueKind): InfraenvEntry {
  if (entry.value.kind === kind) return entry;
  const { comment, ...rest } = entry;
  return {
    ...rest,
    value: blankValue(kind),
    ...(comment !== undefined && entry.value.kind !== "resource" ? { comment } : {}),
  };
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export type EnvironmentNameProblem = "invalid" | "taken" | "too-many";

export function environmentNameProblem(
  doc: InfraenvDocument,
  name: string,
  renaming?: string,
): EnvironmentNameProblem | null {
  if (!isInfraenvEnvironmentName(name)) return "invalid";
  if (name !== renaming && doc.environments.some((e) => e.name === name)) return "taken";
  if (renaming === undefined && doc.environments.length >= INFRAENV_LIMITS.maxEnvironments) {
    return "too-many";
  }
  return null;
}

export function addEnvironment(doc: InfraenvDocument, name: string): InfraenvDocument {
  if (environmentNameProblem(doc, name) !== null) return doc;
  return { ...doc, environments: [...doc.environments, { name, entries: [] }] };
}

export function renameEnvironment(
  doc: InfraenvDocument,
  from: string,
  to: string,
): InfraenvDocument {
  if (from === to || environmentNameProblem(doc, to, from) !== null) return doc;
  return {
    ...doc,
    environments: doc.environments.map((e) => (e.name === from ? { ...e, name: to } : e)),
  };
}

export function removeEnvironment(doc: InfraenvDocument, name: string): InfraenvDocument {
  return { ...doc, environments: doc.environments.filter((e) => e.name !== name) };
}

// ---------------------------------------------------------------------------
// Rows: what the table shows for one scope
// ---------------------------------------------------------------------------

export interface EnvRow {
  entry: InfraenvEntry;
  /** Index in the scope's own entries; null for a row inherited from `[env]`. */
  index: number | null;
  /** A shared row shown in a named environment, read-only there. */
  inherited: boolean;
  /** A named environment's row whose key `[env]` also sets. */
  overrides: boolean;
}

/**
 * The rows of one scope. `[env]` is its own entries. A named environment is
 * every variable it ends up with (`infraenvEntriesFor`'s order): its own rows,
 * and the shared rows it does not override, marked inherited.
 */
export function rowsFor(doc: InfraenvDocument, scope: EnvScope): EnvRow[] {
  if (scope === null) {
    return doc.shared.map((entry, index) => ({
      entry,
      index,
      inherited: false,
      overrides: false,
    }));
  }
  const own = scopeEntries(doc, scope);
  const ownKeys = new Set(own.map((e) => e.key));
  const rows: EnvRow[] = doc.shared.map((entry) => {
    if (!ownKeys.has(entry.key)) return { entry, index: null, inherited: true, overrides: false };
    const index = own.findIndex((e) => e.key === entry.key);
    return { entry: own[index]!, index, inherited: false, overrides: true };
  });
  own.forEach((entry, index) => {
    if (rows.some((r) => r.index === index)) return;
    rows.push({ entry, index, inherited: false, overrides: false });
  });
  return rows;
}

/** Copy a shared entry into a named environment, where it can then be changed. */
export function overrideEntry(
  doc: InfraenvDocument,
  scope: string,
  shared: InfraenvEntry,
): InfraenvDocument {
  if (scopeEntries(doc, scope).some((e) => e.key === shared.key)) return doc;
  return putEntry(doc, scope, null, shared);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type RowProblem =
  "key-missing" | "key-invalid" | "key-duplicate" | "resource-missing" | "secret-missing";

/** What is wrong with a row before anything is sent: the editor's own checks. */
export function rowProblem(entries: readonly InfraenvEntry[], index: number): RowProblem | null {
  const entry = entries[index];
  if (!entry) return null;
  if (entry.key === "") return "key-missing";
  if (!isInfraenvKey(entry.key)) return "key-invalid";
  if (entries.some((e, i) => i !== index && e.key === entry.key)) return "key-duplicate";
  if (entry.value.kind === "resource" && (!entry.value.resourceId || !entry.value.output)) {
    return "resource-missing";
  }
  if (entry.value.kind === "secret" && !entry.value.name) return "secret-missing";
  return null;
}

/** Every row problem in the document, so saving can be held back until there are none. */
export function documentProblemCount(doc: InfraenvDocument): number {
  let count = 0;
  for (const entries of [doc.shared, ...doc.environments.map((e) => e.entries)]) {
    for (let i = 0; i < entries.length; i++) if (rowProblem(entries, i) !== null) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// References, as `/describe` reports them
// ---------------------------------------------------------------------------

export type ReferenceState =
  | "ok"
  /** Not described yet (the first describe has not answered). */
  | "unknown"
  | "resource-not-found"
  | "output-unknown"
  | "secret-not-found"
  | "secret-without-value";

export function referenceState(
  value: InfraenvValue,
  described: InfraenvDescribeResponse | null,
): ReferenceState {
  if (value.kind === "literal") return "ok";
  if (!described) return "unknown";
  if (value.kind === "resource") {
    const hit = described.resources.find(
      (r) => r.resourceId === value.resourceId && r.output === value.output,
    );
    if (!hit) return "unknown";
    if (!hit.found) return "resource-not-found";
    if (!hit.outputKnown) return "output-unknown";
    return "ok";
  }
  const secret = described.secrets.find((s) => s.name === value.name);
  if (!secret) return "unknown";
  if (!secret.found) return "secret-not-found";
  if (!secret.hasValue) return "secret-without-value";
  return "ok";
}

/**
 * The comment written above a resource reference, so the committed file reads
 * in review without looking the id up: `Neon: main (connectionString)`.
 */
export function resourceComment(source: InfraenvSource, output: InfraenvSourceOutput): string {
  return `${source.pluginName}: ${source.displayName} (${output.key})`;
}

/** The variable name a picked output suggests. */
export function suggestedKeyFor(output: InfraenvSourceOutput): string {
  return output.suggestedKey && isInfraenvKey(output.suggestedKey)
    ? output.suggestedKey
    : suggestInfraenvKey(output.key);
}

/** `base`, or `base_2`, `base_3`… when a row of the scope already uses it. */
export function uniqueKey(base: string, entries: readonly InfraenvEntry[], skip?: number): string {
  const taken = new Set(entries.filter((_, i) => i !== skip).map((e) => e.key));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Point an entry at a picked resource output: the value, the readable
 * comment, and a key when the row has none yet.
 */
export function pickResource(
  entries: readonly InfraenvEntry[],
  index: number | null,
  source: InfraenvSource,
  output: InfraenvSourceOutput,
): InfraenvEntry {
  const current = index === null ? undefined : entries[index];
  const key =
    current && current.key !== ""
      ? current.key
      : uniqueKey(suggestedKeyFor(output), entries, index ?? undefined);
  return {
    key,
    value: { kind: "resource", resourceId: source.resourceId, output: output.key },
    comment: resourceComment(source, output),
  };
}

/** The file name a repository path ends in, for a download. */
export function fileNameOf(path: string): string {
  const name = path.split("/").filter(Boolean).pop();
  return name && name !== "" ? name : ".infraenv";
}
