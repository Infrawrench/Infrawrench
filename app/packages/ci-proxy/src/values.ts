// Secrets and variables, set per organisation or per repository and handed
// to the runners with each run. Variables are stored as written. Secrets are
// sealed with AES-GCM under SECRETS_KEY, with their kind, owner, repository
// and name as associated data, so a stored value cannot be moved to another
// name or repository; they are never returned by the API, only their names.

import type { D1Database } from "@cloudflare/workers-types/index";

export type Kind = "secret" | "var";

/** The AES-GCM key secrets are sealed with (what `importKey` gives back). */
export type SecretsKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export interface StoredValue {
  name: string;
  /** Plain text for a variable; sealed for a secret. */
  value: string;
  updatedAt: number;
}

/** The most values one organisation or repository may set, per kind. */
export const MAX_PER_SCOPE = 100;
/** The largest one value may be; the runner refuses more. */
export const MAX_VALUE_BYTES = 48 << 10;

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function isName(name: string): boolean {
  return NAME.test(name);
}

export interface ValueStore {
  /** `repoId` is `""` for the organisation's own. */
  list(kind: Kind, owner: string, repoId: string): Promise<StoredValue[]>;
  /** False when the scope is full and `name` is new. */
  put(
    kind: Kind,
    owner: string,
    repoId: string,
    name: string,
    value: string,
    now: number,
  ): Promise<boolean>;
  remove(kind: Kind, owner: string, repoId: string, name: string): Promise<boolean>;
}

interface Row {
  name: string;
  value: string;
  updated_at: number;
}

export class D1Values implements ValueStore {
  constructor(private readonly db: D1Database) {}

  async list(kind: Kind, owner: string, repoId: string): Promise<StoredValue[]> {
    const { results } = await this.db
      .prepare(
        "SELECT name, value, updated_at FROM named_values WHERE kind = ? AND owner = ? AND repo_id = ? ORDER BY name",
      )
      .bind(kind, owner, repoId)
      .all<Row>();
    return results.map((r) => ({ name: r.name, value: r.value, updatedAt: r.updated_at }));
  }

  async put(
    kind: Kind,
    owner: string,
    repoId: string,
    name: string,
    value: string,
    now: number,
  ): Promise<boolean> {
    // One statement, so two writers cannot both slip under the limit: it
    // inserts only while the scope has room, and always updates in place.
    const result = await this.db
      .prepare(
        `INSERT INTO named_values (kind, owner, repo_id, name, value, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE EXISTS (SELECT 1 FROM named_values WHERE kind = ?1 AND owner = ?2 AND repo_id = ?3 AND name = ?4)
            OR (SELECT COUNT(*) FROM named_values WHERE kind = ?1 AND owner = ?2 AND repo_id = ?3) < ?7
         ON CONFLICT (kind, owner, repo_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(kind, owner, repoId, name, value, now, MAX_PER_SCOPE)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async remove(kind: Kind, owner: string, repoId: string, name: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM named_values WHERE kind = ? AND owner = ? AND repo_id = ? AND name = ?")
      .bind(kind, owner, repoId, name)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}

export class MemoryValues implements ValueStore {
  rows = new Map<string, StoredValue>();

  private scope(kind: Kind, owner: string, repoId: string): string {
    return `${kind}\n${owner}\n${repoId}\n`;
  }

  async list(kind: Kind, owner: string, repoId: string): Promise<StoredValue[]> {
    const prefix = this.scope(kind, owner, repoId);
    return [...this.rows.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v)
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async put(
    kind: Kind,
    owner: string,
    repoId: string,
    name: string,
    value: string,
    now: number,
  ): Promise<boolean> {
    const key = this.scope(kind, owner, repoId) + name;
    if (!this.rows.has(key) && (await this.list(kind, owner, repoId)).length >= MAX_PER_SCOPE)
      return false;
    this.rows.set(key, { name, value, updatedAt: now });
    return true;
  }

  async remove(kind: Kind, owner: string, repoId: string, name: string): Promise<boolean> {
    return this.rows.delete(this.scope(kind, owner, repoId) + name);
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The AES-GCM key from SECRETS_KEY (32 bytes, base64), or `null` if unset or malformed. */
export async function secretsKey(base64: string | undefined): Promise<SecretsKey | null> {
  if (!base64) return null;
  let raw: Uint8Array;
  try {
    raw = fromBase64(base64.trim());
  } catch {
    return null;
  }
  if (raw.length !== 32) return null;
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function associated(owner: string, repoId: string, name: string): Uint8Array {
  return new TextEncoder().encode(`secret\n${owner}\n${repoId}\n${name}`);
}

export async function seal(
  key: SecretsKey,
  owner: string,
  repoId: string,
  name: string,
  value: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associated(owner, repoId, name) },
    key,
    new TextEncoder().encode(value),
  );
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
}

/** The secret's value, or `null` when it cannot be opened (wrong key, moved row). */
export async function open(
  key: SecretsKey,
  owner: string,
  repoId: string,
  name: string,
  sealed: string,
): Promise<string | null> {
  const [version, iv, data] = sealed.split(".");
  if (version !== "v1" || !iv || !data) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv), additionalData: associated(owner, repoId, name) },
      key,
      fromBase64(data),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export interface RunValues {
  vars: Record<string, string>;
  secrets: Record<string, string>;
  /** Secrets that are stored but could not be opened. */
  unreadable: string[];
}

/**
 * The variables and (when `withSecrets`) secrets a run of `owner`'s
 * `repoId` gets: the organisation's, overridden by the repository's.
 */
export async function forRun(
  store: ValueStore,
  key: SecretsKey | null,
  owner: string,
  repoId: string,
  withSecrets: boolean,
): Promise<RunValues> {
  const out: RunValues = { vars: {}, secrets: {}, unreadable: [] };
  for (const scope of ["", repoId]) {
    for (const v of await store.list("var", owner, scope)) out.vars[v.name] = v.value;
    if (!withSecrets || key === null) continue;
    for (const s of await store.list("secret", owner, scope)) {
      const value = await open(key, owner, scope, s.name, s.value);
      if (value === null) out.unreadable.push(s.name);
      else out.secrets[s.name] = value;
    }
  }
  return out;
}
