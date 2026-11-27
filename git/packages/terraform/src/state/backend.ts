import { sha256Hex } from "../util/bytes.js";
import { DEFAULT_MAX_STATE_BYTES, readStateHeader, withSerial } from "./document.js";
import type { HeldLock, LockInfo, StateStore, StateVersion } from "./types.js";

/**
 * What a Terraform state backend does, as plain functions over a
 * {@link StateStore}: each reads the head, decides, and asks the store to
 * apply the change only if the head is still what it decided on. The answers
 * are outcomes, not HTTP; `http.ts` turns them into what Terraform's `http`
 * backend expects, and the forge's own API (restore, force-unlock, listings)
 * uses them directly.
 */

/** How often a change is tried again when the head moved under it. */
const ATTEMPTS = 4;

export interface WriteContext {
  /** The `?ID=` Terraform sent, or null when it wrote without a lock (`-lock=false`). */
  readonly lockId: string | null;
  /** The authenticated principal, recorded as the version's `createdBy`. */
  readonly actor: string;
  readonly now?: (() => Date) | undefined;
  readonly maxBytes?: number | undefined;
}

export type WriteConflict =
  /** The document belongs to another state's history. */
  | "lineage"
  /** The document is older than the stored one. */
  | "serial-behind"
  /** Same serial, other content: two writers started from the same version. */
  | "serial-reused"
  /** The head kept moving; the client may try again. */
  | "busy";

export type WriteOutcome =
  | { readonly kind: "written"; readonly version: StateVersion }
  /** The stored head already is this document: a retried request. */
  | { readonly kind: "unchanged"; readonly version: StateVersion }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "too-large"; readonly limit: number }
  /** Someone else holds the lock, or the write named none while one is held. */
  | { readonly kind: "locked"; readonly lock: HeldLock }
  /** The write named a lock that is no longer held (it was force-unlocked). */
  | { readonly kind: "lock-lost" }
  | {
      readonly kind: "conflict";
      readonly conflict: WriteConflict;
      readonly current: StateVersion | null;
    };

export async function writeState(
  store: StateStore,
  bytes: Uint8Array,
  context: WriteContext,
): Promise<WriteOutcome> {
  const limit = context.maxBytes ?? DEFAULT_MAX_STATE_BYTES;
  if (bytes.length > limit) return { kind: "too-large", limit };
  const parsed = readStateHeader(bytes);
  if (!parsed.ok) return { kind: "invalid", reason: parsed.reason };
  const { header } = parsed;
  const sha256 = await sha256Hex(bytes);

  let current: StateVersion | null = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const head = await store.head();
    current = head.version;
    if (head.lock) {
      if (context.lockId !== head.lock.info.ID) return { kind: "locked", lock: head.lock };
    } else if (context.lockId !== null) {
      return { kind: "lock-lost" };
    }
    if (current) {
      if (current.lineage !== header.lineage) {
        return { kind: "conflict", conflict: "lineage", current };
      }
      if (header.serial < current.serial) {
        return { kind: "conflict", conflict: "serial-behind", current };
      }
      if (header.serial === current.serial) {
        return current.sha256 === sha256
          ? { kind: "unchanged", version: current }
          : { kind: "conflict", conflict: "serial-reused", current };
      }
    }
    const result = await store.commit(
      {
        serial: header.serial,
        lineage: header.lineage,
        terraformVersion: header.terraformVersion,
        resourceCount: header.resourceCount,
        size: bytes.length,
        sha256,
        createdAt: (context.now?.() ?? new Date()).toISOString(),
        createdBy: context.actor,
      },
      bytes,
      { versionId: current?.id ?? null, lockId: head.lock?.info.ID ?? null },
    );
    if (result.ok) return { kind: "written", version: result.version };
  }
  return { kind: "conflict", conflict: "busy", current };
}

export type ReadOutcome =
  | { readonly kind: "found"; readonly version: StateVersion; readonly bytes: Uint8Array }
  | { readonly kind: "empty" };

/** The current state. Reading never needs the lock, as with every Terraform backend. */
export async function readState(store: StateStore): Promise<ReadOutcome> {
  const { version } = await store.head();
  if (!version) return { kind: "empty" };
  const bytes = await store.read(version.id);
  // A head whose bytes are gone is a broken store, not an empty workspace:
  // answering "empty" would have Terraform plan to create everything again.
  if (!bytes) throw new Error(`State version ${version.id} has no stored bytes`);
  return { kind: "found", version, bytes };
}

export interface LockContext {
  readonly actor: string;
  readonly now?: (() => Date) | undefined;
}

