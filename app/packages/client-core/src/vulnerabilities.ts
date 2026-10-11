/**
 * Vulnerabilities: the shared contract and the join to what is running.
 *
 * Plugins report what their provider's scanner found (`listVulnerabilityFindings`,
 * see `plugin-base/src/vulnerabilities.ts`); the poller stores it per account.
 * This module is the part every host shares: it parses image references,
 * matches each stored finding to the synced resources that run the affected
 * image (or *are* the affected resource), applies dismissals and the CISA KEV
 * catalog, and shapes the wire response. The server calls
 * {@link computeVulnerabilityFeed} over Postgres rows; the CLI, desktop and
 * mobile only read the result, so the semantics live in one place.
 *
 * Pure: no clock of its own, no I/O. Its plugin-base import is type-only, the
 * posture stance (mobile must not pull zod).
 */
import type {
  RunningImageDeclaration,
  VulnerabilityArtifactKind,
  VulnerabilitySeverity,
} from "@infrawrench/plugin-base";
import type { CloudFetch } from "./fetch";

export type { VulnerabilityArtifactKind, VulnerabilitySeverity };

/** Strongest first; mirrors plugin-base's `VULNERABILITY_SEVERITIES` (kept here type-free). */
export const VULNERABILITY_SEVERITY_ORDER: readonly VulnerabilitySeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "unknown",
];

export const VULNERABILITY_SEVERITY_LABELS: Record<VulnerabilitySeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  unknown: "Unscored",
};

const SEVERITY_RANK: Record<VulnerabilitySeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4,
};

// --- Image references ---

/** A container image reference, normalised so two spellings of one image compare equal. */
export interface ParsedImageRef {
  /** `registry/path`, lower-cased, Docker Hub canonicalised (`docker.io/library/nginx`). Empty for a bare digest. */
  repository: string;
  tag?: string;
  /** `sha256:…`, lower-cased. */
  digest?: string;
}

const DOCKER_HUB_ALIASES = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);

/**
 * Parse one image reference: `nginx`, `nginx:1.27`, `ghcr.io/acme/api:v2`,
 * `repo@sha256:…`, `docker-pullable://repo@sha256:…`, or a bare `sha256:…`.
 * Returns null for anything that is not one.
 */
