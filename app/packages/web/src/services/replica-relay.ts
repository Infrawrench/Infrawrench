/**
 * Reaching the replica that holds an in-process session.
 *
 * Some sessions cannot be moved between pods. A Linux application session is
 * an SSH channel to a compositor on a customer's host, and that compositor
 * exits the moment the channel closes — so the pod that opened it is the only
 * one that can serve the next call about it. With `replicas: 2` and round-robin
 * routing, roughly half of those calls arrive somewhere else, and the pod they
 * land on has no way to know it should not just start its own.
 *
 * `infra/k8s/web-ws-ingress.yaml` handles the browser half by consistent-
 * hashing `?sid=` at the ingress, and states outright that the durable fix is
 * "a cross-replica relay". This is that relay, in two halves:
 *
 *   * a **lease** in `replica_session_owners` saying which pod holds a
 *     session, taken in one statement so two pods cannot both win it, and
 *   * a **forward** to that pod's address, so the call runs where the session
 *     already is instead of failing or duplicating it.
 *
 * It is a routing mechanism and nothing more. An address in the table is a
 * hint, not a capability: the receiving pod re-checks the caller's permissions
 * exactly as it would on a direct call, and this module never carries a user's
 * identity — only the operation and the session it belongs to.
 *
 * ## When it is off
 *
 * Without `POD_IP` and `INTERNAL_RELAY_SECRET` the relay disables itself and
 * every claim answers "self", which is precisely the single-process behaviour
 * of a dev server, a test, or the desktop app. Nothing here should ever be a
 * reason a local run behaves differently from production in any way other than
 * how many processes there are.
 */
import { timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { replicaSessionOwners } from "@/db/schema";

/**
 * How long a lease survives without a heartbeat. A pod that is OOM killed or
 * evicted never releases anything, so the lease has to expire on its own — and
 * this is the delay before a stranded session can be replaced, which is why it
 * is a minute rather than an hour.
 */
const LEASE_TTL_MS = 60_000;

/** Don't write a heartbeat more often than this; a lease only needs liveness. */
const HEARTBEAT_EVERY_MS = 15_000;

/** How long to wait on a forwarded call before giving up on the owner. */
const FORWARD_TIMEOUT_MS = 60_000;

/** The path {@link forwardToOwner} posts to, served by `api/routes/internal-relay.ts`. */
export const RELAY_PATH = "/api/internal/relay";

/** A pod address: a bare private IPv4 and a port, which is all GKE ever gives us. */
const ADDRESS_SHAPE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/;

export class RelayUnreachableError extends Error {
  constructor(
    readonly address: string,
    cause: unknown,
  ) {
    super(`the replica holding this session (${address}) did not answer`);
    this.name = "RelayUnreachableError";
    this.cause = cause;
  }
}

/** Raised when the owner answered, but the operation itself failed there. */
export class RelayRemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayRemoteError";
  }
}

let warnedAboutSecret = false;

/**
 * This pod's in-cluster address, or undefined when it has none.
 *
 * `POD_IP` comes from the downward API (`infra/k8s/web-deployment.yaml`). A
 * process without it is not part of a replica set as far as this module is
 * concerned, and takes the single-process path.
 */
export function relayAddress(): string | undefined {
  const ip = process.env["POD_IP"]?.trim();
  if (!ip) return undefined;
  const port = process.env["PORT"]?.trim() || "3000";
  const address = `${ip}:${port}`;
  return isForwardableAddress(address) ? address : undefined;
}

function relaySecret(): string | undefined {
  return process.env["INTERNAL_RELAY_SECRET"]?.trim() || undefined;
}

/**
 * Whether this process can both be reached and authenticate what it receives.
 *
 * Both halves are required. An address with no secret would mean forwarding
 * onto an endpoint that cannot tell a sibling pod from anyone else who can
 * reach it, so that configuration disables the relay rather than weakening it.
 */
export function relayEnabled(): boolean {
  const address = relayAddress();
  if (!address) return false;
  if (relaySecret()) return true;
  if (!warnedAboutSecret) {
    warnedAboutSecret = true;
    console.warn(
      "[relay] POD_IP is set but INTERNAL_RELAY_SECRET is not — cross-replica routing is off, " +
        "so sessions held by another replica will fail rather than being forwarded to it.",
    );
  }
  return false;
}

/**
 * Only ever forward to a private IPv4 address.
 *
 * The addresses in this table are written by our own pods, so this is defence
 * in depth rather than input validation — but it is the cheap kind: a row that
 * somehow named a public host would otherwise turn every replica into an
 * open forwarder for an authenticated internal endpoint.
 */
