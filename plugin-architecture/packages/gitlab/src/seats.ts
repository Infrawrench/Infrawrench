import type { SeatPrice, SeatRecord, SeatRemovalResult } from "@infrawrench/plugin-base";
import type { GitLabContext } from "./api.js";
import { GITLAB_COM, enc, glFetch, glRequest, statusOf } from "./api.js";
import type { GlGroup, GlNamespace } from "./types.js";

/**
 * GitLab.com subscription seats for the Seats findings: the billable members
 * of each paid top-level group.
 *
 * Only GitLab.com is reported. Self-managed and Dedicated instances are
 * licensed per instance, not per group subscription, and their namespaces all
 * carry the `default` plan, so there is no group seat or plan price to read.
 */

export const GITLAB_PRODUCT = "GitLab";

/** A member of the billable members list. */
export interface GlBillableMember {
  id: number;
  username?: string;
  name?: string | null;
  state?: string;
  email?: string | null;
  public_email?: string | null;
  last_activity_on?: string | null;
  last_login_at?: string | null;
  membership_type?: string;
  removable?: boolean;
  created_at?: string | null;
}

/**
 * Plans that are paid GitLab.com subscriptions, with the seat type shown and
 * the published monthly list price where one exists. Plan names are the keys
 * of `Plan::PLAN_NAME_UID_LIST` in gitlab-org/gitlab `app/models/plan.rb`
 * (2026-10). `silver` and `gold` are the legacy names of Premium and Ultimate.
 * Free, trial, open source and early adopter plans carry no paid seats and
 * are left out; `bronze` was retired and has no current price.
 *
 * Premium: $29 per user per month, billed annually; Ultimate: custom pricing
 * only (https://about.gitlab.com/pricing/, 2026-10).
 */
const PAID_PLANS: Record<string, { seatType: string; monthly: number | null }> = {
  premium: { seatType: "Premium", monthly: 29 },
  silver: { seatType: "Premium", monthly: 29 },
  ultimate: { seatType: "Ultimate", monthly: null },
  gold: { seatType: "Ultimate", monthly: null },
  bronze: { seatType: "Bronze", monthly: null },
  // A paying customer trialling Ultimate: still a paid subscription, but which
  // tier they pay for is not reported, so there is no defensible price.
  ultimate_trial_paid_customer: { seatType: "Paid subscription (Ultimate trial)", monthly: null },
};
const LIST_PRICE_NOTE = "about.gitlab.com/pricing, 2026-10 (billed annually)";

/** Pages of 100 read per group; reaching it fails the read rather than truncating it. */
const MAX_PAGES = 500;

export function isGitLabCom(ctx: GitLabContext): boolean {
  return ctx.baseUrl === GITLAB_COM;
}

/**
 * The top-level groups whose subscriptions are in scope: the configured
 * group's root (billable members are only listed on top-level groups), or
 * every top-level group the token's user owns.
 *
 * GET /groups/:id, GET /groups?top_level_only=true&min_access_level=50
 * https://docs.gitlab.com/api/groups/
 */
export async function topLevelGroups(ctx: GitLabContext, groupValue: string): Promise<GlGroup[]> {
  if (groupValue) {
    const group = await glFetch<GlGroup>(ctx, `/groups/${enc(groupValue)}`, {
      query: { with_projects: false },
    });
    if (!group.parent_id) return [group];
    const rootPath = group.full_path.split("/")[0]!;
    return [
      await glFetch<GlGroup>(ctx, `/groups/${enc(rootPath)}`, { query: { with_projects: false } }),
    ];
  }
  return pagedAll<GlGroup>(ctx, "/groups", {
    top_level_only: true,
    min_access_level: 50,
    order_by: "id",
  });
}

/** Every page of a list; throws past {@link MAX_PAGES} instead of returning part of it. */
async function pagedAll<T>(
  ctx: GitLabContext,
  path: string,
  query: Record<string, string | number | boolean>,
): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await glRequest(ctx, path, { query: { ...query, per_page: 100, page } });
    const batch = res.text ? (JSON.parse(res.text) as T[]) : [];
    if (!Array.isArray(batch)) return out;
    out.push(...batch);
    const next = res.headers["x-next-page"];
    if (next !== undefined) {
      if (!next) return out;
      page = Number(next);
      if (!Number.isFinite(page)) return out;
    } else {
      if (batch.length < 100) return out;
      page++;
    }
  }
  throw new Error(
    `GitLab plugin: ${path} has more than ${MAX_PAGES * 100} rows; refusing to report a partial list.`,
  );
}

