/**
 * What a run is lent: the `lent` field of the run request
 * (`ci-runner/README.md`, "HTTP API"), built at dispatch from what its jobs
 * name (`connections:`, `ssh-keys:`, `${{ resources.* }}`, `env-from:`, read
 * with its pipelines by `POST /v1/concurrency`) and what the organization
 * allows.
 *
 * - Only for a trusted run. A fork's pull request is never sent `lent`; the
 *   runner fails the jobs that name something with its own reason.
 * - Each name is checked against its opt-in: the connection lent to CI, the
 *   SSH key lent by its owner, the resource granted, each for this
 *   repository and this branch. A name that is not allowed is sent as a
 *   `refused` reason, which the job that names it fails with; never as an
 *   empty value.
 * - Values are read fresh for every run (a rotated secret takes effect on
 *   the next run), minted short-lived where the plugin can, and sent as
 *   secret parts the runner masks. Nothing here stores them.
 * - Every lend is audit logged, with who allowed it.
 *
 * Calls plugins for arbitrary accounts, so it runs only where plugin code
 * does (the gateway); the edge leaves such runs for the gateway's pass.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  ciAlias,
  type CiLentMaterial,
  type CiLentValue,
  type HostPlugin,
  type HostPluginClient,
} from "@infrawrench/plugin-base";
import {
  CI_SECRET_VALUE_OUTPUT as SECRET_VALUE_OUTPUT,
  ciBranchMatches,
  ciRepoAllowed,
} from "@infrawrench/client-core";

import { db } from "../db/client.js";
import {
  accounts,
  auditLogs,
  ciConnectionAccess,
  ciResourceGrants,
  ciSshKeyAccess,
  organizationMembers,
  resources,
  sshHostKeys,
  sshKeys,
  type CiJobAccess,
} from "../db/schema.js";
import { buildAad, decrypt } from "../encryption.js";
import { getOrgAccountClient } from "../org-accounts.js";
import { getClientForResource } from "../peer-clients.js";

/** A value as the run request carries it: secret as a whole, or shown and secret parts. */
export type LentValue = string | Array<{ text: string } | { secret: string }>;

export interface LentFile {
  path: string;
  mode?: string;
  content: LentValue;
}

export type LentEntry =
  { refused: string } | { env?: Record<string, LentValue>; files?: LentFile[] };

export type LentResource =
  | { refused: string }
  | {
      outputs?: Record<string, LentValue>;
      "refused-outputs"?: Record<string, string>;
      env?: Record<string, LentValue>;
    };

export interface Lent {
  connections?: Record<string, LentEntry>;
  "ssh-keys"?: Record<string, LentEntry>;
  resources?: Record<string, LentResource>;
}

/** What a run is, as lending checks it. */
export interface LendingRun {
  id: string;
  organizationId: string;
  repoFullName: string;
  event: "push" | "pull-request";
  /** The pushed branch, or the pull request's head branch. */
  headRef: string;
  fromFork: boolean;
}

/** What one lend was, for the audit log. */
export interface LendRecord {
  kind: "connection" | "ssh-key" | "resource";
  name: string;
  entityId: string;
  /** Who allowed it. */
  allowedBy: string | null;
  summary: string;
}

/** The runner's limits on `lent` (`ci-runner/README.md`, "HTTP API"). */
const MAX_ENTRIES = 64;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_FILES_PER_ENTRY = 16;
const MAX_REASON = 1024;
/** The whole run request body. */
export const MAX_RUN_BODY_BYTES = 1024 * 1024;
/** How long minted credentials last: a run's jobs may start well after dispatch. */
export const LEND_TTL_SECONDS = 4 * 60 * 60;

/** The names a run's jobs reference, merged across jobs. */
export interface ReferencedNames {
  /** Each connection name, with every namespace a job asks for it in (`undefined`: none). */
  connections: Map<string, Set<string | undefined>>;
  sshKeys: Set<string>;
  /** Grant name to the outputs some job reads. */
  resources: Map<string, Set<string>>;
  envFrom: Set<string>;
}

