import type { SeatPrice, SeatRecord } from "@infrawrench/plugin-base";
import type { GitHubContext, GitHubOwner } from "./api.js";
import { ghFetch, ownerBase, statusOf } from "./api.js";
import type { GhCopilotSeat } from "./mappers.js";

/**
 * Copilot seats for the Seats findings.
 *
 * Only Copilot is reported. GitHub organization member seats are deliberately
 * left out: no REST or GraphQL API exposes per-member activity, so an "idle
 * member" could only be guessed at.
 */

export const COPILOT_PRODUCT = "GitHub Copilot";

/**
 * Published per-user monthly prices, used when this month's bill has no unit
 * price for the plan's SKU yet.
 * https://docs.github.com/en/copilot/concepts/billing/organizations-and-enterprises
 */
export const COPILOT_LIST_PRICE: Record<string, number> = { business: 19, enterprise: 39 };
const LIST_PRICE_NOTE =
  "docs.github.com/en/copilot/concepts/billing/organizations-and-enterprises, 2026-10";

const SEAT_TYPE: Record<string, string> = {
  business: "Copilot Business",
  enterprise: "Copilot Enterprise",
};

/** Hard stop for the seat listing; reaching it fails the read rather than truncating it. */
const MAX_PAGES = 500;

/**
 * Every Copilot seat object for the owner.
 *
 * GET /orgs/{org}/copilot/billing/seats
 * https://docs.github.com/en/rest/copilot/copilot-user-management#list-all-copilot-seat-assignments-for-an-organization
 * GET /enterprises/{enterprise}/copilot/billing/seats
 * https://docs.github.com/en/enterprise-cloud@latest/rest/copilot/copilot-user-management#list-all-copilot-seat-assignments-for-an-enterprise
 *
 * `per_page` is at most 100. Any failed page fails the whole read. A 404 means
 * the owner has no Copilot subscription (or the owner is gone), which is an
 * empty inventory rather than an error; 401/403 still throw so a token that
 * lost its permission is reported instead of reading as "no seats".
 */
export async function fetchCopilotSeatObjects(ctx: GitHubContext): Promise<GhCopilotSeat[]> {
  const out: GhCopilotSeat[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let res: { seats?: GhCopilotSeat[] };
    try {
      res = await ghFetch<{ seats?: GhCopilotSeat[] }>(
        ctx,
        `${ownerBase(ctx.owner)}/copilot/billing/seats`,
        { query: { per_page: 100, page } },
      );
    } catch (err) {
      if (page === 1 && statusOf(err) === 404) return [];
      throw err;
    }
    const batch = res?.seats ?? [];
    out.push(...batch);
    if (batch.length < 100) return out;
  }
  throw new Error(
    `GitHub plugin: more than ${MAX_PAGES * 100} Copilot seat assignments; refusing to report a partial list.`,
  );
}

function latest(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestAt = -Infinity;
  for (const v of values) {
    if (!v) continue;
    const at = Date.parse(v);
    if (Number.isNaN(at) || at <= bestAt) continue;
    best = v;
    bestAt = at;
  }
  return best;
}

function earliest(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestAt = Infinity;
  for (const v of values) {
    if (!v) continue;
    const at = Date.parse(v);
    if (Number.isNaN(at) || at >= bestAt) continue;
    best = v;
    bestAt = at;
  }
  return best;
}

function teamOf(s: GhCopilotSeat): string | undefined {
  return s.assigning_team?.slug || s.assigning_team?.name || undefined;
}

/**
 * One `SeatRecord` per user. An enterprise listing returns one seat object per
 * granting organization or team, but GitHub bills the user once, so the
 * grants are folded together: the latest activity, the earliest assignment,
 * the most expensive plan, and pending removal only when every grant is
 * pending.
 *
 * `billedPrice` returns this month's unit price for a plan from the bill, or
 * undefined to fall back to the published list price.
 */
