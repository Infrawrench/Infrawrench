/**
 * Pure edits on an `.infraenv` document for the environment files panel.
 * Every function returns a new document; nothing here touches React, the
 * network or translations, so the panel's behaviour is testable on its own.
 *
 * A "scope" is where a variable lives: `null` for `[env]` (shared by every
 * environment), or the name of an `[env.<name>]` section.
 */
import {
  expandInfraenvValue,
  INFRAENV_LIMITS,
  infraenvReferenceKey,
  isInfraenvEnvironmentName,
  isInfraenvKey,
  suggestInfraenvKey,
  type InfraenvDescribeResponse,
  type InfraenvDocument,
  type InfraenvEntry,
  type InfraenvResourceDescription,
  type InfraenvResourceMatch,
  type InfraenvSource,
  type InfraenvSourceOutput,
  type InfraenvValue,
  type InfraenvVar,
  escapeInfraenvSubstitutions,
  infraenvKeyForOutput,
  infraenvMatchForSource,
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

/**
 * The source a row's kind picker shows. A resource output is one choice
 * whether the reference finds the resource by name or pins it by id.
 */
export type EditorKind = "literal" | "resource" | "secret";

export function editorKind(value: InfraenvValue): EditorKind {
  return value.kind === "named-resource" ? "resource" : value.kind;
}

/** A resource reference, by id or by name. */
export function isResourceValue(
  value: InfraenvValue,
): value is Extract<InfraenvValue, { kind: "resource" } | { kind: "named-resource" }> {
  return value.kind === "resource" || value.kind === "named-resource";
}

/** A blank value of one kind, for switching a row's source. A resource starts by name. */
export function blankValue(kind: EditorKind): InfraenvValue {
  switch (kind) {
    case "literal":
      return { kind: "literal", value: "" };
    case "resource":
      return {
        kind: "named-resource",
        match: { pluginId: "", resourceTypeId: "", name: "" },
        output: "",
      };
    case "secret":
      return { kind: "secret", name: "" };
  }
}

/**
 * Switch an entry's source kind. A resource comment describes the resource it
 * pointed at, so it goes when the reference does.
 */
export function withKind(entry: InfraenvEntry, kind: EditorKind): InfraenvEntry {
  if (editorKind(entry.value) === kind) return entry;
  const { comment, ...rest } = entry;
  return {
    ...rest,
    value: blankValue(kind),
    ...(comment !== undefined && !isResourceValue(entry.value) ? { comment } : {}),
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

function resourceIncomplete(value: InfraenvValue): boolean {
  if (value.kind === "resource") return !value.resourceId || !value.output;
  if (value.kind === "named-resource") {
    const m = value.match;
    return !m.pluginId || !m.resourceTypeId || !m.name || m.account === "" || !value.output;
  }
  return false;
}

/** What is wrong with a row before anything is sent: the editor's own checks. */
export function rowProblem(entries: readonly InfraenvEntry[], index: number): RowProblem | null {
  const entry = entries[index];
  if (!entry) return null;
  if (entry.key === "") return "key-missing";
  if (!isInfraenvKey(entry.key)) return "key-invalid";
  if (entries.some((e, i) => i !== index && e.key === entry.key)) return "key-duplicate";
  if (resourceIncomplete(entry.value)) return "resource-missing";
  if (entry.value.kind === "secret" && !entry.value.name) return "secret-missing";
  return null;
}

/**
 * Every row and substitution problem in the document, so saving can be held
 * back until there are none.
 */
export function documentProblemCount(doc: InfraenvDocument): number {
  let count = 0;
  for (const entries of [doc.shared, ...doc.environments.map((e) => e.entries)]) {
    for (let i = 0; i < entries.length; i++) if (rowProblem(entries, i) !== null) count++;
  }
  for (const vars of [doc.vars ?? [], ...doc.environments.map((e) => e.vars ?? [])]) {
    for (let i = 0; i < vars.length; i++) if (varProblem(vars, i) !== null) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// References, as `/describe` reports them
// ---------------------------------------------------------------------------

export type ReferenceCheck =
  | {
      readonly state:
        | "ok"
        /** Not described yet (the first describe has not answered). */
        | "unknown"
        | "resource-not-found"
        | "output-unknown"
        | "secret-without-value";
    }
  /** A by-name reference that finds more than one resource. */
  | { readonly state: "ambiguous"; readonly matches: number }
  /** `name` is the secret's name with its substitutions filled in. */
  | { readonly state: "secret-not-found"; readonly name: string }
  /** A `${name}` in the reference has no value in this scope. */
  | { readonly state: "substitution-missing"; readonly missing: readonly string[] };

export type ReferenceState = ReferenceCheck["state"];

/**
 * What `/describe` said about a resource reference in one scope: the value is
 * expanded with that scope's substitutions and matched on its reference key,
 * the same key the server reports as `ref`.
 */
export function describedResource(
  value: InfraenvValue,
  described: InfraenvDescribeResponse | null,
  vars: ReadonlyMap<string, string>,
): InfraenvResourceDescription | null {
  if (!described || !isResourceValue(value)) return null;
  const expanded = expandInfraenvValue(value, vars);
  if (!expanded.ok) return null;
  const ref = infraenvReferenceKey(expanded.value);
  return described.resources.find((r) => r.ref === ref) ?? null;
}

/** A row's reference as `/describe` reports it, in the scope whose substitutions `vars` holds. */
export function referenceState(
  value: InfraenvValue,
  described: InfraenvDescribeResponse | null,
  vars: ReadonlyMap<string, string> = new Map(),
): ReferenceCheck {
  if (value.kind === "literal") return { state: "ok" };
  const expanded = expandInfraenvValue(value, vars);
  if (!expanded.ok) return { state: "substitution-missing", missing: expanded.missing };
  if (!described) return { state: "unknown" };
  const x = expanded.value;
  if (x.kind === "secret") {
    const secret = described.secrets.find((s) => s.name === x.name);
    if (!secret) return { state: "unknown" };
    if (!secret.found) return { state: "secret-not-found", name: x.name };
    if (!secret.hasValue) return { state: "secret-without-value" };
    return { state: "ok" };
  }
  const ref = infraenvReferenceKey(x);
  const hit = described.resources.find((r) => r.ref === ref);
  if (!hit) return { state: "unknown" };
  if ((hit.matches ?? 0) > 1) return { state: "ambiguous", matches: hit.matches! };
  if (!hit.found) return { state: "resource-not-found" };
  if (!hit.outputKnown) return { state: "output-unknown" };
  return { state: "ok" };
}

/**
 * The comment written above a resource reference, so the committed file reads
 * in review without looking the id up: `Neon: main (connectionString)`.
 */
export function resourceComment(source: InfraenvSource, output: InfraenvSourceOutput): string {
  return `${source.pluginName}: ${source.displayName} (${output.key})`;
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

export interface PickOptions {
  /** Pin the resource by id instead of finding it by name. */
  readonly pin: boolean;
  /** The resources the picker had loaded, to tell same-named ones apart. */
  readonly loaded: readonly InfraenvSource[];
}

/**
 * Point an entry at a picked resource output: the value (by name unless
 * pinned), the readable comment, and a key when the row has none yet.
 */
export function pickResource(
  entries: readonly InfraenvEntry[],
  index: number | null,
  source: InfraenvSource,
  output: InfraenvSourceOutput,
  options: PickOptions = { pin: false, loaded: [] },
): InfraenvEntry {
  const current = index === null ? undefined : entries[index];
  const key =
    current && current.key !== ""
      ? current.key
      : uniqueKey(suggestedKeyFor(output), entries, index ?? undefined);
  const match = options.pin ? null : namedMatchFor(source, options.loaded);
  const value: InfraenvValue = match
    ? { kind: "named-resource", match, output: output.key }
    : {
        kind: "resource",
        resourceId: escapeInfraenvTemplate(source.resourceId),
        output: output.key,
      };
  return { key, value, comment: resourceComment(source, output) };
}

/**
 * Change the name a by-name reference looks for. A comment the picker wrote
 * (`Neon: main (connectionString)`) follows the new name; any other comment
 * is the author's and stays as it is.
 */
export function withResourceName(entry: InfraenvEntry, name: string): InfraenvEntry {
  const value = entry.value;
  if (value.kind !== "named-resource") return entry;
  const tail = `: ${value.match.name} (${value.output})`;
  const comment =
    entry.comment !== undefined && value.match.name !== "" && entry.comment.endsWith(tail)
      ? `${entry.comment.slice(0, -tail.length)}: ${name} (${value.output})`
      : entry.comment;
  return {
    ...entry,
    value: { ...value, match: { ...value.match, name } },
    ...(comment !== undefined ? { comment } : {}),
  };
}

/**
 * Switch a resource reference between by-name and by-id, from what
 * `/describe` found for it. Null when the description cannot say (the
 * resource was not found, or the name matches several).
 */
export function toggledReference(
  value: InfraenvValue,
  hit: InfraenvResourceDescription | null,
): InfraenvValue | null {
  if (!hit?.found) return null;
  if (value.kind === "named-resource") {
    if (!hit.resourceId) return null;
    return {
      kind: "resource",
      resourceId: escapeInfraenvTemplate(hit.resourceId),
      output: value.output,
    };
  }
  if (value.kind === "resource") {
    if (!hit.pluginId || !hit.resourceTypeId || !hit.displayName) return null;
    return {
      kind: "named-resource",
      match: {
        pluginId: hit.pluginId,
        resourceTypeId: hit.resourceTypeId,
        name: escapeInfraenvTemplate(hit.displayName),
      },
      output: value.output,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Substitutions: `[vars]` and `[vars.<env>]`
// ---------------------------------------------------------------------------

export function scopeVars(doc: InfraenvDocument, scope: EnvScope): readonly InfraenvVar[] {
  if (scope === null) return doc.vars ?? [];
  return doc.environments.find((e) => e.name === scope)?.vars ?? [];
}

function withScopeVars(
  doc: InfraenvDocument,
  scope: EnvScope,
  vars: readonly InfraenvVar[],
): InfraenvDocument {
  if (scope === null) {
    const { vars: _vars, ...rest } = doc;
    return vars.length ? { ...rest, vars } : rest;
  }
  return {
    ...doc,
    environments: doc.environments.map((e) => {
      if (e.name !== scope) return e;
      const { vars: _vars, ...rest } = e;
      return vars.length ? { ...rest, vars } : rest;
    }),
  };
}

/** Replace the substitution at `index` in `scope`, or append it when `index` is null. */
export function putVar(
  doc: InfraenvDocument,
  scope: EnvScope,
  index: number | null,
  v: InfraenvVar,
): InfraenvDocument {
  const vars = [...scopeVars(doc, scope)];
  const { line: _line, ...next } = v;
  if (index === null || index >= vars.length) vars.push(next);
  else vars[index] = next;
  return withScopeVars(doc, scope, vars);
}

export function removeVar(doc: InfraenvDocument, scope: EnvScope, index: number): InfraenvDocument {
  return withScopeVars(
    doc,
    scope,
    scopeVars(doc, scope).filter((_, i) => i !== index),
  );
}

export interface VarRow {
  readonly v: InfraenvVar;
  /** Index in the scope's own substitutions; null for one inherited from `[vars]`. */
  readonly index: number | null;
  readonly inherited: boolean;
  /** A named environment's substitution that `[vars]` also sets. */
  readonly overrides: boolean;
}

/** The substitutions of one scope, laid out like `rowsFor` lays out variables. */
export function varRowsFor(doc: InfraenvDocument, scope: EnvScope): VarRow[] {
  const shared = doc.vars ?? [];
  if (scope === null) {
    return shared.map((v, index) => ({ v, index, inherited: false, overrides: false }));
  }
  const own = scopeVars(doc, scope);
  const rows: VarRow[] = shared.map((v) => {
    const index = own.findIndex((o) => o.key === v.key);
    if (index < 0) return { v, index: null, inherited: true, overrides: false };
    return { v: own[index]!, index, inherited: false, overrides: true };
  });
  own.forEach((v, index) => {
    if (rows.some((r) => r.index === index)) return;
    rows.push({ v, index, inherited: false, overrides: false });
  });
  return rows;
}

/** Copy a `[vars]` substitution into a named environment, where it can then be changed. */
export function overrideVar(
  doc: InfraenvDocument,
  scope: string,
  v: InfraenvVar,
): InfraenvDocument {
  if (scopeVars(doc, scope).some((o) => o.key === v.key)) return doc;
  return putVar(doc, scope, null, v);
}

export type VarProblem = "key-missing" | "key-invalid" | "key-duplicate";

export function varProblem(vars: readonly InfraenvVar[], index: number): VarProblem | null {
  const v = vars[index];
  if (!v) return null;
  if (v.key === "") return "key-missing";
  if (!isInfraenvKey(v.key)) return "key-invalid";
  if (vars.some((o, i) => i !== index && o.key === v.key)) return "key-duplicate";
  return null;
}

/** The file name a repository path ends in, for a download. */
export function fileNameOf(path: string): string {
  const name = path.split("/").filter(Boolean).pop();
  return name && name !== "" ? name : ".infraenv";
}

/** The variable name a picked output suggests: the template's, or its key in upper snake case. */
export const suggestedKeyFor = infraenvKeyForOutput;
/** A literal name written into a reference, with any `${` in it escaped. */
export const escapeInfraenvTemplate = escapeInfraenvSubstitutions;
/** The by-name match a picked resource writes, or null when it has to be pinned by id. */
export const namedMatchFor = infraenvMatchForSource;
