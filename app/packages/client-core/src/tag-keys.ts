/**
 * Tag key management: which tag keys an org hides from its pickers and which
 * it pins to the top of them.
 *
 * Cloud bills arrive carrying dozens of keys nobody groups by
 * (`aws:cloudformation:stack-id`, `aws:autoscaling:groupName`,
 * `goog-k8s-cluster-location`…), and the two or three keys a team actually
 * reports on (`team`, `env`, `cost-centre`) end up buried alphabetically
 * between them. This is a display preference, nothing more: a hidden key is
 * still stored, still in every export, and a query naming it still runs. Only
 * the lists a person picks from change.
 *
 * Pure and dependency-free, so the server (which applies the preferences to
 * every tag-key listing), the settings editor (which previews them), the CLI
 * and mobile all agree on what a pattern matches.
 */
import type { CostDimensionOption } from "./costs";

/** The org's tag key preferences (`GET/PUT /tag-keys/settings`). */
export interface TagKeySettings {
  /**
   * Keys to leave out of pickers. Each entry is either an exact key (`Name`)
   * or a prefix pattern ending in a single `*` (`aws:cloudformation:*`).
   * Matching is case-sensitive, because providers treat `Env` and `env` as two
   * different keys and so does the cost data.
   */
  hidden: string[];
  /**
   * Exact keys pinned to the top of every picker, in this order. A key cannot
   * be both preferred and hidden.
   */
  preferred: string[];
}

export const DEFAULT_TAG_KEY_SETTINGS: TagKeySettings = { hidden: [], preferred: [] };

export const TAG_KEY_SETTINGS_LIMITS = {
  maxHidden: 200,
  maxPreferred: 50,
  /** Azure allows 512-character tag names, the longest of the providers. */
  maxKeyLength: 512,
} as const;

/** Where a discovered key was seen. */
export type TagKeySource = "costs" | "resources";

/** One row of `GET /tag-keys`: a key the org's data actually carries. */
export interface DiscoveredTagKey {
  key: string;
  /** Plugin ids whose cost rows or resources carry the key, sorted. */
  providers: string[];
  sources: TagKeySource[];
  /** Cost rows in the lookback window carrying the key (0 when only in inventory). */
  costRowCount: number;
  /** Distinct billed resource ids among those rows (providers that bill per resource). */
  costResourceCount: number;
  /** Resources in the synced inventory whose tags or labels carry the key. */
  inventoryCount: number;
  /** Most recent cost day carrying the key, `YYYY-MM-DD`; null when only in inventory. */
  lastSeen: string | null;
  hidden: boolean;
  /** The hidden entry that matched (an exact key or a `prefix*` pattern). */
  hiddenBy: string | null;
  preferred: boolean;
}

/** `GET /tag-keys` response. */
export interface DiscoveredTagKeysResponse {
  keys: DiscoveredTagKey[];
  settings: TagKeySettings;
  /** Days of cost data the counts cover. */
  lookbackDays: number;
  /** True when more keys exist than were returned. */
  truncated: boolean;
}

/** True when `pattern` is a prefix pattern (`aws:*`) rather than an exact key. */
export function isTagKeyPrefixPattern(pattern: string): boolean {
  return pattern.endsWith("*");
}

/**
 * Why a hidden entry is unusable, or null when it is fine. A lone `*` would
 * hide every key, and a `*` anywhere but the end is not a syntax this
 * supports; both are refused rather than silently matching something other
 * than what the person meant.
 */
export function tagKeyPatternError(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return "Pattern is empty";
  if (trimmed.length > TAG_KEY_SETTINGS_LIMITS.maxKeyLength) {
    return `Pattern is longer than ${TAG_KEY_SETTINGS_LIMITS.maxKeyLength} characters`;
  }
  if (trimmed === "*") return "A lone * would hide every tag key";
  const star = trimmed.indexOf("*");
  if (star !== -1 && star !== trimmed.length - 1) {
    return "* is only supported at the end of a pattern";
  }
  return null;
}

/** Does one hidden entry match `key`? */
export function tagKeyMatchesPattern(key: string, pattern: string): boolean {
  if (isTagKeyPrefixPattern(pattern)) return key.startsWith(pattern.slice(0, -1));
  return key === pattern;
}

/** The hidden entry that matches `key` (exact entries win over prefixes), or null. */
export function hiddenTagKeyMatch(key: string, hidden: readonly string[]): string | null {
  if (hidden.includes(key)) return key;
  for (const pattern of hidden) {
    if (isTagKeyPrefixPattern(pattern) && tagKeyMatchesPattern(key, pattern)) return pattern;
  }
  return null;
}

export function isTagKeyHidden(key: string, settings: TagKeySettings): boolean {
  // A preferred key is never hidden. The API refuses a key that is both, but a
  // prefix can still cover a preferred key (`aws:*` hidden, `aws:team`
  // preferred), and pinning one key out of a noisy family is exactly what
  // that combination asks for.
  if (settings.preferred.includes(key)) return false;
  return hiddenTagKeyMatch(key, settings.hidden) !== null;
}

/**
 * Why a settings document is invalid, or null. Run by the API (after the zod
 * shape check) and by the editor before saving, so the two refuse the same
 * documents.
 */
