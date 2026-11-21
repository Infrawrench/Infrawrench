/**
 * `.infraenv` for the editor extensions (VS Code, Raycast): the Bearer reads
 * of `/api/org/:orgId/env-files` and the pure logic both turn a local copy of
 * the file into: diagnostics, the reference under a cursor and what it
 * resolves to, and the lines an inserted reference writes.
 *
 * The format itself (parser, printer, expansion, wire types) is `infraenv.ts`;
 * nothing here re-parses it differently. Responses are typed with the
 * client-core wire types and passed through as the server sent them, so a
 * newer server's extra fields never break an older extension.
 */
import type { CloudFetch } from "./fetch";
import {
  INFRAENV_DEFAULT_OUTPUT,
  expandInfraenvValue,
  infraenvEntriesFor,
  infraenvReferenceKey,
  infraenvReferences,
  infraenvVariables,
  isGeneratedDotenv,
  isInfraenvKey,
  parseInfraenv,
  printInfraenvValue,
  resourceKindOf,
  suggestInfraenvKey,
  type InfraenvDescribeResponse,
  type InfraenvDocument,
  type InfraenvEntry,
  type InfraenvResolveResponse,
  type InfraenvResourceDescription,
  type InfraenvResourceMatch,
  type InfraenvSecretDescription,
  type InfraenvSource,
  type InfraenvSourceOutput,
  type InfraenvValue,
} from "./infraenv";

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const ENV_FILES = "/env-files";

export interface InfraenvDescribeInput {
  readonly source: string;
  /** Substitutions laid over the file's own `[vars]`, like the CLI's `--var`. */
  readonly vars?: Readonly<Record<string, string>> | undefined;
}

/** `POST /env-files/describe`: what every reference points at. Returns no values. */
export async function fetchInfraenvDescribe(
  api: CloudFetch,
  orgId: string,
  input: InfraenvDescribeInput,
  init?: RequestInit,
): Promise<InfraenvDescribeResponse> {
  const body = await api.org<InfraenvDescribeResponse>(orgId, `${ENV_FILES}/describe`, {
    ...init,
    method: "POST",
    body: JSON.stringify({
      source: input.source,
      ...(input.vars && Object.keys(input.vars).length > 0 ? { vars: input.vars } : {}),
    }),
  });
  return body ?? { problems: [], environments: [], resources: [], secrets: [] };
}

export interface InfraenvResolveInput extends InfraenvDescribeInput {
  /** `[env.<name>]` to lay over `[env]`; null or absent for `[env]` alone. */
  readonly environment?: string | null | undefined;
  /** The file's path relative to the `.env`, named in the generated header. */
  readonly sourceName?: string | undefined;
}

/**
 * `POST /env-files/resolve`: the plaintext values of one environment and the
 * `.env` text. Needs `secrets:read`. A variable that does not resolve is in
 * `problems` and left out; a file with syntax problems is refused (400).
 */
export async function fetchInfraenvResolve(
  api: CloudFetch,
  orgId: string,
  input: InfraenvResolveInput,
  init?: RequestInit,
): Promise<InfraenvResolveResponse> {
  const body = await api.org<InfraenvResolveResponse>(orgId, `${ENV_FILES}/resolve`, {
    ...init,
    method: "POST",
    body: JSON.stringify({
      source: input.source,
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.vars && Object.keys(input.vars).length > 0 ? { vars: input.vars } : {}),
      ...(input.sourceName ? { sourceName: input.sourceName } : {}),
    }),
  });
  if (!body) throw new Error("Infrawrench returned an empty response");
  return body;
}

