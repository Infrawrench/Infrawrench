/**
 * Anomaly feedback from a link: the page behind the Expected / Unexpected
 * buttons on Microsoft Teams anomaly cards (mounted at `/api`, session-authed).
 *
 * Teams cards arrive through one-way incoming webhooks, so a card button can
 * only open a URL. The URL names the org, the anomaly and the preselected
 * verdict, none of which is a secret: everything is decided by the signed-in
 * session, exactly as the HTTP route decides it.
 *
 * The GET only renders a small form: a state-changing write must not ride a
 * URL that link unfurlers, prefetchers and mail scanners follow. The write is
 * the POST, guarded by a double-submit CSRF pair (a cookie bound to this
 * browser plus the same value echoed by the form), the pattern the Slack
 * account-link page uses. Both halves re-check membership, `costs:write`, and
 * the member's cost visibility before touching anything.
 */
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  COST_ANOMALY_FEEDBACK_REASONS,
  COST_ANOMALY_FEEDBACK_REASON_LABELS,
  COST_ANOMALY_RECURRENCES,
  COST_ANOMALY_RECURRENCE_LABELS,
  COST_ANOMALY_VERDICTS,
  formatMoney,
  type CostAnomaly,
  type CostAnomalyFeedbackInput,
  type CostAnomalyFeedbackReason,
  type CostAnomalyRecurrence,
  type CostAnomalyVerdict,
} from "@infrawrench/client-core";
import { resolveEffectivePermissions } from "@infrawrench/server-core/permissions";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { withPrincipalCostVisibility } from "../../auth/cost-visibility";
import { getCostAnomalyView } from "../../services/cost-anomalies";
import {
  CostAnomalyFeedbackError,
  submitCostAnomalyFeedback,
} from "../../services/cost-anomaly-feedback";
import { logAudit } from "../../services/audit";
import { sessionMiddleware } from "../auth-middleware";
import { safeReturnPath } from "../oauth-state";

const CSRF_COOKIE = "anomaly_feedback_csrf";
const PATH = "/api/anomaly-feedback";

