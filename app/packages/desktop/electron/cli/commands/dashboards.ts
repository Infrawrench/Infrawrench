// `infrawrench dashboards`: the org's dashboards, their scheduled deliveries,
// and the server-rendered PDF of one.
//
// A terminal cannot draw a dashboard's grid of cards, so this command does not
// try: it lists them, says who receives each one on a schedule, writes the PDF
// (`--format pdf`) that a browser download or a scheduled email would carry,
// and can deliver a dashboard to its schedules right now (`send`).
//
// Wire types come from `@infrawrench/client-core`, imported type-only like
// `reports`, so the CLI still ships zero new runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  Dashboard,
  DashboardNotification,
  DashboardNotificationSendResult,
} from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { matchCostReport } from "../format";
import { c, printJson, println, printTable } from "../output";
import { exportPdf, wantsPdf, type PdfExportFlags } from "../pdf-export";
import { deliverySummary, describeSchedule } from "./reports";

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Dashboard PDFs and scheduled delivery live in Infrawrench Cloud. Drop --local to use them.",
    );
  }
}

/** Destination counts for one schedule: `"2 Slack, 1 email"`. */
function describeTargets(n: DashboardNotification): string {
  const parts: string[] = [];
  if (n.slackChannelIds.length > 0) parts.push(`${n.slackChannelIds.length} Slack`);
  if (n.teamsWebhookIds.length > 0) parts.push(`${n.teamsWebhookIds.length} Teams`);
  if (n.emailRecipients.length > 0) {
    parts.push(`${n.emailRecipients.length} email${n.emailRecipients.length === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(", ") : "no destinations";
}

/** `infrawrench dashboards`: list the org's dashboards with their delivery. */
export async function cmdDashboards(ctx: CliContext): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const [dashboards, notifications] = await Promise.all([
    orgFetch<Dashboard[]>(org.id, "/dashboards"),
    // Org-wide in one call, like `reports`. Defensive: a server without
    // dashboard delivery costs the column, not the list.
    orgFetch<DashboardNotification[]>(org.id, "/dashboard-notifications").catch(
      () => [] as DashboardNotification[],
    ),
  ]);
  const schedulesByDashboard = new Map<string, DashboardNotification[]>();
  for (const n of notifications) {
    const list = schedulesByDashboard.get(n.dashboardId) ?? [];
    list.push(n);
    schedulesByDashboard.set(n.dashboardId, list);
  }

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, dashboards, notifications });
    return;
  }

  println(`${c.bold(org.displayName)} ${c.dim("· dashboards")}`);
  println();

  if (dashboards.length === 0) {
    println(c.dim("No dashboards yet. Create one in the web or desktop app."));
    return;
  }

  printTable(dashboards, [
    {
      header: "name",
      value: (d) => (d.isDefault ? `${c.bold(d.name)} ${c.dim("(default)")}` : c.bold(d.name)),
    },
    {
      header: "delivery",
      value: (d) => deliverySummary(schedulesByDashboard.get(d.id) ?? []),
    },
    { header: "id", value: (d) => c.dim(d.id) },
  ]);

  println();
  println(
    c.dim(
      "Save one as a PDF with `infrawrench dashboards <name|id> --format pdf`; `infrawrench dashboards send <name|id>` delivers it to its schedules now.",
    ),
  );
}

/** Resolve a name/id query to exactly one dashboard, or throw a helpful error. */
async function resolveDashboard(orgId: string, query: string): Promise<Dashboard> {
  const dashboards = await orgFetch<Dashboard[]>(orgId, "/dashboards");
  // Same matching rules as reports: id, case-insensitive exact name, then a
  // unique substring.
  const found = matchCostReport(dashboards, query);
  if (found.match) return found.match;
  if (found.candidates.length === 0) {
    throw new CliError(
      `No dashboard matches "${query}". Run \`infrawrench dashboards\` to see them.`,
    );
  }
  throw new CliError(
    `"${query}" matches ${found.candidates.length} dashboards: ${found.candidates
      .map((d) => d.name)
      .join(", ")}. Use the full name or the id.`,
  );
}

/**
 * `infrawrench dashboards <name|id>`: with `--format pdf`, write the
 * server-rendered PDF; otherwise a short summary of the dashboard and its
 * delivery schedules.
 */