export function referencedNames(access: readonly CiJobAccess[]): ReferencedNames {
  const out: ReferencedNames = {
    connections: new Map(),
    sshKeys: new Set(),
    resources: new Map(),
    envFrom: new Set(),
  };
  for (const job of access) {
    for (const c of job.connections ?? []) {
      const namespaces = out.connections.get(c.name) ?? new Set<string | undefined>();
      namespaces.add(c.namespace);
      out.connections.set(c.name, namespaces);
    }
    for (const k of job.sshKeys ?? []) out.sshKeys.add(k);
    for (const [name, outputs] of Object.entries(job.resources ?? {})) {
      const set = out.resources.get(name) ?? new Set<string>();
      for (const o of outputs) set.add(o);
      out.resources.set(name, set);
    }
    for (const e of job.envFrom ?? []) out.envFrom.add(e);
  }
  return out;
}

export function needsLending(access: readonly CiJobAccess[] | null): boolean {
  if (!access) return false;
  const names = referencedNames(access);
  return (
    names.connections.size > 0 ||
    names.sshKeys.size > 0 ||
    names.resources.size > 0 ||
    names.envFrom.size > 0
  );
}

/** Why a permission does not cover this run, or null when it does. */
export function scopeRefusal(
  what: string,
  run: LendingRun,
  scope: { repos: string[] | null; branchPattern: string | null },
): string | null {
  if (
    !ciRepoAllowed(scope.repos, run.repoFullName) ||
    !ciBranchMatches(scope.branchPattern, run.headRef)
  ) {
    return `${what} is not lent to CI for ${run.repoFullName} on ${run.headRef}`;
  }
  return null;
}

function reason(text: string): { refused: string } {
  return { refused: text.slice(0, MAX_REASON) };
}

function plain(value: LentValue): string {
  return typeof value === "string"
    ? value
    : value.map((p) => ("text" in p ? p.text : p.secret)).join("");
}

/** Why the runner would refuse a value, or null: at most 64 KiB of UTF-8, and no NUL. */
export function valueProblem(value: LentValue): string | null {
  const text = plain(value);
  if (text.includes("\u0000")) return "holds a NUL character";
  if (Buffer.byteLength(text, "utf8") > MAX_VALUE_BYTES) return "is larger than 64 KiB";
  return null;
}

/** An entry the runner would accept, or a refusal saying why it would not. */
export function checked(name: string, entry: LentEntry): LentEntry {
  if ("refused" in entry) return entry;
  if ((entry.files?.length ?? 0) > MAX_FILES_PER_ENTRY) {
    return reason(`${name} would write more than ${MAX_FILES_PER_ENTRY} files`);
  }
  for (const f of entry.files ?? []) {
    const problem = valueProblem(f.content);
    if (problem) return reason(`${f.path} of ${name} ${problem}`);
  }
  for (const [k, v] of Object.entries(entry.env ?? {})) {
    const problem = valueProblem(v);
    if (problem) return reason(`${k} of ${name} ${problem}`);
  }
  return entry;
}

function toLentValue(value: CiLentValue): LentValue {
  return typeof value === "string"
    ? value
    : value.map((p) => ("text" in p ? { text: p.text } : { secret: p.secret }));
}

/** Join two values of one file, a line feed between. */
function joinValues(a: LentValue, b: LentValue): LentValue {
  const parts = (v: LentValue): Array<{ text: string } | { secret: string }> =>
    typeof v === "string" ? [{ secret: v }] : v;
  return [...parts(a), { text: "\n" }, ...parts(b)];
}

