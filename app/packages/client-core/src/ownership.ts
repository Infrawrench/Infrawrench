/**
 * Resource ownership — owner, purpose, and the ticket that authorized it, as
 * first-class fields on any resource.
 *
 * The point of the feature is attribution that other features can *use*, not
 * a notes box. Two consumers already do:
 *
 * - The orphan finder annotates every flagged resource with its owner, so
 *   "23 unattached volumes" becomes a list with a name against each row and an
 *   explicit **Unowned** bucket for the ones nobody has claimed.
 * - Resource-scoped alerts (lease countdowns, probe transitions, threshold
 *   breaches) are additionally delivered to the owning person, instead of
 *   only fanning out to everyone in the org.
 *
 * Owner is two fields because one cannot cover both jobs. `ownerUserId` is an
 * org member and is the only thing an alert can be routed to; `ownerLabel` is
 * free text for a team or an external, and is display-only. A resource may
 * have either, both, or neither — purpose and ticket stand on their own.
 *
 * This module is the shared pure half every surface uses: the wire contract
 * for `/api/org/:orgId/ownership`, the validation the editor UIs and the API
 * boundary both run (so they reject the same input with the same words), and
 * the Bearer fetch helpers mobile and the CLI call.
 */
import type { ResourceOwnerAnnotation } from "@infrawrench/plugin-base";

import type { CloudFetch } from "./fetch";

/**
 * The compact owner annotation other features embed — the orphan finder, an
 * alert body, a report row.
 *
 * Defined in plugin-base (beside `OrphanCostAnnotation`, the other host-supplied
 * annotation on a flagged resource) and re-exported here so the ownership
 * feature has one import site. The import above is `import type`, so this
 * module still erases to zero runtime dependency on plugin-base — the
 * `orphans.ts` stance, which is what keeps zod and the provider SDKs out of the
 * mobile bundle.
 */
export type OwnerSummary = ResourceOwnerAnnotation;
export type { ResourceOwnerAnnotation };

/** Wire shape of an ownership record as every read endpoint returns it. */
export interface ResourceOwnership {
  id: string;
  resourceId: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  /** Resource display name, denormalized when the record was written. */
  resourceName: string;
  /** The routable owner — an org member — or null. */
  ownerUserId: string | null;
  /** Owner's display name, resolved server-side; null when unset or removed. */
  ownerName: string | null;
  /** Owner's email, resolved server-side. Null when unset or removed. */
  ownerEmail: string | null;
  /** Free-text owner (a team, a rota, a contractor); display-only. */
  ownerLabel: string | null;
  /** What this resource is for. */
  purpose: string | null;
  /** Link to the ticket/issue/PR that authorized it. */
  ticketUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceOwnershipListResponse {
  ownership: ResourceOwnership[];
}

/**
 * Body of `PUT /api/org/:orgId/ownership` — an upsert keyed by `resourceId`.
 *
 * There is no create/update split because ownership is a property *of the
 * resource*, not a record with its own lifecycle: the caller knows the
 * resource, not whether a row already exists. Every optional field accepts
 * `null` to clear it, and an omitted field keeps its current value — so a UI
 * that only edits the ticket link cannot accidentally blank the purpose.
 */
export interface ResourceOwnershipPatch {
  resourceId: string;
  /** `null` clears the routable owner. */
  ownerUserId?: string | null;
  /** `null` clears the free-text owner. */
  ownerLabel?: string | null;
  /** `null` clears the purpose. */
  purpose?: string | null;
  /** `null` clears the ticket link. */
  ticketUrl?: string | null;
}

export const OWNERSHIP_LIMITS = {
  /** Longest accepted free-text owner. */
  maxOwnerLabelLength: 120,
  /** Longest accepted purpose. A sentence or two, not a design doc. */
  maxPurposeLength: 500,
  /** Longest accepted ticket URL. */
  maxTicketUrlLength: 500,
} as const;

/**
 * Validate an ownership patch. Returns a human-readable problem or null when
 * valid — shared verbatim by the editor UIs and the API boundary.
 *
 * Only fields actually present are checked: a patch that touches nothing but
 * `purpose` must not be rejected for a ticket URL recorded before the rule
 * existed.
 */
export function validateOwnershipPatch(patch: ResourceOwnershipPatch): string | null {
  if (typeof patch.resourceId !== "string" || !patch.resourceId.trim()) {
    return "A resource is required.";
  }
  if (patch.ownerLabel != null && patch.ownerLabel.length > OWNERSHIP_LIMITS.maxOwnerLabelLength) {
    return `Owner names are limited to ${OWNERSHIP_LIMITS.maxOwnerLabelLength} characters.`;
  }
  if (patch.purpose != null && patch.purpose.length > OWNERSHIP_LIMITS.maxPurposeLength) {
    return `Purpose is limited to ${OWNERSHIP_LIMITS.maxPurposeLength} characters.`;
  }
  if (patch.ticketUrl != null) {
    if (patch.ticketUrl.length > OWNERSHIP_LIMITS.maxTicketUrlLength) {
      return `Ticket links are limited to ${OWNERSHIP_LIMITS.maxTicketUrlLength} characters.`;
    }
    const problem = validateTicketUrl(patch.ticketUrl);
    if (problem) return problem;
  }
  return null;
}

/**
 * Validate a ticket link. An empty string is "cleared", not invalid — the
 * editors bind a text input straight to this field and an empty box means the
 * user removed the link.
 *
 * Only http(s) is accepted. The value is rendered as a link on surfaces the
 * org does not fully control (an owner report, a public-facing summary), and
 * `javascript:` in an href is the one input here that could do harm.
 */
export function validateTicketUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "The ticket link must be a full URL, e.g. https://linear.app/acme/issue/ENG-1.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Ticket links must be http or https.";
  }
  return null;
}