export function mapCopilotSeatRecords(
  objects: GhCopilotSeat[],
  owner: GitHubOwner,
  billedPrice: (planType: string) => number | undefined,
): SeatRecord[] {
  const byUser = new Map<string, GhCopilotSeat[]>();
  for (const s of objects) {
    const login = s.assignee?.login;
    if (!login) continue;
    const key = s.assignee?.id !== undefined ? String(s.assignee.id) : login;
    const list = byUser.get(key);
    if (list) list.push(s);
    else byUser.set(key, [s]);
  }

  const out: SeatRecord[] = [];
  for (const [memberId, grants] of byUser) {
    const first = grants[0]!;
    const login = first.assignee!.login!;
    const plans = grants.map((g) => (g.plan_type ?? "").toLowerCase());
    const plan = plans.includes("enterprise")
      ? "enterprise"
      : plans.includes("business")
        ? "business"
        : "unknown";

    let price: SeatPrice | null = null;
    const billed = plan === "unknown" ? undefined : billedPrice(plan);
    if (billed !== undefined) {
      price = { monthly: billed, currency: "USD", source: "billing" };
    } else if (COPILOT_LIST_PRICE[plan] !== undefined) {
      price = {
        monthly: COPILOT_LIST_PRICE[plan]!,
        currency: "USD",
        source: "list-price",
        note: LIST_PRICE_NOTE,
      };
    }

    // `last_activity_at` only reflects IDE use when the user has IDE telemetry
    // on. A user with it off still authenticates, so a sign-in date is used
    // (as the weaker basis) rather than reading them as "never used".
    const lastActivity = latest(grants.map((g) => g.last_activity_at));
    const activeGrant = grants.find((g) => g.last_activity_at === lastActivity);
    const lastAuth = latest(grants.map((g) => g.last_authenticated_at));
    const activity: SeatRecord["activity"] = lastActivity
      ? {
          basis: "last-activity",
          lastActiveAt: lastActivity,
          source: activeGrant?.last_activity_editor
            ? `Copilot last activity (${activeGrant.last_activity_editor.split("/")[0]})`
            : "Copilot last activity",
        }
      : lastAuth
        ? { basis: "last-login", lastActiveAt: lastAuth, source: "Copilot last authentication" }
        : { basis: "last-activity", lastActiveAt: null, source: "Copilot last activity" };

    const allPending = grants.every((g) => g.pending_cancellation_date);
    const pendingRemovalOn = allPending
      ? latest(grants.map((g) => g.pending_cancellation_date))
      : null;

    const teams = [...new Set(grants.map(teamOf).filter((t): t is string => !!t))];
    const orgs = [
      ...new Set(
        grants.map((g) => g.organization?.login).filter((o): o is string => !!o && o !== ""),
      ),
    ];

    // The DELETE only cancels a direct assignment: GitHub refuses (422) a seat
    // that comes from a team, and an enterprise-level DELETE leaves seats a
    // child organization granted in place.
    let removable = true;
    let removalNote = "Billed until the end of the billing cycle.";
    if (teams.length > 0) {
      removable = false;
      removalNote = `Granted through the ${teams.join(", ")} team; remove the user from the team, or the team from Copilot, in GitHub.`;
    } else if (owner.kind === "enterprise" && orgs.length > 0) {
      removable = false;
      removalNote = `Granted by the ${orgs.join(", ")} organization; cancel it in that organization's Copilot settings.`;
    }

    const context: Record<string, string> = {
      ownerKind: owner.kind,
      owner: owner.slug,
    };
    const grantingOrg = owner.kind === "org" ? owner.slug : orgs.length === 1 ? orgs[0] : undefined;
    if (grantingOrg) context["organization"] = grantingOrg;
    if (teams.length > 0) context["team"] = teams.join(", ");

    const email = grants.map((g) => g.assignee?.email).find((e) => !!e) ?? null;
    out.push({
      memberId,
      name: first.assignee?.name ?? null,
      email: email ? email.toLowerCase() : null,
      login,
      product: COPILOT_PRODUCT,
      category: "ai-coding",
      seatType: SEAT_TYPE[plan] ?? "Copilot",
      price,
      activity,
      assignedAt: earliest(grants.map((g) => g.created_at)),
      pendingRemovalOn,
      removable,
      removalNote,
      downgrade: null,
      context,
      resource: { resourceTypeId: "copilot-seat", externalId: login },
    });
  }
  return out;
}