/** One connection's material and its references', as one entry (files with one path joined). */
export function mergeMaterials(materials: readonly CiLentMaterial[]): LentEntry {
  const env: Record<string, LentValue> = {};
  const files = new Map<string, LentFile>();
  for (const m of materials) {
    for (const [k, v] of Object.entries(m.env)) env[k] = toLentValue(v);
    for (const f of m.files) {
      const content = toLentValue(f.content);
      const prior = files.get(f.path);
      files.set(
        f.path,
        prior
          ? { ...prior, content: joinValues(prior.content, content) }
          : { path: f.path, ...(f.mode ? { mode: f.mode } : {}), content },
      );
    }
  }
  return {
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(files.size > 0 ? { files: [...files.values()] } : {}),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The fingerprint the organization pinned for a host, for `ciCredential` plugins. */
function pinnedHostKeyLookup(organizationId: string) {
  return async (host: string, port: number): Promise<string | null> => {
    const [row] = await db
      .select({ fingerprint: sshHostKeys.fingerprint })
      .from(sshHostKeys)
      .where(
        and(
          eq(sshHostKeys.organizationId, organizationId),
          eq(sshHostKeys.host, host),
          eq(sshHostKeys.port, port),
        ),
      )
      .limit(1);
    return row?.fingerprint ?? null;
  };
}

interface LendableAccount {
  id: string;
  displayName: string;
  pluginId: string;
  access: typeof ciConnectionAccess.$inferSelect | null;
}

async function lendableAccounts(
  organizationId: string,
  names: string[],
): Promise<LendableAccount[]> {
  if (names.length === 0) return [];
  const rows = await db
    .select({
      id: accounts.id,
      displayName: accounts.displayName,
      pluginId: accounts.pluginId,
      access: ciConnectionAccess,
    })
    .from(accounts)
    .leftJoin(ciConnectionAccess, eq(ciConnectionAccess.accountId, accounts.id))
    .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.displayName, names)));
  return rows;
}

async function accountById(organizationId: string, id: string): Promise<LendableAccount | null> {
  const [row] = await db
    .select({
      id: accounts.id,
      displayName: accounts.displayName,
      pluginId: accounts.pluginId,
      access: ciConnectionAccess,
    })
    .from(accounts)
    .leftJoin(ciConnectionAccess, eq(ciConnectionAccess.accountId, accounts.id))
    .where(and(eq(accounts.organizationId, organizationId), eq(accounts.id, id)))
    .limit(1);
  return row ?? null;
}

/**
 * File-safe aliases, unique within a run: `Deploy` and `deploy`, or `a_b`
 * and `a-b`, would otherwise write the same file. The first name (in sorted
 * order, so a run's aliases do not depend on job order) keeps the plain
 * alias; the next gets `-2`, and so on.
 */
export class AliasRegistry {
  private readonly byName = new Map<string, string>();
  private readonly taken = new Set<string>();

  constructor(names: Iterable<string> = []) {
    for (const name of [...names].sort()) this.aliasFor(name);
  }

  aliasFor(name: string): string {
    const known = this.byName.get(name);
    if (known) return known;
    const base = ciAlias(name);
    let alias = base;
    for (let i = 2; this.taken.has(alias); i++) alias = `${base}-${i}`;
    this.taken.add(alias);
    this.byName.set(name, alias);
    return alias;
  }
}

/** Seam for tests: how lending reaches an account's plugin. */
export interface LendDeps {
  accountClient(
    accountId: string,
    organizationId: string,
  ): Promise<{
    client: HostPluginClient;
    plugin: HostPlugin;
    credentials: Record<string, string>;
  } | null>;
  /** The plugin's accounts are hosts another account connects through (`jumpHost`). */
  isJumpHost(pluginId: string): Promise<boolean>;
}

const defaultDeps: LendDeps = {
  accountClient: (accountId, organizationId) => getOrgAccountClient(accountId, organizationId),
  isJumpHost: async (pluginId) => {
    const { getPlugin } = await import("../plugin-loader.js");
    return (await getPlugin(pluginId))?.plugin.manifest.jumpHost === true;
  },
};

/**
 * Lends one account, and every account its `accountReference` fields name
 * (an SSH host's jump host), each checked like the first. `chain` stops a
 * loop of references.
 */