export function tagKeySettingsError(settings: TagKeySettings): string | null {
  if (settings.hidden.length > TAG_KEY_SETTINGS_LIMITS.maxHidden) {
    return `At most ${TAG_KEY_SETTINGS_LIMITS.maxHidden} hidden keys`;
  }
  if (settings.preferred.length > TAG_KEY_SETTINGS_LIMITS.maxPreferred) {
    return `At most ${TAG_KEY_SETTINGS_LIMITS.maxPreferred} preferred keys`;
  }
  for (const pattern of settings.hidden) {
    const error = tagKeyPatternError(pattern);
    if (error) return `${pattern}: ${error}`;
  }
  for (const key of settings.preferred) {
    if (key.trim().length === 0) return "Preferred key is empty";
    if (key.length > TAG_KEY_SETTINGS_LIMITS.maxKeyLength) {
      return `${key}: longer than ${TAG_KEY_SETTINGS_LIMITS.maxKeyLength} characters`;
    }
    if (key.includes("*")) return `${key}: preferred keys are exact keys, not patterns`;
    if (settings.hidden.includes(key)) return `${key} is both hidden and preferred`;
  }
  return null;
}

/**
 * Force a stored (or hand-written) document back inside the documented
 * bounds: trims, drops blanks, duplicates and invalid patterns, and removes a
 * preferred key from the exact hidden list rather than letting the two
 * contradict each other. The API rejects all of these; this is the last line
 * of defence for a row written some other way.
 */
export function normalizeTagKeySettings(
  input: Partial<TagKeySettings> | null | undefined,
): TagKeySettings {
  const clean = (raw: unknown, isValid: (s: string) => boolean, max: number): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (out.length >= max) break;
      if (typeof entry !== "string") continue;
      const value = entry.trim();
      if (!isValid(value) || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  };
  const preferred = clean(
    input?.preferred,
    (k) => k.length > 0 && k.length <= TAG_KEY_SETTINGS_LIMITS.maxKeyLength && !k.includes("*"),
    TAG_KEY_SETTINGS_LIMITS.maxPreferred,
  );
  const hidden = clean(
    input?.hidden,
    (p) => tagKeyPatternError(p) === null && !preferred.includes(p),
    TAG_KEY_SETTINGS_LIMITS.maxHidden,
  );
  return { hidden, preferred };
}

/**
 * Order (and filter) a list of discovered tag keys for a picker: preferred
 * keys first in the order the org set them, then everything else
 * alphabetically, with hidden keys dropped unless `includeHidden` is set (in
 * which case they are kept, flagged, and sorted last).
 *
 * Preferred keys the data does not carry are not invented: a pinned key with
 * no rows would group everything into one empty bucket.
 */
export function applyTagKeySettings(
  keys: readonly string[],
  settings: TagKeySettings,
  opts: { includeHidden?: boolean } = {},
): CostDimensionOption[] {
  const present = new Set(keys);
  const preferred = settings.preferred.filter((k) => present.has(k));
  const preferredSet = new Set(preferred);
  const visible: string[] = [];
  const hidden: string[] = [];
  for (const key of new Set(keys)) {
    if (preferredSet.has(key)) continue;
    (isTagKeyHidden(key, settings) ? hidden : visible).push(key);
  }
  const byName = (a: string, b: string) => a.localeCompare(b);
  visible.sort(byName);
  hidden.sort(byName);
  return [
    ...preferred.map((k) => ({ value: k, label: k, preferred: true })),
    ...visible.map((k) => ({ value: k, label: k })),
    ...(opts.includeHidden ? hidden.map((k) => ({ value: k, label: k, hidden: true })) : []),
  ];
}

/**
 * Split picker options into the preferred group and the rest, keeping order.
 * Pickers render the first as a pinned group and the second below it.
 */
export function groupTagKeyOptions<T extends { preferred?: boolean | undefined }>(
  options: readonly T[],
): { preferred: T[]; others: T[] } {
  const preferred: T[] = [];
  const others: T[] = [];
  for (const option of options) (option.preferred ? preferred : others).push(option);
  return { preferred, others };
}

/** A prefix pattern worth offering, with how many discovered keys it covers. */
export interface TagKeyPrefixSuggestion {
  pattern: string;
  keyCount: number;
}

/**
 * Prefix patterns worth offering as one-click hides: the namespaces
 * providers stamp their bookkeeping keys under (`aws:cloudformation:`,
 * `kubernetes.io/`). A key's namespace is everything up to and including its
 * last `:` or `/`; one shared by at least `minKeys` keys, and not already
 * covered by a hidden entry, is suggested. Busiest first.
 *
 * Preferred keys are left out of the count, so pinning `aws:team` does not
 * make `aws:*` look more attractive than it is.
 */
export function suggestTagKeyPrefixes(
  keys: readonly string[],
  settings: TagKeySettings,
  minKeys = 2,
): TagKeyPrefixSuggestion[] {
  const counts = new Map<string, number>();
  for (const key of new Set(keys)) {
    if (settings.preferred.includes(key)) continue;
    const cut = Math.max(key.lastIndexOf(":"), key.lastIndexOf("/"));
    if (cut <= 0 || cut === key.length - 1) continue;
    const prefix = key.slice(0, cut + 1);
    const pattern = prefix + "*";
    if (hiddenTagKeyMatch(prefix, settings.hidden) !== null) continue;
    if (settings.hidden.includes(pattern)) continue;
    counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, keyCount]) => keyCount >= minKeys)
    .map(([pattern, keyCount]) => ({ pattern, keyCount }))
    .sort((a, b) => b.keyCount - a.keyCount || a.pattern.localeCompare(b.pattern));
}
