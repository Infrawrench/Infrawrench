/**
 * Fan-out SSH — run one command across many SSH-capable hosts.
 *
 * Targets come in two flavours, mirroring the single-host terminal:
 *  - "account": accounts of the `ssh` plugin, whose client natively exposes
 *    `getSshConfig()` (host, username, and key live in the account creds).
 *  - "resource": resources whose type declares `sshEndpoint` (EC2 instances,
 *    droplets, Hetzner servers, …) — paired with an org SSH key at run time,
 *    exactly like the quick-connect flow.
 *
 * Execution reuses `sshExecCapture` (services/ssh.ts) per host under a
 * concurrency cap; grouping/diffing of the results is client-side
 * (`@infrawrench/client-core` ssh-fanout helpers).
 */
import { eq, and, isNull, inArray } from "drizzle-orm";
import {
  runWithConcurrency,
  extractRecordTags,
  FANOUT_DEFAULT_CONCURRENCY,
  FANOUT_MAX_TARGETS,
} from "@infrawrench/client-core";
import type { ResourceTypeDefinition, SshConfig } from "@infrawrench/plugin-base";
import { loadPlugins, getPlugin } from "../plugins/loader";
import { db } from "../db/client";
import { accounts, resources, sshKeys } from "../db/schema";
import { decrypt, buildAad } from "./encryption";
import { getClientForAccount } from "./plugin-clients";
import { resolveSshConfig, sshExecCapture } from "./ssh";
import { HostKeyTrustRequiredError } from "./ssh-host-keys";
import { assertHostNotInternal } from "./host-validation";

export const FANOUT_MAX_CONCURRENCY = 16;

export interface FanoutTargetSummary {
  kind: "account" | "resource";
  /** accountId for account targets, resourceId for resource targets. */
  id: string;
  accountId: string;
  label: string;
  pluginId: string;
  resourceTypeId?: string;
  /** Resolved SSH host (resource targets only; account creds stay sealed). */
  host?: string;
  defaultUsername?: string;
  /** False when the sshEndpoint's runningWhen check says the VM is stopped. */
  running: boolean;
  /** True when the target needs an org SSH key (sshEndpoint resources). */
  needsKey: boolean;
  tags: string[];
}

export interface FanoutTargetRef {
  kind: "account" | "resource";
  id: string;
}

export interface FanoutHostRunResult {
  kind: "account" | "resource";
  targetId: string;
  label: string;
  status: "done" | "error" | "blocked";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  durationMs: number;
  /** Present when the failure was an untrusted/changed host key. */
  hostKeyTrust?: {
    kind: "unknown" | "mismatch";
    host: string;
    port: number;
    presentedFingerprint: string;
    storedFingerprint: string | null;
  };
}

interface ResourceRowLike {
  id: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  fieldsJson: Record<string, unknown>;
  outputsJson: Record<string, unknown>;
}

/**
 * Derive a fan-out target from a stored resource row and its type definition.
 * Pure — exercised directly by unit tests. Returns null when the type has no
 * sshEndpoint or no host resolves.
 */
export function deriveResourceTarget(
  row: ResourceRowLike,
  typeDef: Pick<ResourceTypeDefinition, "sshEndpoint"> | undefined,
): FanoutTargetSummary | null {
  const endpoint = typeDef?.sshEndpoint;
  if (!endpoint) return null;
  const host = String(
    row.outputsJson?.[endpoint.hostOutputKey] ?? row.fieldsJson?.[endpoint.hostOutputKey] ?? "",
  );
  if (!host) return null;
  let running = true;
  if (endpoint.runningWhen) {
    const fieldVal = String(row.fieldsJson?.[endpoint.runningWhen.fieldKey] ?? "");
    running = fieldVal.toLowerCase() === endpoint.runningWhen.value.toLowerCase();
  }
  let username = endpoint.defaultUsername ?? "root";
  if (endpoint.usernameFieldKey) {
    const val = String(row.fieldsJson?.[endpoint.usernameFieldKey] ?? "");
    if (val) username = val;
  }
  const tags = extractRecordTags(row.fieldsJson) ?? {};
  return {
    kind: "resource",
    id: row.id,
    accountId: row.accountId,
    label: row.displayName,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    host,
    defaultUsername: username,
    running,
    needsKey: true,
    tags: Object.entries(tags).map(([k, v]) => (v ? `${k}:${v}` : k)),
  };
}