async function lendAccount(
  run: LendingRun,
  account: LendableAccount,
  namespace: string | undefined,
  deps: LendDeps,
  records: LendRecord[],
  aliases: AliasRegistry,
  chain: Set<string> = new Set(),
): Promise<CiLentMaterial[]> {
  const what = `connection \`${account.displayName}\``;
  if (chain.has(account.id)) throw new Error(`${what} goes through itself`);
  chain.add(account.id);
  const access = account.access;
  if (!access?.lendEnabled) throw new Error(`${what} is not lent to CI`);
  const refused = scopeRefusal(what, run, {
    repos: access.lendRepos,
    branchPattern: access.lendBranchPattern,
  });
  if (refused) throw new Error(refused);
  const resolved = await deps.accountClient(account.id, run.organizationId);
  if (!resolved) throw new Error(`${what} is no longer connected`);
  if (!resolved.plugin.manifest.ciCredential || !resolved.client.lendCiCredential) {
    throw new Error(`${resolved.plugin.manifest.displayName} connections cannot be lent to jobs`);
  }
  const materials: CiLentMaterial[] = [];
  const references: Record<string, string> = {};
  for (const field of resolved.plugin.manifest.credentialFields) {
    const target = field.accountReference ? resolved.credentials[field.key] : undefined;
    if (!target) continue;
    const referenced = await accountById(run.organizationId, target);
    if (!referenced) throw new Error(`${what} goes through a connection that no longer exists`);
    // Only a connection a job goes through (a jump host) is lent along with
    // it; any other reference is the plugin's own business.
    if (!(await deps.isJumpHost(referenced.pluginId))) continue;
    materials.push(
      ...(await lendAccount(run, referenced, undefined, deps, records, aliases, chain)),
    );
    references[field.key] = aliases.aliasFor(referenced.displayName);
  }
  const material = await resolved.client.lendCiCredential({
    name: account.displayName,
    alias: aliases.aliasFor(account.displayName),
    ...(namespace ? { namespace } : {}),
    ttlSeconds: LEND_TTL_SECONDS,
    references,
    pinnedHostKey: pinnedHostKeyLookup(run.organizationId),
  });
  materials.push(material);
  records.push({
    kind: "connection",
    name: account.displayName,
    entityId: account.id,
    allowedBy: access.updatedByUserId,
    summary: material.summary,
  });
  return materials;
}

async function lendConnections(
  run: LendingRun,
  names: Map<string, Set<string | undefined>>,
  deps: LendDeps,
  records: LendRecord[],
): Promise<Record<string, LentEntry>> {
  const out: Record<string, LentEntry> = {};
  const all = [...names.keys()];
  const aliases = new AliasRegistry(all.slice(0, MAX_ENTRIES));
  const found = await lendableAccounts(run.organizationId, all.slice(0, MAX_ENTRIES));
  for (const [i, name] of all.entries()) {
    if (i >= MAX_ENTRIES) break;
    const matches = found.filter((a) => a.displayName === name);
    if (matches.length === 0) {
      out[name] = reason(`no connection is called \`${name}\``);
      continue;
    }
    if (matches.length > 1) {
      out[name] = reason(
        `${matches.length} connections are called \`${name}\`; rename one so a pipeline can tell them apart`,
      );
      continue;
    }
    // The runner keys `lent` by name, so one run can lend a name in only one
    // namespace; lending the first and ignoring the rest would point a job at
    // a namespace it did not ask for.
    const namespaces = [...(names.get(name) ?? [])];
    if (namespaces.length > 1) {
      out[name] = reason(
        `\`${name}\` is used in more than one namespace in this run (${namespaces
          .map((n) => n ?? "its default")
          .join(
            ", ",
          )}); a run lends a connection in one namespace, so use the same one in every job`,
      );
      continue;
    }
    try {
      out[name] = checked(
        name,
        mergeMaterials(await lendAccount(run, matches[0]!, namespaces[0], deps, records, aliases)),
      );
    } catch (err) {
      out[name] = reason(message(err));
    }
  }
  return out;
}

