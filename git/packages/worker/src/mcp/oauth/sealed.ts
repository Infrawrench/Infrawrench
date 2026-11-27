/**
 * The values the authorization server hands out and takes back without
 * keeping a row for them: a registered client's id, the consent form's
 * request, an authorization code, a refresh token.
 *
 * Each is sealed with the session cookie's own construction
 * (`auth/session-cookie.ts`: AES-256-GCM under a key derived per value from
 * `WORKOS_COOKIE_PASSWORD`), so nobody else can make or read one. What keeps
 * one kind from being presented as another, or as a session, is the purpose
 * sealed inside it: a value opens only as the purpose it was sealed for.
 */
import { seal, unseal } from "../../auth/session-cookie";

export type SealedPurpose = "client" | "consent" | "code" | "refresh";

interface Envelope {
  /** The purpose. */
  readonly p: string;
  /** The value. */
  readonly v: unknown;
  /** When it stops opening, in milliseconds since the epoch. Absent: never. */
  readonly e?: number;
}

const tag = (purpose: SealedPurpose): string => `mcp-oauth:${purpose}`;

export const sealAs = (
  purpose: SealedPurpose,
  value: unknown,
  password: string,
  expiresAt?: number,
): Promise<string> =>
  seal(
    {
      p: tag(purpose),
      v: value,
      ...(expiresAt === undefined ? {} : { e: expiresAt }),
    } satisfies Envelope,
    password,
  );

/**
 * What was sealed for `purpose`, or null: not ours, sealed for something
 * else, or past its time. The caller checks the value's own shape.
 */
export const unsealAs = async (
  purpose: SealedPurpose,
  sealed: string,
  password: string,
  now: number = Date.now(),
): Promise<unknown> => {
  // Nothing we seal is longer; do not derive a key for a megabyte of noise.
  if (sealed.length > 8192) return null;
  const opened = await unseal(sealed, password);
  if (typeof opened !== "object" || opened === null) return null;
  const envelope = opened as Partial<Envelope>;
  if (envelope.p !== tag(purpose)) return null;
  if (envelope.e !== undefined && (typeof envelope.e !== "number" || envelope.e <= now)) {
    return null;
  }
  return envelope.v ?? null;
};
