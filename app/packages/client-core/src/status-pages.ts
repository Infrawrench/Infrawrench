/**
 * Public status pages — the monitoring the org already runs, pointed outward.
 *
 * A status page publishes a chosen set of synthetic probes (`./probes`) at an
 * unauthenticated URL. Nothing new is measured: the current state, the 24h
 * uptime and the daily history all come from the probe rows and the recorded
 * "Up" series, so a page costs one more read and no extra checks.
 *
 * Two contracts live here, and the split is the security model:
 *
 * - {@link StatusPage} and friends are the **org-scoped** shapes behind
 *   `/api/org/:orgId/status-pages`, permissioned like the rest of the app.
 *   They name probes, ids and settings.
 * - {@link PublicStatusPage} is the **public** shape behind
 *   `GET /api/status/:slug`, which anyone with the link can read. It carries
 *   labels, states and uptime numbers — never a probe URL, resource id,
 *   account, org id, or error text. The public payload is assembled by a
 *   dedicated server function rather than by narrowing the private one,
 *   because a field added to the private shape must not become public by
 *   default.
 */
import type { CloudFetch } from "./fetch";
import type { ProbeStatus } from "./probes";

/**
 * A component's public state. `operational` / `down` mirror the probe's own
 * up/down; `unknown` covers a probe that has not reported yet, and a disabled
 * probe reads `unknown` too — "we are not currently checking this" is honest,
 * where showing its last-known green would not be.
 */
export type StatusComponentState = "operational" | "degraded" | "down" | "unknown";

/**
 * The page-level rollup, in descending severity. `degraded` means some but not
 * all components are down — the distinction a visitor actually wants ("is it
 * everything, or just the thing I use?").
 */
export type StatusPageState = "operational" | "degraded" | "major_outage" | "unknown";

export const STATUS_PAGE_LIMITS = {
  /** Hard cap on pages per org — a governance rail, not a product tier. */
  maxPerOrg: 20,
  /** Components on one page; beyond this it stops being scannable. */
  maxComponents: 50,
  maxTitleLength: 120,
  maxDescriptionLength: 1_000,
  maxLabelLength: 80,
  maxGroupNameLength: 80,
  /** Days of daily uptime history the public page renders. */
  historyDays: 90,
} as const;

// ---------------------------------------------------------------------------
// Org-scoped contract (`/api/org/:orgId/status-pages`)
// ---------------------------------------------------------------------------

/** One published probe, as the org-side editor sees it. */
export interface StatusPageComponent {
  id: string;
  probeId: string;
  /** Public name; null means "use the probe's own name". */
  label: string | null;
  /** Optional heading this component sits under. */
  groupName: string | null;
  position: number;
  /** The probe's internal name — editor-only, to identify what was picked. */
  probeName: string;
  /** Current probe status, so the editor can preview what visitors see. */
  probeStatus: ProbeStatus;
  /** False when the underlying probe is paused — the editor warns about it. */
  probeEnabled: boolean;
}

export interface StatusPage {
  id: string;
  /** The public URL segment — the page's only access credential. */
  slug: string;
  title: string;
  description: string | null;
  /** False until deliberately published; a fresh page is never reachable. */
  published: boolean;
  showHistory: boolean;
  showUptime: boolean;
  supportUrl: string | null;
  components: StatusPageComponent[];
  createdAt: string;
  updatedAt: string;
}

export interface StatusPageListResponse {
  pages: StatusPage[];
}

/** One component in a create/update body. */
export interface StatusPageComponentInput {
  probeId: string;
  label?: string | null;
  groupName?: string | null;
}

/** Body of `POST /api/org/:orgId/status-pages`. */
export interface StatusPageCreate {
  title: string;
  description?: string | null;
  published?: boolean;
  showHistory?: boolean;
  showUptime?: boolean;
  supportUrl?: string | null;
  /** Order is significant — it is the render order on the public page. */
  components?: StatusPageComponentInput[];
}

/**
 * Body of `PUT /api/org/:orgId/status-pages/:id`; omitted fields keep their
 * value. `components`, when present, **replaces** the set — the editor always
 * submits the whole list, and a per-component diff API would be three more
 * endpoints for no gain.
 */
export interface StatusPagePatch {
  title?: string;
  description?: string | null;
  published?: boolean;
  showHistory?: boolean;
  showUptime?: boolean;
  supportUrl?: string | null;
  components?: StatusPageComponentInput[];
}

// ---------------------------------------------------------------------------
// Public contract (`GET /api/status/:slug`) — no auth, no org identifiers
// ---------------------------------------------------------------------------

