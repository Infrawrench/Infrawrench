/**
 * Environment files: describing and resolving `.infraenv`, and reading and
 * committing it in a repository.
 *
 * Nothing here stores an environment map. The committed `.infraenv` is the
 * whole of it (client-core `infraenv.ts`); this module looks up what it
 * references and, for `resolve`, reads the values: a `resource()` through the
 * resource's plugin client (`resolveOutput`, so the provider stays the source
 * of truth and a rotated password is picked up on the next pull), a
 * `secret()` from the organization's secrets (`workflow_secrets`, the store
 * workflows already use, AAD `workflowSecret:<id>:value`).
 *
 * `describe` and `listInfraenvSources` read stored state and plugin metadata
 * only, so they run on the edge. `resolve` calls plugins and is a gateway
 * route (`web/src/edge/gateway-routes.ts`).
 */
import { and, asc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import {
  INFRAENV_FILE_NAME,
  INFRAENV_LIMITS,
  infraenvEntriesFor,
  expandInfraenvValue,
  infraenvReferenceKey,
  infraenvReferences,
  infraenvValueHasTemplate,
  infraenvVariables,
  parseInfraenv,
  resourceKindOf,
  renderDotenv,
  type InfraenvCommitMode,
  type InfraenvCommitResult,
  type InfraenvDescribeResponse,
  type InfraenvProblem,
  type InfraenvRepo,
  type InfraenvRepoFile,
  type InfraenvResolveResponse,
  type InfraenvResourceDescription,
  type InfraenvResourceMatch,
  type InfraenvResourceReference,
  type InfraenvSecretDescription,
  type InfraenvSource,
} from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { accounts, resources, workflowSecrets } from "../db/schema.js";
import { buildAad, decrypt } from "../encryption.js";
import { isGithubAppConfigured, listInstallationRepos } from "../github/app.js";
import {
  createBranch,
  createPullRequest,
  getBranchSha,
  getDefaultBranch,
  getFile,
  isRepoFullName,
  putFile,
} from "../github/issues-api.js";
import { orgInstallationIds } from "../github-issues/settings.js";
import { getClientForResource } from "../peer-clients.js";
import { loadPlugins, type LoadedPlugin } from "../plugin-loader.js";

/** A request this module refuses, with the sentence the route answers 400 with. */
export class EnvFileRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvFileRefused";
  }
}

/** A repository or file the organization cannot reach: answered 404. */
export class EnvFileNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvFileNotFound";
  }
}

export type InfraenvResourceRow = {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  parentResourceId: string | null;
  displayName: string;
  accountName: string;
};

async function pluginsById(): Promise<Map<string, LoadedPlugin["plugin"]>> {
  return new Map((await loadPlugins()).map((l) => [l.plugin.manifest.id, l.plugin]));
}

async function loadInfraenvResourceRows(
  organizationId: string,
  ids: readonly string[],
): Promise<Map<string, InfraenvResourceRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: resources.id,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
      parentResourceId: resources.parentResourceId,
      displayName: resources.displayName,
      accountName: accounts.displayName,
    })
    .from(resources)
    .innerJoin(accounts, eq(accounts.id, resources.accountId))
    .where(
      and(
        eq(resources.organizationId, organizationId),
        inArray(resources.id, [...ids]),
        isNull(resources.deletedAt),
      ),
    );
  return new Map(rows.map((r) => [r.id, r]));
}

async function loadSecretRows(organizationId: string, names: readonly string[]) {
  if (names.length === 0) return new Map<string, typeof workflowSecrets.$inferSelect>();
  const rows = await db
    .select()
    .from(workflowSecrets)
    .where(
      and(
        eq(workflowSecrets.organizationId, organizationId),
        inArray(workflowSecrets.name, [...names]),
      ),
    );
  return new Map(rows.map((r) => [r.name, r]));
}

function checkSize(source: string): void {
  if (source.length > INFRAENV_LIMITS.maxSourceLength) {
    throw new EnvFileRefused(
      `The file is too large: at most ${INFRAENV_LIMITS.maxSourceLength} characters`,
    );
  }
}