async function lendSshKeys(
  run: LendingRun,
  names: Set<string>,
  records: LendRecord[],
): Promise<Record<string, LentEntry>> {
  const out: Record<string, LentEntry> = {};
  const all = [...names].slice(0, MAX_ENTRIES);
  if (all.length === 0) return out;
  const aliases = new AliasRegistry(all);
  const rows = await db
    .select({
      access: ciSshKeyAccess,
      keyId: sshKeys.id,
      encryptedPrivateKey: sshKeys.encryptedPrivateKey,
      privateKeyIv: sshKeys.privateKeyIv,
      // The owner's membership: a key whose owner has left lends nothing.
      member: organizationMembers.userId,
    })
    .from(ciSshKeyAccess)
    .innerJoin(sshKeys, eq(sshKeys.id, ciSshKeyAccess.sshKeyId))
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.userId, sshKeys.userId),
        eq(organizationMembers.organizationId, ciSshKeyAccess.organizationId),
      ),
    )
    .where(
      and(
        eq(ciSshKeyAccess.organizationId, run.organizationId),
        inArray(ciSshKeyAccess.ciName, all),
      ),
    );
  for (const name of all) {
    const row = rows.find((r) => r.access.ciName === name);
    const what = `SSH key \`${name}\``;
    if (!row) {
      out[name] = reason(`${what} is not lent to CI`);
      continue;
    }
    if (!row.member) {
      out[name] = reason(`${what} belongs to someone who is no longer a member`);
      continue;
    }
    const refused = scopeRefusal(what, run, row.access);
    if (refused) {
      out[name] = reason(refused);
      continue;
    }
    if (!row.encryptedPrivateKey || !row.privateKeyIv) {
      out[name] = reason(`Infrawrench holds only the public half of ${what}`);
      continue;
    }
    try {
      const plain = await decrypt(
        row.encryptedPrivateKey,
        row.privateKeyIv,
        buildAad("sshKey", row.keyId, "privateKey"),
      );
      // OpenSSH refuses a key file that does not end with a line feed.
      const key = plain.endsWith("\n") ? plain : `${plain}\n`;
      const alias = aliases.aliasFor(name);
      const path = `/root/.ssh/id_${alias}`;
      out[name] = checked(name, {
        files: [
          { path, mode: "600", content: key },
          {
            path: "/root/.ssh/config",
            mode: "600",
            content: [{ text: `Host *\n  IdentityFile ${path}\n` }],
          },
        ],
      });
      if ("refused" in out[name]!) continue;
      records.push({
        kind: "ssh-key",
        name,
        entityId: row.keyId,
        allowedBy: row.access.enabledByUserId,
        summary: "the SSH key's private key",
      });
    } catch (err) {
      out[name] = reason(`${what} could not be read: ${message(err)}`);
    }
  }
  return out;
}

/** Seam for tests: how a granted resource's values are read. */
export interface ResourceReader {
  read(
    grant: typeof ciResourceGrants.$inferSelect,
    resource: {
      id: string;
      pluginId: string;
      resourceTypeId: string;
      accountId: string;
      parentResourceId: string | null;
    },
    output: string,
  ): Promise<string>;
  envTemplate(
    pluginId: string,
    resourceTypeId: string,
  ): Promise<Array<{ envKey: string; outputKey: string }> | null>;
}

function upperSnake(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase()
    .replace(/^([0-9])/, "_$1");
}

async function readGrantedValue(
  client: HostPluginClient,
  grant: typeof ciResourceGrants.$inferSelect,
  resource: { id: string; resourceTypeId: string; accountId: string },
  output: string,
): Promise<string> {
  if (output === SECRET_VALUE_OUTPUT && grant.secretVersion) {
    if (!client.accessSecretVersion || !client.listSecretVersions) {
      throw new Error("its provider no longer reads secret versions");
    }
    let version = grant.secretVersion;
    if (version === "latest") {
      const versions = await client.listSecretVersions(
        resource.resourceTypeId,
        resource.id,
        resource.accountId,
      );
      const enabled = versions.filter((v) => v.state === "enabled");
      const latest =
        enabled.find((v) => v.isLatest) ??
        [...enabled].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
      if (!latest) throw new Error("it has no enabled version");
      version = latest.id;
    }
    return client.accessSecretVersion(
      resource.resourceTypeId,
      resource.id,
      resource.accountId,
      version,
    );
  }
  return client.resolveOutput(resource.resourceTypeId, resource.id, output, resource.accountId);
}