export function parseImageRef(raw: string): ParsedImageRef | null {
  let ref = raw.trim().replace(/^[a-z-]+:\/\//i, "");
  if (!ref) return null;
  let digest: string | undefined;
  const at = ref.indexOf("@");
  if (at >= 0) {
    digest = ref.slice(at + 1).toLowerCase();
    ref = ref.slice(0, at);
  } else if (/^sha256:[0-9a-f]+$/i.test(ref)) {
    return { repository: "", digest: ref.toLowerCase() };
  }
  if (digest !== undefined && !/^sha256:[0-9a-f]+$/.test(digest)) digest = undefined;
  if (!ref) return digest ? { repository: "", digest } : null;

  let tag: string | undefined;
  const lastSlash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  if (colon > lastSlash) {
    tag = ref.slice(colon + 1);
    ref = ref.slice(0, colon);
  }
  if (!ref || /\s/.test(ref)) return null;

  const parts = ref.split("/");
  const first = parts[0]!;
  const hasRegistry =
    parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
  let registry = hasRegistry ? first.toLowerCase() : "docker.io";
  let path = hasRegistry ? parts.slice(1).join("/") : parts.join("/");
  if (DOCKER_HUB_ALIASES.has(registry)) {
    registry = "docker.io";
    if (!path.includes("/")) path = `library/${path}`;
  }
  return {
    repository: `${registry}/${path.toLowerCase()}`,
    ...(tag ? { tag } : {}),
    ...(digest ? { digest } : {}),
  };
}

/** Split a field holding one or several image references (comma, whitespace or newline separated). */
export function splitImageRefs(value: unknown): ParsedImageRef[] {
  if (typeof value !== "string" || !value.trim()) return [];
  const out: ParsedImageRef[] = [];
  for (const part of value.split(/[\s,]+/)) {
    const parsed = parseImageRef(part);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * The repository key a finding's artifact is keyed and dismissed under: the
 * normalised repository for images, the lower-cased name otherwise.
 */
export function vulnerabilityArtifactKey(artifact: {
  kind: VulnerabilityArtifactKind;
  name: string;
}): string {
  if (artifact.kind === "image") {
    const parsed = parseImageRef(artifact.name);
    if (parsed?.repository) return `image:${parsed.repository}`;
  }
  return `${artifact.kind}:${artifact.name.trim().toLowerCase()}`;
}

// --- Wire shapes ---

/** How a running resource was tied to a finding, strongest first. */
export type VulnerabilityMatchKind =
  /** The resource runs exactly the scanned image digest. */
  | "digest"
  /** The scanner named this resource (an ARN, a resource id). */
  | "resource"
  /** Same repository, and the running tag is one the scanned image carries; no digest to confirm. */
  | "tag";

/** One synced resource running (or being) a finding's artifact. */
export interface VulnerabilityRunningRef {
  resourceId: string;
  pluginId: string;
  resourceTypeId: string;
  /** Singular type name, e.g. "Pod". */
  resourceTypeName: string;
  /** Plural type name, e.g. "Pods". */
  resourceTypePluralName: string;
  accountId: string;
  accountName: string;
  displayName: string;
  matchedBy: VulnerabilityMatchKind;
}

/** CISA Known Exploited Vulnerabilities catalog entry for a finding's CVE. */
export interface VulnerabilityKevEntry {
  /** Date CISA added it (YYYY-MM-DD). */
  dateAdded: string;
  /** Federal remediation due date (YYYY-MM-DD), when set. */
  dueDate: string | null;
  /** CISA lists known ransomware campaign use. */
  knownRansomware: boolean;
}

/** One stored finding, joined. The wire shape of a row in `GET /vulnerabilities`. */
export interface VulnerabilityFindingRow {
  /** {@link vulnerabilityFindingKey}: unique across the org. */
  key: string;
  accountId: string;
  accountName: string;
  pluginId: string;
  pluginName: string;
  /** The scanner, e.g. "Amazon Inspector". */
  scanner: string;
  findingId: string;
  advisoryId: string;
  aliases: string[];
  title: string | null;
  severity: VulnerabilitySeverity;
  cvssScore: number | null;
  cvssVector: string | null;
  packageName: string | null;
  packageEcosystem: string | null;
  installedVersion: string | null;
  fixedVersion: string | null;
  /** Null = the scanner does not say. */
  fixAvailable: boolean | null;
  /** Null = the scanner does not say. */
  exploitAvailable: boolean | null;
  /** Present when the advisory (or an alias) is in the CISA KEV catalog. */
  kev: VulnerabilityKevEntry | null;
  artifact: {
    kind: VulnerabilityArtifactKind;
    name: string;
    digest: string | null;
    tags: string[];
    resourceExternalId: string | null;
    url: string | null;
    /** {@link vulnerabilityArtifactKey}; what a dismissal is keyed on. */
    key: string;
  };
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  url: string | null;
  /** When the poller last read this finding from the scanner. */
  collectedAt: string;
  /** Synced resources running the artifact now. Empty = not running anywhere we can see. */
  running: VulnerabilityRunningRef[];
}

/**
 * Accepting an advisory as a known risk: for one artifact (`artifactKey`), or
 * for every artifact in the org (`artifactKey === "*"`). Keyed on the advisory
 * and the artifact's repository rather than a finding id, so it survives a
 * rebuild (a new digest of the same repository) and a re-scan; the
 * `posture_dismissals` stance, with the same "inert, never pruned" semantics.
 */
export interface VulnerabilityDismissal {
  advisoryId: string;
  artifactKey: string;
  dismissedAt: string;
  dismissedBy: string | null;
  reason: string | null;
}

export interface DismissedVulnerabilityFinding extends VulnerabilityFindingRow {
  dismissal: VulnerabilityDismissal;
}

/** Collection status for one account whose plugin declares `vulnerabilities`. */
export interface VulnerabilitySource {
  accountId: string;
  accountName: string;
  pluginId: string;
  pluginName: string;
  scanner: string;
  consoleUrl: string | null;
  /** Reports a bounded subset (`vulnerabilities.partial`). */
  partial: boolean;
  lastCollectedAt: string | null;
  /** Last collection error, when the most recent read failed. */
  error: string | null;
  helpLabel: string | null;
  helpUrl: string | null;
  findingCount: number;
}

export type VulnerabilityCounts = Record<VulnerabilitySeverity, number>;

/** Wire shape of `GET /api/org/:orgId/vulnerabilities`. */
export interface VulnerabilityListResponse {
  /** Live findings: worst first, running before not running, then KEV, then CVSS. */
  findings: VulnerabilityFindingRow[];
  totalCount: number;
  counts: VulnerabilityCounts;
  /** Live findings whose artifact is running somewhere, per severity. */
  runningCounts: VulnerabilityCounts;
  dismissed: DismissedVulnerabilityFinding[];
  dismissedCount: number;
  sources: VulnerabilitySource[];
  /** CISA KEV catalog freshness; null when it has never been fetched. */
  kevUpdatedAt: string | null;
  generatedAt: string;
}

/** The org-unique key of a finding row. NUL-joined: both halves carry slashes and colons. */
export function vulnerabilityFindingKey(f: { accountId: string; findingId: string }): string {
  return `${f.accountId}\u0000${f.findingId}`;
}

/** The key of a dismissal (and of the finding it would apply to). */
export function vulnerabilityDismissalKey(d: { advisoryId: string; artifactKey: string }): string {
  return `${d.advisoryId.toUpperCase()}\u0000${d.artifactKey}`;
}

export function emptyVulnerabilityCounts(): VulnerabilityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
}

// --- The join ---

/** The part of a resource type the join reads. */
export interface VulnerabilityScanResourceType {
  id: string;
  displayName: string;
  pluralDisplayName: string;
  runningImages?: RunningImageDeclaration | undefined;
}

export interface VulnerabilityScanPlugin {
  id: string;
  displayName: string;
  /** `manifest.vulnerabilities`, when declared. */
  vulnerabilities?:
    | { label: string; consoleUrl?: string | undefined; partial?: boolean | undefined }
    | undefined;
  resourceTypes: readonly VulnerabilityScanResourceType[];
}

export interface VulnerabilityScanAccount {
  id: string;
  displayName: string;
  pluginId: string;
}

/** A stored resource row, as hosts map it. */
export interface VulnerabilityScanResource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
  fields: unknown;
}

/** A stored finding row, as hosts map it (the poller's table, camel-cased). */
export interface StoredVulnerabilityFinding {
  accountId: string;
  pluginId: string;
  findingId: string;
  advisoryId: string;
  aliases: readonly string[];
  title: string | null;
  severity: VulnerabilitySeverity;
  cvssScore: number | null;
  cvssVector: string | null;
  packageName: string | null;
  packageEcosystem: string | null;
  installedVersion: string | null;
  fixedVersion: string | null;
  fixAvailable: boolean | null;
  exploitAvailable: boolean | null;
  artifactKind: VulnerabilityArtifactKind;
  artifactName: string;
  artifactDigest: string | null;
  artifactTags: readonly string[];
  artifactResourceId: string | null;
  artifactUrl: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  url: string | null;
  collectedAt: string;
}

export interface VulnerabilityFeedInput {
  plugins: readonly VulnerabilityScanPlugin[];
  accounts: readonly VulnerabilityScanAccount[];
  /**
   * Resources that could join: every instance of a type declaring
   * `runningImages`, plus any whose id/externalId a finding names. Extra rows
   * are harmless; a missing row only means a finding reads as not running.
   */
  resources: readonly VulnerabilityScanResource[];
  findings: readonly StoredVulnerabilityFinding[];
  dismissals?: readonly VulnerabilityDismissal[] | undefined;
  /** KEV catalog keyed by upper-case CVE id. */
  kev?: ReadonlyMap<string, VulnerabilityKevEntry> | undefined;
  kevUpdatedAt?: string | null | undefined;
  sources?: readonly VulnerabilitySource[] | undefined;
  now?: number;
}

type RunningRef = Omit<VulnerabilityRunningRef, "matchedBy">;

interface RunningIndex {
  byDigest: Map<string, RunningRef[]>;
  /** `repository\u0000tag` → resources running that tag with no digest to confirm it. */
  byRepoTag: Map<string, RunningRef[]>;
  /** Resource id and external id → the resource, for findings that name one. */
  byResource: Map<string, RunningRef[]>;
}

function fieldString(fields: unknown, key: string): string | undefined {
  if (!fields || typeof fields !== "object") return undefined;
  const v = (fields as Record<string, unknown>)[key];
  if (v === undefined || v === null) return undefined;
  return typeof v === "string" ? v : String(v);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Whether an instance of a type declaring `runningImages` counts as running now. */
export function isRunningInstance(decl: RunningImageDeclaration, fields: unknown): boolean {
  if (!decl.runningKey || !decl.runningValues) return true;
  const value = fieldString(fields, decl.runningKey)?.trim().toLowerCase();
  if (!value) return false;
  return decl.runningValues.some((v) => v.toLowerCase() === value);
}

function buildRunningIndex(input: VulnerabilityFeedInput): RunningIndex {
  const types = new Map<string, VulnerabilityScanResourceType>();
  for (const p of input.plugins) for (const t of p.resourceTypes) types.set(`${p.id}/${t.id}`, t);
  const accountNames = new Map(input.accounts.map((a) => [a.id, a.displayName]));
  const index: RunningIndex = { byDigest: new Map(), byRepoTag: new Map(), byResource: new Map() };

  for (const r of input.resources) {
    const type = types.get(`${r.pluginId}/${r.resourceTypeId}`);
    if (!type) continue;
    const ref: RunningRef = {
      resourceId: r.id,
      pluginId: r.pluginId,
      resourceTypeId: r.resourceTypeId,
      resourceTypeName: type.displayName,
      resourceTypePluralName: type.pluralDisplayName,
      accountId: r.accountId,
      accountName: accountNames.get(r.accountId) ?? r.accountId,
      displayName: r.displayName,
    };
    const decl = type.runningImages;
    // A resource the scanner names directly joins whatever its type, unless
    // the type says how to tell it is stopped and it is.
    if (!decl || isRunningInstance(decl, r.fields)) {
      push(index.byResource, r.id, ref);
      if (r.externalId) push(index.byResource, r.externalId, ref);
    }
    if (!decl || !isRunningInstance(decl, r.fields)) continue;

    const digests = new Set<string>();
    const digestRepos = new Set<string>();
    for (const key of decl.digestKeys ?? []) {
      for (const parsed of splitImageRefs(fieldString(r.fields, key))) {
        if (!parsed.digest) continue;
        digests.add(parsed.digest);
        if (parsed.repository) digestRepos.add(parsed.repository);
      }
    }
    for (const key of decl.imageKeys) {
      for (const parsed of splitImageRefs(fieldString(r.fields, key))) {
        if (parsed.digest) {
          digests.add(parsed.digest);
          if (parsed.repository) digestRepos.add(parsed.repository);
        } else if (parsed.repository && !digestRepos.has(parsed.repository)) {
          // Tag-only reference whose digest we do not know. A known digest
          // for the same repository wins: a tag can move, a digest cannot.
          push(index.byRepoTag, `${parsed.repository}\u0000${parsed.tag ?? "latest"}`, ref);
        }
      }
    }
    for (const d of digests) push(index.byDigest, d, ref);
  }
  return index;
}

function matchRunning(f: StoredVulnerabilityFinding, index: RunningIndex): VulnerabilityRunningRef[] {
  const out = new Map<string, VulnerabilityRunningRef>();
  const add = (refs: Array<RunningRef> | undefined, by: VulnerabilityMatchKind) => {
    for (const ref of refs ?? []) {
      if (!out.has(ref.resourceId)) out.set(ref.resourceId, { ...ref, matchedBy: by });
    }
  };
  if (f.artifactResourceId) add(index.byResource.get(f.artifactResourceId), "resource");
  if (f.artifactKind === "image") {
    if (f.artifactDigest) add(index.byDigest.get(f.artifactDigest.toLowerCase()), "digest");
    const parsed = parseImageRef(f.artifactName);
    if (parsed?.repository) {
      for (const tag of f.artifactTags) {
        add(index.byRepoTag.get(`${parsed.repository}\u0000${tag}`), "tag");
      }
    }
  }
  return [...out.values()];
}

function compareRows(a: VulnerabilityFindingRow, b: VulnerabilityFindingRow): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    Number(b.running.length > 0) - Number(a.running.length > 0) ||
    Number(b.kev !== null) - Number(a.kev !== null) ||
    (b.cvssScore ?? -1) - (a.cvssScore ?? -1) ||
    b.running.length - a.running.length ||
    a.advisoryId.localeCompare(b.advisoryId) ||
    a.key.localeCompare(b.key)
  );
}

