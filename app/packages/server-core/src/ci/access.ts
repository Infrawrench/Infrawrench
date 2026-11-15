/**
 * What an organization lets its CI jobs use, set from the CI tab: per
 * connection, running jobs on it (cloud jobs) and lending its credentials to
 * jobs; per resource, a grant of chosen outputs, and optionally lending it
 * as a connection of a peer plugin (a managed cluster as `kubernetes`) with
 * cloud jobs on it; per SSH key, its owner's choice to lend it. Everything is off until someone turns it on, and every
 * permission names the repositories and branches it holds for.
 *
 * What a plugin can do comes from its manifest (`ciExecutor`, `ciCredential`),
 * so this module knows no provider. Preflight and the resource output listing
 * call plugins, so their routes are gateway routes; the rest is Postgres.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { HostPlugin, HostPluginClient, PeerPluginIntegration } from "@infrawrench/plugin-base";
import {
  CI_DEFAULT_CONNECTION_ACCESS,
  CI_DEFAULT_PEER_LIMITS,
  CI_EXECUTOR_KIND_IDS,
  CI_GRANT_NAME,
  CI_SECRET_VALUE_OUTPUT,
  ciBranchGlobs,
  type CiAccessOverview,
  type CiConnectionAccess,
  type CiConnectionAccessSettings,
  type CiExecutorKindId,
  type CiExecutorKindInfo,
  type CiPeerOption,
  type CiPreflightRecord,
  type CiResourceGrantPeerInput,
  type CiResourceGrant,
  type CiResourceOutputs,
  type CiSshKeyLending,
} from "@infrawrench/client-core";

import { db } from "../db/client.js";
import {
  accounts,
  ciCloudJobs,
  ciConnectionAccess,
  ciResourceGrants,
  ciSshKeyAccess,
  resources,
  sshKeys,
  users,
} from "../db/schema.js";
import { getOrgAccountClient } from "../org-accounts.js";
import { filterVisiblePeerIntegrations, getClientForResource } from "../peer-clients.js";
import { loadPlugins } from "../plugin-loader.js";
import { resourcePeerClient } from "./lend.js";
import { CiInputError } from "./runs.js";

const SECRET_VALUE_OUTPUT = CI_SECRET_VALUE_OUTPUT;

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_REPOS = 200;
const MAX_PATTERN = 200;

async function pluginsById(): Promise<Map<string, HostPlugin>> {
  const loaded = await loadPlugins();
  return new Map(loaded.map((l) => [l.plugin.manifest.id, l.plugin]));
}

/** A repository list as sent: null for every repository, else `owner/name`s. */
export function cleanRepos(repos: readonly string[] | null | undefined): string[] | null {
  if (repos === null || repos === undefined) return null;
  const out = [...new Set(repos.map((r) => r.trim()).filter((r) => r.length > 0))];
  if (out.length > MAX_REPOS) throw new CiInputError(`At most ${MAX_REPOS} repositories.`, 400);
  for (const r of out) {
    if (!REPO.test(r)) throw new CiInputError(`Not a repository (owner/name): ${r}`, 400);
  }
  return out;
}

export function cleanPattern(pattern: string | null | undefined): string | null {
  const p = (pattern ?? "").trim();
  if (p.length === 0) return null;
  if (p.length > MAX_PATTERN) {
    throw new CiInputError(`A branch pattern is at most ${MAX_PATTERN} characters.`, 400);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(p)) throw new CiInputError("A branch pattern is one line.", 400);
  // Commas and spaces alone would read as "every branch" to a careless
  // matcher: refuse them, so only an empty field means every branch.
  if (ciBranchGlobs(p).length === 0) {
    throw new CiInputError(
      "A branch pattern needs at least one branch. Leave it empty for every branch.",
      400,
    );
  }
  return p;
}

type AccessRow = typeof ciConnectionAccess.$inferSelect;

function settingsOf(row: AccessRow | undefined): CiConnectionAccessSettings {
  if (!row) return { ...CI_DEFAULT_CONNECTION_ACCESS };
  return {
    jobsEnabled: row.jobsEnabled,
    jobKinds: row.jobKinds.filter((k): k is CiExecutorKindId =>
      (CI_EXECUTOR_KIND_IDS as readonly string[]).includes(k),
    ),
    maxConcurrentJobs: row.maxConcurrentJobs,
    maxJobMinutes: row.maxJobMinutes,
    jobRepos: row.jobRepos,
    jobBranchPattern: row.jobBranchPattern,
    lendEnabled: row.lendEnabled,
    lendRepos: row.lendRepos,
    lendBranchPattern: row.lendBranchPattern,
  };
}

