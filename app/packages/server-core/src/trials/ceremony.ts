/**
 * Agent registration and the claim ceremony.
 *
 * **We own the ceremony, and issue our own credential.** The auth.md
 * application spec is explicit that the *service* owns the claim state machine
 * — minting the `user_code`, serving the verification page, matching the user
 * to an account — and that is the half no identity provider can do for you.
 * What WorkOS would additionally provide is the credential itself, and this
 * module does not wait for it: registrations here authenticate with an `iwa_`
 * token hashed exactly like `api_keys.hashed_key`.
 *
 * That choice is reversible by design rather than by accident. `resolveAgentPrincipal`
 * keys on the registration id, not on how the bearer proved it — so a WorkOS
 * agent token whose `sub` is this row's id resolves to the same principal with
 * the same permissions, and `hashedCredential` simply stays null for those. The
 * two can coexist; nothing here has to be unwound to adopt the other.
 *
 * The ceremony is RFC 8628-shaped (device authorization):
 *
 *  1. the agent registers and gets a credential plus a trial org;
 *  2. the agent asks to be claimed and gets a `user_code` and a URL;
 *  3. it shows both to its user, who signs in and confirms on our page;
 *  4. the agent's next poll sees `claimed: true`.
 *
 * The code travels agent → human, never by email. We have no address for an
 * anonymous registration, and mailing a code to an address the *agent* supplied
 * would let an agent claim a workspace into somebody else's inbox.
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { and, count, eq, gte, isNull } from "drizzle-orm";

import { db } from "../db/client.js";
import { agentAuthRegistrations } from "../db/schema.js";
import { keyedHash } from "../encryption.js";
import { createTrialOrg, type TrialOrg } from "./create.js";

/** Domain label for HMAC sub-key derivation. Distinct from the API-key domain. */
const AGENT_CREDENTIAL_HASH_DOMAIN = "agent-credential";
const AGENT_CLAIM_CODE_HASH_DOMAIN = "agent-claim-code";

/** How long a `user_code` stays valid. */
export const CLAIM_CODE_TTL_MS = 15 * 60 * 1000;

/**
 * The `user_code` alphabet and length.
 *
 * Eight characters from an unambiguous 32-symbol alphabet — no I, L, O or U, so
 * nothing is lost reading a code aloud or retyping it from a terminal. That is
 * 32^8 ≈ 1.1 × 10¹² possibilities.
 *
 * The size is doing real work. A code is submitted to a page that looks it up
 * *globally* — the human confirming has no registration id to scope the search
 * to — so a guessable code is a way to bind somebody else's agent, and their
 * cloud accounts, to your own account. A 6-digit numeric code (a million
 * possibilities, the shape RFC 8628 suggests for TV sign-in) is not enough for
 * that threat: device flows can scope guesses to a device the attacker already
 * holds, and this cannot. The per-user submission limit in the route handles
 * targeted grinding; this handles blind search.
 */
const CLAIM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";
const CLAIM_CODE_LENGTH = 8;

/**
 * Anonymous registrations allowed from one IP per hour.
 *
 * Each one is a free paid-tier organization, so this is the tap that has to be
 * closed. WorkOS's own published guidance for anonymous agent registration is
 * 5/hour per IP; matching it is a reasonable default, and it is intentionally
 * low enough to be felt — an agent developer registering in a loop should hit
 * this and read the message, not discover it at the invoice.
 */
export const REGISTRATIONS_PER_IP_PER_HOUR = 5;

/** Global ceiling across every IP, as a kill switch for a distributed flood. */
export const GLOBAL_REGISTRATIONS_PER_HOUR = Number(
  process.env["AGENT_TRIAL_GLOBAL_HOURLY_LIMIT"] ?? 500,
);

export class RegistrationRateLimitedError extends Error {
  status = 429;
  constructor(message: string) {
    super(message);
    this.name = "RegistrationRateLimitedError";
  }
}

export class ClaimCeremonyError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.name = "ClaimCeremonyError";
  }
}

/** `iwa_` + 32 random bytes, base64url. Shown once, stored only as an HMAC. */
function mintCredential(): { token: string; prefix: string } {
  const token = `iwa_${randomBytes(32).toString("base64url")}`;
  return { token, prefix: token.slice(0, 8) };
}

/**
 * Mint a `user_code`.
 *
 * `randomInt` rather than `Math.random`: this is a bearer secret for the length
 * of the ceremony, and a predictable one is the same as no ceremony at all.
 * Rejection-free because the alphabet is exactly 32 symbols.
 */