/**
 * Join stored findings to running resources, apply dismissals and KEV, and
 * shape the feed. Dismissed findings are partitioned out (the posture
 * stance): they leave `findings`/`counts`, appear in `dismissed`, and so stay
 * out of every alert, digest and helper that reads the live list.
 */
export function computeVulnerabilityFeed(input: VulnerabilityFeedInput): VulnerabilityListResponse {
  const plugins = new Map(input.plugins.map((p) => [p.id, p]));
  const accountNames = new Map(input.accounts.map((a) => [a.id, a.displayName]));
  const index = buildRunningIndex(input);
  const dismissals = new Map(
    (input.dismissals ?? []).map((d) => [vulnerabilityDismissalKey(d), d] as const),
  );

  const findings: VulnerabilityFindingRow[] = [];
  const dismissed: DismissedVulnerabilityFinding[] = [];
  const counts = emptyVulnerabilityCounts();
  const runningCounts = emptyVulnerabilityCounts();

  for (const f of input.findings) {
    const plugin = plugins.get(f.pluginId);
    const artifactKey = vulnerabilityArtifactKey({ kind: f.artifactKind, name: f.artifactName });
    let kev: VulnerabilityKevEntry | null = null;
    if (input.kev) {
      for (const id of [f.advisoryId, ...f.aliases]) {
        const hit = input.kev.get(id.toUpperCase());
        if (hit) {
          kev = hit;
          break;
        }
      }
    }
    const row: VulnerabilityFindingRow = {
      key: vulnerabilityFindingKey(f),
      accountId: f.accountId,
      accountName: accountNames.get(f.accountId) ?? f.accountId,
      pluginId: f.pluginId,
      pluginName: plugin?.displayName ?? f.pluginId,
      scanner: plugin?.vulnerabilities?.label ?? plugin?.displayName ?? f.pluginId,
      findingId: f.findingId,
      advisoryId: f.advisoryId,
      aliases: [...f.aliases],
      title: f.title,
      severity: f.severity,
      cvssScore: f.cvssScore,
      cvssVector: f.cvssVector,
      packageName: f.packageName,
      packageEcosystem: f.packageEcosystem,
      installedVersion: f.installedVersion,
      fixedVersion: f.fixedVersion,
      fixAvailable: f.fixAvailable,
      exploitAvailable: f.exploitAvailable,
      kev,
      artifact: {
        kind: f.artifactKind,
        name: f.artifactName,
        digest: f.artifactDigest,
        tags: [...f.artifactTags],
        resourceExternalId: f.artifactResourceId,
        url: f.artifactUrl,
        key: artifactKey,
      },
      firstSeenAt: f.firstSeenAt,
      lastSeenAt: f.lastSeenAt,
      url: f.url,
      collectedAt: f.collectedAt,
      running: matchRunning(f, index),
    };
    const dismissal =
      dismissals.get(vulnerabilityDismissalKey({ advisoryId: f.advisoryId, artifactKey })) ??
      dismissals.get(vulnerabilityDismissalKey({ advisoryId: f.advisoryId, artifactKey: "*" }));
    if (dismissal) {
      dismissed.push({ ...row, dismissal });
      continue;
    }
    findings.push(row);
    counts[row.severity] += 1;
    if (row.running.length > 0) runningCounts[row.severity] += 1;
  }

  findings.sort(compareRows);
  dismissed.sort(
    (a, b) =>
      b.dismissal.dismissedAt.localeCompare(a.dismissal.dismissedAt) || compareRows(a, b),
  );

  return {
    findings,
    totalCount: findings.length,
    counts,
    runningCounts,
    dismissed,
    dismissedCount: dismissed.length,
    sources: [...(input.sources ?? [])],
    kevUpdatedAt: input.kevUpdatedAt ?? null,
    generatedAt: new Date(input.now ?? Date.now()).toISOString(),
  };
}

