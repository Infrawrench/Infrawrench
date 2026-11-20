/**
 * `.infraenv`: the committed half of a project's environment.
 *
 * A `.env` file mixes two things that want opposite treatment. Its *shape*
 * (which variables exist, which environment sets what, where each value comes
 * from) is code: it should be reviewed, versioned and shared, and a new
 * teammate should get it with `git clone`. Its *values* are secrets and must
 * never reach Git. `.infraenv` is the shape: every variable as a literal,
 * a reference to a resource output in the user's infrastructure, or a
 * reference to an organization secret held by Infrawrench. It is safe to
 * commit by construction, and `infrawrench env pull` (or the app) resolves it
 * into a plain `.env` that carries a "generated, do not edit" header.
 *
 * The name is `.infraenv` rather than `.env.<something>` on purpose: the
 * default `.gitignore` of most frameworks ignores `.env*`, which would hide
 * exactly the file that is meant to be committed.
 *
 * The format is a small dotenv superset with INI-style sections:
 *
 * ```
 * [infrawrench]
 * org = org_123            # optional: the organization the references live in
 * output = .env            # optional: where `env pull` writes
 *
 * [env]                    # shared by every environment
 * NODE_ENV = development
 * # Neon: main branch
 * DATABASE_URL = resource("res_abc", "connectionString")
 * STRIPE_SECRET_KEY = secret("STRIPE_SECRET_KEY")
 *
 * [env.production]         # overrides for one environment
 * NODE_ENV = production
 * ```
 *
 * Lines before any section header belong to `[env]`, so a plain dotenv file
 * of literals parses as-is. A quoted value is always a literal; only a bare
 * `resource(...)` or `secret(...)` is a reference.
 *
 * Everything here is pure and platform neutral: web, desktop, the CLI and the
 * server all parse and print through it.
 */

/** The file name the CLI and the app look for. */
export const INFRAENV_FILE_NAME = ".infraenv";

/** Where `env pull` writes when the file names no `output`. */
export const INFRAENV_DEFAULT_OUTPUT = ".env";

/** Bounds the API and the editors share. */
export const INFRAENV_LIMITS = {
  /** Largest `.infraenv` the API accepts, in characters. */
  maxSourceLength: 256 * 1024,
  /** Most variables across every section. */
  maxEntries: 2_000,
  /** Most named environments. */
  maxEnvironments: 50,
  maxKeyLength: 256,
  maxEnvironmentNameLength: 64,
} as const;

/** Where one variable's value comes from. */
export type InfraenvValue =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "resource"; readonly resourceId: string; readonly output: string }
  | { readonly kind: "secret"; readonly name: string };

export type InfraenvValueKind = InfraenvValue["kind"];

export interface InfraenvEntry {
  readonly key: string;
  readonly value: InfraenvValue;
  /** Comment lines directly above the entry, without their `#`. */
  readonly comment?: string | undefined;
  /** 1-based line in the parsed source; absent on entries built in an editor. */
  readonly line?: number | undefined;
}

export interface InfraenvEnvironment {
  readonly name: string;
  readonly entries: readonly InfraenvEntry[];
  readonly comment?: string | undefined;
}

export interface InfraenvSettings {
  /** Organization id the references resolve in. */
  readonly org?: string | undefined;
  /** Path `env pull` writes to, relative to the file. */
  readonly output?: string | undefined;
}

export interface InfraenvDocument {
  /** Comment block at the top of the file, kept on a round trip. */
  readonly header?: string | undefined;
  readonly settings: InfraenvSettings;
  /** `[env]`: applies to every environment. */
  readonly shared: readonly InfraenvEntry[];
  /** `[env.<name>]` sections, in file order. */
  readonly environments: readonly InfraenvEnvironment[];
}

export interface InfraenvProblem {
  /** 1-based; 0 for a problem with the file as a whole. */
  readonly line: number;
  readonly message: string;
  /** The variable the problem is about, when there is one. */
  readonly key?: string | undefined;
}

