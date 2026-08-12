/**
 * Minting and parsing shared-console invite links.
 *
 * Pure but for `node:crypto` — no database — so the token format can be tested
 * on its own. That matters more here than it looks: the token is the one part
 * of this feature a user copies into a chat window, and every property it has
 * (what is stored, what is guessable, how long it lives) is decided in this
 * file rather than at the call site.
 *
 * The format is `<shareId>.<64 hex chars>`. Two halves because a join URL has
 * to resolve to a share *before* the secret is checked — the join screen has
 * to say "you are about to watch root@db-prod-1" — and threading a second
 * query parameter through a link people paste by hand is a way to lose it. The
 * id half is not secret; the secret half is 256 bits of `randomBytes` and is
 * never stored, only its sha256.
 */
import { createHash, randomBytes } from "node:crypto";

/**
 * How long an invite link is good for by default.
 *
 * Short because the link's whole job is to get somebody who is already on a
 * call with you into the session that is happening now. An invite still live
 * tomorrow outlived the conversation that produced it, and the session it
 * points at is long gone anyway.
 */
export const DEFAULT_INVITE_TTL_MINUTES = 15;
export const MIN_INVITE_TTL_MINUTES = 1;
export const MAX_INVITE_TTL_MINUTES = 120;

/** A freshly minted invite: the token to hand out once, and the digest to keep. */
export interface MintedInvite {
  token: string;
  hash: string;
  /** First few characters of the secret, so the UI can name the live invite. */
  prefix: string;
  expiresAt: Date;
}

export function hashInviteSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Split `<shareId>.<secret>`; null when the string is not that shape.
 *
 * Strict on both halves on purpose. A caller that has to distinguish "not a
 * token" from "a token for a share that does not exist" would end up with an
 * error message that tells an outsider which share ids are real, and the
 * shapes are cheap to check.
 */
export function parseInviteToken(token: string): { shareId: string; secret: string } | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const shareId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shareId)) return null;
  if (!/^[0-9a-f]{64}$/i.test(secret)) return null;
  return { shareId, secret };
}

/** Mint an invite for `shareId`, clamping the TTL to the documented bounds. */
export function mintInvite(shareId: string, ttlMinutes: number, now: Date): MintedInvite {
  const requested = Math.trunc(ttlMinutes);
  const minutes = Number.isFinite(requested)
    ? Math.min(MAX_INVITE_TTL_MINUTES, Math.max(MIN_INVITE_TTL_MINUTES, requested))
    : DEFAULT_INVITE_TTL_MINUTES;
  const secret = randomBytes(32).toString("hex");
  return {
    token: `${shareId}.${secret}`,
    hash: hashInviteSecret(secret),
    prefix: secret.slice(0, 6),
    expiresAt: new Date(now.getTime() + minutes * 60_000),
  };
}
