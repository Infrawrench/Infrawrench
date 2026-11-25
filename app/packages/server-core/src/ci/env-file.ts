/**
 * `.infraenv` files lent to a run's jobs (`env-file:` in a pipeline, the run
 * request's `lent.env-files`; `ci-runner/README.md`, "Environment files").
 *
 * The file is the repository's, so anyone who can push a branch can edit
 * it. What a job gets from it is therefore decided here, at dispatch, by the
 * same opt-ins as every other lend, never by the file:
 *
 * - Read through the GitHub App installation at the run's own commit
 *   (`sha`), the commit the runner checks out. The runner is never asked
 *   for it, so no file text reaches the stored `ci_runs.access` or a
 *   report, and the runner protocol carries only the job's `env-file:` as
 *   written.
 * - Never for a fork's pull request: nothing is sent, and the runner fails
 *   every job that names a file with its own reason.
 * - A literal passes through as shown text.
 * - A `resource()`, by id or by name (after `${var}` substitution, with the
 *   job's `vars:` laid over the file's), is lent only when an existing
 *   `ci_resource_grants` row for that resource covers this repository and
 *   branch and has that output ticked. Anything else refuses the whole file,
 *   naming the variable and what to grant; the job fails with that reason
 *   and never runs with an empty value. Values are read fresh, like
 *   `${{ resources.<name>.<output> }}`, and sent as secrets the runner masks.
 * - A `secret("<NAME>")` reads the repository's CI secrets (the proxy's
 *   store, the same as `${{ secrets.<NAME> }}`), not the organization's
 *   secrets the app and the CLI resolve it from: those were never granted
 *   to CI. Only the name is sent; the runner fills the value from the run's
 *   `secrets` when the job starts, masks it, and fails the job if the run
 *   does not have it. Nothing here reads a CI secret's value.
 * - Every lend is audit logged by variable name, never by value: one record
 *   per file, and one per grant a value was read under, naming who allowed
 *   it.
 *
 * Reads plugin outputs, so like the rest of `lend.ts` it runs only where
 * plugin code does (the gateway).
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  INFRAENV_LIMITS,
  expandInfraenvValue,
  infraenvEntriesFor,
  infraenvVariables,
  parseInfraenv,
  resourceKindOf,
  type InfraenvResourceMatch,
} from "@infrawrench/client-core";

import { db } from "../db/client.js";
import {
  accounts,
  ciResourceGrants,
  resources,
  type CiEnvFileUse,
  type CiJobAccess,
} from "../db/schema.js";
import {
  defaultResourceReader,
  scopeRefusal,
  valueProblem,
  type LendRecord,
  type LendingRun,
  type LentValue,
  type ResourceReader,
} from "./lend.js";

/** One file's variables as the run request carries them (`LentEnvFile` in the runner). */
export type LentEnvFile =
  | { refused: string }
  | {
      /** Literals as shown text, resource outputs as secrets. */
      env?: Record<string, LentValue>;
      /** Variable to the CI secret it reads, filled in by the runner. */
      secrets?: Record<string, string>;
    };

/** What a run is, as lending a file checks it. */
export interface EnvFileRun extends LendingRun {
  /** `GIT_SOURCE_INSTALLATION_ID` for a repository on git.infrawrench.com (`gitRepositoryId`). */
  installationId: number;
  /** The commit the runner checks out, which the file is read at. */
  sha: string;
}

/** The runner's limits (`lent.rs`). */
const MAX_ENTRIES = 64;
const MAX_REASON = 1024;
/** How many same-named resources are counted to say a name is ambiguous. */
const NAMED_LIMIT = 10;

/**
 * The key a file's variables are lent under, as the runner computes it for
 * a job (`EnvFileUse::key`): compact JSON of `path`, then `environment` and
 * `vars` (sorted) when set. Their names are ASCII and nothing in them has a
 * control character (the runner refuses those at parse time), so this and
 * serde_json write the same text.
 */
export function envFileKey(use: CiEnvFileUse): string {
  const names = Object.keys(use.vars ?? {}).sort();
  return JSON.stringify({
    path: use.path,
    ...(use.environment !== undefined ? { environment: use.environment } : {}),
    ...(names.length > 0 ? { vars: Object.fromEntries(names.map((k) => [k, use.vars![k]])) } : {}),
  });
}

/** Each distinct use of a file the run's jobs make, by its key. */
export function envFileRequests(access: readonly CiJobAccess[] | null): Map<string, CiEnvFileUse> {
  const out = new Map<string, CiEnvFileUse>();
  for (const job of access ?? []) {
    if (job.envFile) out.set(envFileKey(job.envFile), job.envFile);
  }
  return out;
}