/** At most this many same-named resources are read to report an ambiguous name. */
const NAMED_LIMIT = 10;

async function loadNamedRows(
  organizationId: string,
  match: InfraenvResourceMatch,
): Promise<InfraenvResourceRow[]> {
  return db
    .select({
      id: resources.id,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
      parentResourceId: resources.parentResourceId,
      displayName: resources.displayName,
      accountName: accounts.displayName,
    })
    .from(resources)
    .innerJoin(accounts, eq(accounts.id, resources.accountId))
    .where(
      and(
        eq(resources.organizationId, organizationId),
        eq(resources.pluginId, match.pluginId),
        eq(resources.resourceTypeId, match.resourceTypeId),
        eq(resources.displayName, match.name),
        match.account !== undefined ? eq(accounts.displayName, match.account) : undefined,
        isNull(resources.deletedAt),
      ),
    )
    .orderBy(asc(resources.id))
    .limit(NAMED_LIMIT);
}

type SecretRow = Pick<
  typeof workflowSecrets.$inferSelect,
  "id" | "name" | "encryptedValue" | "encryptedValueIv"
>;

/** Seam for tests: how the referenced rows and their values are read. */
export interface InfraenvReader {
  resources(
    organizationId: string,
    ids: readonly string[],
  ): Promise<Map<string, InfraenvResourceRow>>;
  /** Resources matching a by-name reference, at most a handful. */
  named(organizationId: string, match: InfraenvResourceMatch): Promise<InfraenvResourceRow[]>;
  secrets(organizationId: string, names: readonly string[]): Promise<Map<string, SecretRow>>;
  resourceOutput(organizationId: string, row: InfraenvResourceRow, output: string): Promise<string>;
  secretValue(row: SecretRow): Promise<string | null>;
}