/** All SSH-capable targets in the org: `ssh` accounts + sshEndpoint resources. */
export async function listFanoutTargets(organizationId: string): Promise<FanoutTargetSummary[]> {
  const targets: FanoutTargetSummary[] = [];

  const sshAccounts = await db
    .select({ id: accounts.id, displayName: accounts.displayName })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        eq(accounts.pluginId, "ssh"),
        isNull(accounts.deletedAt),
      ),
    );
  for (const a of sshAccounts) {
    targets.push({
      kind: "account",
      id: a.id,
      accountId: a.id,
      label: a.displayName,
      pluginId: "ssh",
      running: true,
      needsKey: false,
      tags: [],
    });
  }

  // Resource types that declare sshEndpoint, from the plugin registry.
  const plugins = await loadPlugins();
  const sshTypes = new Map<string, Pick<ResourceTypeDefinition, "sshEndpoint">>();
  for (const { plugin } of plugins) {
    for (const rt of plugin.resourceTypes) {
      if (rt.sshEndpoint) sshTypes.set(`${plugin.manifest.id}:${rt.id}`, rt);
    }
  }
  if (sshTypes.size > 0) {
    const pluginIds = [...new Set([...sshTypes.keys()].map((k) => k.split(":")[0] as string))];
    const rows = await db
      .select({
        id: resources.id,
        accountId: resources.accountId,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        displayName: resources.displayName,
        fieldsJson: resources.fieldsJson,
        outputsJson: resources.outputsJson,
      })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          isNull(resources.deletedAt),
          inArray(resources.pluginId, pluginIds),
        ),
      );
    for (const row of rows) {
      const typeDef = sshTypes.get(`${row.pluginId}:${row.resourceTypeId}`);
      const target = deriveResourceTarget(row, typeDef);
      if (target) targets.push(target);
    }
  }

  return targets.sort((a, b) => a.label.localeCompare(b.label));
}

export interface FanoutRunOptions {
  command: string;
  targets: FanoutTargetRef[];
  /** Org SSH key for sshEndpoint resource targets (must be caller-owned). */
  sshKeyId?: string | undefined;
  /** Username override applied to all resource targets. */
  username?: string | undefined;
  concurrency?: number | undefined;
}

/**
 * Run `command` on every target with a concurrency cap. Per-host failures
 * (unreachable host, untrusted key, blocked internal host) become per-host
 * results — one bad box never fails the run. The caller has already passed
 * permission and change-freeze gates and audits the run.
 */