/** What a plugin can run for CI, as the wire carries it. */
function executorOf(plugin: HostPlugin): CiConnectionAccess["executor"] {
  const { ciExecutor } = plugin.manifest;
  return ciExecutor
    ? {
        kinds: ciExecutor.kinds.map((k): CiExecutorKindInfo => ({
          kind: k.kind,
          label: k.label,
          defaults: { ...k.defaults },
          ...(k.typicalStartSeconds !== undefined
            ? { typicalStartSeconds: k.typicalStartSeconds }
            : {}),
          ...(k.minimumBillingSeconds !== undefined
            ? { minimumBillingSeconds: k.minimumBillingSeconds }
            : {}),
          ...(k.gpus ? { gpus: true } : {}),
          ...(k.machineSuggestions ? { machineSuggestions: [...k.machineSuggestions] } : {}),
          ...(k.regionLabel ? { regionLabel: k.regionLabel } : {}),
        })),
        helpLink: ciExecutor.helpLink ? { ...ciExecutor.helpLink } : null,
      }
    : null;
}

/** What a plugin lends a job, as the wire carries it. */
function credentialOf(plugin: HostPlugin): CiConnectionAccess["credential"] {
  const { ciCredential } = plugin.manifest;
  return ciCredential
    ? {
        description: ciCredential.description,
        shortLived: ciCredential.shortLived,
        namespaces: ciCredential.namespaces === true,
      }
    : null;
}

function connectionOf(
  account: { id: string; displayName: string; pluginId: string },
  plugin: HostPlugin,
  row: AccessRow | undefined,
): CiConnectionAccess {
  return {
    accountId: account.id,
    accountName: account.displayName,
    pluginId: account.pluginId,
    pluginName: plugin.manifest.displayName,
    executor: executorOf(plugin),
    credential: credentialOf(plugin),
    settings: settingsOf(row),
    preflight: row?.jobPreflight ?? {},
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/** Every connection whose provider can do something for CI, with what it may do. */
export async function listConnectionAccess(organizationId: string): Promise<CiConnectionAccess[]> {
  const plugins = await pluginsById();
  const capable = [...plugins.values()]
    .filter((p) => p.manifest.ciExecutor || p.manifest.ciCredential)
    .map((p) => p.manifest.id);
  if (capable.length === 0) return [];
  const rows = await db
    .select({
      id: accounts.id,
      displayName: accounts.displayName,
      pluginId: accounts.pluginId,
    })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.pluginId, capable)))
    .orderBy(accounts.displayName);
  const access = await db
    .select()
    .from(ciConnectionAccess)
    .where(eq(ciConnectionAccess.organizationId, organizationId));
  const byAccount = new Map(access.map((a) => [a.accountId, a]));
  return rows.flatMap((a) => {
    const plugin = plugins.get(a.pluginId);
    return plugin ? [connectionOf(a, plugin, byAccount.get(a.id))] : [];
  });
}

async function loadAccount(organizationId: string, accountId: string) {
  const [account] = await db
    .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
    .limit(1);
  if (!account) throw new CiInputError("No such connection.", 404);
  const plugin = (await pluginsById()).get(account.pluginId);
  if (!plugin) throw new CiInputError("This connection's provider is not available.", 404);
  return { account, plugin };
}

async function loadAccess(accountId: string): Promise<AccessRow | undefined> {
  const [row] = await db
    .select()
    .from(ciConnectionAccess)
    .where(eq(ciConnectionAccess.accountId, accountId))
    .limit(1);
  return row;
}

/**
 * Sets what CI may do with a connection. Running jobs needs the provider to
 * run CI jobs and every chosen kind to have passed its preflight; lending
 * needs the provider to lend.
 */