const defaultReader: InfraenvReader = {
  resources: loadInfraenvResourceRows,
  named: loadNamedRows,
  secrets: loadSecretRows,
  async resourceOutput(organizationId, row, output) {
    const ctx = await getClientForResource(
      row.pluginId,
      row.accountId,
      organizationId,
      row.parentResourceId ?? undefined,
    );
    if (!ctx) throw new Error("its account is no longer connected");
    return ctx.client.resolveOutput(row.resourceTypeId, row.id, output, row.accountId);
  },
  async secretValue(row) {
    if (!row.encryptedValue || !row.encryptedValueIv) return null;
    return decrypt(
      row.encryptedValue,
      row.encryptedValueIv,
      buildAad("workflowSecret", row.id, "value"),
    );
  },
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What one expanded resource reference found: the row, or how many rows a name matched. */
interface Found {
  readonly row: InfraenvResourceRow | null;
  /** For a by-name reference. */
  readonly matches?: number;
}

/** Each distinct expanded reference looked up once, keyed by `infraenvReferenceKey`. */
async function findResources(
  organizationId: string,
  refs: readonly InfraenvResourceReference[],
  reader: Pick<InfraenvReader, "resources" | "named">,
): Promise<Map<string, Found>> {
  const out = new Map<string, Found>();
  const ids = refs.flatMap((r) => (r.kind === "resource" ? [r.resourceId] : []));
  const byId = await reader.resources(organizationId, ids);
  for (const ref of refs) {
    const key = infraenvReferenceKey(ref);
    if (out.has(key)) continue;
    if (ref.kind === "resource") {
      out.set(key, { row: byId.get(ref.resourceId) ?? null });
    } else {
      const rows = await reader.named(organizationId, ref.match);
      out.set(key, { row: rows.length === 1 ? rows[0]! : null, matches: rows.length });
    }
  }
  return out;
}

/** What a reference that found nothing says, in the words both describe and resolve use. */
function notFoundMessage(ref: InfraenvResourceReference, found: Found | undefined): string {
  if (ref.kind === "resource") return `No resource ${ref.resourceId} in this organization`;
  const m = ref.match;
  const what = `${resourceKindOf(m)} named "${m.name}"`;
  const n = found?.matches ?? 0;
  if (n === 0) return `No ${what} in this organization`;
  return `${n >= NAMED_LIMIT ? `${NAMED_LIMIT} or more` : n} resources match ${what}: add the account, as "${m.pluginId}/${m.resourceTypeId}@<account>", or pin one by id`;
}

/** What every reference in the file points at, plus syntax and dangling-reference problems. */
export async function describeInfraenv(
  organizationId: string,
  source: string,
  options: { vars?: Readonly<Record<string, string>> | undefined } = {},
  reader: Pick<InfraenvReader, "resources" | "named" | "secrets"> = defaultReader,
): Promise<InfraenvDescribeResponse> {
  checkSize(source);
  const { document, problems } = parseInfraenv(source);
  const refs = infraenvReferences(document, options.vars);
  const [found, secretRows, plugins] = await Promise.all([
    findResources(organizationId, refs.resources, reader),
    reader.secrets(organizationId, refs.secrets),
    pluginsById(),
  ]);

  const resourceDescriptions: InfraenvResourceDescription[] = refs.resources.map((ref) => {
    const key = infraenvReferenceKey(ref);
    const f = found.get(key);
    const base = {
      ref: key,
      output: ref.output,
      ...(ref.kind === "resource"
        ? { resourceId: ref.resourceId }
        : { match: ref.match, matches: f?.matches ?? 0 }),
    };
    const row = f?.row;
    if (!row) return { ...base, found: false, outputKnown: false, sensitive: true };
    const plugin = plugins.get(row.pluginId);
    const type = plugin?.resourceTypes.find((t) => t.id === row.resourceTypeId);
    const output = type?.outputs.find((o) => o.key === ref.output);
    return {
      ...base,
      resourceId: row.id,
      found: true,
      displayName: row.displayName,
      pluginId: row.pluginId,
      pluginName: plugin?.manifest.displayName ?? row.pluginId,
      resourceTypeId: row.resourceTypeId,
      resourceTypeName: type?.displayName ?? row.resourceTypeId,
      accountId: row.accountId,
      accountName: row.accountName,
      ...(output ? { outputLabel: output.label } : {}),
      outputKnown: output !== undefined,
      // An undeclared output may hold anything: treat it as a secret.
      sensitive: output ? output.sensitive || output.hidden === true : true,
    };
  });
  const byRef = new Map(resourceDescriptions.map((d) => [d.ref, d]));

  const secretDescriptions: InfraenvSecretDescription[] = refs.secrets.map((name) => {
    const row = secretRows.get(name);
    return {
      name,
      found: row !== undefined,
      hasValue: Boolean(row?.encryptedValue && row.encryptedValueIv),
    };
  });
  const bySecret = new Map(secretDescriptions.map((d) => [d.name, d]));

  // Dangling references, at each line that makes one, in every scope that
  // expands it (a by-name reference can find a resource for one environment
  // and nothing for another).
  const dangling = new Map<string, InfraenvProblem>();
  // A reference without substitutions is the same in every scope: it reads once,
  // with no environment named.
  const note = (line: number, key: string, msg: string, scope: string | null) => {
    const m = scope ? `${msg} (environment ${scope})` : msg;
    dangling.set(`${line}\u0000${m}`, { line, key, message: m });
  };
  for (const scope of [null, ...document.environments.map((e) => e.name)]) {
    const vars = infraenvVariables(document, scope, options.vars);
    for (const entry of infraenvEntriesFor(document, scope)) {
      const x = expandInfraenvValue(entry.value, vars);
      if (!x.ok) continue; // Reported by infraenvReferences.
      const v = x.value;
      const line = entry.line ?? 0;
      const where = infraenvValueHasTemplate(entry.value) ? scope : null;
      if (v.kind === "resource" || v.kind === "named-resource") {
        const d = byRef.get(infraenvReferenceKey(v));
        if (d && !d.found) note(line, entry.key, notFoundMessage(v, found.get(d.ref)), where);
        else if (d && !d.outputKnown) {
          note(
            line,
            entry.key,
            `${d.resourceTypeName ?? "The resource"} has no output "${v.output}"`,
            where,
          );
        }
      } else if (v.kind === "secret") {
        const d = bySecret.get(v.name);
        if (d && !d.found) note(line, entry.key, `No organization secret named ${v.name}`, where);
        else if (d && !d.hasValue) {
          note(line, entry.key, `The organization secret ${v.name} has no value yet`, where);
        }
      }
    }
  }
  const problemsOut = [...dangling.values()];

  return {
    problems: [...problems, ...refs.problems, ...problemsOut],
    environments: document.environments.map((e) => e.name),
    resources: resourceDescriptions,
    secrets: secretDescriptions,
  };
}

export interface ResolveInfraenvInput {
  readonly source: string;
  readonly environment?: string | null | undefined;
  readonly vars?: Readonly<Record<string, string>> | undefined;
  readonly sourceName?: string | undefined;
}

/**
 * Every variable of one environment with its value. A file with syntax
 * problems, or an environment it does not declare, is refused; a variable
 * whose source cannot be read (including a substitution with no value) is
 * reported and left out, so one broken reference does not hold up the rest
 * of a pull.
 */
export async function resolveInfraenv(
  organizationId: string,
  input: ResolveInfraenvInput,
  reader: InfraenvReader = defaultReader,
): Promise<InfraenvResolveResponse> {
  checkSize(input.source);
  const { document, problems } = parseInfraenv(input.source);
  if (problems.length > 0) {
    const first = problems[0]!;
    throw new EnvFileRefused(
      `The file has ${problems.length === 1 ? "a problem" : `${problems.length} problems`}: ` +
        `${first.line > 0 ? `line ${first.line}: ` : ""}${first.message}`,
    );
  }
  const environment = input.environment || null;
  if (environment && !document.environments.some((e) => e.name === environment)) {
    throw new EnvFileRefused(
      `The file has no [env.${environment}] section` +
        (document.environments.length
          ? `; it declares ${document.environments.map((e) => e.name).join(", ")}`
          : ""),
    );
  }

  const vars = infraenvVariables(document, environment, input.vars);
  const entries = infraenvEntriesFor(document, environment).map((entry) => ({
    entry,
    expanded: expandInfraenvValue(entry.value, vars),
  }));
  const refs: InfraenvResourceReference[] = [];
  const secretNames = new Set<string>();
  for (const { expanded } of entries) {
    if (!expanded.ok) continue;
    const v = expanded.value;
    if (v.kind === "resource" || v.kind === "named-resource") refs.push(v);
    else if (v.kind === "secret") secretNames.add(v.name);
  }
  const [found, secretRows] = await Promise.all([
    findResources(organizationId, refs, reader),
    reader.secrets(organizationId, [...secretNames]),
  ]);

  // Each (resource, output) is read once even when several variables use it.
  const outputReads = new Map<string, Promise<string>>();
  const readOutput = (row: InfraenvResourceRow, output: string) => {
    const k = `${row.id}\u0000${output}`;
    let p = outputReads.get(k);
    if (!p) {
      p = reader.resourceOutput(organizationId, row, output);
      outputReads.set(k, p);
    }
    return p;
  };

  const settled = await Promise.all(
    entries.map(
      async ({ entry, expanded }): Promise<{ key: string; value: string } | InfraenvProblem> => {
        const fail = (m: string): InfraenvProblem => ({
          line: entry.line ?? 0,
          key: entry.key,
          message: m,
        });
        if (!expanded.ok) return fail(expanded.message);
        const v = expanded.value;
        switch (v.kind) {
          case "literal":
            return { key: entry.key, value: v.value };
          case "resource":
          case "named-resource": {
            const f = found.get(infraenvReferenceKey(v));
            const row = f?.row;
            if (!row) return fail(notFoundMessage(v, f));
            try {
              return { key: entry.key, value: await readOutput(row, v.output) };
            } catch (err) {
              return fail(`Could not read ${v.output} of ${row.displayName}: ${message(err)}`);
            }
          }
          case "secret": {
            const row = secretRows.get(v.name);
            if (!row) return fail(`No organization secret named ${v.name}`);
            try {
              const value = await reader.secretValue(row);
              if (value === null) return fail(`The organization secret ${v.name} has no value yet`);
              return { key: entry.key, value };
            } catch (err) {
              return fail(`Could not read the organization secret ${v.name}: ${message(err)}`);
            }
          }
        }
      },
    ),
  );

  const values: { key: string; value: string }[] = [];
  const failures: InfraenvProblem[] = [];
  for (const r of settled) {
    if ("value" in r) values.push(r);
    else failures.push(r);
  }
  return {
    environment,
    values,
    problems: failures,
    dotenv: renderDotenv(values, {
      source: input.sourceName || INFRAENV_FILE_NAME,
      environment,
    }),
  };
}

/** `%`, `_` and `\` matched literally in an ILIKE pattern. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Synced resources whose type declares outputs, for the editor's picker,
 * each with those outputs and the variable name its secret export template
 * suggests.
 */
export async function listInfraenvSources(
  organizationId: string,
  options: { q?: string | undefined; limit?: number | undefined } = {},
): Promise<InfraenvSource[]> {
  const plugins = await pluginsById();
  const withOutputs: string[] = [];
  for (const [pluginId, plugin] of plugins) {
    for (const type of plugin.resourceTypes) {
      if (type.outputs.length > 0) withOutputs.push(`${pluginId}:${type.id}`);
    }
  }
  if (withOutputs.length === 0) return [];
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);
  const q = options.q?.trim();
  const rows = await db
    .select({
      id: resources.id,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
      displayName: resources.displayName,
      accountName: accounts.displayName,
    })
    .from(resources)
    .innerJoin(accounts, eq(accounts.id, resources.accountId))
    .where(
      and(
        eq(resources.organizationId, organizationId),
        isNull(resources.deletedAt),
        inArray(
          sql<string>`${resources.pluginId} || ':' || ${resources.resourceTypeId}`,
          withOutputs,
        ),
        q
          ? or(
              ilike(resources.displayName, likePattern(q)),
              ilike(resources.id, likePattern(q)),
              ilike(resources.resourceTypeId, likePattern(q)),
              ilike(accounts.displayName, likePattern(q)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(resources.displayName))
    .limit(limit);

  return rows.flatMap((row): InfraenvSource[] => {
    const plugin = plugins.get(row.pluginId);
    const type = plugin?.resourceTypes.find((t) => t.id === row.resourceTypeId);
    if (!plugin || !type) return [];
    const suggested = new Map(
      (type.secretExportTemplates?.[0]?.entries ?? []).map((e) => [e.outputKey, e.envKey]),
    );
    return [
      {
        resourceId: row.id,
        displayName: row.displayName,
        pluginId: row.pluginId,
        pluginName: plugin.manifest.displayName,
        resourceTypeId: row.resourceTypeId,
        resourceTypeName: type.displayName,
        accountId: row.accountId,
        accountName: row.accountName,
        outputs: type.outputs.map((o) => ({
          key: o.key,
          label: o.label,
          sensitive: o.sensitive || o.hidden === true,
          ...(suggested.has(o.key) ? { suggestedKey: suggested.get(o.key)! } : {}),
        })),
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// The file in a repository, through the organization's GitHub App installation
// ---------------------------------------------------------------------------

/** Every repository the organization's installations reach. */
export async function listInfraenvRepos(
  organizationId: string,
): Promise<{ appConfigured: boolean; repos: InfraenvRepo[] }> {
  if (!isGithubAppConfigured()) return { appConfigured: false, repos: [] };
  const installs = [...(await orgInstallationIds(organizationId))];
  const lists = await Promise.all(
    installs.map(async (installationId) => {
      const repos = await listInstallationRepos(installationId).catch(() => []);
      return repos.map((r): InfraenvRepo => ({
        installationId,
        fullName: r.fullName,
        defaultBranch: r.defaultBranch || null,
      }));
    }),
  );
  return {
    appConfigured: true,
    repos: lists.flat().sort((a, b) => a.fullName.localeCompare(b.fullName)),
  };
}

/** A repository path: relative, no `..`, no leading slash. */
function checkRepoPath(path: string): string {
  const p = path.trim();
  if (
    p === "" ||
    p.startsWith("/") ||
    p.includes("\\") ||
    p.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  ) {
    throw new EnvFileRefused(`Invalid path in the repository: ${path}`);
  }
  return p;
}

async function checkRepo(
  organizationId: string,
  installationId: number,
  repo: string,
): Promise<void> {
  if (!isRepoFullName(repo)) throw new EnvFileRefused(`Invalid repository name: ${repo}`);
  const installs = await orgInstallationIds(organizationId);
  if (!installs.has(installationId)) {
    throw new EnvFileNotFound("That GitHub installation is not connected to this organization");
  }
}

export async function readInfraenvRepoFile(
  organizationId: string,
  input: { installationId: number; repo: string; path: string; branch?: string | undefined },
): Promise<InfraenvRepoFile> {
  await checkRepo(organizationId, input.installationId, input.repo);
  const path = checkRepoPath(input.path);
  const branch = input.branch?.trim() || (await getDefaultBranch(input.installationId, input.repo));
  const file = await getFile(input.installationId, input.repo, path, branch);
  return { path, branch, content: file?.content ?? null, sha: file?.sha ?? null };
}

export interface CommitInfraenvInput {
  readonly installationId: number;
  readonly repo: string;
  readonly path: string;
  readonly branch?: string | null | undefined;
  readonly content: string;
  readonly sha: string | null;
  readonly mode: InfraenvCommitMode;
  readonly message?: string | undefined;
}

/**
 * Commit the file, straight to the branch or to a new branch with a pull
 * request. The text must parse: an `.infraenv` the CLI would refuse never
 * reaches the repository. The sha the editor read is checked first, so a
 * file someone changed since is not silently overwritten.
 */
export async function commitInfraenvFile(
  organizationId: string,
  input: CommitInfraenvInput,
): Promise<InfraenvCommitResult> {
  await checkRepo(organizationId, input.installationId, input.repo);
  checkSize(input.content);
  const path = checkRepoPath(input.path);
  const { problems } = parseInfraenv(input.content);
  if (problems.length > 0) {
    const first = problems[0]!;
    throw new EnvFileRefused(
      `Refusing to commit a file that does not parse: ${first.line > 0 ? `line ${first.line}: ` : ""}${first.message}`,
    );
  }
  const { installationId, repo } = input;
  const base = input.branch?.trim() || (await getDefaultBranch(installationId, repo));
  const current = await getFile(installationId, repo, path, base);
  if ((current?.sha ?? null) !== (input.sha ?? null)) {
    throw new EnvFileRefused(
      current
        ? `${path} changed on ${base} since it was opened. Reopen it and apply your changes again.`
        : `${path} no longer exists on ${base}. Reopen it and apply your changes again.`,
    );
  }
  const message = input.message?.trim() || `Update ${path.split("/").pop()}`;

  if (input.mode === "commit") {
    const commit = await putFile(installationId, repo, {
      path,
      branch: base,
      content: input.content,
      sha: input.sha,
      message,
    });
    return { mode: "commit", branch: base, ...commit, pullRequest: null };
  }

  const baseSha = await getBranchSha(installationId, repo, base);
  const branch = `infrawrench/env-${Date.now().toString(36)}`;
  await createBranch(installationId, repo, branch, baseSha);
  const commit = await putFile(installationId, repo, {
    path,
    branch,
    content: input.content,
    sha: input.sha,
    message,
  });
  const pullRequest = await createPullRequest(installationId, repo, {
    title: message,
    head: branch,
    base,
    body:
      `Updates \`${path}\` from Infrawrench.\n\n` +
      "This file holds references to resource outputs and organization secrets, never their " +
      "values. Run `infrawrench env pull` after merging to regenerate your `.env`.",
  });
  return { mode: "pull-request", branch, ...commit, pullRequest };
}