export async function runFanout(
  organizationId: string,
  userId: string,
  opts: FanoutRunOptions,
): Promise<FanoutHostRunResult[]> {
  if (opts.targets.length === 0) throw new FanoutInputError("No targets selected");
  if (opts.targets.length > FANOUT_MAX_TARGETS) {
    throw new FanoutInputError(`Too many targets (max ${FANOUT_MAX_TARGETS})`);
  }
  const concurrency = Math.max(
    1,
    Math.min(opts.concurrency ?? FANOUT_DEFAULT_CONCURRENCY, FANOUT_MAX_CONCURRENCY),
  );

  // Resolve the org key once (resource targets). Restricted to keys owned by
  // the caller — same policy as /ssh-tunnels/exec.
  let privateKey: string | null = null;
  const needsKey = opts.targets.some((t) => t.kind === "resource");
  if (needsKey) {
    if (!opts.sshKeyId) throw new FanoutInputError("sshKeyId is required for resource targets");
    const [keyRow] = await db
      .select({
        encryptedPrivateKey: sshKeys.encryptedPrivateKey,
        privateKeyIv: sshKeys.privateKeyIv,
      })
      .from(sshKeys)
      .where(
        and(
          eq(sshKeys.id, opts.sshKeyId),
          eq(sshKeys.organizationId, organizationId),
          eq(sshKeys.userId, userId),
        ),
      )
      .limit(1);
    if (!keyRow) throw new FanoutInputError("SSH key not found");
    if (!keyRow.encryptedPrivateKey || !keyRow.privateKeyIv) {
      throw new FanoutInputError("SSH key has no private key data (imported public key?)");
    }
    privateKey = await decrypt(
      keyRow.encryptedPrivateKey,
      keyRow.privateKeyIv,
      buildAad("sshKey", opts.sshKeyId, "privateKey"),
    );
  }

  // Pre-load resource rows in one query; hosts are resolved server-side from
  // stored state, never trusted from the client.
  const resourceIds = opts.targets.flatMap((t) => (t.kind === "resource" ? [t.id] : []));
  const resourceRows =
    resourceIds.length > 0
      ? await db
          .select({
            id: resources.id,
            accountId: resources.accountId,
            pluginId: resources.pluginId,
            resourceTypeId: resources.resourceTypeId,
            displayName: resources.displayName,
            fieldsJson: resources.fieldsJson,
            outputsJson: resources.outputsJson,
          })
          .from(resources)
          .where(
            and(
              eq(resources.organizationId, organizationId),
              isNull(resources.deletedAt),
              inArray(resources.id, resourceIds),
            ),
          )
      : [];
  const rowById = new Map(resourceRows.map((r) => [r.id, r]));

  return runWithConcurrency(opts.targets, concurrency, async (ref) => {
    const started = Date.now();
    const base = { kind: ref.kind, targetId: ref.id };
    try {
      let config: SshConfig;
      let label: string;
      if (ref.kind === "account") {
        const ctx = await getClientForAccount(ref.id, organizationId);
        if (!ctx) return failResult(base, ref.id, "Account not found", started);
        if (ctx.plugin.manifest.id !== "ssh") {
          return failResult(base, ref.id, "Account is not an SSH host", started);
        }
        label = await accountLabel(ref.id, organizationId);
        config = await resolveSshConfig(ctx.client, organizationId, {});
      } else {
        const row = rowById.get(ref.id);
        if (!row) return failResult(base, ref.id, "Resource not found", started);
        label = row.displayName;
        const loaded = await getPlugin(row.pluginId);
        const typeDef = loaded?.plugin.resourceTypes.find((t) => t.id === row.resourceTypeId);
        const target = deriveResourceTarget(row, typeDef);
        if (!target?.host) return failResult(base, label, "No SSH host on this resource", started);
        if (!target.running) {
          return blockedResult(base, label, "Host is not running", started);
        }
        config = {
          host: target.host,
          port: 22,
          username: opts.username || target.defaultUsername || "root",
          privateKey: privateKey as string,
        };
      }

      // SSRF guard on the host the server is about to dial.
      try {
        await assertHostNotInternal(config.host);
      } catch (e) {
        return blockedResult(base, label, e instanceof Error ? e.message : "Host blocked", started);
      }

      const result = await sshExecCapture(organizationId, config, opts.command);
      return {
        ...base,
        label,
        status: "done" as const,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
      };
    } catch (e) {
      if (e instanceof HostKeyTrustRequiredError) {
        return {
          ...base,
          label: labelFallback(ref, rowById),
          status: "error" as const,
          exitCode: null,
          stdout: "",
          stderr: "",
          error: e.message,
          durationMs: Date.now() - started,
          hostKeyTrust: {
            kind: e.kind,
            host: e.host,
            port: e.port,
            presentedFingerprint: e.presentedFingerprint,
            storedFingerprint: e.storedFingerprint,
          },
        };
      }
      return failResult(
        base,
        labelFallback(ref, rowById),
        e instanceof Error ? e.message : "SSH exec failed",
        started,
      );
    }
  });
}

/** Validation failures the route maps to 400s. */
export class FanoutInputError extends Error {}

function labelFallback(
  ref: FanoutTargetRef,
  rowById: Map<string, { displayName: string }>,
): string {
  return ref.kind === "resource" ? (rowById.get(ref.id)?.displayName ?? ref.id) : ref.id;
}

async function accountLabel(accountId: string, organizationId: string): Promise<string> {
  const [row] = await db
    .select({ displayName: accounts.displayName })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
    .limit(1);
  return row?.displayName ?? accountId;
}

function failResult(
  base: { kind: "account" | "resource"; targetId: string },
  label: string,
  error: string,
  started: number,
): FanoutHostRunResult {
  return {
    ...base,
    label,
    status: "error",
    exitCode: null,
    stdout: "",
    stderr: "",
    error,
    durationMs: Date.now() - started,
  };
}

function blockedResult(
  base: { kind: "account" | "resource"; targetId: string },
  label: string,
  error: string,
  started: number,
): FanoutHostRunResult {
  return {
    ...base,
    label,
    status: "blocked",
    exitCode: null,
    stdout: "",
    stderr: "",
    error,
    durationMs: Date.now() - started,
  };
}
