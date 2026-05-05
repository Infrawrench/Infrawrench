/**
 * Shared client-side TypeScript types for API responses.
 *
 * These mirror the response shape produced by the server routes — if you
 * change the shape on the server, update these types too.
 */

/**
 * An SSH key entry as returned by `GET /api/org/:orgId/ssh-keys`.
 * Mirrors the full shape produced by `app/packages/web/src/api/routes/ssh-keys.ts`.
 * Components that only need a subset can `Pick<SshKey, ...>`.
 */
export interface SshKey {
  id: string;
  name: string;
  keyType: string;
  isImported: boolean;
  fingerprint: string | null;
  publicKey: string;
  userId: string;
  ownerEmail: string;
  ownerName: string;
  createdAt: string;
}