/** The query string for `GET /env-files/sources`. */
export function infraenvSourcesQueryString(options: { q?: string; limit?: number } = {}): string {
  const params = new URLSearchParams();
  const q = options.q?.trim();
  if (q) params.set("q", q);
  if (options.limit !== undefined) {
    params.set("limit", String(Math.min(100, Math.max(1, Math.floor(options.limit)))));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** `GET /env-files/sources`: resources whose type declares outputs, for a picker. */
export async function fetchInfraenvSources(
  api: CloudFetch,
  orgId: string,
  options: { q?: string; limit?: number } = {},
  init?: RequestInit,
): Promise<InfraenvSource[]> {
  const body = await api.org<{ sources?: InfraenvSource[] }>(
    orgId,
    `${ENV_FILES}/sources${infraenvSourcesQueryString(options)}`,
    init,
  );
  return body?.sources ?? [];
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type InfraenvDiagnosticSeverity = "error" | "warning";

export interface InfraenvDiagnostic {
  /** 1-based; 0 for the file as a whole. */
  readonly line: number;
  readonly message: string;
  readonly severity: InfraenvDiagnosticSeverity;
  readonly key?: string | undefined;
}

const problemId = (line: number, message: string) => `${line}\u0000${message}`;

/**
 * Everything wrong with a local copy of the file. Syntax problems are found
 * offline and are errors (the server refuses to resolve or commit the file).
 * A substitution with no value, also found offline, and every reference a
 * describe reports as dangling are warnings: the file still resolves, minus
 * those variables. A describe problem the offline parse already reported is
 * not repeated. Sorted by line.
 */
export function infraenvDiagnostics(
  source: string,
  describe: InfraenvDescribeResponse | null,
): InfraenvDiagnostic[] {
  const { document, problems } = parseInfraenv(source);
  const out: InfraenvDiagnostic[] = [];
  const seen = new Set<string>();
  const add = (
    p: { line: number; message: string; key?: string | undefined },
    severity: InfraenvDiagnosticSeverity,
  ) => {
    const id = problemId(p.line, p.message);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      line: p.line,
      message: p.message,
      severity,
      ...(p.key !== undefined ? { key: p.key } : {}),
    });
  };
  for (const p of problems) add(p, "error");
  for (const p of infraenvReferences(document).problems) add(p, "warning");
  for (const p of describe?.problems ?? []) add(p, "warning");
  return out
    .map((d, i) => ({ d, i }))
    .sort((a, b) => a.d.line - b.d.line || a.i - b.i)
    .map(({ d }) => d);
}

// ---------------------------------------------------------------------------
// The reference under a cursor
// ---------------------------------------------------------------------------

export interface InfraenvReferenceAt {
  readonly entry: InfraenvEntry;
  /** The reference as written, `${...}` substitutions unexpanded. */
  readonly value: Exclude<InfraenvValue, { kind: "literal" }>;
  /** The `[env.<name>]` section the entry is in; null for `[env]`. */
  readonly environment: string | null;
  /** 1-based line. */
  readonly line: number;
  /** 0-based column where the entry's key starts. */
  readonly start: number;
  /** 0-based column just after the reference's closing `)`. */
  readonly end: number;
}

/** The index just after the `)` that closes a call starting at `from`, or -1. */
function callEnd(text: string, from: number): number {
  const open = text.indexOf("(", from);
  if (open < 0) return -1;
  let quoted = false;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ")") return i + 1;
  }
  return -1;
}

/**
 * The `resource(...)` or `secret(...)` reference on `line` (1-based) when
 * `column` (0-based, as editors count) falls between the start of the entry's
 * key and the reference's closing parenthesis. Null for literals, settings,
 * substitutions, comments and lines that do not parse.
 */
export function infraenvReferenceAt(
  source: string,
  line: number,
  column: number,
): InfraenvReferenceAt | null {
  const { document } = parseInfraenv(source);
  const found = entryOnLine(document, line);
  if (!found || found.entry.value.kind === "literal") return null;
  const text = source.replace(/\r\n?/g, "\n").split("\n")[line - 1] ?? "";
  const head = /^(\s*)(?:export\s+)?[^=\s]+\s*=\s*/.exec(text);
  if (!head) return null;
  const start = head[1]!.length;
  const end = callEnd(text, head[0].length);
  if (end < 0 || column < start || column > end) return null;
  return {
    entry: found.entry,
    value: found.entry.value,
    environment: found.environment,
    line,
    start,
    end,
  };
}