/** A resource as a file's reference finds it. */
export interface EnvFileResource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  parentResourceId: string | null;
  displayName: string;
  incarnation: number;
}

type GrantRow = typeof ciResourceGrants.$inferSelect;

/** Seam for tests: how the file, the resources and the grants are read. */
export interface EnvFileDeps {
  /** The file's text at `sha`, or null when the commit has no such file. */
  readFile(
    installationId: number,
    repo: string,
    path: string,
    sha: string,
    /** Set for a repository on git.infrawrench.com, which is read from the forge. */
    gitRepositoryId?: string | null,
  ): Promise<string | null>;
  resourcesById(organizationId: string, ids: readonly string[]): Promise<EnvFileResource[]>;
  /** At most `NAMED_LIMIT` resources matching a by-name reference. */
  resourcesNamed(organizationId: string, match: InfraenvResourceMatch): Promise<EnvFileResource[]>;
  /** Every grant of these resources, whatever it covers. */
  grants(organizationId: string, resourceIds: readonly string[]): Promise<GrantRow[]>;
  reader: ResourceReader;
}

const RESOURCE_COLUMNS = {
  id: resources.id,
  pluginId: resources.pluginId,
  resourceTypeId: resources.resourceTypeId,
  accountId: resources.accountId,
  parentResourceId: resources.parentResourceId,
  displayName: resources.displayName,
  incarnation: resources.incarnation,
};

const defaultDeps: EnvFileDeps = {
  readFile: async (installationId, repo, path, sha, gitRepositoryId) => {
    if (gitRepositoryId) {
      const { gitReadFile } = await import("./git-forge.js");
      return gitReadFile({ gitRepositoryId, repoFullName: repo }, path, sha);
    }
    const { getFile } = await import("../github/issues-api.js");
    return (await getFile(installationId, repo, path, sha))?.content ?? null;
  },
  resourcesById: async (organizationId, ids) => {
    if (ids.length === 0) return [];
    return db
      .select(RESOURCE_COLUMNS)
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          inArray(resources.id, [...ids]),
          isNull(resources.deletedAt),
        ),
      );
  },
  resourcesNamed: async (organizationId, match) =>
    db
      .select(RESOURCE_COLUMNS)
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
      .limit(NAMED_LIMIT),
  grants: async (organizationId, resourceIds) => {
    if (resourceIds.length === 0) return [];
    return db
      .select()
      .from(ciResourceGrants)
      .where(
        and(
          eq(ciResourceGrants.organizationId, organizationId),
          inArray(ciResourceGrants.resourceId, [...resourceIds]),
        ),
      );
  },
  reader: defaultResourceReader,
};