export interface InfraenvParseResult {
  readonly document: InfraenvDocument;
  readonly problems: readonly InfraenvProblem[];
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SETTINGS = new Set(["org", "output"]);

/** The comment written at the top of a new file. */
export const INFRAENV_DEFAULT_HEADER = [
  " Infrawrench environment map. Safe to commit: it holds references, never secret values.",
  " `infrawrench env pull` writes .env from it. See https://infrawrench.com/docs/features/env-files",
].join("\n");

export function isInfraenvKey(key: string): boolean {
  return key.length <= INFRAENV_LIMITS.maxKeyLength && KEY.test(key);
}

export function isInfraenvEnvironmentName(name: string): boolean {
  return name.length <= INFRAENV_LIMITS.maxEnvironmentNameLength && ENV_NAME.test(name);
}

export function emptyInfraenvDocument(): InfraenvDocument {
  return { header: INFRAENV_DEFAULT_HEADER, settings: {}, shared: [], environments: [] };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A double-quoted string starting at `s[start] === '"'`: its value and the index after it. */
function readDoubleQuoted(s: string, start: number): { value: string; end: number } | null {
  let out = "";
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') return { value: out, end: i + 1 };
    if (c === "\\" && i + 1 < s.length) {
      const n = s[++i]!;
      out += n === "n" ? "\n" : n === "r" ? "\r" : n === "t" ? "\t" : n;
      continue;
    }
    out += c;
  }
  return null;
}

function readSingleQuoted(s: string, start: number): { value: string; end: number } | null {
  const close = s.indexOf("'", start + 1);
  if (close < 0) return null;
  return { value: s.slice(start + 1, close), end: close + 1 };
}

/** What may follow a value: nothing, or whitespace and a `#` comment. */
function restIsComment(rest: string): boolean {
  const t = rest.trim();
  return t === "" || t.startsWith("#");
}

/** `resource("a", "b")` / `secret("a")` with double-quoted arguments. */
function readCall(raw: string): { name: string; args: string[]; rest: string } | null {
  const m = /^([a-z]+)\s*\(/.exec(raw);
  if (!m) return null;
  const args: string[] = [];
  let i = m[0].length;
  const skip = () => {
    while (i < raw.length && /\s/.test(raw[i]!)) i++;
  };
  skip();
  if (raw[i] === ")") return { name: m[1]!, args, rest: raw.slice(i + 1) };
  for (;;) {
    skip();
    if (raw[i] !== '"') return null;
    const q = readDoubleQuoted(raw, i);
    if (!q) return null;
    args.push(q.value);
    i = q.end;
    skip();
    if (raw[i] === ",") {
      i++;
      continue;
    }
    if (raw[i] === ")") return { name: m[1]!, args, rest: raw.slice(i + 1) };
    return null;
  }
}

type ValueRead = { ok: true; value: InfraenvValue } | { ok: false; message: string };

/**
 * One value, everything after the `=`. Multi-line double-quoted values are
 * joined by the caller before this sees them.
 */
function parseValue(raw: string): ValueRead {
  const s = raw.trim();
  if (s === "") return { ok: true, value: { kind: "literal", value: "" } };
  if (s[0] === '"' || s[0] === "'") {
    const q = s[0] === '"' ? readDoubleQuoted(s, 0) : readSingleQuoted(s, 0);
    if (!q) return { ok: false, message: "Unterminated quoted value" };
    if (!restIsComment(s.slice(q.end))) {
      return { ok: false, message: "Unexpected text after a quoted value" };
    }
    return { ok: true, value: { kind: "literal", value: q.value } };
  }
  if (/^(resource|secret)\s*\(/.test(s)) {
    const call = readCall(s);
    if (!call || !restIsComment(call.rest)) {
      return {
        ok: false,
        message: 'Malformed reference: write resource("<id>", "<output>") or secret("<name>")',
      };
    }
    if (call.name === "resource") {
      const [resourceId, output] = call.args;
      if (call.args.length !== 2 || !resourceId || !output) {
        return {
          ok: false,
          message: 'resource() takes two arguments: resource("<id>", "<output>")',
        };
      }
      return { ok: true, value: { kind: "resource", resourceId, output } };
    }
    const [name] = call.args;
    if (call.args.length !== 1 || !name) {
      return { ok: false, message: 'secret() takes one argument: secret("<name>")' };
    }
    return { ok: true, value: { kind: "secret", name } };
  }
  // Bare literal: a ` #` starts a comment, as in dotenv.
  const hash = s.search(/\s#/);
  return { ok: true, value: { kind: "literal", value: (hash < 0 ? s : s.slice(0, hash)).trim() } };
}

/** Does a double-quoted value that starts on this line close on it? */
function opensMultiline(rawValue: string): boolean {
  const s = rawValue.trim();
  return s.startsWith('"') && readDoubleQuoted(s, 0) === null;
}

export function parseInfraenv(source: string): InfraenvParseResult {
  const problems: InfraenvProblem[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const settings: { org?: string; output?: string } = {};
  const shared: InfraenvEntry[] = [];
  const environments: { name: string; entries: InfraenvEntry[]; comment?: string }[] = [];
  let section: "settings" | "shared" | { env: (typeof environments)[number] } = "shared";
  let pending: string[] = [];
  let header: string | undefined;
  let sawContent = false;
  const seen = new Map<string, Set<string>>();
  let entryCount = 0;

  const flushHeader = () => {
    if (!sawContent && pending.length > 0) header = pending.join("\n");
    pending = [];
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const line = lines[idx]!;
    const t = line.trim();
    if (t === "") {
      // A blank line ends the leading comment block: that block is the header.
      if (!sawContent) flushHeader();
      else pending = [];
      continue;
    }
    if (t.startsWith("#")) {
      pending.push(t.slice(1));
      continue;
    }
    const sectionMatch = /^\[([^\]]*)\]\s*(#.*)?$/.exec(t);
    if (sectionMatch) {
      if (!sawContent) {
        // Comments directly above the first section with no blank line in
        // between still read as the file's header when nothing came before.
        if (header === undefined && pending.length > 0) header = pending.join("\n");
        pending = [];
      }
      sawContent = true;
      const name = sectionMatch[1]!.trim();
      if (name === "infrawrench") section = "settings";
      else if (name === "env") section = "shared";
      else if (name.startsWith("env.")) {
        const envName = name.slice(4);
        if (!isInfraenvEnvironmentName(envName)) {
          problems.push({
            line: lineNo,
            message: `Invalid environment name "${envName}": use letters, digits, - and _`,
          });
          section = { env: { name: envName, entries: [] } };
        } else {
          let env = environments.find((e) => e.name === envName);
          if (env) {
            problems.push({ line: lineNo, message: `Environment "${envName}" is declared twice` });
          } else {
            env = {
              name: envName,
              entries: [],
              ...(pending.length ? { comment: pending.join("\n") } : {}),
            };
            environments.push(env);
          }
          section = { env };
        }
      } else {
        problems.push({
          line: lineNo,
          message: `Unknown section [${name}]: expected [infrawrench], [env] or [env.<name>]`,
        });
        section = { env: { name, entries: [] } };
      }
      pending = [];
      continue;
    }
    if (!sawContent) flushHeader();
    sawContent = true;

    const assign = /^(?:export\s+)?([^=\s]+)\s*=(.*)$/.exec(t);
    if (!assign) {
      problems.push({ line: lineNo, message: "Expected KEY = value" });
      pending = [];
      continue;
    }
    const key = assign[1]!;
    let rawValue = assign[2]!;
    if (opensMultiline(rawValue)) {
      let j = idx + 1;
      while (j < lines.length && opensMultiline(rawValue)) {
        rawValue += "\n" + lines[j]!;
        j++;
      }
      idx = j - 1;
    }

    if (section === "settings") {
      const v = parseValue(rawValue);
      if (!SETTINGS.has(key)) {
        problems.push({
          line: lineNo,
          message: `Unknown setting "${key}": expected org or output`,
        });
      } else if (!v.ok) {
        problems.push({ line: lineNo, message: v.message });
      } else if (v.value.kind !== "literal") {
        problems.push({ line: lineNo, message: `The ${key} setting takes a plain value` });
      } else {
        settings[key as "org" | "output"] = v.value.value;
      }
      pending = [];
      continue;
    }

    const sectionName = section === "shared" ? "" : section.env.name;
    if (!isInfraenvKey(key)) {
      problems.push({
        line: lineNo,
        key,
        message: `Invalid variable name "${key}": use letters, digits and _, not starting with a digit`,
      });
      pending = [];
      continue;
    }
    const v = parseValue(rawValue);
    if (!v.ok) {
      problems.push({ line: lineNo, key, message: v.message });
      pending = [];
      continue;
    }
    let keys = seen.get(sectionName);
    if (!keys) seen.set(sectionName, (keys = new Set()));
    if (keys.has(key)) {
      problems.push({ line: lineNo, key, message: `${key} is set twice in this section` });
      pending = [];
      continue;
    }
    keys.add(key);
    entryCount++;
    const entry: InfraenvEntry = {
      key,
      value: v.value,
      line: lineNo,
      ...(pending.length ? { comment: pending.join("\n") } : {}),
    };
    if (section === "shared") shared.push(entry);
    else section.env.entries.push(entry);
    pending = [];
  }
  if (!sawContent) flushHeader();

  if (entryCount > INFRAENV_LIMITS.maxEntries) {
    problems.push({
      line: 0,
      message: `Too many variables: at most ${INFRAENV_LIMITS.maxEntries}`,
    });
  }
  if (environments.length > INFRAENV_LIMITS.maxEnvironments) {
    problems.push({
      line: 0,
      message: `Too many environments: at most ${INFRAENV_LIMITS.maxEnvironments}`,
    });
  }

  return {
    document: {
      ...(header !== undefined ? { header } : {}),
      settings,
      shared,
      environments: environments.filter((e) => isInfraenvEnvironmentName(e.name)),
    },
    problems,
  };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

const BARE = /^[A-Za-z0-9_./:@%+,=~-]*$/;

/** A string as a double-quoted literal with `\\`, `\"` and newline escapes. */
function doubleQuote(value: string): string {
  return (
    '"' +
    value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t") +
    '"'
  );
}

/** A literal as `.infraenv` writes it: bare when that reads back the same. */
function printLiteral(value: string): string {
  if (value === "") return "";
  if (BARE.test(value)) return value;
  return doubleQuote(value);
}

export function printInfraenvValue(value: InfraenvValue): string {
  switch (value.kind) {
    case "literal":
      return printLiteral(value.value);
    case "resource":
      return `resource(${doubleQuote(value.resourceId)}, ${doubleQuote(value.output)})`;
    case "secret":
      return `secret(${doubleQuote(value.name)})`;
  }
}

function printComment(comment: string | undefined): string[] {
  if (comment === undefined) return [];
  return comment.split("\n").map((l) => `#${l.startsWith(" ") || l === "" ? l : " " + l}`);
}

function printEntries(entries: readonly InfraenvEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    out.push(...printComment(e.comment));
    const v = printInfraenvValue(e.value);
    out.push(v === "" ? `${e.key} =` : `${e.key} = ${v}`);
  }
  return out;
}

/** The document as `.infraenv` text, ending in a newline. */
export function serializeInfraenv(doc: InfraenvDocument): string {
  const blocks: string[][] = [];
  if (doc.header !== undefined && doc.header !== "") blocks.push(printComment(doc.header));
  const settings: string[] = [];
  if (doc.settings.org) settings.push(`org = ${printLiteral(doc.settings.org)}`);
  if (doc.settings.output) settings.push(`output = ${printLiteral(doc.settings.output)}`);
  if (settings.length) blocks.push(["[infrawrench]", ...settings]);
  blocks.push(["[env]", ...printEntries(doc.shared)]);
  for (const env of doc.environments) {
    blocks.push([...printComment(env.comment), `[env.${env.name}]`, ...printEntries(env.entries)]);
  }
  return blocks.map((b) => b.join("\n")).join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Resolving and rendering `.env`
// ---------------------------------------------------------------------------

/**
 * The variables one environment gets: `[env]` with that environment's
 * section laid over it, in file order (overrides keep the shared position,
 * new keys follow). No environment means `[env]` alone.
 */
export function infraenvEntriesFor(
  doc: InfraenvDocument,
  environment?: string | null,
): InfraenvEntry[] {
  const out = [...doc.shared];
  if (!environment) return out;
  const env = doc.environments.find((e) => e.name === environment);
  if (!env) return out;
  for (const e of env.entries) {
    const at = out.findIndex((x) => x.key === e.key);
    if (at >= 0) out[at] = e;
    else out.push(e);
  }
  return out;
}

export function infraenvEnvironmentNames(doc: InfraenvDocument): string[] {
  return doc.environments.map((e) => e.name);
}

/** Every distinct reference the document makes, for a describe or a resolve. */
export function infraenvReferences(doc: InfraenvDocument): {
  resources: { resourceId: string; output: string }[];
  secrets: string[];
} {
  const resources = new Map<string, { resourceId: string; output: string }>();
  const secrets = new Set<string>();
  for (const e of [...doc.shared, ...doc.environments.flatMap((x) => x.entries)]) {
    if (e.value.kind === "resource") {
      resources.set(`${e.value.resourceId}\u0000${e.value.output}`, {
        resourceId: e.value.resourceId,
        output: e.value.output,
      });
    } else if (e.value.kind === "secret") secrets.add(e.value.name);
  }
  return { resources: [...resources.values()], secrets: [...secrets] };
}

/**
 * A value as a `.env` line writes it. Single quotes where they can hold it
 * (no expansion in dotenv or docker), double quotes with escapes otherwise.
 */
export function quoteDotenvValue(value: string): string {
  if (value === "") return "";
  if (BARE.test(value)) return value;
  if (!value.includes("'") && !/[\n\r]/.test(value)) return `'${value}'`;
  return doubleQuote(value);
}

export interface RenderDotenvOptions {
  /** The file the values came from, named in the header. */
  readonly source?: string | undefined;
  readonly environment?: string | null | undefined;
}

/** The first line of every generated `.env`: how the CLI recognises its own output. */
export const GENERATED_DOTENV_MARKER = "# Auto-generated by Infrawrench. Do not edit.";

export function isGeneratedDotenv(text: string): boolean {
  return text.startsWith(GENERATED_DOTENV_MARKER);
}

/**
 * A `.env` file from resolved values. The header says it is generated, where
 * from, and that it holds secrets. Nothing time-based goes in it, so pulling
 * twice gives the same bytes.
 */
export function renderDotenv(
  values: readonly { readonly key: string; readonly value: string }[],
  options: RenderDotenvOptions = {},
): string {
  const source = options.source ?? INFRAENV_FILE_NAME;
  const header = [
    GENERATED_DOTENV_MARKER,
    `# Source: ${source}${options.environment ? ` (environment: ${options.environment})` : ""}.`,
    `# Edit ${source} instead, then run \`infrawrench env pull\` to regenerate this file.`,
    "# It holds secret values: keep it out of Git.",
  ];
  const body = values.map(({ key, value }) => {
    const q = quoteDotenvValue(value);
    return q === "" ? `${key}=` : `${key}=${q}`;
  });
  return [...header, "", ...body].join("\n") + "\n";
}

/** Upper snake case of an output key, for a suggested variable name. */
export function suggestInfraenvKey(...parts: string[]): string {
  const key = parts
    .filter(Boolean)
    .join("_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return /^[0-9]/.test(key) ? `_${key}` : key || "VALUE";
}

// ---------------------------------------------------------------------------
// The wire contract for `/api/org/:orgId/env-files`
// ---------------------------------------------------------------------------

/** How one reference looks to a human: what the editors and `env check` show. */
export interface InfraenvResourceDescription {
  readonly resourceId: string;
  readonly output: string;
  /** False when the resource is not in the organization (deleted, or a typo). */
  readonly found: boolean;
  readonly displayName?: string | undefined;
  readonly pluginId?: string | undefined;
  readonly pluginName?: string | undefined;
  readonly resourceTypeId?: string | undefined;
  readonly resourceTypeName?: string | undefined;
  readonly accountId?: string | undefined;
  readonly accountName?: string | undefined;
  /** The output's label, when the type declares it. */
  readonly outputLabel?: string | undefined;
  /** False when the type does not declare this output. */
  readonly outputKnown: boolean;
  readonly sensitive: boolean;
}

export interface InfraenvSecretDescription {
  readonly name: string;
  /** The organization secret exists. */
  readonly found: boolean;
  /** It exists and has a value set. */
  readonly hasValue: boolean;
}

export interface InfraenvDescribeResponse {
  readonly problems: readonly InfraenvProblem[];
  readonly environments: readonly string[];
  readonly resources: readonly InfraenvResourceDescription[];
  readonly secrets: readonly InfraenvSecretDescription[];
}

export interface InfraenvResolveResponse {
  readonly environment: string | null;
  /** Every variable that resolved, in file order. */
  readonly values: readonly { readonly key: string; readonly value: string }[];
  /** Variables that did not, with why. A resolve with problems still answers 200. */
  readonly problems: readonly InfraenvProblem[];
  /** The `.env` text `renderDotenv` makes from `values`. */
  readonly dotenv: string;
}

/** One output of one resource, as the editor's picker lists it. */
export interface InfraenvSourceOutput {
  readonly key: string;
  readonly label: string;
  readonly sensitive: boolean;
  /** The variable name the type's secret export template uses, when it has one. */
  readonly suggestedKey?: string | undefined;
}

export interface InfraenvSource {
  readonly resourceId: string;
  readonly displayName: string;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly resourceTypeId: string;
  readonly resourceTypeName: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly outputs: readonly InfraenvSourceOutput[];
}

export interface InfraenvRepo {
  readonly installationId: number;
  /** `owner/name`. */
  readonly fullName: string;
  readonly defaultBranch: string | null;
}

export interface InfraenvRepoFile {
  readonly path: string;
  readonly branch: string;
  /** Null when the file does not exist on that branch yet. */
  readonly content: string | null;
  /** The blob sha a commit must name to replace it; null for a new file. */
  readonly sha: string | null;
}

export type InfraenvCommitMode = "commit" | "pull-request";

export interface InfraenvCommitResult {
  readonly mode: InfraenvCommitMode;
  readonly branch: string;
  readonly commitSha: string;
  readonly commitUrl: string;
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
}