/** One day of a component's history, oldest first. */
export interface StatusHistoryDay {
  /** `YYYY-MM-DD` in UTC. */
  day: string;
  /**
   * Fraction of the day the endpoint was up (0–1), or null when nothing was
   * recorded — a gap renders grey, never green. A page that started last week
   * must not claim 90 days of perfect uptime.
   */
  uptime: number | null;
}

export interface PublicStatusComponent {
  /** Stable per page, so a visitor can link to a component. Not the probe id. */
  id: string;
  name: string;
  groupName: string | null;
  state: StatusComponentState;
  /** Trailing-24h uptime (0–1), or null when unmeasured. */
  uptime24h: number | null;
  /** Oldest-first daily history; empty when the page hides history. */
  history: StatusHistoryDay[];
}

/**
 * A written update on the page — the one thing on a status page that a human
 * typed. Usually written by incident mode when an incident is declared, and
 * closed when it resolves; the org can also post one by hand.
 *
 * The four states are the vocabulary status pages have used for a decade, and
 * the same words `provider_status_incidents.state` already carries.
 *
 * What is deliberately *not* here: the id of the declared incident that wrote
 * it, who wrote it, and anything about the org. A visitor learns that something
 * is wrong and what is being done, never our internal handle for it.
 */
export interface PublicStatusNotice {
  id: string;
  title: string;
  body: string | null;
  state: "investigating" | "identified" | "monitoring" | "resolved";
  /** Ids of components on this page the notice is about; empty = the whole page. */
  affectedComponentIds: string[];
  startedAt: string;
  resolvedAt: string | null;
  updatedAt: string;
}

export interface PublicStatusPage {
  title: string;
  description: string | null;
  /** Rollup over the components — see {@link StatusPageState}. */
  state: StatusPageState;
  /** One sentence describing `state`, so every renderer says the same thing. */
  summary: string;
  components: PublicStatusComponent[];
  /**
   * Unresolved notices, plus recently resolved ones, newest first. Empty when
   * nothing is being reported — and empty rather than absent, so a renderer
   * never has to distinguish "no notices" from "an older server".
   */
  notices: PublicStatusNotice[];
  supportUrl: string | null;
  showHistory: boolean;
  showUptime: boolean;
  /** Days of history the components carry; 0 when history is hidden. */
  historyDays: number;
  /** When this snapshot was assembled, ISO 8601. */
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Shared pure helpers
// ---------------------------------------------------------------------------

/**
 * Map a probe's own status onto a component state.
 *
 * A disabled probe reads `unknown` regardless of its last result: the page is
 * a claim about what is being checked *now*, and showing the green from before
 * someone paused the check would be a false one.
 */
export function componentStateFromProbe(
  status: ProbeStatus,
  enabled: boolean,
): StatusComponentState {
  if (!enabled) return "unknown";
  if (status === "up") return "operational";
  if (status === "down") return "down";
  return "unknown";
}

/**
 * Roll component states up into the page state.
 *
 * `unknown` components are ignored rather than dragging the page to unknown —
 * one newly-added component must not blank out a page that is otherwise
 * reporting. A page with nothing known is `unknown`.
 */
export function rollUpStatusPageState(
  components: readonly { state: StatusComponentState }[],
): StatusPageState {
  const known = components.filter((c) => c.state !== "unknown");
  if (known.length === 0) return "unknown";
  const down = known.filter((c) => c.state === "down" || c.state === "degraded").length;
  if (down === 0) return "operational";
  return down === known.length ? "major_outage" : "degraded";
}

/** The one sentence every renderer prints for a page state. */
export function statusPageSummary(state: StatusPageState): string {
  switch (state) {
    case "operational":
      return "All systems operational";
    case "degraded":
      return "Some systems are experiencing issues";
    case "major_outage":
      return "Major outage";
    case "unknown":
      return "Status unavailable";
  }
}

/** Human label for a component state, shared by every renderer. */
export function statusComponentLabel(state: StatusComponentState): string {
  switch (state) {
    case "operational":
      return "Operational";
    case "degraded":
      return "Degraded";
    case "down":
      return "Down";
    case "unknown":
      return "No data";
  }
}

/**
 * Validate status page settings. Returns a human-readable problem or null —
 * shared verbatim by the editor UI and the API boundary.
 */
export function validateStatusPageInput(input: {
  title?: string | undefined;
  description?: string | null | undefined;
  supportUrl?: string | null | undefined;
  components?: readonly StatusPageComponentInput[] | undefined;
}): string | null {
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) return "A title is required.";
    if (title.length > STATUS_PAGE_LIMITS.maxTitleLength) {
      return `Titles are limited to ${STATUS_PAGE_LIMITS.maxTitleLength} characters.`;
    }
  }
  if (
    input.description != null &&
    input.description.length > STATUS_PAGE_LIMITS.maxDescriptionLength
  ) {
    return `Descriptions are limited to ${STATUS_PAGE_LIMITS.maxDescriptionLength} characters.`;
  }
  if (input.supportUrl != null && input.supportUrl.trim()) {
    let parsed: URL;
    try {
      parsed = new URL(input.supportUrl.trim());
    } catch {
      return "The support link must be a full URL, e.g. https://acme.com/support.";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Support links must be http or https.";
    }
  }
  if (input.components) {
    if (input.components.length > STATUS_PAGE_LIMITS.maxComponents) {
      return `A page can publish at most ${STATUS_PAGE_LIMITS.maxComponents} components.`;
    }
    const seen = new Set<string>();
    for (const component of input.components) {
      if (typeof component.probeId !== "string" || !component.probeId) {
        return "Every component must name a probe.";
      }
      if (seen.has(component.probeId)) return "The same probe is listed twice.";
      seen.add(component.probeId);
      if (component.label != null && component.label.length > STATUS_PAGE_LIMITS.maxLabelLength) {
        return `Component names are limited to ${STATUS_PAGE_LIMITS.maxLabelLength} characters.`;
      }
      if (
        component.groupName != null &&
        component.groupName.length > STATUS_PAGE_LIMITS.maxGroupNameLength
      ) {
        return `Group names are limited to ${STATUS_PAGE_LIMITS.maxGroupNameLength} characters.`;
      }
    }
  }
  return null;
}