export async function cmdShowDashboard(
  ctx: CliContext,
  query: string,
  pdfFlags: PdfExportFlags = {},
): Promise<void> {
  requireCloud(ctx);
  const pdf = wantsPdf(pdfFlags, "dashboards");
  const org = await resolveOrg(ctx);
  const dashboard = await resolveDashboard(org.id, query.trim());

  if (pdf) {
    await exportPdf(ctx, {
      orgId: org.id,
      path: `/dashboards/${encodeURIComponent(dashboard.id)}/pdf`,
      flags: pdfFlags,
      subject: { kind: "dashboard", id: dashboard.id, name: dashboard.name },
    });
    return;
  }

  const schedules = await orgFetch<DashboardNotification[]>(
    org.id,
    `/dashboards/${encodeURIComponent(dashboard.id)}/notifications`,
  ).catch(() => [] as DashboardNotification[]);

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, dashboard, notifications: schedules });
    return;
  }

  println(
    `${c.bold(dashboard.name)}${dashboard.isDefault ? ` ${c.dim("(default)")}` : ""} ${c.dim(`· ${dashboard.id}`)}`,
  );
  println();
  if (schedules.length === 0) {
    println(c.dim("No delivery schedules. Add one from the dashboard's menu (web or desktop)."));
  } else {
    println(c.dim("Delivery"));
    for (const n of schedules) {
      const failing =
        n.lastStatus === "failed" || n.lastStatus === "partial" || n.lastStatus === "no_targets";
      const status = !n.enabled
        ? c.dim("paused")
        : failing
          ? c.red(n.lastStatus ?? "")
          : c.dim(n.lastStatus ?? "not sent yet");
      println(
        `  ${describeSchedule(n)} ${c.dim(`· ${describeTargets(n)}${n.attachPdf ? " · PDF attached" : ""} ·`)} ${status}`,
      );
      if (failing && n.lastError) println(`    ${c.red(n.lastError)}`);
    }
  }
  println();
  println(
    c.dim(
      `A terminal can't draw the cards: \`infrawrench dashboards "${dashboard.name}" --format pdf\` saves the rendered dashboard.`,
    ),
  );
}

/**
 * `infrawrench dashboards send <name|id>`: render the dashboard and deliver it
 * to every one of its schedules right now. Behind an explicit verb like
 * `reports send`: it posts into channels and inboxes.
 */
export async function cmdSendDashboard(ctx: CliContext, query: string): Promise<void> {
  requireCloud(ctx);
  if (!query.trim()) {
    throw new CliError("Which dashboard? `infrawrench dashboards send <name|id>`.");
  }
  const org = await resolveOrg(ctx);
  const dashboard = await resolveDashboard(org.id, query.trim());

  const schedules = await orgFetch<DashboardNotification[]>(
    org.id,
    `/dashboards/${encodeURIComponent(dashboard.id)}/notifications`,
  );
  if (schedules.length === 0) {
    throw new CliError(
      `"${dashboard.name}" has no delivery schedules. Add one from the dashboard's menu (web or desktop) first.`,
    );
  }

  // Sequential: each send renders the PDF server-side, and a per-schedule
  // transcript reads better than an interleaved one.
  const results: Array<{
    notification: DashboardNotification;
    result: DashboardNotificationSendResult;
  }> = [];
  const failures: Array<{ notification: DashboardNotification; error: string }> = [];
  for (const notification of schedules) {
    try {
      const result = await orgFetch<DashboardNotificationSendResult>(
        org.id,
        `/dashboards/${encodeURIComponent(dashboard.id)}/notifications/${encodeURIComponent(notification.id)}/send`,
        { method: "POST" },
      );
      results.push({ notification, result });
    } catch (e) {
      failures.push({ notification, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (ctx.flags.output === "json") {
    printJson({
      org: org.id,
      dashboard: { id: dashboard.id, name: dashboard.name },
      sent: results.map((r) => ({ notificationId: r.notification.id, ...r.result })),
      failed: failures.map((f) => ({ notificationId: f.notification.id, error: f.error })),
    });
    if (failures.length > 0 && results.length === 0) throw new CliError("Every send failed.");
    return;
  }

  println(`${c.bold(dashboard.name)} ${c.dim("· send now")}`);
  println();
  for (const { notification, result } of results) {
    const extras: string[] = [];
    if (result.pdfAttached) extras.push("PDF attached");
    if (result.pdfAttached && result.slack.attempted > 0) {
      extras.push(
        `PDF uploaded to ${result.slackFilesUploaded}/${result.slack.attempted} Slack channel(s)`,
      );
    }
    println(
      `  ${c.green("✓")} ${describeSchedule(notification)} ${c.dim(
        `· delivered to ${result.succeeded}/${result.attempted} destination(s)${
          extras.length > 0 ? `; ${extras.join(", ")}` : ""
        }`,
      )}`,
    );
  }
  for (const { notification, error } of failures) {
    println(`  ${c.red("✗")} ${describeSchedule(notification)} ${c.dim(`· ${error}`)}`);
  }
  if (
    results.some(
      (r) => r.result.pdfAttached && r.result.slack.succeeded > r.result.slackFilesUploaded,
    )
  ) {
    println();
    println(
      c.dim(
        "Slack channels without the file got the message only: the Slack install needs the files:write scope to upload PDFs.",
      ),
    );
  }
  if (failures.length > 0 && results.length === 0) {
    throw new CliError("Every send failed. See the errors above.");
  }
}
