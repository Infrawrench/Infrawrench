/**
 * The pure half of leak attribution: which plugin owns a token type, and
 * which of the things Infrawrench stores a fingerprint points at. No
 * database, no decryption, no secrets: the caller hands in fingerprints and
 * the index of fingerprints it built, so every rule here is unit-testable.
 */
import type { CredentialField, TokenFormatDeclaration } from "@infrawrench/plugin-base";

export interface TokenOwner {
  pluginId: string;
  pluginName: string;
  format: TokenFormatDeclaration;
}

export interface TokenFormatIndex {
  byType: Map<string, TokenOwner>;
  /** Longest prefix first, so `sk-ant-` wins over `sk-`. */
  prefixes: Array<{ prefix: string; owner: TokenOwner }>;
}

interface PluginLike {
  manifest: {
    id: string;
    displayName: string;
    tokenFormats?: TokenFormatDeclaration[] | undefined;
    credentialFields: CredentialField[];
  };
}

export function indexTokenFormats(plugins: readonly PluginLike[]): TokenFormatIndex {
  const byType = new Map<string, TokenOwner>();
  const prefixes: TokenFormatIndex["prefixes"] = [];
  for (const { manifest } of plugins) {
    for (const format of manifest.tokenFormats ?? []) {
      const owner = { pluginId: manifest.id, pluginName: manifest.displayName, format };
      for (const t of format.scannerTypes) {
        const key = t.trim().toLowerCase();
        // First declaration wins: registry order is stable, and two plugins
        // claiming one identifier is a manifest bug the test suite catches.
        if (!byType.has(key)) byType.set(key, owner);
      }
      for (const prefix of format.prefixes ?? []) prefixes.push({ prefix, owner });
    }
  }
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
  return { byType, prefixes };
}

/**
 * The plugin that issues this token: by the scanner's identifier, else by the
 * raw value's prefix (checked here, in memory, and nowhere else).
 */
export function resolveTokenOwner(
  index: TokenFormatIndex,
  tokenType: string,
  secret?: string,
): TokenOwner | null {
  const byType = index.byType.get(tokenType.trim().toLowerCase());
  if (byType) return byType;
  if (secret) {
    const value = secret.trim();
    for (const { prefix, owner } of index.prefixes) {
      if (value.startsWith(prefix)) return owner;
    }
  }
  return null;
}

/** The credential fields of a plugin worth fingerprinting. */
export function fingerprintableFields(manifest: PluginLike["manifest"]): string[] {
  const keys = new Set<string>();
  for (const f of manifest.credentialFields) if (f.sensitive) keys.add(f.key);
  for (const format of manifest.tokenFormats ?? []) {
    for (const k of format.credentialFields ?? []) keys.add(k);
  }
  return [...keys];
}

/** Something Infrawrench stores whose value a fingerprint was taken of. */
export type StoredSecretRef =
  | { kind: "account"; accountId: string; pluginId: string; fieldKey: string }
  | {
      kind: "secret-field";
      accountId: string;
      pluginId: string;
      resourceId: string;
      resourceTypeId: string;
      fieldKey: string;
    }
  | {
      /** A cached output another resource references: the *source* is named here. */
      kind: "output";
      accountId: string;
      pluginId: string;
      resourceId: string;
      resourceTypeId: string;
      fieldKey: string;
    };

export type StoredSecretIndex = Map<string, StoredSecretRef[]>;

export interface LeakMatch {
  matchKind: "account" | "secret-field" | "output" | "none";
  matchConfidence: "fingerprint" | "token-type" | "none";
  matchedAccountId: string | null;
  matchedResourceId: string | null;
  matchedResourceTypeId: string | null;
  matchedPluginId: string | null;
  matchedFieldKey: string | null;
  candidateAccountIds: string[];
}

const NO_MATCH: LeakMatch = {
  matchKind: "none",
  matchConfidence: "none",
  matchedAccountId: null,
  matchedResourceId: null,
  matchedResourceTypeId: null,
  matchedPluginId: null,
  matchedFieldKey: null,
  candidateAccountIds: [],
};

/** Account credentials first, then a referenced output (rotating it fixes every consumer), then a stored literal. */
const KIND_RANK: Record<StoredSecretRef["kind"], number> = {
  account: 0,
  output: 1,
  "secret-field": 2,
};

/**
 * Attribute a leak.
 *
 * - With a fingerprint, only a byte-for-byte match counts. A fingerprint that
 *   matches nothing means the leaked token is *not* one Infrawrench holds,
 *   even when the org has accounts on the owning provider, so no candidates
 *   are offered: suggesting the account would invite rotating the wrong key.
 * - Without one (the scanner withholds values), the owner's accounts are the
 *   candidates; exactly one becomes the match, at `token-type` confidence.
 */
export function matchLeak(input: {
  fingerprint: string | null;
  index: StoredSecretIndex;
  owner: TokenOwner | null;
  /** The org's live accounts by plugin id. */
  accountsByPlugin: ReadonlyMap<string, readonly string[]>;
}): LeakMatch {
  if (input.fingerprint) {
    const refs = input.index.get(input.fingerprint);
    if (!refs || refs.length === 0) return NO_MATCH;
    const best = [...refs].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind])[0]!;
    return {
      matchKind: best.kind,
      matchConfidence: "fingerprint",
      matchedAccountId: best.accountId,
      matchedResourceId: best.kind === "account" ? null : best.resourceId,
      matchedResourceTypeId: best.kind === "account" ? null : best.resourceTypeId,
      matchedPluginId: best.pluginId,
      matchedFieldKey: best.fieldKey,
      candidateAccountIds: [],
    };
  }
  if (!input.owner) return NO_MATCH;
  const candidates = [...(input.accountsByPlugin.get(input.owner.pluginId) ?? [])];
  if (candidates.length === 0) return NO_MATCH;
  if (candidates.length === 1) {
    const fields = input.owner.format.credentialFields;
    return {
      ...NO_MATCH,
      matchKind: "account",
      matchConfidence: "token-type",
      matchedAccountId: candidates[0]!,
      matchedPluginId: input.owner.pluginId,
      matchedFieldKey: fields && fields.length === 1 ? fields[0]! : null,
    };
  }
  return { ...NO_MATCH, matchConfidence: "token-type", candidateAccountIds: candidates };
}