const defaultReader: ResourceReader = {
  async read(grant, resource, output) {
    const resolved = await getClientForResource(
      resource.pluginId,
      resource.accountId,
      grant.organizationId,
      resource.parentResourceId ?? undefined,
    );
    if (!resolved) throw new Error("its connection is gone");
    return readGrantedValue(resolved.client, grant, resource, output);
  },
  async envTemplate(pluginId, resourceTypeId) {
    const { loadPlugins } = await import("../plugin-loader.js");
    const plugin = (await loadPlugins()).find((l) => l.plugin.manifest.id === pluginId)?.plugin;
    const type = plugin?.resourceTypes.find((t) => t.id === resourceTypeId);
    const template = type?.secretExportTemplates?.[0];
    return template
      ? template.entries.map((e) => ({ envKey: e.envKey, outputKey: e.outputKey }))
      : null;
  },
};

async function lendResources(
  run: LendingRun,
  wanted: Map<string, Set<string>>,
  envFrom: Set<string>,
  reader: ResourceReader,
  records: LendRecord[],
): Promise<Record<string, LentResource>> {
  const out: Record<string, LentResource> = {};
  const names = [...new Set([...wanted.keys(), ...envFrom])].slice(0, MAX_ENTRIES);
  if (names.length === 0) return out;
  const grants = await db
    .select()
    .from(ciResourceGrants)
    .where(
      and(
        eq(ciResourceGrants.organizationId, run.organizationId),
        inArray(ciResourceGrants.ciName, names),
      ),
    );
  for (const name of names) {
    const grant = grants.find((g) => g.ciName === name);
    const what = `resource \`${name}\``;
    if (!grant) {
      out[name] = reason(`${name} is not granted to CI`);
      continue;
    }
    const refused = scopeRefusal(what, run, grant);
    if (refused) {
      out[name] = reason(`${name} is not granted to CI for ${run.repoFullName} on ${run.headRef}`);
      continue;
    }
    const [resource] = await db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        parentResourceId: resources.parentResourceId,
      })
      .from(resources)
      .where(
        and(
          eq(resources.id, grant.resourceId),
          eq(resources.organizationId, run.organizationId),
          isNull(resources.deletedAt),
        ),
      )
      .limit(1);
    if (!resource) {
      out[name] = reason(`the resource ${name} is granted for no longer exists`);
      continue;
    }
    const outputs: Record<string, LentValue> = {};
    const refusedOutputs: Record<string, string> = {};
    const read = async (output: string): Promise<string | null> => {
      if (!grant.outputs.includes(output)) {
        refusedOutputs[output] = `${output} of ${name} is not granted to CI`;
        return null;
      }
      try {
        const value = await reader.read(grant, resource, output);
        if (!value) {
          refusedOutputs[output] = `${output} of ${name} is empty`;
          return null;
        }
        const problem = valueProblem(value);
        if (problem) {
          refusedOutputs[output] = `${output} of ${name} ${problem}`;
          return null;
        }
        return value;
      } catch (err) {
        refusedOutputs[output] = `${output} of ${name} could not be read: ${message(err)}`.slice(
          0,
          MAX_REASON,
        );
        return null;
      }
    };
    for (const output of wanted.get(name) ?? []) {
      const value = await read(output);
      if (value !== null) outputs[output] = value;
    }
    const env: Record<string, LentValue> = {};
    if (envFrom.has(name)) {
      const template =
        (await reader.envTemplate(resource.pluginId, resource.resourceTypeId))?.filter((e) =>
          grant.outputs.includes(e.outputKey),
        ) ?? grant.outputs.map((o) => ({ envKey: upperSnake(o), outputKey: o }));
      for (const entry of template) {
        const value = outputs[entry.outputKey] ?? (await read(entry.outputKey));
        if (
          value !== null &&
          !/^IWCI_/.test(entry.envKey) &&
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.envKey)
        ) {
          env[entry.envKey] = value;
        }
      }
      if (Object.keys(env).length === 0) {
        out[name] = reason(`none of ${name}'s granted outputs could be read for env-from`);
        continue;
      }
    }
    out[name] = {
      ...(Object.keys(outputs).length > 0 ? { outputs } : {}),
      ...(Object.keys(refusedOutputs).length > 0 ? { "refused-outputs": refusedOutputs } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
    const lentOutputs = [
      ...new Set([...Object.keys(outputs), ...(envFrom.has(name) ? grant.outputs : [])]),
    ];
    if (lentOutputs.length > 0) {
      records.push({
        kind: "resource",
        name,
        entityId: grant.id,
        // Whoever last widened it is who allowed this.
        allowedBy: grant.updatedByUserId ?? grant.createdByUserId,
        summary: `outputs ${lentOutputs.join(", ")}`,
      });
    }
  }
  return out;
}