/** The public URL of a page, given the app's origin. */
export function statusPageUrl(origin: string, slug: string): string {
  return `${origin.replace(/\/+$/, "")}/status/${slug}`;
}

/**
 * Group components in render order without sorting them.
 *
 * Order is the org's choice, so groups appear in the order their first member
 * does and members keep their relative order — re-sorting alphabetically here
 * would silently override the editor's drag order. Ungrouped components come
 * back under a `null` heading.
 */
export function groupStatusComponents<T extends { groupName: string | null }>(
  components: readonly T[],
): { groupName: string | null; components: T[] }[] {
  const groups: { groupName: string | null; components: T[] }[] = [];
  const index = new Map<string | null, { groupName: string | null; components: T[] }>();
  for (const component of components) {
    const key = component.groupName || null;
    let group = index.get(key);
    if (!group) {
      group = { groupName: key, components: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.components.push(component);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/** Read `GET /api/org/:orgId/status-pages` (permission `resources:read`). */
export async function fetchStatusPages(
  api: CloudFetch,
  orgId: string,
): Promise<StatusPageListResponse> {
  const res = await api.org<StatusPageListResponse>(orgId, "/status-pages");
  return res ?? { pages: [] };
}

/** Create a status page (`resources:write`). */
export async function createStatusPage(
  api: CloudFetch,
  orgId: string,
  body: StatusPageCreate,
): Promise<StatusPage | null> {
  return api.org<StatusPage>(orgId, "/status-pages", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Update a status page — settings, components, publish toggle (`resources:write`). */
export async function updateStatusPage(
  api: CloudFetch,
  orgId: string,
  pageId: string,
  patch: StatusPagePatch,
): Promise<StatusPage | null> {
  return api.org<StatusPage>(orgId, `/status-pages/${encodeURIComponent(pageId)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

/** Delete a status page (`resources:write`). */
export async function deleteStatusPage(
  api: CloudFetch,
  orgId: string,
  pageId: string,
): Promise<void> {
  await api.org(orgId, `/status-pages/${encodeURIComponent(pageId)}`, { method: "DELETE" });
}

/**
 * Roll the slug, revoking the old public URL (`resources:write`).
 *
 * The slug is the page's only credential, so this is the "someone shared the
 * link too widely" escape hatch — the equivalent of a secret reroll.
 */
export async function rotateStatusPageSlug(
  api: CloudFetch,
  orgId: string,
  pageId: string,
): Promise<StatusPage | null> {
  return api.org<StatusPage>(orgId, `/status-pages/${encodeURIComponent(pageId)}/rotate-slug`, {
    method: "POST",
  });
}

/**
 * Read a public status page by slug. Deliberately a plain `fetch` against the
 * app origin with no credentials: this endpoint takes no auth, and sending a
 * token to it would be the one way to leak who is looking.
 */
export async function fetchPublicStatusPage(
  origin: string,
  slug: string,
): Promise<PublicStatusPage | null> {
  const res = await fetch(`${origin.replace(/\/+$/, "")}/api/status/${encodeURIComponent(slug)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  return (await res.json()) as PublicStatusPage;
}