// --- Filters and summaries every surface shares ---

export interface VulnerabilityFilter {
  severities?: readonly VulnerabilitySeverity[] | undefined;
  /** true = only running, false = only not running, undefined = both. */
  running?: boolean | undefined;
  /** true = only findings the scanner says have a fix. */
  fixAvailable?: boolean | undefined;
  /** true = only findings in the CISA KEV catalog. */
  kev?: boolean | undefined;
  pluginId?: string | undefined;
  accountId?: string | undefined;
  /** Case-insensitive substring over advisory, aliases, package, artifact and title. */
  search?: string | undefined;
}

export function filterVulnerabilityFindings<T extends VulnerabilityFindingRow>(
  rows: readonly T[],
  filter: VulnerabilityFilter,
): T[] {
  const q = filter.search?.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter.severities && filter.severities.length > 0 && !filter.severities.includes(r.severity))
      return false;
    if (filter.running !== undefined && r.running.length > 0 !== filter.running) return false;
    if (filter.fixAvailable && r.fixAvailable !== true) return false;
    if (filter.kev && !r.kev) return false;
    if (filter.pluginId && r.pluginId !== filter.pluginId) return false;
    if (filter.accountId && r.accountId !== filter.accountId) return false;
    if (q) {
      const hay = [
        r.advisoryId,
        ...r.aliases,
        r.packageName ?? "",
        r.artifact.name,
        r.title ?? "",
      ]
        .join("\n")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * "3 Pods and 1 Lambda Function": the running half of a finding in English,
 * for alerts, the CLI and the digest. The UI composes its own (translated)
 * version from {@link groupRunningByType}.
 */
export function groupRunningByType(
  running: readonly VulnerabilityRunningRef[],
): Array<{ resourceTypeName: string; resourceTypePluralName: string; count: number }> {
  const groups = new Map<
    string,
    { resourceTypeName: string; resourceTypePluralName: string; count: number }
  >();
  for (const r of running) {
    const key = `${r.pluginId}/${r.resourceTypeId}`;
    const g = groups.get(key);
    if (g) g.count += 1;
    else
      groups.set(key, {
        resourceTypeName: r.resourceTypeName,
        resourceTypePluralName: r.resourceTypePluralName,
        count: 1,
      });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export function describeRunning(running: readonly VulnerabilityRunningRef[]): string {
  const parts = groupRunningByType(running).map(
    (g) => `${g.count} ${g.count === 1 ? g.resourceTypeName : g.resourceTypePluralName}`,
  );
  if (parts.length === 0) return "not running";
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Open (undismissed) findings per resource, for the scorecard check and
 * compliance evidence: `resourceId → counts and advisories` over the live
 * feed, at or above `minSeverity` (default `high`). A finding counts against
 * every resource it runs on; a resource with none is simply absent.
 */
export interface ResourceVulnerabilitySummary {
  resourceId: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
  /** Distinct advisory ids, worst first. */
  advisories: string[];
  /** Any of them is in the CISA KEV catalog. */
  kev: boolean;
}

export function openVulnerabilitiesByResource(
  feed: Pick<VulnerabilityListResponse, "findings">,
  options: { minSeverity?: VulnerabilitySeverity } = {},
): Map<string, ResourceVulnerabilitySummary> {
  const min = SEVERITY_RANK[options.minSeverity ?? "high"];
  const out = new Map<string, ResourceVulnerabilitySummary>();
  for (const f of feed.findings) {
    if (SEVERITY_RANK[f.severity] > min) continue;
    for (const r of f.running) {
      let s = out.get(r.resourceId);
      if (!s) {
        s = {
          resourceId: r.resourceId,
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          unknown: 0,
          advisories: [],
          kev: false,
        };
        out.set(r.resourceId, s);
      }
      s[f.severity] += 1;
      if (!s.advisories.includes(f.advisoryId)) s.advisories.push(f.advisoryId);
      if (f.kev) s.kev = true;
    }
  }
  return out;
}

// --- Settings and alerting ---

/** Wire shape of `GET|PUT /api/org/:orgId/vulnerabilities/settings`. */
export interface VulnerabilitySettings {
  /** Whether the poller sends vulnerability alerts for this org at all. */
  alertsEnabled: boolean;
  /** Lowest severity that alerts: `critical` (default) or `high`. KEV-listed findings always alert. */
  minSeverity: "critical" | "high";
  /** Only alert on findings whose artifact is running (default true). */
  runningOnly: boolean;
  lastNotifiedAt: string | null;
}

export interface VulnerabilitySettingsPatch {
  alertsEnabled?: boolean;
  minSeverity?: "critical" | "high";
  runningOnly?: boolean;
}

export const DEFAULT_VULNERABILITY_SETTINGS: Omit<VulnerabilitySettings, "lastNotifiedAt"> = {
  alertsEnabled: true,
  minSeverity: "critical",
  runningOnly: true,
};

/** The live findings the settings say are worth a page. */
export function alertableVulnerabilityFindings(
  feed: Pick<VulnerabilityListResponse, "findings">,
  settings: Pick<VulnerabilitySettings, "minSeverity" | "runningOnly">,
): VulnerabilityFindingRow[] {
  const max = SEVERITY_RANK[settings.minSeverity];
  return feed.findings.filter(
    (f) =>
      (SEVERITY_RANK[f.severity] <= max || (f.kev !== null && f.severity !== "unknown")) &&
      (!settings.runningOnly || f.running.length > 0),
  );
}

// --- Client calls ---

function emptyFeed(): VulnerabilityListResponse {
  return {
    findings: [],
    totalCount: 0,
    counts: emptyVulnerabilityCounts(),
    runningCounts: emptyVulnerabilityCounts(),
    dismissed: [],
    dismissedCount: 0,
    sources: [],
    kevUpdatedAt: null,
    generatedAt: new Date().toISOString(),
  };
}

/** Read `GET /api/org/:orgId/vulnerabilities` (permission `resources:read`). No provider calls. */
export async function fetchVulnerabilities(
  api: CloudFetch,
  orgId: string,
): Promise<VulnerabilityListResponse> {
  return (await api.org<VulnerabilityListResponse>(orgId, "/vulnerabilities")) ?? emptyFeed();
}

export async function getVulnerabilitySettings(
  api: CloudFetch,
  orgId: string,
): Promise<VulnerabilitySettings> {
  const res = await api.org<VulnerabilitySettings>(orgId, "/vulnerabilities/settings");
  return res ?? { ...DEFAULT_VULNERABILITY_SETTINGS, lastNotifiedAt: null };
}

export async function updateVulnerabilitySettings(
  api: CloudFetch,
  orgId: string,
  patch: VulnerabilitySettingsPatch,
): Promise<VulnerabilitySettings> {
  const res = await api.org<VulnerabilitySettings>(orgId, "/vulnerabilities/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  return res ?? { ...DEFAULT_VULNERABILITY_SETTINGS, lastNotifiedAt: null };
}

export interface VulnerabilityDismissInput {
  advisoryId: string;
  /** An artifact key from a finding row, or `"*"` for the advisory everywhere. */
  artifactKey: string;
  reason?: string | undefined;
}

/** `POST /vulnerabilities/dismissals` (permission `resources:write`). Idempotent. */
export async function dismissVulnerability(
  api: CloudFetch,
  orgId: string,
  input: VulnerabilityDismissInput,
): Promise<VulnerabilityDismissal> {
  const res = await api.org<VulnerabilityDismissal>(orgId, "/vulnerabilities/dismissals", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res) throw new Error("Dismissing the vulnerability returned no dismissal");
  return res;
}

/** `DELETE /vulnerabilities/dismissals?advisoryId=…&artifactKey=…`. The key is in the query: artifact names carry slashes. */
export async function restoreVulnerability(
  api: CloudFetch,
  orgId: string,
  input: { advisoryId: string; artifactKey: string },
): Promise<void> {
  const query = new URLSearchParams({ advisoryId: input.advisoryId, artifactKey: input.artifactKey });
  await api.org(orgId, `/vulnerabilities/dismissals?${query.toString()}`, { method: "DELETE" });
}