/**
 * Render a ticket URL as the short reference a table cell can hold —
 * `https://github.com/acme/api/issues/482` → `acme/api#482`, a Linear or Jira
 * URL → its issue key. Falls back to the host so the cell is never empty.
 *
 * Presentation only: the href is always the original URL.
 */
export function formatTicketRef(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  // github.com/<owner>/<repo>/issues|pull/<n>
  const numberedIndex = segments.findIndex((s) => s === "issues" || s === "pull");
  if (numberedIndex >= 2 && segments[numberedIndex + 1]) {
    return `${segments[numberedIndex - 2]}/${segments[numberedIndex - 1]}#${segments[numberedIndex + 1]}`;
  }
  // Linear (/issue/ENG-1/…) and Jira (/browse/ENG-1) both end on the key.
  const keyed = segments.find((s) => /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(s));
  if (keyed) return keyed.toUpperCase();
  const last = segments[segments.length - 1];
  return last ? `${parsed.hostname}/${last}` : parsed.hostname;
}

/**
 * Reduce a full record to the {@link OwnerSummary} other features embed, or
 * null when the record names nobody.
 *
 * A record carrying only a purpose is *not* an owner — the orphan finder must
 * still count it as unowned, because there is nobody to send the list to.
 */
export function toOwnerSummary(
  record: Pick<
    ResourceOwnership,
    "ownerUserId" | "ownerName" | "ownerEmail" | "ownerLabel" | "purpose" | "ticketUrl"
  >,
): OwnerSummary | null {
  const memberName = record.ownerName ?? record.ownerEmail;
  if (record.ownerUserId && memberName) {
    return {
      userId: record.ownerUserId,
      displayName: memberName,
      isLabel: false,
      ticketUrl: record.ticketUrl,
      purpose: record.purpose,
    };
  }
  const label = record.ownerLabel?.trim();
  if (label) {
    return {
      userId: null,
      displayName: label,
      isLabel: true,
      ticketUrl: record.ticketUrl,
      purpose: record.purpose,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bearer fetch helpers (mobile + any host that talks the cloud API directly)
// ---------------------------------------------------------------------------

/** One person the owner picker can offer. */
export interface OwnerCandidate {
  userId: string;
  /** Display name, falling back to the email when the user has no name set. */
  name: string;
  email: string;
}

/**
 * Org members an owner can be set to (`resources:read`).
 *
 * Deliberately its own endpoint rather than the team list: setting an owner
 * needs no visibility into roles or membership, and gating it on `team:read`
 * would put the feature out of reach of the people who create resources.
 */
export async function fetchOwnerCandidates(
  api: CloudFetch,
  orgId: string,
): Promise<OwnerCandidate[]> {
  const res = await api.org<{ members: OwnerCandidate[] }>(orgId, "/ownership/members");
  return res?.members ?? [];
}

/** Read every ownership record in the org (`resources:read`). */
export async function fetchOwnership(
  api: CloudFetch,
  orgId: string,
): Promise<ResourceOwnershipListResponse> {
  const res = await api.org<ResourceOwnershipListResponse>(orgId, "/ownership");
  return res ?? { ownership: [] };
}

/** Read one resource's ownership, or null (`resources:read`). */
export async function fetchResourceOwnership(
  api: CloudFetch,
  orgId: string,
  resourceId: string,
): Promise<ResourceOwnership | null> {
  const res = await api.org<{ ownership: ResourceOwnership | null }>(
    orgId,
    `/ownership/resource?resourceId=${encodeURIComponent(resourceId)}`,
  );
  return res?.ownership ?? null;
}

/** Upsert a resource's ownership (`resources:write`). */
export async function saveResourceOwnership(
  api: CloudFetch,
  orgId: string,
  patch: ResourceOwnershipPatch,
): Promise<ResourceOwnership | null> {
  return api.org<ResourceOwnership>(orgId, "/ownership", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

/** Remove a resource's ownership record entirely (`resources:write`). */
export async function clearResourceOwnership(
  api: CloudFetch,
  orgId: string,
  resourceId: string,
): Promise<void> {
  await api.org(orgId, `/ownership?resourceId=${encodeURIComponent(resourceId)}`, {
    method: "DELETE",
  });
}
