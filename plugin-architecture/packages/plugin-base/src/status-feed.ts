/**
 * Provider status-feed contract ("is it me or is it them?").
 *
 * A plugin whose provider publishes a public status page declares a
 * `statusFeed` on its manifest and implements `Plugin.parseStatusFeed`.
 * The host owns scheduling (a low-frequency background pass), fetching
 * (through the egress proxy — the feed is public, so no credentials are
 * involved), storage, and correlation against the resources an org holds;
 * the plugin owns everything provider-specific: which feed to poll, how to
 * parse its wire format, and how to map feed components onto the plugin's
 * own region ids and service names.
 *
 * The mapper contract that makes correlation work: `StatusIncident.regions`
 * must contain the same region identifiers the plugin writes into
 * `ResourceInstance.fields.region` (e.g. "nyc3" for DigitalOcean,
 * "us-central1" for GCP). The host matches purely on string equality — it
 * knows nothing about any provider's region naming.
 */

/** Declares that this plugin's provider publishes a public status feed. */
export interface StatusFeedDeclaration {
  /**
   * Public machine-readable status feed URL. Must require no credentials —
   * the host polls it anonymously and infrequently, so there is no
   * rate-limit budget to declare.
   */
  url: string;
  /**
   * Wire format of the feed. Informational for the host (it fetches bytes
   * and hands them to `parseStatusFeed` either way) and documentation for
   * humans:
   *   - "statuspage-v2" — Atlassian Statuspage `/api/v2/*.json`
   *   - "custom-json"   — provider-specific JSON (GCP, AWS Health, …)
   *   - "rss" / "atom"  — XML feeds, for providers that publish nothing else
   */
  format: "statuspage-v2" | "custom-json" | "rss" | "atom";
  /**
   * Human status page URL for "View status page" links. Defaults to the
   * origin of `url` when omitted.
   */
  statusPageUrl?: string;
}

/** Normalized incident impact, ordered from least to most severe. */
export type StatusIncidentImpact = "maintenance" | "minor" | "major" | "critical";

/** Normalized incident lifecycle state. */
export type StatusIncidentState = "investigating" | "identified" | "monitoring" | "resolved";

/**
 * One normalized provider incident, as returned by `Plugin.parseStatusFeed`.
 * The host caches these and correlates them with stored resources.
 */
export interface StatusIncident {
  /**
   * Provider-native incident id, stable across polls of the same incident
   * (Statuspage incident id, GCP incident id, RSS guid, …). The host
   * dedupes and tracks lifecycle transitions on this key.
   */
  externalId: string;
  /** Short human title, e.g. "Elevated error rates in NYC3". */
  title: string;
  state: StatusIncidentState;
  impact: StatusIncidentImpact;
  /** Deep link to the provider's incident page, when the feed carries one. */
  url?: string;
  /** ISO-8601 timestamp the incident started/was created. */
  startedAt: string;
  /** ISO-8601 timestamp the incident was resolved; absent while active. */
  resolvedAt?: string;
  /** ISO-8601 timestamp of the most recent provider update. */
  lastUpdateAt?: string;
  /** Plain-text body of the most recent provider update, HTML stripped. */
  lastUpdateText?: string;
  /**
   * Plugin-native region ids affected — the exact strings this plugin
   * writes into `ResourceInstance.fields.region`. Empty when the feed
   * doesn't scope the incident to regions (correlation then falls back to
   * `services` / `providerWide`).
   */
  regions: string[];
  /** Human-readable affected product/service names, e.g. ["Droplets"]. */
  services: string[];
  /**
   * Plugin resource type ids the incident is scoped to (e.g. ["droplet"]),
   * for feeds whose components are products rather than regions. Empty when
   * the feed doesn't scope by product.
   */
  resourceTypes?: string[];
  /**
   * True when the incident affects the provider as a whole (or the feed
   * gives no usable scoping) — the host then treats every resource on this
   * plugin as potentially affected.
   */
  providerWide?: boolean;
}

/**
 * Result of mapping one feed component onto plugin identifiers. Return
 * `null` from a component mapper to ignore the component entirely
 * (e.g. Statuspage "Support portal" components that never affect
 * infrastructure).
 */
export interface StatusComponentMapping {
  /** Plugin-native region ids this component corresponds to. */
  regions?: string[];
  /** Human service names this component corresponds to. */
  services?: string[];
  /** Plugin resource type ids this component corresponds to. */
  resourceTypes?: string[];
  /** Escalate the incident to provider-wide (e.g. an "API" component). */
  providerWide?: boolean;
}

/** Options for {@link parseStatuspageIncidents}. */
export interface StatuspageParseOptions {
  /**
   * Map one Statuspage component name (e.g. "AMS3", "Droplets",
   * "Cloudflare Sites and Services (São Paulo, Brazil - GRU)") onto plugin
   * identifiers. Return `null` to ignore the component. When every
   * component of an incident is ignored and the incident names no
   * components at all, the incident is kept as provider-wide; when it names
   * only ignored components, it is dropped.
   */
  mapComponent: (componentName: string) => StatusComponentMapping | null;
  /** Base URL used when an incident is missing a shortlink. */
  statusPageUrl?: string;
}

interface StatuspageIncidentJson {
  id?: string;
  name?: string;
  status?: string;
  impact?: string;
  shortlink?: string;
  created_at?: string;
  started_at?: string;
  updated_at?: string;
  resolved_at?: string | null;
  incident_updates?: Array<{ body?: string; created_at?: string; display_at?: string }>;
  components?: Array<{ name?: string }>;
}