export function isForwardableAddress(address: string): boolean {
  const match = ADDRESS_SHAPE.exec(address);
  if (!match) return false;
  const octets = [match[1], match[2], match[3], match[4]].map((part) => Number(part));
  const port = Number(match[5]);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export type SessionClaim = { owner: "self" } | { owner: "remote"; address: string };

function rowId(kind: string, key: string): string {
  return `${kind}:${key}`;
}

/**
 * Take the lease for a session, or find out who already holds it.
 *
 * The upsert is the whole concurrency argument: two pods racing for the same
 * new session both run one statement, and Postgres serialises them, so exactly
 * one insert wins and the loser reads the winner's address. `setWhere` is what
 * stops a live session being stolen — an existing lease is only overwritten
 * when it is already ours (a reconnect) or its holder has stopped
 * heartbeating (a pod that died).
 */
export async function claimSession(kind: string, key: string): Promise<SessionClaim> {
  const me = relayAddress();
  if (!me || !relayEnabled()) return { owner: "self" };

  const id = rowId(kind, key);
  // Two turns at most: the only way the first fails to decide anything is if
  // the row is deleted between the upsert and the read, and then a fresh
  // claim is exactly the right move.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = new Date();
    const claimed = await db
      .insert(replicaSessionOwners)
      .values({ id, kind, ownerAddress: me, claimedAt: now, heartbeatAt: now })
      .onConflictDoUpdate({
        target: replicaSessionOwners.id,
        set: { ownerAddress: me, claimedAt: now, heartbeatAt: now },
        setWhere: sql`${replicaSessionOwners.ownerAddress} = ${me} or ${replicaSessionOwners.heartbeatAt} < ${new Date(now.getTime() - LEASE_TTL_MS)}`,
      })
      .returning({ ownerAddress: replicaSessionOwners.ownerAddress });

    if (claimed[0]) {
      markHeartbeat(id);
      return { owner: "self" };
    }

    const [held] = await db
      .select({ ownerAddress: replicaSessionOwners.ownerAddress })
      .from(replicaSessionOwners)
      .where(eq(replicaSessionOwners.id, id))
      .limit(1);
    if (!held) continue;
    if (held.ownerAddress === me) return { owner: "self" };
    if (!isForwardableAddress(held.ownerAddress)) {
      // A lease we could never route to is worse than none: drop it and let
      // the next claim (ours or anyone's) start a session that can be reached.
      await releaseSessionHeldBy(id, held.ownerAddress);
      continue;
    }
    return { owner: "remote", address: held.ownerAddress };
  }
  return { owner: "self" };
}

/** Give up a session's lease. Only ever our own — another pod's is not ours to drop. */
export async function releaseSession(kind: string, key: string): Promise<void> {
  const me = relayAddress();
  if (!me) return;
  const id = rowId(kind, key);
  heartbeats.delete(id);
  await db
    .delete(replicaSessionOwners)
    .where(and(eq(replicaSessionOwners.id, id), eq(replicaSessionOwners.ownerAddress, me)))
    .catch((error: unknown) => {
      // Losing a lease row is recoverable — it expires — and this runs on
      // teardown paths that must not throw.
      console.warn(`[relay] could not release ${id}:`, error);
    });
}

/** Drop a specific pod's lease, used only when its address is unroutable. */
async function releaseSessionHeldBy(id: string, address: string): Promise<void> {
  await db
    .delete(replicaSessionOwners)
    .where(and(eq(replicaSessionOwners.id, id), eq(replicaSessionOwners.ownerAddress, address)))
    .catch(() => {
      /* another pod got there first, which is the same outcome */
    });
}

/**
 * Drop a lease we could not reach, so the next call can start a session that
 * works. Guarded on the address, so a lease that moved on in the meantime is
 * left alone.
 */
export async function releaseUnreachable(
  kind: string,
  key: string,
  address: string,
): Promise<void> {
  await releaseSessionHeldBy(rowId(kind, key), address);
}

const heartbeats = new Map<string, number>();

function markHeartbeat(id: string): void {
  heartbeats.set(id, Date.now());
}

/**
 * Say the session is still alive, at most once per {@link HEARTBEAT_EVERY_MS}.
 *
 * Throttled because a lease only has to prove liveness: an agent's
 * screenshot-click loop would otherwise write on every call for nothing.
 */
export async function touchSession(kind: string, key: string): Promise<void> {
  const me = relayAddress();
  if (!me) return;
  const id = rowId(kind, key);
  const last = heartbeats.get(id) ?? 0;
  if (Date.now() - last < HEARTBEAT_EVERY_MS) return;
  markHeartbeat(id);
  await db
    .update(replicaSessionOwners)
    .set({ heartbeatAt: new Date() })
    .where(and(eq(replicaSessionOwners.id, id), eq(replicaSessionOwners.ownerAddress, me)))
    .catch((error: unknown) => {
      console.warn(`[relay] heartbeat for ${id} failed:`, error);
    });
}

export interface RelayCall {
  kind: string;
  key: string;
  op: string;
  payload: Record<string, unknown>;
}

/** Constant-time comparison of the shared secret, from a `Bearer …` header. */
export function verifyRelaySecret(header: string | undefined): boolean {
  const expected = relaySecret();
  if (!expected) return false;
  const offered = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!offered) return false;
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Run a call on the pod that holds the session.
 *
 * A transport failure and a failure *of the operation* are deliberately
 * different types: the first means the owner is gone and the lease should be
 * dropped so somebody can start again, the second means the owner is fine and
 * the answer is simply "no".
 */
export async function forwardToOwner<T>(address: string, call: RelayCall): Promise<T> {
  const secret = relaySecret();
  if (!secret) throw new RelayUnreachableError(address, new Error("no relay secret configured"));
  if (!isForwardableAddress(address)) {
    throw new RelayUnreachableError(address, new Error("address is not a private pod address"));
  }

  let response: Response;
  try {
    response = await fetch(`http://${address}${RELAY_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(call),
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new RelayUnreachableError(address, error);
  }

  // 502/503/504 are the shapes a pod mid-termination produces, and they mean
  // the same thing as a refused connection: this owner is gone.
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    throw new RelayUnreachableError(address, new Error(`owner returned ${response.status}`));
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `the replica holding this session answered ${response.status}`;
    // A session the owner no longer has is not an error to report onward — it
    // is a stale lease, and the caller should be free to take over.
    if (response.status === 409) throw new RelayUnreachableError(address, new Error(message));
    throw new RelayRemoteError(message);
  }
  return body as T;
}