/**
 * The `lent` field for a run, and what was lent, or null when the run lends
 * nothing (no job names anything, or the run is a fork's).
 */
export async function buildLent(
  run: LendingRun,
  access: readonly CiJobAccess[] | null,
  deps: LendDeps = defaultDeps,
  reader: ResourceReader = defaultReader,
): Promise<{ lent: Lent; records: LendRecord[] } | null> {
  if (!access || run.fromFork || !needsLending(access)) return null;
  const names = referencedNames(access);
  const records: LendRecord[] = [];
  const lent: Lent = {};
  if (names.connections.size > 0) {
    lent.connections = await lendConnections(run, names.connections, deps, records);
  }
  if (names.sshKeys.size > 0) lent["ssh-keys"] = await lendSshKeys(run, names.sshKeys, records);
  if (names.resources.size > 0 || names.envFrom.size > 0) {
    lent.resources = await lendResources(run, names.resources, names.envFrom, reader, records);
  }
  return { lent, records };
}

function entrySize(entry: unknown): number {
  return Buffer.byteLength(JSON.stringify(entry), "utf8");
}

/**
 * Keeps a run request within the runner's 1 MiB body: while the body with
 * `lent` would be larger, the largest lent entry is refused instead, with a
 * reason, so one oversized name fails its own jobs rather than the run.
 * `baseBytes` is the request body without `lent`.
 */
export function fitLent(lent: Lent, baseBytes: number): Lent {
  const out: Lent = JSON.parse(JSON.stringify(lent)) as Lent;
  const maps = [out.connections, out["ssh-keys"], out.resources].filter(
    (m): m is Record<string, LentEntry | LentResource> => m !== undefined,
  );
  // `,"lent":` and a little room for the rest of the JSON punctuation.
  while (baseBytes + entrySize(out) + 16 > MAX_RUN_BODY_BYTES) {
    let largest: {
      map: Record<string, LentEntry | LentResource>;
      name: string;
      size: number;
    } | null = null;
    for (const map of maps) {
      for (const [name, entry] of Object.entries(map)) {
        if ("refused" in entry) continue;
        const size = entrySize(entry);
        if (!largest || size > largest.size) largest = { map, name, size };
      }
    }
    if (!largest) break;
    largest.map[largest.name] = reason(
      `${largest.name} is too large to send with the run (requests are at most 1 MiB)`,
    );
  }
  return out;
}

/** One audit entry per lend, naming the run and who allowed it. */
export async function auditLends(run: LendingRun, records: readonly LendRecord[]): Promise<void> {
  if (records.length === 0) return;
  await db
    .insert(auditLogs)
    .values(
      records.map((r) => ({
        id: crypto.randomUUID(),
        organizationId: run.organizationId,
        userId: r.allowedBy,
        action: "ci.lend",
        entityType:
          r.kind === "connection"
            ? "account"
            : r.kind === "ssh-key"
              ? "ssh_key"
              : "ci_resource_grant",
        entityId: r.entityId,
        metadata: {
          runId: run.id,
          repo: run.repoFullName,
          branch: run.headRef,
          kind: r.kind,
          name: r.name,
          lent: r.summary,
        },
      })),
    )
    .catch((err: unknown) => console.warn("[ci] could not audit lends:", err));
}