function normalizeStatuspageState(status: string | undefined): StatusIncidentState {
  switch (status) {
    case "identified":
      return "identified";
    case "monitoring":
    case "verifying":
      return "monitoring";
    case "resolved":
    case "postmortem":
    case "completed":
      return "resolved";
    default:
      // investigating, scheduled, in_progress, unknown
      return "investigating";
  }
}

function normalizeStatuspageImpact(
  impact: string | undefined,
  status: string | undefined,
): StatusIncidentImpact {
  if (status === "scheduled" || status === "in_progress" || impact === "maintenance") {
    return "maintenance";
  }
  switch (impact) {
    case "critical":
      return "critical";
    case "major":
      return "major";
    default:
      // minor, none, unknown
      return "minor";
  }
}

/**
 * Strip HTML tags and collapse whitespace — feeds embed markup in updates,
 * sometimes entity-encoded (RSS descriptions), so angle-bracket entities are
 * decoded before tags are stripped and `&amp;` is decoded last.
 */
export function stripStatusHtml(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse an Atlassian Statuspage `/api/v2/incidents/unresolved.json` (or the
 * `incidents` half of `summary.json`) response body into normalized
 * incidents. This is the near-free path for the many providers whose status
 * page is Statuspage-backed — a plugin supplies only the component mapper.
 *
 * Malformed bodies throw — the host logs the failure against the plugin's
 * feed rather than silently no-opping.
 */
export function parseStatuspageIncidents(
  body: string,
  options: StatuspageParseOptions,
): StatusIncident[] {
  const parsed = JSON.parse(body) as { incidents?: StatuspageIncidentJson[] };
  if (!Array.isArray(parsed.incidents)) {
    throw new Error("statuspage feed: missing incidents array");
  }
  const out: StatusIncident[] = [];
  for (const raw of parsed.incidents) {
    if (!raw || typeof raw.id !== "string" || raw.id.length === 0) continue;
    const componentNames = (raw.components ?? [])
      .map((c) => c?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    const regions = new Set<string>();
    const services = new Set<string>();
    const resourceTypes = new Set<string>();
    let providerWide = componentNames.length === 0;
    let mappedAny = componentNames.length === 0;
    for (const name of componentNames) {
      const mapping = options.mapComponent(name);
      if (mapping === null) continue;
      mappedAny = true;
      for (const r of mapping.regions ?? []) regions.add(r);
      for (const s of mapping.services ?? []) services.add(s);
      for (const t of mapping.resourceTypes ?? []) resourceTypes.add(t);
      if (mapping.providerWide) providerWide = true;
    }
    // Every named component was deliberately ignored — the incident cannot
    // affect infrastructure this plugin manages.
    if (!mappedAny) continue;
    const updates = raw.incident_updates ?? [];
    const latest = updates.length > 0 ? updates[0] : undefined;
    const url = raw.shortlink ?? options.statusPageUrl;
    const lastUpdateAt = latest?.created_at ?? latest?.display_at ?? raw.updated_at;
    out.push({
      externalId: raw.id,
      title: raw.name ?? "Provider incident",
      state: normalizeStatuspageState(raw.status),
      impact: normalizeStatuspageImpact(raw.impact, raw.status),
      ...(url ? { url } : {}),
      startedAt: raw.started_at ?? raw.created_at ?? new Date(0).toISOString(),
      ...(raw.resolved_at ? { resolvedAt: raw.resolved_at } : {}),
      ...(lastUpdateAt ? { lastUpdateAt } : {}),
      ...(latest?.body ? { lastUpdateText: stripStatusHtml(latest.body) } : {}),
      regions: Array.from(regions),
      services: Array.from(services),
      ...(resourceTypes.size > 0 ? { resourceTypes: Array.from(resourceTypes) } : {}),
      ...(providerWide ? { providerWide: true } : {}),
    });
  }
  return out;
}

/** One item pulled out of an RSS 2.0 or Atom feed. */
export interface StatusFeedXmlItem {
  guid: string;
  title: string;
  link?: string;
  publishedAt?: string;
  description?: string;
}

function firstTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m || m[1] === undefined) return undefined;
  const inner = m[1].trim();
  const cdata = inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return (cdata?.[1] ?? inner).trim();
}

/**
 * Minimal hand-rolled RSS 2.0 / Atom item extractor — plugin-base takes no
 * runtime dependencies, and status feeds are shallow enough that a
 * tag-scanner beats dragging in an XML parser. Returns items newest-first
 * in feed order; the plugin decides which items represent active incidents.
 */
export function parseStatusFeedXml(body: string): StatusFeedXmlItem[] {
  const items: StatusFeedXmlItem[] = [];
  const blocks = body.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  for (const block of blocks) {
    const title = firstTag(block, "title");
    if (!title) continue;
    const guid = firstTag(block, "guid") ?? firstTag(block, "id") ?? title;
    let link = firstTag(block, "link");
    if (!link) {
      const href = block.match(/<link[^>]*href="([^"]+)"/i);
      link = href?.[1];
    }
    const publishedAt =
      firstTag(block, "pubDate") ?? firstTag(block, "published") ?? firstTag(block, "updated");
    const rawDescription = firstTag(block, "description") ?? firstTag(block, "summary");
    items.push({
      guid,
      title: stripStatusHtml(title),
      ...(link ? { link } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(rawDescription ? { description: stripStatusHtml(rawDescription) } : {}),
    });
  }
  return items;
}