function appUrl(): string {
  return (process.env["APP_URL"] ?? "http://localhost:3000").replace(/\/$/, "");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const isVerdict = (v: string | null | undefined): v is CostAnomalyVerdict =>
  COST_ANOMALY_VERDICTS.includes(v as CostAnomalyVerdict);

function page(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1117; color: #e6e8ee; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { max-width: 28rem; width: 100%; padding: 2rem; background: #171a23; border: 1px solid #2a2f3d; border-radius: 12px; box-sizing: border-box; }
  h1 { font-size: 1.2rem; margin-top: 0; }
  p.hint { color: #9aa1b2; font-size: 0.85rem; }
  label { display: block; font-size: 0.85rem; margin: 0.9rem 0 0.3rem; color: #c3c8d4; }
  select, textarea { width: 100%; box-sizing: border-box; background: #0f1117; color: #e6e8ee; border: 1px solid #2a2f3d; border-radius: 8px; padding: 0.5rem; font: inherit; }
  fieldset { border: 0; padding: 0; margin: 0; display: flex; gap: 1rem; }
  button { margin-top: 1.2rem; background: #4f6df5; color: #fff; border: 0; border-radius: 8px; padding: 0.6rem 1.2rem; font-size: 1rem; cursor: pointer; }
</style>
</head>
<body>
<main>
${inner}
</main>
</body>
</html>`;
}

function errorPage(c: Context, message: string, status: 400 | 403 | 404 = 400) {
  return c.html(
    page("Anomaly feedback", `<h1>Anomaly feedback</h1><p>${escapeHtml(message)}</p>`),
    status,
  );
}

/**
 * Session, membership, permission and the anomaly, or an error response.
 * `costs:write` like the HTTP route; the read happens inside the member's
 * cost visibility, so a scoped member sees "not found" for org-wide findings.
 */
async function resolve(
  c: Context,
  organizationId: string,
  anomalyId: string,
): Promise<{ userId: string; anomaly: CostAnomaly } | Response> {
  const denied = await sessionMiddleware(c, async () => {});
  if (denied instanceof Response) return denied;
  const session = c.get("session");
  if (!session?.userId) return c.json({ error: "Unauthorized" }, 401);
  const access = await resolveEffectivePermissions(organizationId, {
    kind: "user",
    userId: session.userId,
  });
  if (access.permissions.length === 0) {
    return errorPage(c, "You are not a member of the organization this anomaly belongs to.", 403);
  }
  if (!hasPermission(access.permissions, "costs:write")) {
    return errorPage(c, "You need the costs:write permission to give anomaly feedback.", 403);
  }
  const anomaly = await withPrincipalCostVisibility(
    organizationId,
    { userId: session.userId },
    () => getCostAnomalyView(organizationId, anomalyId),
  );
  if (!anomaly) return errorPage(c, "That anomaly no longer exists.", 404);
  return { userId: session.userId, anomaly };
}

const app = new Hono();

app.get("/anomaly-feedback", async (c) => {
  const organizationId = c.req.query("o") ?? "";
  const anomalyId = c.req.query("a") ?? "";
  const verdict = c.req.query("v");
  if (!organizationId || !anomalyId) return errorPage(c, "This link is incomplete.");
  // Signed out: bounce through sign-in and come back here.
  if (!getCookie(c, "wos-session") && !c.req.header("authorization")) {
    const back = `${PATH}?o=${encodeURIComponent(organizationId)}&a=${encodeURIComponent(anomalyId)}${
      isVerdict(verdict) ? `&v=${verdict}` : ""
    }`;
    const returnTo = safeReturnPath(back);
    return c.redirect(`/api/auth/sign-in?return_to=${encodeURIComponent(returnTo ?? "/")}`);
  }
  const resolved = await resolve(c, organizationId, anomalyId);
  if (resolved instanceof Response) return resolved;
  const { anomaly } = resolved;
  const preselected: CostAnomalyVerdict = isVerdict(verdict)
    ? verdict
    : (anomaly.feedback?.verdict ?? "expected");

  const csrf = randomUUID();
  setCookie(c, CSRF_COOKIE, csrf, {
    path: PATH,
    httpOnly: true,
    sameSite: "Lax",
    secure: appUrl().startsWith("https://"),
    maxAge: 15 * 60,
  });

  const option = (value: string, label: string, selected: boolean) =>
    `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
  const reasons = [
    option("", "No reason", !anomaly.feedback?.reason),
    ...COST_ANOMALY_FEEDBACK_REASONS.map((r) =>
      option(r, COST_ANOMALY_FEEDBACK_REASON_LABELS[r], anomaly.feedback?.reason === r),
    ),
  ].join("");
  const recurrences = [
    option("", "Don't suppress future alerts", true),
    ...COST_ANOMALY_RECURRENCES.map((r) => option(r, COST_ANOMALY_RECURRENCE_LABELS[r], false)),
  ].join("");
  const radio = (v: CostAnomalyVerdict, label: string) =>
    `<label><input type="radio" name="verdict" value="${v}"${
      preselected === v ? " checked" : ""
    }> ${label}</label>`;
  const spend = formatMoney(anomaly.actualCents / 100, anomaly.currency);
  const prior = anomaly.feedback
    ? `<p class="hint">Currently marked ${escapeHtml(anomaly.feedback.verdict)}${
        anomaly.feedback.byName ? ` by ${escapeHtml(anomaly.feedback.byName)}` : ""
      } on ${escapeHtml(anomaly.feedback.at.slice(0, 10))}.</p>`
    : "";

  return c.html(
    page(
      "Anomaly feedback",
      `<h1>Was this anomaly expected?</h1>
  <p><strong>${escapeHtml(anomaly.dimensionKey)}</strong> spent ${escapeHtml(spend)} on
  ${escapeHtml(anomaly.day)}.</p>
  ${prior}
  <form method="post" action="${PATH}">
    <input type="hidden" name="o" value="${escapeHtml(organizationId)}">
    <input type="hidden" name="a" value="${escapeHtml(anomalyId)}">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <fieldset>${radio("expected", "Expected")}${radio("unexpected", "Unexpected")}</fieldset>
    <label for="reason">Reason</label>
    <select id="reason" name="reason">${reasons}</select>
    <label for="note">Note</label>
    <textarea id="note" name="note" rows="3" maxlength="500">${escapeHtml(anomaly.feedback?.note ?? "")}</textarea>
    <label for="recurrence">If expected, stop the same pattern alerting</label>
    <select id="recurrence" name="recurrence">${recurrences}</select>
    <p class="hint">Unexpected anomalies keep full sensitivity. File them in Jira or Linear
    from the Costs panel.</p>
    <button type="submit">Save feedback</button>
  </form>`,
    ),
  );
});

app.post("/anomaly-feedback", async (c) => {
  const form = new URLSearchParams(await c.req.text());
  const organizationId = form.get("o") ?? "";
  const anomalyId = form.get("a") ?? "";
  const formCsrf = form.get("csrf") ?? "";
  const cookieCsrf = getCookie(c, CSRF_COOKIE) ?? "";
  if (!formCsrf || !cookieCsrf || !safeEqual(formCsrf, cookieCsrf)) {
    return errorPage(c, "This form expired. Open the link from the alert again.");
  }
  const verdict = form.get("verdict");
  if (!organizationId || !anomalyId || !isVerdict(verdict)) {
    return errorPage(c, "Choose expected or unexpected.");
  }
  const resolved = await resolve(c, organizationId, anomalyId);
  if (resolved instanceof Response) return resolved;
  const { userId } = resolved;

  const rawReason = form.get("reason") ?? "";
  const reason = COST_ANOMALY_FEEDBACK_REASONS.includes(rawReason as CostAnomalyFeedbackReason)
    ? (rawReason as CostAnomalyFeedbackReason)
    : null;
  const note = (form.get("note") ?? "").trim().slice(0, 500) || null;
  const rawRecurrence = form.get("recurrence") ?? "";
  const recurrence = COST_ANOMALY_RECURRENCES.includes(rawRecurrence as CostAnomalyRecurrence)
    ? (rawRecurrence as CostAnomalyRecurrence)
    : null;
  const input: CostAnomalyFeedbackInput = {
    verdict,
    reason,
    note,
    ...(verdict === "expected" && recurrence ? { suppress: { recurrence } } : {}),
  };

  try {
    const result = await withPrincipalCostVisibility(organizationId, { userId }, () =>
      submitCostAnomalyFeedback(organizationId, anomalyId, input, userId),
    );
    if (!result) return errorPage(c, "That anomaly no longer exists.", 404);
    void logAudit({
      organizationId,
      userId,
      action: "cost_anomaly.feedback",
      entityType: "cost_anomaly",
      entityId: result.anomaly.id,
      metadata: {
        day: result.anomaly.day,
        dimension: result.anomaly.dimension,
        dimensionKey: result.anomaly.dimensionKey,
        verdict,
        reason,
        suppressionId: result.suppression?.id ?? null,
        via: "link",
      },
    });
  } catch (e) {
    if (e instanceof CostAnomalyFeedbackError) return errorPage(c, e.message);
    throw e;
  }
  deleteCookie(c, CSRF_COOKIE, { path: PATH });
  return c.redirect(`${appUrl()}/org/${organizationId}/costs`);
});

export { app as anomalyFeedbackLinkRoutes };
