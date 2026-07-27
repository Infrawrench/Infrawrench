/**
 * Cloud delivery for pages a server outside Infrawrench raises over
 * `POST /api/org/{orgId}/pages`.
 *
 * Same alert as `infra.page(...)` — same transports, same cooldown protocol,
 * same recipient opt-ins — for code that runs somewhere Infrawrench does not.
 * A health check, a deploy script, or a cron on a box can hand its alert to the
 * org's on-call fan-out without embedding Twilio, Slack, and Expo itself.
 *
 * The cooldown is a row in `external_pages` keyed by (org, source, page key).
 * `source` is the caller's own name for the system paging — it stands in for
 * the workflow id, so two services pushing under the same key never throttle
 * each other, and it is what the notification shows as the sender.
 */
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { PageResult, PageSpec } from "@infrawrench/workflow-runtime";

import { db } from "../db/client";
import { externalPages } from "../db/schema";
import {
  appBaseUrl,
  deliverPage,
  pageKeyAndCooldown,
  type PageAudience,
  type PageCooldownStore,
  type PriorPage,
} from "./deliver";

/** Which external system is raising the alert. */
export interface ExternalPageContext {
  organizationId: string;
  /** Stable name for the system paging, e.g. "checkout-api". */
  source: string;
}

/** The `external_pages` row for one (org, source, key) triple. */
function cooldownStore(ctx: ExternalPageContext, key: string): PageCooldownStore {
  const where = and(
    eq(externalPages.organizationId, ctx.organizationId),
    eq(externalPages.source, ctx.source),
    eq(externalPages.key, key),
  );
  return {
    async read(): Promise<PriorPage | null> {
      const [row] = await db
        .select({ lastPagedAt: externalPages.lastPagedAt })
        .from(externalPages)
        .where(where)
        .limit(1);
      return row ?? null;
    },

    // The `setWhere` predicate reads the *existing* row, so a caller that
    // retries inside the cooldown gets no row back and is reported suppressed.
    async claim(message: string, cooldownMinutes: number): Promise<boolean> {
      const now = new Date();
      const claimed = await db
        .insert(externalPages)
        .values({
          id: randomUUID(),
          organizationId: ctx.organizationId,
          source: ctx.source,
          key,
          lastPagedAt: now,
          lastMessage: message,
        })
        .onConflictDoUpdate({
          target: [externalPages.organizationId, externalPages.source, externalPages.key],
          set: { lastPagedAt: now, lastMessage: message },
          setWhere: sql`${externalPages.lastPagedAt} <= now() - (${cooldownMinutes}::double precision * interval '1 minute')`,
        })
        .returning({ id: externalPages.id });
      return claimed.length > 0;
    },

    async release(prior: PriorPage | null): Promise<void> {
      if (prior) {
        await db.update(externalPages).set({ lastPagedAt: prior.lastPagedAt }).where(where);
        return;
      }
      await db.delete(externalPages).where(where);
    },
  };
}

function audienceFor(ctx: ExternalPageContext, key: string): PageAudience {
  const base = appBaseUrl();
  return {
    organizationId: ctx.organizationId,
    name: ctx.source,
    context: `Source: ${ctx.source}`,
    // No page of our own to link to — send the reader to the org home, which
    // is also where the mobile deep link lands.
    url: base ? `${base}/org/${ctx.organizationId}` : null,
    pushData: {
      type: "api_page",
      orgId: ctx.organizationId,
      source: ctx.source,
      key,
    },
  };
}

/**
 * Deliver one API-raised page, honoring the key's cooldown. Never throws: a
 * paging outage must not turn into a 500 for the caller that reported the
 * problem.
 */
export async function pageFromExternal(
  ctx: ExternalPageContext,
  spec: PageSpec,
): Promise<PageResult> {
  const { key } = pageKeyAndCooldown(spec);
  return deliverPage(audienceFor(ctx, key), cooldownStore(ctx, key), spec);
}

/**
 * Drop a key's cooldown row so its next page delivers immediately. The caller
 * does this when it sees the condition recover, exactly as
 * `infra.page.clear(key)` does for a workflow. Returns whether a row was
 * actually cleared.
 */
export async function clearExternalPage(
  organizationId: string,
  source: string,
  key: string,
): Promise<boolean> {
  const deleted = await db
    .delete(externalPages)
    .where(
      and(
        eq(externalPages.organizationId, organizationId),
        eq(externalPages.source, source),
        eq(externalPages.key, key),
      ),
    )
    .returning({ id: externalPages.id });
  return deleted.length > 0;
}