function priceFor(plan: string): SeatPrice | null {
  const monthly = PAID_PLANS[plan]?.monthly;
  if (monthly === null || monthly === undefined) return null;
  return { monthly, currency: "USD", source: "list-price", note: LIST_PRICE_NOTE };
}

/**
 * `removable` is GitLab's own flag: true when the user is a direct member of
 * the group hierarchy or one of its projects, false when they are billed only
 * through a share with another group. `created_at` is the user account's
 * creation date (the entity exposes the user), the closest assignment date the
 * API offers; `last_activity_on` is the user's last activity on GitLab.com.
 */
export function mapBillableMember(
  m: GlBillableMember,
  group: Pick<GlGroup, "id" | "full_path">,
  plan: string,
): SeatRecord {
  const removable = m.removable !== false;
  const email = m.email || m.public_email || null;
  return {
    memberId: String(m.id),
    // One person can be billed in several top-level groups, each its own subscription.
    seatKey: String(group.id),
    name: m.name ?? null,
    email: email ? email.toLowerCase() : null,
    login: m.username ?? null,
    product: GITLAB_PRODUCT,
    category: "source-control",
    seatType: PAID_PLANS[plan]?.seatType ?? plan,
    price: priceFor(plan),
    activity: {
      basis: "last-activity",
      lastActiveAt: m.last_activity_on ?? null,
      source: "GitLab last activity",
    },
    assignedAt: m.created_at ?? null,
    removable,
    removalNote: removable
      ? "Removed from the group, its subgroups and projects. The subscription's seat count stays billed until renewal."
      : "Billed only through a group or project shared with another group; remove that share, or the user from the invited group, in GitLab.",
    downgrade: null,
    context: { groupId: String(group.id), groupPath: group.full_path },
  };
}

/**
 * Billable members of every paid top-level group in scope.
 *
 * GET /namespaces/:id (plan, trial)
 * https://docs.gitlab.com/api/namespaces/
 * GET /groups/:id/billable_members (Owner role, top-level groups only)
 * https://docs.gitlab.com/api/members/#list-all-billable-members-of-a-group
 */
export async function fetchGitLabSeats(
  ctx: GitLabContext,
  groupValue: string,
): Promise<SeatRecord[]> {
  if (!isGitLabCom(ctx)) return [];
  const out: SeatRecord[] = [];
  for (const group of await topLevelGroups(ctx, groupValue)) {
    const ns = await glFetch<GlNamespace>(ctx, `/namespaces/${group.id}`);
    const plan = (ns.plan ?? "").toLowerCase();
    if (!PAID_PLANS[plan]) continue;
    if (ns.trial && plan !== "ultimate_trial_paid_customer") continue;
    const members = await pagedAll<GlBillableMember>(
      ctx,
      `/groups/${group.id}/billable_members`,
      {},
    );
    for (const m of members) {
      // Awaiting members are over a limit and take no seat until approved.
      if (m.state === "awaiting") continue;
      out.push(mapBillableMember(m, group, plan));
    }
  }
  return out;
}

/**
 * DELETE /groups/:id/billable_members/:user_id: removes the user from the
 * group, its subgroups and projects, asynchronously.
 * https://docs.gitlab.com/api/members/#remove-a-billable-member-from-a-group
 */
export async function removeGitLabSeat(
  ctx: GitLabContext,
  groupId: string,
  userId: string,
  label: string,
): Promise<SeatRemovalResult> {
  if (!/^\d+$/.test(groupId) || !/^\d+$/.test(userId)) {
    throw new Error("GitLab plugin: this seat has no group or user id to remove.");
  }
  try {
    await glFetch<unknown>(ctx, `/groups/${groupId}/billable_members/${userId}`, {
      method: "DELETE",
    });
  } catch (err) {
    const status = statusOf(err);
    if (status === 403) {
      throw new Error(
        `GitLab refused to remove ${label}: removing billable members needs the Owner role on the top-level group and a token with the api scope.`,
      );
    }
    if (status === 400 || status === 405 || status === 422) {
      const detail = err instanceof Error ? err.message.replace(/^.*?: /, "") : "";
      throw new Error(
        `GitLab refused to remove ${label}${detail ? `: ${detail}` : ""}. A member billed through a shared group, or the group's last owner, has to be changed in GitLab.`,
      );
    }
    throw err;
  }
  return {
    effective: "end-of-cycle",
    message: `GitLab is removing ${label} from the group, its subgroups and projects; the seat frees up once that finishes, in a few minutes, but seats already bought stay billed until the subscription renews.`,
  };
}
