/**
 * Fan-out for provider incidents that overlap an org's resources — the
 * `providerIncidents` trigger over the standard transports: mobile push,
 * Slack, and Microsoft Teams. Deliberately **no** SMS/voice paging: an
 * upstream provider incident is out of the org's hands, so it never warrants
 * a phone buzzing at 3am the way a failing workflow does.
 *
 * Dedupe/claim protocol: one `provider_status_notifications` row per
 * (incident, org). The `ON CONFLICT DO NOTHING` insert *is* the claim — the
 * replica whose insert lands owns delivery, the same single-statement rule
 * as `drift/alerts.ts`. If no transport delivers anything, the row is
 * deleted (`releaseUnlessDelivered` invariant) so an org that wires up a
 * channel mid-incident still hears about it on a later tick.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { accounts, providerStatusIncidents, providerStatusNotifications } from "../db/schema.js";
import { loadPlugins } from "../plugin-loader.js";
import { alertReached, routeAlert } from "../alerts/route.js";
import { matchIncidentsForOrg, type IncidentMatch } from "./match.js";

type IncidentRow = typeof providerStatusIncidents.$inferSelect;

const IMPACT_LABEL: Record<string, string> = {
  critical: "Critical incident",
  major: "Incident",
  minor: "Minor incident",
};

function describeIncident(
  incident: IncidentRow,
  match: IncidentMatch,
): { body: string; context: string } {
  const where =
    match.affectedRegions.length > 0
      ? ` in ${match.affectedRegions.join(", ")}`
      : incident.providerWide
        ? ""
        : incident.services.length > 0
          ? ` on ${incident.services.slice(0, 3).join(", ")}`
          : "";
  const count = match.affectedResourceCount;
  const body =
    `${incident.title} — ${count} of your ${count === 1 ? "resource" : "resources"}` +
    `${where} may be affected.`;
  const context = `Provider status: ${incident.state}${
    incident.lastUpdateText ? ` — ${incident.lastUpdateText.slice(0, 200)}` : ""
  }`;
  return { body, context };
}

/**
 * Notify every org holding matching resources about this plugin's active
 * incidents. Never throws — called from the poller's status pass, and a
 * Slack outage must not fail feed collection.
 */
export async function notifyOrgsOfIncidents(pluginId: string): Promise<void> {
  try {
    const active = await db
      .select()
      .from(providerStatusIncidents)
      .where(
        and(
          eq(providerStatusIncidents.pluginId, pluginId),
          isNull(providerStatusIncidents.resolvedAt),
          // Scheduled maintenance shows in the banner but never alerts.
          ne(providerStatusIncidents.impact, "maintenance"),
        ),
      );
    if (active.length === 0) return;

    const loaded = await loadPlugins();
    const providerName =
      loaded.find((p) => p.plugin.manifest.id === pluginId)?.plugin.manifest.displayName ??
      pluginId;

    const orgs = await db
      .selectDistinct({ organizationId: accounts.organizationId })
      .from(accounts)
      .where(and(eq(accounts.pluginId, pluginId), isNull(accounts.deletedAt)));

    for (const { organizationId } of orgs) {
      try {
        await notifyOneOrg(organizationId, providerName, active);
      } catch (err) {
        console.error(
          `[poller] provider-incident notify for org ${organizationId} (${pluginId}) failed:`,
          err,
        );
      }
    }
  } catch (err) {
    console.error(`[poller] provider-incident notify for plugin ${pluginId} failed:`, err);
  }
}

async function notifyOneOrg(
  organizationId: string,
  providerName: string,
  incidents: IncidentRow[],
): Promise<void> {
  const matches = await matchIncidentsForOrg(organizationId, incidents);

  for (const incident of incidents) {
    const match = matches.get(incident.id);
    if (!match || match.affectedResourceCount === 0) continue;

    // The insert is the claim: only the replica whose row lands delivers.
    const claimed = await db
      .insert(providerStatusNotifications)
      .values({
        id: randomUUID(),
        incidentId: incident.id,
        organizationId,
        affectedResourceCount: match.affectedResourceCount,
      })
      .onConflictDoNothing({
        target: [
          providerStatusNotifications.incidentId,
          providerStatusNotifications.organizationId,
        ],
      })
      .returning({ id: providerStatusNotifications.id });
    const claimId = claimed[0]?.id;
    if (!claimId) continue; // Another replica (or an earlier tick) owns it.

    const { body, context } = describeIncident(incident, match);
    const impactLabel = IMPACT_LABEL[incident.impact] ?? "Incident";
    const title = `${providerName}: ${impactLabel.toLowerCase()} upstream`;
    const url = incident.url ?? undefined;

    // Transport isolation used to be three try/catch blocks here; it is
    // `routeAlert`'s contract now — it never throws and a failing channel is
    // counted rather than propagated, so a Slack outage still cannot skip
    // Teams. Only unclaim when *nothing* landed, so a later tick can retry
    // once the org has a working channel.
    const routed = await routeAlert({
      organizationId,
      trigger: "providerIncidents",
      title,
      body,
      context,
      ...(url ? { url } : {}),
      pushData: {
        type: "provider_incident",
        orgId: organizationId,
        pluginId: incident.pluginId,
        incidentId: incident.id,
        affectedResourceCount: match.affectedResourceCount,
      },
      // The provider is the useful axis here — "route AWS incidents to the
      // team that runs on AWS" — and an upstream incident spans the org, so it
      // deliberately carries no account.
      facts: { pluginId: incident.pluginId, key: providerName },
    });

    // A hold keeps the claim: the row is the exactly-once token for
    // (incident, org), and releasing it because the message has not gone out
    // *yet* would let the next tick claim and queue a second copy.
    if (!alertReached(routed)) {
      // Nothing landed — release the claim so a later tick retries once the
      // org has a working transport. Conditional on our own row id, so a
      // concurrent re-claim can't be deleted from under its owner.
      await db
        .delete(providerStatusNotifications)
        .where(eq(providerStatusNotifications.id, claimId));
    }
  }
}