export async function setConnectionAccess(
  organizationId: string,
  accountId: string,
  input: CiConnectionAccessSettings,
  userId: string | null,
): Promise<CiConnectionAccess> {
  const { account, plugin } = await loadAccount(organizationId, accountId);
  const { ciExecutor, ciCredential } = plugin.manifest;
  const offered = new Set<string>(ciExecutor?.kinds.map((k) => k.kind) ?? []);
  const kinds = [...new Set(input.jobKinds)];
  for (const kind of kinds) {
    if (!offered.has(kind)) {
      throw new CiInputError(`${plugin.manifest.displayName} does not run \`${kind}\` jobs.`, 400);
    }
  }
  const existing = await loadAccess(accountId);
  if (input.jobsEnabled) {
    if (!ciExecutor) {
      throw new CiInputError(`${plugin.manifest.displayName} cannot run CI jobs.`, 400);
    }
    if (kinds.length === 0) throw new CiInputError("Choose at least one kind of job.", 400);
    const preflight = existing?.jobPreflight ?? {};
    const failing = kinds.filter((k) => preflight[k]?.ok !== true);
    if (failing.length > 0) {
      throw new CiInputError(
        `Check the connection's permissions for ${failing.map((k) => `\`${k}\``).join(", ")} first; a connection that fails the check cannot run jobs.`,
        409,
      );
    }
  }
  if (input.lendEnabled && !ciCredential) {
    throw new CiInputError(
      `${plugin.manifest.displayName} connections cannot be lent to jobs.`,
      400,
    );
  }
  const maxConcurrentJobs = Math.trunc(input.maxConcurrentJobs);
  if (!(maxConcurrentJobs >= 1 && maxConcurrentJobs <= 50)) {
    throw new CiInputError("Concurrent jobs must be between 1 and 50.", 400);
  }
  const maxJobMinutes = Math.trunc(input.maxJobMinutes);
  if (!(maxJobMinutes >= 1 && maxJobMinutes <= 24 * 60)) {
    throw new CiInputError("Minutes per job must be between 1 and 1440.", 400);
  }
  const values = {
    jobsEnabled: input.jobsEnabled,
    jobKinds: kinds,
    maxConcurrentJobs,
    maxJobMinutes,
    jobRepos: cleanRepos(input.jobRepos),
    jobBranchPattern: cleanPattern(input.jobBranchPattern),
    lendEnabled: input.lendEnabled,
    lendRepos: cleanRepos(input.lendRepos),
    lendBranchPattern: cleanPattern(input.lendBranchPattern),
    updatedByUserId: userId,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(ciConnectionAccess)
    .values({ id: crypto.randomUUID(), organizationId, accountId, ...values })
    .onConflictDoUpdate({ target: ciConnectionAccess.accountId, set: values })
    .returning();
  return connectionOf(account, plugin, row);
}

/** A plugin's answer to whether it can run jobs of `kind`, as it is kept. */
async function preflightRecord(
  client: HostPluginClient,
  kind: CiExecutorKindId,
  region: string | undefined,
): Promise<CiPreflightRecord> {
  try {
    if (!client.ciPreflight) throw new Error("It cannot be checked.");
    const result = await client.ciPreflight(kind, region);
    return {
      ok: result.ok,
      missing: result.missing.map((m) => ({ permission: m.permission, label: m.label })),
      problems: [...result.problems],
      ...(result.region ? { region: result.region } : {}),
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      missing: [],
      problems: [err instanceof Error ? err.message : String(err)],
      checkedAt: new Date().toISOString(),
    };
  }
}

/**
 * Checks, through the plugin and without starting anything, whether the
 * connection can run jobs of `kind`, and keeps the answer. Calls the plugin:
 * a gateway route.
 */
export async function preflightConnection(
  organizationId: string,
  accountId: string,
  kind: CiExecutorKindId,
  region: string | undefined,
): Promise<CiConnectionAccess> {
  const { account, plugin } = await loadAccount(organizationId, accountId);
  if (!plugin.manifest.ciExecutor?.kinds.some((k) => k.kind === kind)) {
    throw new CiInputError(`${plugin.manifest.displayName} does not run \`${kind}\` jobs.`, 400);
  }
  const resolved = await getOrgAccountClient(accountId, organizationId);
  if (!resolved?.client.ciPreflight) {
    throw new CiInputError("This connection cannot be checked.", 409);
  }
  const record = await preflightRecord(resolved.client, kind, region);
  const existing = await loadAccess(accountId);
  const preflight = { ...(existing?.jobPreflight ?? {}), [kind]: record };
  const [row] = await db
    .insert(ciConnectionAccess)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      accountId,
      jobPreflight: preflight,
    })
    .onConflictDoUpdate({
      target: ciConnectionAccess.accountId,
      // A failing check turns the kind off: a connection that cannot run it
      // must not keep taking jobs of it.
      set: {
        jobPreflight: preflight,
        ...(record.ok
          ? {}
          : {
              jobKinds: (existing?.jobKinds ?? []).filter((k) => k !== kind),
              ...(existing && existing.jobKinds.filter((k) => k !== kind).length === 0
                ? { jobsEnabled: false }
                : {}),
            }),
        updatedAt: new Date(),
      },
    })
    .returning();
  return connectionOf(account, plugin, row);
}