function refused(text: string): { refused: string } {
  return { refused: text.slice(0, MAX_REASON) };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The runner's check on a secret's name (`Lent::check`). */
function secretNameOk(name: string): boolean {
  return name.length > 0 && [...name].length <= 128 && !/\p{Cc}/u.test(name);
}

/** A file's resource reference, expanded and found: what is checked against the grants. */
interface ResourceUse {
  variable: string;
  line: number;
  resource: EnvFileResource;
  output: string;
}

/** Why one variable's resource is not lent, or the grant it is lent under. */
function grantFor(
  run: LendingRun,
  use: ResourceUse,
  grants: readonly GrantRow[],
  where: string,
): { grant: GrantRow } | { refused: string } {
  const { resource, output, variable } = use;
  const what = `\`${variable}\` in ${where} reads ${output} of ${resource.displayName} (${resource.pluginId}/${resource.resourceTypeId})`;
  const mine = grants.filter((g) => g.resourceId === resource.id);
  if (mine.length === 0) {
    return {
      refused: `${what}, which is not granted to CI; grant ${resource.displayName} to CI with the output ${output} for ${run.repoFullName}`,
    };
  }
  const current = mine.filter((g) => g.resourceIncarnation === resource.incarnation);
  if (current.length === 0) {
    return {
      refused: `${what}, which was deleted and created again since it was granted to CI; grant it again`,
    };
  }
  const covering = current.filter((g) => scopeRefusal("", run, g) === null);
  if (covering.length === 0) {
    return {
      refused: `${what}, which is not granted to CI for ${run.repoFullName} on ${run.headRef}; widen its grant (${current.map((g) => g.ciName).join(", ")}) to this repository and branch`,
    };
  }
  const grant = covering.find((g) => g.outputs.includes(output));
  if (!grant) {
    return {
      refused: `${what}, an output that is not granted to CI; tick ${output} on its grant (${covering.map((g) => g.ciName).join(", ")})`,
    };
  }
  return { grant };
}

/**
 * One file, resolved for one job's use of it: every variable lent, or the
 * whole file refused with the first reason. Resources are read only once
 * every variable has passed its checks.
 */
async function lendFile(
  run: EnvFileRun,
  use: CiEnvFileUse,
  deps: EnvFileDeps,
  records: LendRecord[],
): Promise<LentEnvFile> {
  const where = `${use.path}${use.environment ? ` (environment ${use.environment})` : ""}`;
  const at = run.sha.slice(0, 7);
  let source: string | null;
  try {
    source = await deps.readFile(
      run.installationId,
      run.repoFullName,
      use.path,
      run.sha,
      run.gitRepositoryId,
    );
  } catch (err) {
    return refused(`${use.path} could not be read at ${at}: ${message(err)}`);
  }
  if (source === null) return refused(`${use.path} is not in ${run.repoFullName} at ${at}`);
  if (source.length > INFRAENV_LIMITS.maxSourceLength) {
    return refused(
      `${use.path} is larger than ${INFRAENV_LIMITS.maxSourceLength} characters, the most an environment file may be`,
    );
  }
  const { document, problems } = parseInfraenv(source);
  if (problems.length > 0) {
    const first = problems[0]!;
    return refused(
      `${use.path} has ${problems.length === 1 ? "a problem" : `${problems.length} problems`}: ${
        first.line > 0 ? `line ${first.line}: ` : ""
      }${first.message}`,
    );
  }
  if (document.settings.org && document.settings.org !== run.organizationId) {
    return refused(
      `${use.path} is pinned to another organization (\`org\` under [infrawrench]), so it is not resolved for this one`,
    );
  }
  const environment = use.environment ?? null;
  if (environment && !document.environments.some((e) => e.name === environment)) {
    return refused(`${use.path} has no [env.${environment}] section`);
  }

  const vars = infraenvVariables(document, environment, use.vars);
  const env: Record<string, LentValue> = {};
  const secrets: Record<string, string> = {};
  const byId: Array<{ variable: string; line: number; id: string; output: string }> = [];
  const byName: Array<{
    variable: string;
    line: number;
    match: InfraenvResourceMatch;
    output: string;
  }> = [];
  const summary: string[] = [];
  for (const entry of infraenvEntriesFor(document, environment)) {
    const line = entry.line ?? 0;
    const variable = `\`${entry.key}\` in ${where}${line > 0 ? ` (line ${line})` : ""}`;
    if (entry.key.startsWith("IWCI_")) {
      return refused(`${variable}: \`IWCI_*\` variables are the runner's`);
    }
    const x = expandInfraenvValue(entry.value, vars);
    if (!x.ok) return refused(`${variable}: ${x.message}, or in the job's \`env-file.vars\``);
    const v = x.value;
    switch (v.kind) {
      case "literal": {
        const problem = valueProblem([{ text: v.value }]);
        if (problem) return refused(`${variable} ${problem}`);
        env[entry.key] = [{ text: v.value }];
        summary.push(entry.key);
        break;
      }
      case "secret":
        if (!secretNameOk(v.name)) {
          return refused(`${variable} reads secret("${v.name}"), which is not a secret's name`);
        }
        secrets[entry.key] = v.name;
        summary.push(`${entry.key} (CI secret ${v.name})`);
        break;
      case "resource":
        byId.push({ variable: entry.key, line, id: v.resourceId, output: v.output });
        break;
      case "named-resource":
        byName.push({ variable: entry.key, line, match: v.match, output: v.output });
        break;
    }
  }

  // Every reference found, then checked against the grants, before any is read.
  const uses: ResourceUse[] = [];
  const found = new Map(
    (
      await deps.resourcesById(
        run.organizationId,
        byId.map((r) => r.id),
      )
    ).map((r) => [r.id, r]),
  );
  for (const r of byId) {
    const resource = found.get(r.id);
    if (!resource) {
      return refused(
        `\`${r.variable}\` in ${where} reads resource ${r.id}, which is not in this organization`,
      );
    }
    uses.push({ variable: r.variable, line: r.line, resource, output: r.output });
  }
  for (const r of byName) {
    const rows = await deps.resourcesNamed(run.organizationId, r.match);
    const what = `${resourceKindOf(r.match)} named "${r.match.name}"`;
    if (rows.length === 0) {
      return refused(`\`${r.variable}\` in ${where} reads a ${what}, and there is none`);
    }
    if (rows.length > 1) {
      return refused(
        `\`${r.variable}\` in ${where} reads a ${what}, and ${rows.length >= NAMED_LIMIT ? `${NAMED_LIMIT} or more` : rows.length} match; add the account, as "${r.match.pluginId}/${r.match.resourceTypeId}@<account>", or pin one by id`,
      );
    }
    uses.push({ variable: r.variable, line: r.line, resource: rows[0]!, output: r.output });
  }
  const grants = await deps.grants(run.organizationId, [
    ...new Set(uses.map((u) => u.resource.id)),
  ]);
  const granted: Array<ResourceUse & { grant: GrantRow }> = [];
  for (const u of uses) {
    const g = grantFor(run, u, grants, where);
    if ("refused" in g) return refused(g.refused);
    granted.push({ ...u, grant: g.grant });
  }

  // Each (resource, output) read once, however many variables use it.
  const reads = new Map<string, Promise<string>>();
  for (const u of granted) {
    const key = `${u.resource.id}\u0000${u.output}`;
    let read = reads.get(key);
    if (!read) {
      read = deps.reader.read(u.grant, u.resource, u.output);
      reads.set(key, read);
    }
    let value: string;
    try {
      value = await read;
    } catch (err) {
      return refused(
        `\`${u.variable}\` in ${where}: ${u.output} of ${u.resource.displayName} could not be read: ${message(err)}`,
      );
    }
    if (!value) {
      return refused(
        `\`${u.variable}\` in ${where}: ${u.output} of ${u.resource.displayName} is empty`,
      );
    }
    const problem = valueProblem(value);
    if (problem) {
      return refused(
        `\`${u.variable}\` in ${where}: ${u.output} of ${u.resource.displayName} ${problem}`,
      );
    }
    env[u.variable] = value;
    summary.push(`${u.variable} (resource ${u.grant.ciName}, ${u.output})`);
  }

  // Audited once everything is read: by name, never by value.
  const perGrant = new Map<string, { grant: GrantRow; parts: string[] }>();
  for (const u of granted) {
    const entry = perGrant.get(u.grant.id) ?? { grant: u.grant, parts: [] };
    entry.parts.push(`${u.output} as ${u.variable}`);
    perGrant.set(u.grant.id, entry);
  }
  for (const { grant, parts } of perGrant.values()) {
    records.push({
      kind: "resource",
      name: grant.ciName,
      entityId: grant.id,
      allowedBy: grant.updatedByUserId ?? grant.createdByUserId,
      summary: `outputs ${parts.join(", ")} through ${where}`.slice(0, MAX_REASON),
    });
  }
  records.push({
    kind: "env-file",
    name: where,
    entityId: `${run.repoFullName}:${use.path}`,
    // The pipeline asked; each resource's own record names who allowed it.
    allowedBy: null,
    summary: `${summary.length} variables from ${use.path} at ${at}: ${summary.join(", ")}`.slice(
      0,
      4096,
    ),
  });
  return {
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
  };
}

/**
 * The `lent.env-files` field for a run, and what was lent, or null when no
 * job names a file or the run is a fork's.
 */
export async function lendEnvFiles(
  run: EnvFileRun,
  access: readonly CiJobAccess[] | null,
  deps: EnvFileDeps = defaultDeps,
): Promise<{ entries: Record<string, LentEnvFile>; records: LendRecord[] } | null> {
  if (run.fromFork) return null;
  const requests = envFileRequests(access);
  if (requests.size === 0) return null;
  const entries: Record<string, LentEnvFile> = {};
  const records: LendRecord[] = [];
  for (const [key, use] of [...requests].slice(0, MAX_ENTRIES)) {
    try {
      entries[key] = await lendFile(run, use, deps, records);
    } catch (err) {
      entries[key] = refused(`${use.path} could not be resolved: ${message(err)}`);
    }
  }
  return { entries, records };
}

/** What one variable of a file would give a CI job, without reading any value. */
export interface EnvFileCheckVariable {
  readonly key: string;
  readonly line: number;
  readonly kind: "literal" | "resource" | "ci-secret";
  /** For a resource: what it found and the grant that covers it. */
  readonly resource?: { id: string; displayName: string; output: string; grant: string };
  /** For a secret: the CI secret's name, read from the run's CI secrets. */
  readonly secret?: string;
  /** Why the job would fail on this variable; absent when it would get it. */
  readonly refused?: string;
}

export interface EnvFileCheck {
  readonly path: string;
  readonly environment: string | null;
  /** A refusal of the whole file (missing, does not parse, pinned elsewhere); else null. */
  readonly refused: string | null;
  readonly variables: readonly EnvFileCheckVariable[];
}

/**
 * What a job naming this file would get on `run`'s repository and branch:
 * the same checks `lendFile` makes (the file at the commit, parse, org pin,
 * environment, `IWCI_*`, substitutions, references found, grants covering
 * repository, branch and output), every one reported rather than only the
 * first, and **no value read and nothing audited**. For the MCP tool and
 * anyone asking "will CI get this?" before pushing. A `secret()` is reported
 * by its CI secret name; whether the run has it is the proxy's to say.
 */
export async function checkEnvFileForCi(
  run: EnvFileRun,
  use: CiEnvFileUse,
  deps: Omit<EnvFileDeps, "reader"> = defaultDeps,
): Promise<EnvFileCheck> {
  const environment = use.environment ?? null;
  const whole = (text: string): EnvFileCheck => ({
    path: use.path,
    environment,
    refused: text.slice(0, MAX_REASON),
    variables: [],
  });
  const where = `${use.path}${environment ? ` (environment ${environment})` : ""}`;
  const source = await deps.readFile(
    run.installationId,
    run.repoFullName,
    use.path,
    run.sha,
    run.gitRepositoryId,
  );
  if (source === null) return whole(`${use.path} is not in ${run.repoFullName} at ${run.sha}`);
  if (source.length > INFRAENV_LIMITS.maxSourceLength) {
    return whole(`${use.path} is larger than ${INFRAENV_LIMITS.maxSourceLength} characters`);
  }
  const { document, problems } = parseInfraenv(source);
  if (problems.length > 0) {
    const first = problems[0]!;
    return whole(
      `${use.path} does not parse: ${first.line > 0 ? `line ${first.line}: ` : ""}${first.message}`,
    );
  }
  if (document.settings.org && document.settings.org !== run.organizationId) {
    return whole(`${use.path} is pinned to another organization`);
  }
  if (environment && !document.environments.some((e) => e.name === environment)) {
    return whole(`${use.path} has no [env.${environment}] section`);
  }

  const vars = infraenvVariables(document, environment, use.vars);
  const out: EnvFileCheckVariable[] = [];
  const pending: Array<{ index: number; use: ResourceUse }> = [];
  for (const entry of infraenvEntriesFor(document, environment)) {
    const line = entry.line ?? 0;
    const base = { key: entry.key, line };
    if (entry.key.startsWith("IWCI_")) {
      out.push({ ...base, kind: "literal", refused: "`IWCI_*` variables are the runner's" });
      continue;
    }
    const x = expandInfraenvValue(entry.value, vars);
    if (!x.ok) {
      out.push({
        ...base,
        kind:
          entry.value.kind === "secret"
            ? "ci-secret"
            : entry.value.kind === "literal"
              ? "literal"
              : "resource",
        refused: x.message,
      });
      continue;
    }
    const v = x.value;
    if (v.kind === "literal") {
      out.push({ ...base, kind: "literal" });
      continue;
    }
    if (v.kind === "secret") {
      out.push({
        ...base,
        kind: "ci-secret",
        secret: v.name,
        ...(secretNameOk(v.name) ? {} : { refused: `secret("${v.name}") is not a secret's name` }),
      });
      continue;
    }
    let resource: EnvFileResource | undefined;
    if (v.kind === "resource") {
      resource = (await deps.resourcesById(run.organizationId, [v.resourceId]))[0];
      if (!resource) {
        out.push({
          ...base,
          kind: "resource",
          refused: `No resource ${v.resourceId} in this organization`,
        });
        continue;
      }
    } else {
      const rows = await deps.resourcesNamed(run.organizationId, v.match);
      const what = `${resourceKindOf(v.match)} named "${v.match.name}"`;
      if (rows.length !== 1) {
        out.push({
          ...base,
          kind: "resource",
          refused:
            rows.length === 0
              ? `No ${what} in this organization`
              : `${rows.length >= NAMED_LIMIT ? `${NAMED_LIMIT} or more` : rows.length} resources match ${what}; add the account or pin one by id`,
        });
        continue;
      }
      resource = rows[0]!;
    }
    out.push({ ...base, kind: "resource" });
    pending.push({
      index: out.length - 1,
      use: { variable: entry.key, line, resource, output: v.output },
    });
  }

  const grants = await deps.grants(run.organizationId, [
    ...new Set(pending.map((p) => p.use.resource.id)),
  ]);
  for (const { index, use: u } of pending) {
    const g = grantFor(run, u, grants, where);
    out[index] =
      "refused" in g
        ? { ...out[index]!, refused: g.refused }
        : {
            ...out[index]!,
            resource: {
              id: u.resource.id,
              displayName: u.resource.displayName,
              output: u.output,
              grant: g.grant.ciName,
            },
          };
  }
  return { path: use.path, environment, refused: null, variables: out };
}
