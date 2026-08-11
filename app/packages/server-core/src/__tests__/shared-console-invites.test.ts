/**
 * The invite token: what it is, what it is not, and what it must never accept.
 *
 * Worth testing separately from the join rules because the token is the part
 * of this feature that leaves the building — it gets pasted into chat, into a
 * ticket, into somebody's notes — and a parser that is lax about its shape is
 * how a share id ends up in an error message that tells an outsider which
 * sessions exist.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_INVITE_TTL_MINUTES,
  MAX_INVITE_TTL_MINUTES,
  MIN_INVITE_TTL_MINUTES,
  hashInviteSecret,
  mintInvite,
  parseInviteToken,
} from "../shared-console/invites";

const SHARE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const NOW = new Date("2026-08-11T12:00:00Z");

describe("mintInvite", () => {
  it("produces a token that parses back to the share it was minted for", () => {
    const invite = mintInvite(SHARE_ID, 15, NOW);
    expect(parseInviteToken(invite.token)).toEqual({
      shareId: SHARE_ID,
      secret: invite.token.slice(SHARE_ID.length + 1),
    });
  });

  it("stores only a digest — the token itself is never recoverable from it", () => {
    const invite = mintInvite(SHARE_ID, 15, NOW);
    const secret = invite.token.slice(SHARE_ID.length + 1);
    expect(invite.hash).toBe(hashInviteSecret(secret));
    expect(invite.hash).not.toContain(secret);
    expect(invite.hash).toHaveLength(64);
  });

  it("mints a different secret every time", () => {
    const a = mintInvite(SHARE_ID, 15, NOW);
    const b = mintInvite(SHARE_ID, 15, NOW);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });

  it("clamps the TTL to the documented bounds rather than honouring the caller", () => {
    expect(mintInvite(SHARE_ID, 100_000, NOW).expiresAt.getTime()).toBe(
      NOW.getTime() + MAX_INVITE_TTL_MINUTES * 60_000,
    );
    expect(mintInvite(SHARE_ID, -5, NOW).expiresAt.getTime()).toBe(
      NOW.getTime() + MIN_INVITE_TTL_MINUTES * 60_000,
    );
  });

  it("falls back to the default rather than NaN when handed nonsense", () => {
    expect(mintInvite(SHARE_ID, Number.NaN, NOW).expiresAt.getTime()).toBe(
      NOW.getTime() + DEFAULT_INVITE_TTL_MINUTES * 60_000,
    );
  });
});

describe("parseInviteToken", () => {
  const secret = "a".repeat(64);

  it("rejects anything that is not <uuid>.<64 hex>", () => {
    for (const bad of [
      "",
      ".",
      SHARE_ID,
      `${SHARE_ID}.`,
      `.${secret}`,
      `not-a-uuid.${secret}`,
      `${SHARE_ID}.${"a".repeat(63)}`,
      `${SHARE_ID}.${"z".repeat(64)}`,
      // A path traversal or an injected separator must not survive parsing.
      `../../${SHARE_ID}.${secret}`,
      `${SHARE_ID}/${secret}`,
    ]) {
      expect(parseInviteToken(bad), bad).toBeNull();
    }
  });

  it("splits on the first dot, so a secret is never truncated by one", () => {
    const parsed = parseInviteToken(`${SHARE_ID}.${secret}`);
    expect(parsed?.secret).toBe(secret);
  });

  it("accepts either case in the hex halves", () => {
    expect(parseInviteToken(`${SHARE_ID.toUpperCase()}.${"A".repeat(64)}`)).not.toBeNull();
  });
});