function entryOnLine(
  doc: InfraenvDocument,
  line: number,
): { entry: InfraenvEntry; environment: string | null } | null {
  const shared = doc.shared.find((e) => e.line === line);
  if (shared) return { entry: shared, environment: null };
  for (const env of doc.environments) {
    const entry = env.entries.find((e) => e.line === line);
    if (entry) return { entry, environment: env.name };
  }
  return null;
}

/** Every entry that makes a reference, with its section, in file order. */
export function infraenvReferenceEntries(
  doc: InfraenvDocument,
): { entry: InfraenvEntry; environment: string | null }[] {
  const out: { entry: InfraenvEntry; environment: string | null }[] = [];
  for (const entry of doc.shared) {
    if (entry.value.kind !== "literal") out.push({ entry, environment: null });
  }
  for (const env of doc.environments) {
    for (const entry of env.entries) {
      if (entry.value.kind !== "literal") out.push({ entry, environment: env.name });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// What a reference resolves to
// ---------------------------------------------------------------------------

/** `unchecked`: no describe yet (signed out, or still loading). */
export type InfraenvCheckState = "ok" | "warning" | "error" | "unchecked";

export interface InfraenvReferenceCheck {
  /**
   * The scopes this row covers, in file order: null is `[env]` alone, a name
   * is that environment. A reference without substitutions is the same in
   * every scope and comes back as one row.
   */
  readonly environments: readonly (string | null)[];
  /** The reference with substitutions filled in; null when one has no value. */
  readonly value: InfraenvValue | null;
  readonly state: InfraenvCheckState;
  /** What the reference found or names: a resource's display name, a secret's name. */
  readonly title: string;
  /** `Neon Branch · acme-neon · Connection string`, or what was looked for. */
  readonly detail: string;
  /** Why the state is not `ok`. */
  readonly message?: string | undefined;
  readonly resource?: InfraenvResourceDescription | undefined;
  readonly secret?: InfraenvSecretDescription | undefined;
}

function sameEntry(a: InfraenvEntry, b: InfraenvEntry): boolean {
  return a === b || (a.key === b.key && a.line !== undefined && a.line === b.line);
}

/** `neon/neon-branch "main" · connectionString`: what a reference looks for. */
function wanted(value: Exclude<InfraenvValue, { kind: "literal" }>): string {
  switch (value.kind) {
    case "resource":
      return `${value.resourceId} · ${value.output}`;
    case "named-resource":
      return `${resourceKindOf(value.match)} "${value.match.name}" · ${value.output}`;
    case "secret":
      return "Organization secret";
  }
}

function checkOne(
  value: Exclude<InfraenvValue, { kind: "literal" }>,
  describe: InfraenvDescribeResponse | null,
): Omit<InfraenvReferenceCheck, "environments" | "value"> {
  if (value.kind === "secret") {
    const secret = describe?.secrets.find((s) => s.name === value.name);
    const base = { title: value.name, detail: "Organization secret", secret };
    if (!describe || !secret) return { ...base, state: "unchecked" };
    if (!secret.found) {
      return { ...base, state: "error", message: `No organization secret named ${value.name}` };
    }
    if (!secret.hasValue) {
      return {
        ...base,
        state: "warning",
        message: `The organization secret ${value.name} has no value yet`,
      };
    }
    return { ...base, state: "ok" };
  }
  const ref = infraenvReferenceKey(value);
  const resource = describe?.resources.find((r) => r.ref === ref);
  const notFound = {
    title: value.kind === "named-resource" ? value.match.name : value.resourceId,
    detail: wanted(value),
    resource,
  };
  if (!describe || !resource) return { ...notFound, state: "unchecked" };
  if (!resource.found) {
    const matches = resource.matches ?? 0;
    return {
      ...notFound,
      state: "error",
      message:
        value.kind === "named-resource"
          ? matches > 1
            ? `Ambiguous: ${matches} resources match`
            : "No resource by that name"
          : "Resource not found",
    };
  }
  const kind = [resource.pluginName, resource.resourceTypeName].filter(Boolean).join(" ");
  const detail = [kind, resource.accountName, resource.outputLabel ?? resource.output]
    .filter((p): p is string => Boolean(p))
    .join(" · ");
  const base = {
    title: resource.displayName ?? resource.resourceId ?? notFound.title,
    detail,
    resource,
  };
  if (!resource.outputKnown) {
    return {
      ...base,
      state: "warning",
      message: `${resource.resourceTypeName ?? "The resource"} has no output "${value.output}"`,
    };
  }
  return { ...base, state: "ok" };
}

/**
 * What one entry's reference resolves to, per the describe of the same text.
 * The entry is expanded in every scope it applies to (an `[env]` entry in
 * `[env]` alone and in each environment that does not override it; an
 * `[env.<name>]` entry in that environment), and scopes that expand to the
 * same reference share a row.
 */
export function checkInfraenvReference(
  doc: InfraenvDocument,
  at: { entry: InfraenvEntry; environment: string | null },
  describe: InfraenvDescribeResponse | null,
  overrides?: Readonly<Record<string, string>> | null,
): InfraenvReferenceCheck[] {
  const value = at.entry.value;
  if (value.kind === "literal") return [];
  const scopes =
    at.environment === null
      ? [null, ...doc.environments.map((e) => e.name)].filter((scope) =>
          infraenvEntriesFor(doc, scope).some((e) => sameEntry(e, at.entry)),
        )
      : [at.environment];
  const rows = new Map<
    string,
    { environments: (string | null)[]; check: Omit<InfraenvReferenceCheck, "environments"> }
  >();
  for (const scope of scopes) {
    const x = expandInfraenvValue(value, infraenvVariables(doc, scope, overrides));
    const id = x.ok ? infraenvReferenceKey(x.value) : `missing:${x.missing.join(",")}`;
    const row = rows.get(id);
    if (row) {
      row.environments.push(scope);
      continue;
    }
    const check: Omit<InfraenvReferenceCheck, "environments"> = x.ok
      ? {
          value: x.value,
          ...checkOne(x.value as Exclude<InfraenvValue, { kind: "literal" }>, describe),
        }
      : {
          value: null,
          state: "error",
          title: value.kind === "named-resource" ? value.match.name : at.entry.key,
          detail: wanted(value),
          message: x.message,
        };
    rows.set(id, { environments: [scope], check });
  }
  return [...rows.values()].map(({ environments, check }) => ({ environments, ...check }));
}

/** The worst state of several checks: what one row or one file shows. */
export function worstInfraenvCheckState(states: readonly InfraenvCheckState[]): InfraenvCheckState {
  const rank: Record<InfraenvCheckState, number> = { error: 3, warning: 2, unchecked: 1, ok: 0 };
  let worst: InfraenvCheckState = "ok";
  for (const s of states) if (rank[s] > rank[worst]) worst = s;
  return worst;
}

/** `[env]` for null, `production` for a name: how a scope reads in a list. */
export function infraenvScopeLabel(scope: string | null): string {
  return scope ?? "[env]";
}

// ---------------------------------------------------------------------------
// Pulling a `.env` next to the file
// ---------------------------------------------------------------------------

/** Where `env pull` writes, relative to the file's directory. */
export function infraenvOutputPath(doc: InfraenvDocument): string {
  return doc.settings.output || INFRAENV_DEFAULT_OUTPUT;
}

/**
 * Whether a pull may write over what is at the target: nothing there, a
 * `.env` Infrawrench generated, or something hand-written that needs the
 * user's say-so first (the CLI's `--force`).
 */
export function infraenvPullDecision(existing: string | null): "create" | "replace" | "confirm" {
  if (existing === null) return "create";
  return isGeneratedDotenv(existing) ? "replace" : "confirm";
}

// ---------------------------------------------------------------------------
// Inserting a reference
// ---------------------------------------------------------------------------

/**
 * A string as a reference argument that reads back as itself: a `${...}` in
 * a resource's own name is not a substitution, so it is written `$${...}`.
 */
export function escapeInfraenvSubstitutions(text: string): string {
  return text.replace(/\$?\$\{[^}]*\}/g, (m) => `$${m}`);
}

/**
 * The by-name match a picked resource writes. When other resources in
 * `loaded` share its plugin, type and name, the account is added; when even
 * that cannot tell them apart, null, and the caller pins it by id.
 */
export function infraenvMatchForSource(
  source: InfraenvSource,
  loaded: readonly InfraenvSource[],
): InfraenvResourceMatch | null {
  const twins = loaded.filter(
    (s) =>
      s.resourceId !== source.resourceId &&
      s.pluginId === source.pluginId &&
      s.resourceTypeId === source.resourceTypeId &&
      s.displayName === source.displayName,
  );
  const base = {
    pluginId: source.pluginId,
    resourceTypeId: source.resourceTypeId,
    name: escapeInfraenvSubstitutions(source.displayName),
  };
  if (twins.length === 0) return base;
  if (source.accountName === "" || twins.some((s) => s.accountName === source.accountName)) {
    return null;
  }
  return { ...base, account: escapeInfraenvSubstitutions(source.accountName) };
}

/** The variable name a picked output suggests. */
export function infraenvKeyForOutput(output: InfraenvSourceOutput): string {
  return output.suggestedKey && isInfraenvKey(output.suggestedKey)
    ? output.suggestedKey
    : suggestInfraenvKey(output.key);
}

/** `base`, or `base_2`, `base_3`… when `taken` already has it. */
export function uniqueInfraenvKey(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * The two lines an inserted reference writes: a comment naming what it points
 * at, and the variable. By name (portable across organizations), unless
 * resources in `loaded` share the name and the account cannot tell them
 * apart, in which case it is pinned by id.
 */
export function infraenvReferenceLines(
  key: string,
  source: InfraenvSource,
  output: InfraenvSourceOutput,
  loaded: readonly InfraenvSource[] = [],
): [comment: string, line: string] {
  const match = infraenvMatchForSource(source, loaded);
  const value: InfraenvValue = match
    ? { kind: "named-resource", match, output: output.key }
    : {
        kind: "resource",
        resourceId: escapeInfraenvSubstitutions(source.resourceId),
        output: output.key,
      };
  const comment = `# ${source.pluginName}: ${source.displayName} (${output.label || output.key})`;
  return [comment.replace(/[\r\n]+/g, " "), `${key} = ${printInfraenvValue(value)}`];
}

/** The section a 1-based line is in, by the nearest header above it. */
export type InfraenvSectionAt =
  | { readonly kind: "settings" }
  | { readonly kind: "vars"; readonly environment: string | null }
  | { readonly kind: "env"; readonly environment: string | null }
  | { readonly kind: "unknown" };

export function infraenvSectionAt(source: string, line: number): InfraenvSectionAt {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const m = /^\s*\[([^\]]*)\]\s*(#.*)?$/.exec(lines[i]!);
    if (!m) continue;
    const name = m[1]!.trim();
    if (name === "infrawrench") return { kind: "settings" };
    if (name === "env") return { kind: "env", environment: null };
    if (name === "vars") return { kind: "vars", environment: null };
    if (name.startsWith("env.")) return { kind: "env", environment: name.slice(4) };
    if (name.startsWith("vars.")) return { kind: "vars", environment: name.slice(5) };
    return { kind: "unknown" };
  }
  // Lines before any header belong to `[env]`.
  return { kind: "env", environment: null };
}

/** The keys a section already sets, for {@link uniqueInfraenvKey}. */
export function infraenvKeysIn(doc: InfraenvDocument, environment: string | null): string[] {
  const entries =
    environment === null
      ? doc.shared
      : (doc.environments.find((e) => e.name === environment)?.entries ?? []);
  return entries.map((e) => e.key);
}