/* ------------------------------------------------------------------ *
 * Resource grants.
 * ------------------------------------------------------------------ */

type GrantRow = typeof ciResourceGrants.$inferSelect;

function grantOf(
  row: GrantRow,
  account: { displayName: string; pluginId: string },
  plugins: Map<string, HostPlugin>,
): CiResourceGrant {
  const peerPlugin = row.peerPluginId ? plugins.get(row.peerPluginId) : undefined;
  return {
    id: row.id,
    accountId: row.accountId,
    accountName: account.displayName,
    pluginId: account.pluginId,
    resourceId: row.resourceId,
    resourceTypeId: row.resourceTypeId,
    resourceName: row.resourceName,
    ciName: row.ciName,
    outputs: row.outputs,
    secretVersion: row.secretVersion,
    repos: row.repos,
    branchPattern: row.branchPattern,
    peer: row.peerPluginId
      ? {
          pluginId: row.peerPluginId,
          pluginName: peerPlugin?.manifest.displayName ?? row.peerPluginId,
          jobKinds: row.peerJobKinds.filter((k): k is CiExecutorKindId =>
            (CI_EXECUTOR_KIND_IDS as readonly string[]).includes(k),
          ),
          maxConcurrentJobs: row.peerMaxConcurrentJobs,
          maxJobMinutes: row.peerMaxJobMinutes,
          preflight: row.peerPreflight,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listGrants(organizationId: string): Promise<CiResourceGrant[]> {
  const rows = await db
    .select({
      grant: ciResourceGrants,
      displayName: accounts.displayName,
      pluginId: accounts.pluginId,
    })
    .from(ciResourceGrants)
    .innerJoin(accounts, eq(accounts.id, ciResourceGrants.accountId))
    .where(eq(ciResourceGrants.organizationId, organizationId))
    .orderBy(ciResourceGrants.ciName);
  const plugins = rows.some((r) => r.grant.peerPluginId) ? await pluginsById() : new Map();
  return rows.map((r) => grantOf(r.grant, r, plugins));
}

async function loadResource(organizationId: string, resourceId: string) {
  const [row] = await db
    .select({
      id: resources.id,
      accountId: resources.accountId,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      displayName: resources.displayName,
      parentResourceId: resources.parentResourceId,
      fields: resources.fieldsJson,
    })
    .from(resources)
    .where(
      and(
        eq(resources.id, resourceId),
        eq(resources.organizationId, organizationId),
        isNull(resources.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new CiInputError("No such resource.", 404);
  return row;
}

async function typeOutputs(pluginId: string, resourceTypeId: string) {
  const plugin = (await pluginsById()).get(pluginId);
  const type = plugin?.resourceTypes.find((t) => t.id === resourceTypeId);
  return type?.outputs ?? [];
}

/** Whether every field a peer integration names as its way in is empty. */
function unreachableOf(
  integration: PeerPluginIntegration,
  fields: Record<string, unknown>,
): string | null {
  const gate = integration.unreachableWhen;
  if (!gate) return null;
  const empty = gate.fieldsEmpty.every((k) => fields[k] == null || fields[k] === "");
  return empty ? gate.title : null;
}

/**
 * What a resource can be lent to CI as: the peer integrations its type
 * declares that apply to it (the same gates the peer tabs use), whose
 * plugin lends a connection to jobs or runs cloud jobs.
 */
export function peerOptionsOf(
  resource: { pluginId: string; resourceTypeId: string; fields: Record<string, unknown> | null },
  plugins: Map<string, HostPlugin>,
): CiPeerOption[] {
  const type = plugins
    .get(resource.pluginId)
    ?.resourceTypes.find((t) => t.id === resource.resourceTypeId);
  const fields = resource.fields ?? {};
  const out: CiPeerOption[] = [];
  for (const integration of filterVisiblePeerIntegrations(type?.peerIntegrations ?? [], fields)) {
    const peer = plugins.get(integration.pluginId);
    if (!peer || out.some((o) => o.pluginId === integration.pluginId)) continue;
    const credential = credentialOf(peer);
    const executor = executorOf(peer);
    if (!credential && !executor) continue;
    out.push({
      pluginId: integration.pluginId,
      pluginName: peer.manifest.displayName,
      credential,
      executor,
      unreachable: unreachableOf(integration, fields),
    });
  }
  return out;
}

/**
 * What a resource can be granted: its type's outputs, for a secret with
 * versions its versions (read through the plugin, so a gateway route), and
 * what it can be lent as.
 */
export async function resourceOutputs(
  organizationId: string,
  resourceId: string,
): Promise<CiResourceOutputs> {
  const resource = await loadResource(organizationId, resourceId);
  const outputs = (await typeOutputs(resource.pluginId, resource.resourceTypeId)).map((o) => ({
    key: o.key,
    label: o.label,
    sensitive: o.sensitive,
  }));
  let secretVersions: CiResourceOutputs["secretVersions"] = null;
  const resolved = await getClientForResource(
    resource.pluginId,
    resource.accountId,
    organizationId,
    resource.parentResourceId ?? undefined,
  ).catch(() => null);
  if (resolved?.client.listSecretVersions && resolved.client.accessSecretVersion) {
    try {
      const versions = await resolved.client.listSecretVersions(
        resource.resourceTypeId,
        resource.id,
        resource.accountId,
      );
      secretVersions = versions.map((v) => ({
        id: v.id,
        state: v.state,
        createdAt: v.createdAt ?? null,
      }));
    } catch {
      // A secret whose versions cannot be listed right now can still be
      // granted by output; the picker offers "latest".
      secretVersions = [];
    }
  }
  return { outputs, secretVersions, peers: peerOptionsOf(resource, await pluginsById()) };
}

export interface GrantInput {
  resourceId: string;
  ciName: string;
  outputs: string[];
  secretVersion: string | null;
  repos: string[] | null;
  branchPattern: string | null;
  /** Undefined: unchanged on an update, none on a new grant. */
  peer?: CiResourceGrantPeerInput | null;
}

/** A peer as it is stored, checked against what the resource can be lent as. */
function checkPeer(
  input: CiResourceGrantPeerInput | null,
  options: CiPeerOption[],
): {
  peerPluginId: string | null;
  peerJobKinds: string[];
  peerMaxConcurrentJobs: number;
  peerMaxJobMinutes: number;
} {
  if (!input) {
    return {
      peerPluginId: null,
      peerJobKinds: [],
      peerMaxConcurrentJobs: CI_DEFAULT_PEER_LIMITS.maxConcurrentJobs,
      peerMaxJobMinutes: CI_DEFAULT_PEER_LIMITS.maxJobMinutes,
    };
  }
  const option = options.find((o) => o.pluginId === input.pluginId);
  if (!option) {
    throw new CiInputError(
      `This resource cannot be lent to CI as \`${input.pluginId}\`.${options.length > 0 ? ` It can be lent as ${options.map((o) => `\`${o.pluginId}\``).join(", ")}.` : ""}`,
      400,
    );
  }
  const offered = new Set<string>(option.executor?.kinds.map((k) => k.kind) ?? []);
  const kinds = [...new Set(input.jobKinds)];
  for (const kind of kinds) {
    if (!offered.has(kind)) {
      throw new CiInputError(`${option.pluginName} does not run \`${kind}\` jobs.`, 400);
    }
  }
  const maxConcurrentJobs = Math.trunc(input.maxConcurrentJobs);
  if (!(maxConcurrentJobs >= 1 && maxConcurrentJobs <= 50)) {
    throw new CiInputError("Concurrent jobs must be between 1 and 50.", 400);
  }
  const maxJobMinutes = Math.trunc(input.maxJobMinutes);
  if (!(maxJobMinutes >= 1 && maxJobMinutes <= 24 * 60)) {
    throw new CiInputError("Minutes per job must be between 1 and 1440.", 400);
  }
  return {
    peerPluginId: option.pluginId,
    peerJobKinds: kinds,
    peerMaxConcurrentJobs: maxConcurrentJobs,
    peerMaxJobMinutes: maxJobMinutes,
  };
}

async function checkGrant(
  organizationId: string,
  input: GrantInput,
  existing: GrantRow | null,
  plugins: Map<string, HostPlugin>,
) {
  if (!CI_GRANT_NAME.test(input.ciName)) {
    throw new CiInputError(
      "A CI name is letters, digits, `-` and `_`, starting with a letter or digit, at most 64 characters.",
      400,
    );
  }
  const resource = await loadResource(organizationId, input.resourceId);
  const known = new Set(
    (await typeOutputs(resource.pluginId, resource.resourceTypeId)).map((o) => o.key),
  );
  const outputs = [...new Set(input.outputs)];
  for (const o of outputs) {
    if (o === SECRET_VALUE_OUTPUT && input.secretVersion !== null) continue;
    if (!known.has(o)) throw new CiInputError(`The resource has no output \`${o}\`.`, 400);
  }
  const secretVersion = input.secretVersion?.trim() || null;
  if (secretVersion && !outputs.includes(SECRET_VALUE_OUTPUT)) outputs.push(SECRET_VALUE_OUTPUT);
  // Left out of an update: what the grant is lent as stays, unless the
  // resource changes, which no peer of the old one need fit.
  const keepPeer = input.peer === undefined && existing?.resourceId === resource.id;
  const peerInput: CiResourceGrantPeerInput | null =
    input.peer !== undefined
      ? input.peer
      : keepPeer && existing?.peerPluginId
        ? {
            pluginId: existing.peerPluginId,
            jobKinds: existing.peerJobKinds as CiExecutorKindId[],
            maxConcurrentJobs: existing.peerMaxConcurrentJobs,
            maxJobMinutes: existing.peerMaxJobMinutes,
          }
        : null;
  const options = peerOptionsOf(resource, plugins);
  const peer = checkPeer(peerInput, options);
  if (outputs.length === 0 && !peer.peerPluginId) {
    throw new CiInputError("Tick at least one output, or lend it as a connection.", 400);
  }
  if (peer.peerPluginId) {
    // A pipeline names a peer in `connections:`, where a connection of the
    // same name would make the name mean two things.
    const [clash] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(eq(accounts.organizationId, organizationId), eq(accounts.displayName, input.ciName)),
      )
      .limit(1);
    if (clash) {
      throw new CiInputError(
        `A connection is already called ${input.ciName}, and pipelines name both in \`connections:\`. Choose another name.`,
        409,
      );
    }
  }
  return {
    resource,
    values: {
      resourceTypeId: resource.resourceTypeId,
      resourceName: resource.displayName,
      ciName: input.ciName,
      outputs,
      secretVersion,
      repos: cleanRepos(input.repos),
      branchPattern: cleanPattern(input.branchPattern),
      ...peer,
    },
  };
}

/**
 * Checks, through the peer and without starting anything, every cloud job
 * kind the grant turns on that has not passed already, and refuses the
 * grant when one fails: a peer that cannot run a kind must not take jobs of
 * it. Calls the plugin, so the grant routes are gateway routes.
 */
async function preflightPeer(
  organizationId: string,
  resource: { id: string; accountId: string },
  peer: { peerPluginId: string | null; peerJobKinds: string[] },
  existing: GrantRow | null,
): Promise<GrantRow["peerPreflight"]> {
  const kept =
    existing && existing.peerPluginId === peer.peerPluginId && existing.resourceId === resource.id
      ? existing.peerPreflight
      : {};
  if (!peer.peerPluginId) return {};
  const due = peer.peerJobKinds.filter((k) => kept[k]?.ok !== true);
  if (due.length === 0) return kept;
  const resolved = await resourcePeerClient(organizationId, resource, peer.peerPluginId).catch(
    () => null,
  );
  if (!resolved) {
    throw new CiInputError(
      `The resource could not be reached as \`${peer.peerPluginId}\` to check it can run cloud jobs.`,
      409,
    );
  }
  const out = { ...kept };
  const failing: string[] = [];
  for (const kind of due) {
    const record = await preflightRecord(resolved.client, kind as CiExecutorKindId, undefined);
    out[kind] = record;
    if (!record.ok) {
      const why = [
        ...record.missing.map((m) => `${m.permission} (${m.label})`),
        ...record.problems,
      ].join("; ");
      failing.push(`\`${kind}\`${why ? `: ${why}` : ""}`);
    }
  }
  if (failing.length > 0) {
    throw new CiInputError(
      `The ${resolved.plugin.manifest.displayName} check failed, so these jobs cannot run on it: ${failing.join(". ")}`,
      409,
    );
  }
  return out;
}

function nameTaken(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    ((err as { code?: unknown }).code === "23505" ||
      (err as { cause?: { code?: unknown } }).cause?.code === "23505")
  );
}

export async function createGrant(
  organizationId: string,
  input: GrantInput,
  userId: string | null,
): Promise<CiResourceGrant> {
  const plugins = await pluginsById();
  const { resource, values } = await checkGrant(organizationId, input, null, plugins);
  const { account } = await loadAccount(organizationId, resource.accountId);
  const peerPreflight = await preflightPeer(organizationId, resource, values, null);
  try {
    const [row] = await db
      .insert(ciResourceGrants)
      .values({
        id: crypto.randomUUID(),
        organizationId,
        accountId: resource.accountId,
        resourceId: resource.id,
        createdByUserId: userId,
        updatedByUserId: userId,
        ...values,
        peerPreflight,
      })
      .returning();
    return grantOf(row!, account, plugins);
  } catch (err) {
    if (nameTaken(err)) throw new CiInputError(`A grant is already called ${input.ciName}.`, 409);
    throw err;
  }
}

export async function updateGrant(
  organizationId: string,
  id: string,
  input: GrantInput,
  userId: string | null,
): Promise<CiResourceGrant> {
  const [existing] = await db
    .select()
    .from(ciResourceGrants)
    .where(and(eq(ciResourceGrants.id, id), eq(ciResourceGrants.organizationId, organizationId)))
    .limit(1);
  if (!existing) throw new CiInputError("No such grant.", 404);
  const plugins = await pluginsById();
  const { resource, values } = await checkGrant(organizationId, input, existing, plugins);
  const { account } = await loadAccount(organizationId, resource.accountId);
  const peerPreflight = await preflightPeer(organizationId, resource, values, existing);
  try {
    const [row] = await db
      .update(ciResourceGrants)
      .set({
        ...values,
        peerPreflight,
        accountId: resource.accountId,
        resourceId: resource.id,
        updatedByUserId: userId,
        updatedAt: new Date(),
      })
      .where(and(eq(ciResourceGrants.id, id), eq(ciResourceGrants.organizationId, organizationId)))
      .returning();
    if (!row) throw new CiInputError("No such grant.", 404);
    return grantOf(row, account, plugins);
  } catch (err) {
    if (nameTaken(err)) throw new CiInputError(`A grant is already called ${input.ciName}.`, 409);
    throw err;
  }
}

export async function deleteGrant(organizationId: string, id: string): Promise<CiResourceGrant> {
  const [row] = await db
    .delete(ciResourceGrants)
    .where(and(eq(ciResourceGrants.id, id), eq(ciResourceGrants.organizationId, organizationId)))
    .returning();
  if (!row) throw new CiInputError("No such grant.", 404);
  const [account] = await db
    .select({ displayName: accounts.displayName, pluginId: accounts.pluginId })
    .from(accounts)
    .where(eq(accounts.id, row.accountId))
    .limit(1);
  return grantOf(row, account ?? { displayName: "", pluginId: "" }, new Map());
}

/* ------------------------------------------------------------------ *
 * SSH keys.
 * ------------------------------------------------------------------ */

export async function listSshKeyLending(
  organizationId: string,
  userId: string | null,
): Promise<CiSshKeyLending[]> {
  const rows = await db
    .select({
      access: ciSshKeyAccess,
      keyName: sshKeys.name,
      ownerUserId: sshKeys.userId,
      ownerName: users.displayName,
      ownerEmail: users.email,
    })
    .from(ciSshKeyAccess)
    .innerJoin(sshKeys, eq(sshKeys.id, ciSshKeyAccess.sshKeyId))
    .leftJoin(users, eq(users.id, sshKeys.userId))
    .where(eq(ciSshKeyAccess.organizationId, organizationId))
    .orderBy(ciSshKeyAccess.ciName);
  return rows.map((r) => ({
    sshKeyId: r.access.sshKeyId,
    keyName: r.keyName,
    ownerUserId: r.ownerUserId,
    ownerName: r.ownerName ?? r.ownerEmail ?? null,
    ciName: r.access.ciName,
    repos: r.access.repos,
    branchPattern: r.access.branchPattern,
    mine: userId !== null && r.ownerUserId === userId,
    createdAt: r.access.createdAt.toISOString(),
  }));
}

export interface SshKeyLendingInput {
  enabled: boolean;
  ciName: string;
  repos: string[] | null;
  branchPattern: string | null;
}

/**
 * Lends one of the caller's own SSH keys to CI jobs, or stops lending it.
 * Only the key's owner can; only a key whose private half Infrawrench holds.
 */
export async function setSshKeyLending(
  organizationId: string,
  userId: string,
  sshKeyId: string,
  input: SshKeyLendingInput,
): Promise<CiSshKeyLending | null> {
  const [key] = await db
    .select({
      id: sshKeys.id,
      name: sshKeys.name,
      hasPrivate: sshKeys.encryptedPrivateKey,
    })
    .from(sshKeys)
    .where(
      and(
        eq(sshKeys.id, sshKeyId),
        eq(sshKeys.organizationId, organizationId),
        eq(sshKeys.userId, userId),
      ),
    )
    .limit(1);
  if (!key) throw new CiInputError("No such SSH key of yours.", 404);
  if (!input.enabled) {
    await db.delete(ciSshKeyAccess).where(eq(ciSshKeyAccess.sshKeyId, key.id));
    return null;
  }
  if (!key.hasPrivate) {
    throw new CiInputError(
      "Infrawrench holds only this key's public half, so it cannot be lent. Generate a key in Infrawrench, or import one with its private key.",
      400,
    );
  }
  if (!CI_GRANT_NAME.test(input.ciName)) {
    throw new CiInputError(
      "A CI name is letters, digits, `-` and `_`, starting with a letter or digit, at most 64 characters.",
      400,
    );
  }
  const values = {
    ciName: input.ciName,
    repos: cleanRepos(input.repos),
    branchPattern: cleanPattern(input.branchPattern),
    enabledByUserId: userId,
    updatedAt: new Date(),
  };
  try {
    await db
      .insert(ciSshKeyAccess)
      .values({ id: crypto.randomUUID(), organizationId, sshKeyId: key.id, ...values })
      .onConflictDoUpdate({ target: ciSshKeyAccess.sshKeyId, set: values });
  } catch (err) {
    if (nameTaken(err)) {
      throw new CiInputError(`Another SSH key is lent to CI as ${input.ciName}.`, 409);
    }
    throw err;
  }
  const lent = await listSshKeyLending(organizationId, userId);
  return lent.find((l) => l.sshKeyId === key.id) ?? null;
}

/** Stops lending any SSH key of the organization (admins). */
export async function revokeSshKeyLending(
  organizationId: string,
  sshKeyId: string,
): Promise<{ ciName: string; ownerUserId: string } | null> {
  const [row] = await db
    .delete(ciSshKeyAccess)
    .where(
      and(eq(ciSshKeyAccess.sshKeyId, sshKeyId), eq(ciSshKeyAccess.organizationId, organizationId)),
    )
    .returning();
  if (!row) throw new CiInputError("That SSH key is not lent to CI.", 404);
  const [key] = await db
    .select({ userId: sshKeys.userId })
    .from(sshKeys)
    .where(eq(sshKeys.id, sshKeyId))
    .limit(1);
  return { ciName: row.ciName, ownerUserId: key?.userId ?? "" };
}

export async function ciAccessOverview(
  organizationId: string,
  userId: string | null,
): Promise<CiAccessOverview> {
  const [connections, grants, sshKeyLending] = await Promise.all([
    listConnectionAccess(organizationId),
    listGrants(organizationId),
    listSshKeyLending(organizationId, userId),
  ]);
  return { viewerUserId: userId, connections, grants, sshKeys: sshKeyLending };
}

/**
 * Cloud jobs still running, or still being torn down, on a connection. A
 * connection with any cannot be deleted: its credentials are what tears the
 * job's compute down, and the reaper finds leftovers through it.
 */
export async function liveCloudJobCount(
  organizationId: string,
  accountId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ciCloudJobs)
    .where(
      and(
        eq(ciCloudJobs.organizationId, organizationId),
        eq(ciCloudJobs.accountId, accountId),
        inArray(ciCloudJobs.state, ["claiming", "starting", "running", "tearing_down"]),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Stops lending a member's SSH keys to CI, when they leave the organization:
 * a key lent by someone who is no longer a member must not keep reaching
 * every trusted run. Answers the CI names it stopped.
 */
export async function stopLendingKeysOf(organizationId: string, userId: string): Promise<string[]> {
  const keys = db
    .select({ id: sshKeys.id })
    .from(sshKeys)
    .where(and(eq(sshKeys.organizationId, organizationId), eq(sshKeys.userId, userId)));
  const removed = await db
    .delete(ciSshKeyAccess)
    .where(
      and(
        eq(ciSshKeyAccess.organizationId, organizationId),
        inArray(ciSshKeyAccess.sshKeyId, keys),
      ),
    )
    .returning({ ciName: ciSshKeyAccess.ciName });
  return removed.map((r) => r.ciName);
}