function mintClaimCode(): string {
  let out = "";
  for (let i = 0; i < CLAIM_CODE_LENGTH; i++) {
    out += CLAIM_CODE_ALPHABET[randomInt(0, CLAIM_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Strip formatting and normalise case, so `k7mp-2q9x` and `K7MP2Q9X` are the
 * same code. Returns null when what is left cannot be a code at all.
 */
export function normalizeClaimCode(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== CLAIM_CODE_LENGTH) return null;
  for (const ch of cleaned) {
    if (!CLAIM_CODE_ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}

/** Group as `XXXX-XXXX` for display. Purely cosmetic; input is normalised. */
export function formatClaimCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

async function assertRegistrationAllowed(ip: string | null): Promise<void> {
  const since = new Date(Date.now() - 60 * 60 * 1000);

  const [global] = await db
    .select({ n: count() })
    .from(agentAuthRegistrations)
    .where(gte(agentAuthRegistrations.createdAt, since));
  if ((global?.n ?? 0) >= GLOBAL_REGISTRATIONS_PER_HOUR) {
    throw new RegistrationRateLimitedError(
      "Trial registrations are temporarily paused. Try again later.",
    );
  }

  // No IP is not a free pass, but it cannot be counted per-IP either; the
  // global ceiling above is what covers it.
  if (!ip) return;

  const [perIp] = await db
    .select({ n: count() })
    .from(agentAuthRegistrations)
    .where(
      and(
        eq(agentAuthRegistrations.createdFromIp, ip),
        gte(agentAuthRegistrations.createdAt, since),
      ),
    );
  if ((perIp?.n ?? 0) >= REGISTRATIONS_PER_IP_PER_HOUR) {
    throw new RegistrationRateLimitedError(
      `A maximum of ${REGISTRATIONS_PER_IP_PER_HOUR} trial workspaces can be opened per hour ` +
        `from one address. Claim an existing workspace to keep using it.`,
    );
  }
}

export interface RegisterAgentOptions {
  label?: string;
  /** Source address, for the per-IP limit. */
  ip?: string | null;
}

export interface RegisteredAgent {
  registrationId: string;
  /** Plaintext credential. Returned once, never recoverable. */
  credential: string;
  organizationId: string;
  trialExpiresAt: Date;
}

/**
 * Open an anonymous registration and the trial org behind it.
 *
 * Rate-limited before anything is created — the limit exists to stop orgs being
 * created, so checking after would be a limit on nothing.
 */
export async function registerAnonymousAgent(
  options: RegisterAgentOptions = {},
): Promise<RegisteredAgent> {
  await assertRegistrationAllowed(options.ip ?? null);

  const registrationId = randomUUID();
  const { token, prefix } = mintCredential();

  let trial: TrialOrg;
  try {
    trial = await createTrialOrg({
      registrationId,
      ...(options.label ? { label: options.label } : {}),
    });
  } catch (e) {
    throw new Error(`could not open a trial workspace: ${e instanceof Error ? e.message : e}`);
  }

  await db
    .update(agentAuthRegistrations)
    .set({
      hashedCredential: await keyedHash(token, AGENT_CREDENTIAL_HASH_DOMAIN),
      credentialPrefix: prefix,
      createdFromIp: options.ip ?? null,
    })
    .where(eq(agentAuthRegistrations.id, registrationId));

  return {
    registrationId,
    credential: token,
    organizationId: trial.organizationId,
    trialExpiresAt: trial.trialExpiresAt,
  };
}

/**
 * Resolve an `iwa_` credential to its registration id, or null.
 *
 * Only the id is returned: everything about what that principal may do comes
 * from {@link resolveAgentPrincipal}, so there is exactly one place that
 * decides an agent's authority regardless of how it authenticated.
 */
export async function resolveAgentCredential(token: string): Promise<string | null> {
  if (!token.startsWith("iwa_")) return null;
  const hashed = await keyedHash(token, AGENT_CREDENTIAL_HASH_DOMAIN);
  const [row] = await db
    .select({ id: agentAuthRegistrations.id })
    .from(agentAuthRegistrations)
    .where(
      and(
        eq(agentAuthRegistrations.hashedCredential, hashed),
        isNull(agentAuthRegistrations.revokedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

export interface StartedClaim {
  userCode: string;
  expiresAt: Date;
}

/**
 * Mint a `user_code` for a registration, replacing any code already in flight.
 *
 * Replacing rather than refusing is deliberate: an agent whose user lost the
 * code should be able to ask again without waiting out a TTL, and the old code
 * stops working the moment the new one is issued.
 */
export async function startClaimCeremony(registrationId: string): Promise<StartedClaim> {
  const [row] = await db
    .select({
      claimedAt: agentAuthRegistrations.claimedAt,
      revokedAt: agentAuthRegistrations.revokedAt,
    })
    .from(agentAuthRegistrations)
    .where(eq(agentAuthRegistrations.id, registrationId))
    .limit(1);
  if (!row) throw new ClaimCeremonyError("Unknown registration.", 404);
  if (row.revokedAt) throw new ClaimCeremonyError("This registration has been revoked.", 403);
  if (row.claimedAt) throw new ClaimCeremonyError("This registration is already claimed.");

  const userCode = mintClaimCode();
  const expiresAt = new Date(Date.now() + CLAIM_CODE_TTL_MS);
  await db
    .update(agentAuthRegistrations)
    .set({
      hashedClaimCode: await keyedHash(userCode, AGENT_CLAIM_CODE_HASH_DOMAIN),
      claimCodeExpiresAt: expiresAt,
    })
    .where(eq(agentAuthRegistrations.id, registrationId));

  return { userCode, expiresAt };
}

/**
 * Find the registration an in-flight `user_code` belongs to.
 *
 * Only ever called from the claim page *after* the human has authenticated, and
 * behind that route's per-user submission limit. Both matter: the lookup is
 * global, so without them a code is the only thing standing between a stranger
 * and somebody else's cloud accounts.
 *
 * The code is compared as an HMAC, so the stored value is not usable if the
 * table leaks, and the comparison happens in the index rather than in JS.
 */
export async function resolveClaimCode(userCode: string): Promise<string> {
  const normalized = normalizeClaimCode(userCode);
  if (!normalized) {
    throw new ClaimCeremonyError("That code doesn't look right. Ask your agent for a new one.");
  }
  const hashed = await keyedHash(normalized, AGENT_CLAIM_CODE_HASH_DOMAIN);

  const [match] = await db
    .select({
      id: agentAuthRegistrations.id,
      claimCodeExpiresAt: agentAuthRegistrations.claimCodeExpiresAt,
    })
    .from(agentAuthRegistrations)
    .where(
      and(
        eq(agentAuthRegistrations.hashedClaimCode, hashed),
        isNull(agentAuthRegistrations.claimedAt),
        isNull(agentAuthRegistrations.revokedAt),
      ),
    )
    .limit(1);

  if (!match) {
    throw new ClaimCeremonyError("That code is not valid. Ask your agent for a new one.");
  }
  if (!match.claimCodeExpiresAt || match.claimCodeExpiresAt < new Date()) {
    throw new ClaimCeremonyError("That code has expired. Ask your agent for a new one.");
  }
  return match.id;
}

/** Destroy an in-flight code, leaving the registration itself untouched. */
export async function clearClaimCode(registrationId: string): Promise<void> {
  await db
    .update(agentAuthRegistrations)
    .set({ hashedClaimCode: null, claimCodeExpiresAt: null })
    .where(eq(agentAuthRegistrations.id, registrationId));
}

export interface ClaimStatus {
  claimed: boolean;
  organizationId: string;
  /** Milliseconds until the trial org is destroyed; null once claimed. */
  trialExpiresInMs: number | null;
  /** Whether a `user_code` is currently outstanding. */
  claimPending: boolean;
}

/** What the agent polls for — the whole point of the ceremony from its side. */
export async function getClaimStatus(registrationId: string): Promise<ClaimStatus | null> {
  const [row] = await db
    .select({
      organizationId: agentAuthRegistrations.organizationId,
      claimedAt: agentAuthRegistrations.claimedAt,
      claimCodeExpiresAt: agentAuthRegistrations.claimCodeExpiresAt,
    })
    .from(agentAuthRegistrations)
    .where(eq(agentAuthRegistrations.id, registrationId))
    .limit(1);
  if (!row) return null;

  const { trialTimeRemainingMs } = await import("./create.js");
  const remaining = await trialTimeRemainingMs(row.organizationId);

  return {
    claimed: row.claimedAt !== null,
    organizationId: row.organizationId,
    trialExpiresInMs: remaining,
    claimPending: row.claimCodeExpiresAt !== null && row.claimCodeExpiresAt > new Date(),
  };
}

/** Revoke a registration. Its credential stops working on the next request. */
export async function revokeAgentRegistration(registrationId: string): Promise<boolean> {
  const rows = await db
    .update(agentAuthRegistrations)
    .set({ revokedAt: new Date(), hashedClaimCode: null, claimCodeExpiresAt: null })
    .where(
      and(eq(agentAuthRegistrations.id, registrationId), isNull(agentAuthRegistrations.revokedAt)),
    )
    .returning({ id: agentAuthRegistrations.id });
  return rows.length > 0;
}