export type LockOutcome =
  | { readonly kind: "acquired"; readonly lock: HeldLock }
  | { readonly kind: "locked"; readonly lock: HeldLock };

export async function lockState(
  store: StateStore,
  info: LockInfo,
  context: LockContext,
): Promise<LockOutcome> {
  const wanted: HeldLock = {
    info,
    heldBy: context.actor,
    lockedAt: (context.now?.() ?? new Date()).toISOString(),
  };
  const holder = await store.acquireLock(wanted);
  if (!holder) return { kind: "acquired", lock: wanted };
  // The same lock asked for twice is a request retried after its answer was
  // lost: Terraform's HTTP client retries, and must not lock itself out.
  if (holder.info.ID === info.ID) return { kind: "acquired", lock: holder };
  return { kind: "locked", lock: holder };
}

export interface UnlockRequest {
  /** The lock's `ID`, or null when the caller did not name one. */
  readonly lockId: string | null;
  /** Whether the caller may release a lock without naming it (an admin). */
  readonly force: boolean;
}

export type UnlockOutcome =
  | { readonly kind: "released"; readonly lock: HeldLock }
  /** Nothing was locked. Unlocking twice is not an error. */
  | { readonly kind: "not-locked" }
  /** Another lock is held than the one named. */
  | { readonly kind: "mismatch"; readonly lock: HeldLock }
  /** No lock was named and the caller may not force. */
  | { readonly kind: "force-required"; readonly lock: HeldLock };

export async function unlockState(
  store: StateStore,
  request: UnlockRequest,
): Promise<UnlockOutcome> {
  const { lock } = await store.head();
  if (!lock) return { kind: "not-locked" };
  if (request.lockId === null) {
    if (!request.force) return { kind: "force-required", lock };
    await store.releaseLock(null);
    return { kind: "released", lock };
  }
  if (request.lockId !== lock.info.ID) return { kind: "mismatch", lock };
  const remaining = await store.releaseLock(request.lockId);
  return remaining ? { kind: "mismatch", lock: remaining } : { kind: "released", lock };
}

export type PurgeOutcome =
  | { readonly kind: "purged" }
  | { readonly kind: "empty" }
  | { readonly kind: "locked"; readonly lock: HeldLock }
  | { readonly kind: "busy" };

/**
 * Leaves the workspace without a current state (the backend's `DELETE`). The
 * stored versions stay, so it is undone with {@link restoreVersion}. Refused
 * while anyone holds the lock: there is no `?ID=` on a delete to say it is the
 * holder asking.
 */
export async function purgeState(store: StateStore): Promise<PurgeOutcome> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const head = await store.head();
    if (head.lock) return { kind: "locked", lock: head.lock };
    if (!head.version) return { kind: "empty" };
    const result = await store.purge({ versionId: head.version.id, lockId: null });
    if (result.ok) return { kind: "purged" };
  }
  return { kind: "busy" };
}

export interface RestoreContext {
  readonly actor: string;
  readonly now?: (() => Date) | undefined;
}

export type RestoreOutcome =
  | { readonly kind: "restored"; readonly version: StateVersion }
  | { readonly kind: "not-found" }
  | { readonly kind: "locked"; readonly lock: HeldLock }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "busy" };

/**
 * Makes an old version the current state again, as a new version: the same
 * document with a serial one past the newest, so every client sees it as a
 * change and nothing in the history is rewritten. Refused while the state is
 * locked, because a run in progress would write over it.
 */
export async function restoreVersion(
  store: StateStore,
  versionId: string,
  context: RestoreContext,
): Promise<RestoreOutcome> {
  const target = await store.version(versionId);
  const stored = target ? await store.read(versionId) : null;
  if (!target || !stored) return { kind: "not-found" };
  const text = new TextDecoder().decode(stored);

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const head = await store.head();
    if (head.lock) return { kind: "locked", lock: head.lock };
    const serial = Math.max(target.serial, head.version?.serial ?? 0) + 1;
    const rewritten = withSerial(text, serial);
    if (rewritten === null) return { kind: "invalid", reason: "The version has no serial." };
    const bytes = new TextEncoder().encode(rewritten);
    const result = await store.commit(
      {
        serial,
        lineage: target.lineage,
        terraformVersion: target.terraformVersion,
        resourceCount: target.resourceCount,
        size: bytes.length,
        sha256: await sha256Hex(bytes),
        createdAt: (context.now?.() ?? new Date()).toISOString(),
        createdBy: context.actor,
      },
      bytes,
      { versionId: head.version?.id ?? null, lockId: null },
    );
    if (result.ok) return { kind: "restored", version: result.version };
  }
  return { kind: "busy" };
}
