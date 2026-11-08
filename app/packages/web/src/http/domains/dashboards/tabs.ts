/**
 * Dashboards: `POST /dashboards/validate-tabs`, which restored workspace tab
 * targets still exist, as the Hono route checked them. Promise code, called
 * through `legacy` (a dashboard tab survives only while the caller's
 * sharing still lets them open it).
 *
 * A new tab kind goes in the `TabTarget` enum (`./schemas.ts`) and, when it
 * stands for a page rather than a row, in {@link ALWAYS_VALID_TAB_KINDS}.
 */
import { and, eq, isNull } from "drizzle-orm";
import { Predicate } from "effect";
import { db } from "../../../db/client";
import { accounts, chatConversations, dashboards, resources } from "../../../db/schema";
import { filterVisibleObjects } from "../../../services/object-sharing";
import { stringField } from "./store";

/**
 * Tab kinds that stand for a page rather than a row, so a restored tab of
 * that kind is always valid. Several remember which object was open (a
 * report, an invoice, a canvas, a framework): that is remembered state only,
 * and a deleted object must not invalidate the tab.
 */
const ALWAYS_VALID_TAB_KINDS: ReadonlySet<string> = new Set([
  "agents",
  "costs",
  // Retired in favour of a section on Costs, but still valid for older
  // clients that have the tab open and a panel to render it with.
  "savings",
  // The Cost reports tab is the list page; `reportId` only remembers which
  // report was open, so a deleted report must not invalidate the tab.
  "cost-reports",
  // Resource reports likewise: `reportId` is remembered state only.
  "resource-reports",
  // Same rule for Canvases: `canvasId` only remembers which canvas was
  // open, and the panel shows "not found" for one that is gone.
  "cost-canvases",
  // And for Kubernetes efficiency reports: `reportId` is remembered state.
  "k8s-efficiency",
  // Same as Cost reports: the Invoices tab is the list page, and
  // `invoiceId` only remembers which invoice was open. A voided or deleted
  // invoice must not invalidate the tab.
  "invoices",
  "graph",
  "logs",
  "changes",
  "expiring",
  "posture",
  "vulnerabilities",
  // `framework` only remembers which framework the tab was on.
  "compliance",
  "access-review",
  "jit-access",
  "backups",
  "wallboard",
  "calendar",
  "runbooks",
  "query-monitors",
  "dns",
  "iac",
  "environment-diff",
  "environments",
  "ssh-fanout",
  "metric-alerts",
  "probes",
  "status-pages",
  "quotas",
  "price-catalog",
  "incidents",
  "slos",
  "services",
  "delivery",
  "workflows",
  "deployments",
  "settings",
]);

/** A restored tab as the handler decoded it: its id and the raw target. */
export interface RestoredTab {
  readonly id: string;
  readonly target: { readonly [key: string]: unknown };
}

/** POST /validate-tabs: which workspace tab targets still exist. */
export async function validateTabs(
  organizationId: string,
  userId: string,
  tabs: ReadonlyArray<RestoredTab>,
) {
  const validIds = new Set<string>();

  for (const tab of tabs) {
    const { target } = tab;
    const kind = target["kind"];
    const dashboardId = stringField(target, "dashboardId");
    const accountId = stringField(target, "accountId");
    const resourceId = stringField(target, "resourceId");
    const conversationId = target["conversationId"];
    // A window of a remote application belongs to a session that lived in the
    // page that opened it, so a restored tab has nothing to reattach to. The
    // application is still running on the host and its launcher will list it.
    if (kind === "linux-app") continue;
    if (Predicate.isString(kind) && ALWAYS_VALID_TAB_KINDS.has(kind)) {
      validIds.add(tab.id);
    } else if (kind === "chat") {
      // The conversation-list tab is always valid; a conversation tab only
      // survives while the caller's own conversation is unarchived.
      if (!conversationId) {
        validIds.add(tab.id);
      } else if (Predicate.isString(conversationId)) {
        const [row] = await db
          .select({ id: chatConversations.id })
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.id, conversationId),
              eq(chatConversations.organizationId, organizationId),
              eq(chatConversations.userId, userId),
              isNull(chatConversations.archivedAt),
            ),
          )
          .limit(1);
        if (row) validIds.add(tab.id);
      }
    } else if (kind === "dashboard" && dashboardId) {
      const [row] = await db
        .select({ id: dashboards.id, name: dashboards.name })
        .from(dashboards)
        .where(
          and(
            eq(dashboards.id, dashboardId),
            eq(dashboards.organizationId, organizationId),
            isNull(dashboards.deletedAt),
          ),
        )
        .limit(1);
      // A dashboard unshared from the caller drops out of their tabs.
      if (
        row &&
        (await filterVisibleObjects(organizationId, "dashboard", [row], (d) => d.id)).length > 0
      ) {
        validIds.add(tab.id);
      }
    } else if (kind === "account" && accountId) {
      const [row] = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.id, accountId),
            eq(accounts.organizationId, organizationId),
            isNull(accounts.deletedAt),
          ),
        )
        .limit(1);
      if (row) validIds.add(tab.id);
    } else if (kind === "resource" && resourceId) {
      const [row] = await db
        .select({ id: resources.id })
        .from(resources)
        .where(
          and(
            eq(resources.id, resourceId),
            eq(resources.organizationId, organizationId),
            isNull(resources.deletedAt),
          ),
        )
        .limit(1);
      if (row) validIds.add(tab.id);
    }
  }

  return { validTabIds: [...validIds] };
}
