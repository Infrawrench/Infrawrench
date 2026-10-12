/**
 * Vulnerability alerts: new critical findings (or high, per settings, and any
 * CISA KEV-listed finding) in artifacts that are running, delivered through
 * alert routing under the `vulnerabilityAlerts` trigger.
 *
 * Unlike the posture digest this is *edge-triggered per finding*: a finding is
 * named once, when it first becomes alertable (first seen, or first seen
 * running), and `account_vulnerability_findings.alerted_at` records that. The
 * claim/cooldown protocol is the shared `alerts/daily-window.ts` engine on a
 * one-hour window, so a burst of new findings from one scan arrives as one
 * message rather than one per CVE. Never throws: errors are logged with the
 * `[vulnerabilities]` prefix.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  alertableVulnerabilityFindings,
  describeRunning,
  vulnerabilityFindingKey,
  type VulnerabilityFindingRow,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { accountVulnerabilityFindings, orgVulnerabilitySettings } from "../db/schema";
import { routeAlert } from "../alerts/route";
import {
  dailyWindowStore,
  runDailyAlertWindows,
  type DailyWindowOutcome,
  type DailyWindowResult,
  type WindowDelivery,
} from "../alerts/daily-window";
import { orgAppUrl } from "../app-url";
import { listVulnerabilities } from "./feed";
import { getVulnerabilitySettings, type VulnerabilitySettingsRecord } from "./settings";

/** Least time between alert scans for one org. Short: a new critical CVE should not wait a day. */
export const VULNERABILITY_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;

/** How many findings a message names before it says "and N more". */
const MESSAGE_LIMIT = 8;

type VulnerabilityScanOutcome =
  | { status: "quiet" }
  | { status: "sent"; findings: number }
  | { status: "undelivered"; findings: number };

export type VulnerabilityAlertsResult = DailyWindowResult<VulnerabilityScanOutcome>;
export type VulnerabilityOrgOutcome = DailyWindowOutcome<VulnerabilityScanOutcome>;

const store = dailyWindowStore<VulnerabilitySettingsRecord>({
  table: orgVulnerabilitySettings,
  cooldownMs: VULNERABILITY_NOTIFY_COOLDOWN_MS,
  claimValues: (organizationId, settings, now) => ({
    organizationId,
    enabled: settings.enabled,
    minSeverity: settings.minSeverity,
    runningOnly: settings.runningOnly,
    lastNotifiedAt: now,
  }),
});

function line(f: VulnerabilityFindingRow): string {
  const pkg = f.packageName
    ? ` in ${f.packageName}${f.installedVersion ? ` ${f.installedVersion}` : ""}`
    : "";
  const fix = f.fixedVersion ? ` (fixed in ${f.fixedVersion})` : "";
  const kev = f.kev ? " [known exploited]" : "";
  const where =
    f.running.length > 0 ? `, running in ${describeRunning(f.running)}` : ", not running";
  return `${f.advisoryId} (${f.severity})${kev}${pkg}${fix}: ${f.artifact.name}${where}`;
}

/** Message parts for a batch of new alertable findings. Exported for tests. */
export function formatVulnerabilityAlert(findings: VulnerabilityFindingRow[]): {
  title: string;
  body: string;
  pushBody: string;
} {
  const critical = findings.filter((f) => f.severity === "critical").length;
  const running = findings.filter((f) => f.running.length > 0).length;
  const noun = findings.length === 1 ? "vulnerability" : "vulnerabilities";
  const title =
    critical > 0
      ? `${findings.length} new ${noun} (${critical} critical)${running > 0 ? `, ${running} running` : ""}`
      : `${findings.length} new ${noun}${running > 0 ? `, ${running} running` : ""}`;
  const shown = findings.slice(0, MESSAGE_LIMIT).map((f) => `• ${line(f)}`);
  const more =
    findings.length > MESSAGE_LIMIT ? `\n…and ${findings.length - MESSAGE_LIMIT} more` : "";
  const first = findings[0]!;
  return {
    title,
    body: `${shown.join("\n")}${more}`,
    pushBody:
      findings.length === 1
        ? line(first)
        : `${first.advisoryId} and ${findings.length - 1} more, ${running} running`,
  };
}

async function deliverWindow(
  organizationId: string,
  settings: VulnerabilitySettingsRecord,
  now: Date,
  delivery: WindowDelivery,
): Promise<VulnerabilityScanOutcome> {
  const feed = await listVulnerabilities(organizationId, { now: now.getTime() });
  const alertable = alertableVulnerabilityFindings(feed, settings);
  if (alertable.length === 0) {
    delivery.spent = true;
    return { status: "quiet" };
  }

  // Only the ones never named before. Read in one query per account to keep
  // the IN lists bounded by what one scanner reported.
  const byAccount = new Map<string, string[]>();
  for (const f of alertable) {
    const list = byAccount.get(f.accountId) ?? [];
    list.push(f.findingId);
    byAccount.set(f.accountId, list);
  }
  const fresh = new Set<string>();
  for (const [accountId, ids] of byAccount) {
    const rows = await db
      .select({ findingId: accountVulnerabilityFindings.findingId })
      .from(accountVulnerabilityFindings)
      .where(
        and(
          eq(accountVulnerabilityFindings.accountId, accountId),
          inArray(accountVulnerabilityFindings.findingId, ids),
          isNull(accountVulnerabilityFindings.alertedAt),
        ),
      );
    for (const r of rows) fresh.add(vulnerabilityFindingKey({ accountId, findingId: r.findingId }));
  }
  const toSend = alertable.filter((f) => fresh.has(f.key));
  if (toSend.length === 0) {
    delivery.spent = true;
    return { status: "quiet" };
  }

  const message = formatVulnerabilityAlert(toSend);
  const routed = await routeAlert({
    organizationId,
    trigger: "vulnerabilityAlerts",
    severity: toSend.some((f) => f.severity === "critical" || f.kev) ? "critical" : "warning",
    title: message.title,
    body: message.body,
    pushBody: message.pushBody,
    context: "Vulnerabilities",
    url: orgAppUrl(organizationId, "vulnerabilities"),
    pushData: { type: "vulnerability_alert", orgId: organizationId, count: toSend.length },
    facts: {
      ...(toSend.length === 1
        ? { accountId: toSend[0]!.accountId, pluginId: toSend[0]!.pluginId }
        : {}),
    },
  });
  delivery.succeeded += routed.succeeded + routed.held;
  if (delivery.succeeded === 0) return { status: "undelivered", findings: toSend.length };

  // Stamp what was named, so the next scan only speaks about what is new.
  for (const [accountId] of byAccount) {
    const ids = toSend.filter((f) => f.accountId === accountId).map((f) => f.findingId);
    if (ids.length === 0) continue;
    await db
      .update(accountVulnerabilityFindings)
      .set({ alertedAt: now })
      .where(
        and(
          eq(accountVulnerabilityFindings.accountId, accountId),
          inArray(accountVulnerabilityFindings.findingId, ids),
        ),
      );
  }
  return { status: "sent", findings: toSend.length };
}

/** The poller pass: claim up to `limit` due orgs and alert on their new findings. */
export async function runVulnerabilityAlerts(
  options: { limit?: number } = {},
  now = new Date(),
): Promise<VulnerabilityAlertsResult> {
  return runDailyAlertWindows(
    {
      logPrefix: "vulnerabilities",
      store,
      getSettings: getVulnerabilitySettings,
      deliver: deliverWindow,
    },
    options,
    now,
  );
}
