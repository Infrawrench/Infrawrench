/**
 * Anomaly feedback from a link, the handlers. Both halves resolve the
 * signed-in member themselves, then read and write inside that member's cost
 * visibility through `withPrincipalCostVisibility` (in promise code, under
 * `legacy`), so a scoped member sees "not found" for org-wide findings.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Duration, Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  COST_ANOMALY_FEEDBACK_REASONS,
  COST_ANOMALY_FEEDBACK_REASON_LABELS,
  COST_ANOMALY_RECURRENCES,
  COST_ANOMALY_RECURRENCE_LABELS,
  COST_ANOMALY_VERDICTS,
  formatMoney,
  type CostAnomaly,
  type CostAnomalyFeedbackInput,
  type CostAnomalyVerdict,
} from "@infrawrench/client-core";
import { resolveEffectivePermissions } from "@infrawrench/server-core/permissions";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { AnomalyFeedbackLinkApi } from "@infrawrench/api-contract";
import { safeReturnPath } from "../../../api/oauth-state";
import { withPrincipalCostVisibility } from "../../../auth/cost-visibility";
import { getCostAnomalyView } from "../../../services/cost-anomalies";
import {
  CostAnomalyFeedbackError,
  submitCostAnomalyFeedback,
} from "../../../services/cost-anomaly-feedback";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { failureResponse, json } from "../../middleware";
import { SESSION_COOKIE } from "../../session-cookie";
import { sessionPerson } from "../../session-person";

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
  COST_ANOMALY_VERDICTS.some((verdict) => verdict === v);

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

/** Hono's `c.html(body, status)`, byte for byte. */
const html = (body: string, status = 200) =>
  HttpServerResponse.text(body, { status, contentType: "text/html; charset=UTF-8" });

function errorPage(message: string, status: 400 | 403 | 404 = 400) {
  return html(
    page("Anomaly feedback", `<h1>Anomaly feedback</h1><p>${escapeHtml(message)}</p>`),
    status,
  );
}

type Resolved =
  | { readonly ok: true; readonly userId: string; readonly anomaly: CostAnomaly }
  | { readonly ok: false; readonly response: HttpServerResponse.HttpServerResponse };

const refuse = (response: HttpServerResponse.HttpServerResponse): Resolved => ({
  ok: false,
  response,
});

/**
 * Session, membership, permission and the anomaly, or the response to send
 * instead. `costs:write` like the org-tree route; the read happens inside the
 * member's cost visibility, so a scoped member sees "not found" for org-wide
 * findings.
 */
const resolve = Effect.fnUntraced(function* (organizationId: string, anomalyId: string) {
  const person = yield* Effect.result(sessionPerson);
  if (person._tag === "Failure") return refuse(failureResponse(person.failure));
  const userId = person.success.userId;
  if (!userId) return refuse(json({ error: "Unauthorized" }, 401));
  const access = yield* legacy(() =>
    resolveEffectivePermissions(organizationId, { kind: "user", userId }),
  );
  if (access.permissions.length === 0) {
    return refuse(
      errorPage("You are not a member of the organization this anomaly belongs to.", 403),
    );
  }
  if (!hasPermission(access.permissions, "costs:write")) {
    return refuse(errorPage("You need the costs:write permission to give anomaly feedback.", 403));
  }
  const anomaly = yield* legacy(() =>
    withPrincipalCostVisibility(organizationId, { userId }, () =>
      getCostAnomalyView(organizationId, anomalyId),
    ),
  );
  if (!anomaly) return refuse(errorPage("That anomaly no longer exists.", 404));
  const resolved: Resolved = { ok: true, userId, anomaly };
  return resolved;
});

/** The query string of a request URL, which HttpApi hands over as a path. */
const searchParams = (url: string) => new URL(url, "http://localhost").searchParams;

const AnomalyFeedbackLinkHandlers = HttpApiBuilder.group(
  AnomalyFeedbackLinkApi,
  "anomalyFeedbackLink",
  (h) =>
    h
      .handle("form", ({ request }) =>
        Effect.gen(function* () {
          const query = searchParams(request.url);
          const organizationId = query.get("o") ?? "";
          const anomalyId = query.get("a") ?? "";
          const verdict = query.get("v");
          if (!organizationId || !anomalyId) return errorPage("This link is incomplete.");
          // Signed out: bounce through sign-in and come back here.
          if (!request.cookies[SESSION_COOKIE] && !request.headers["authorization"]) {
            const back = `${PATH}?o=${encodeURIComponent(organizationId)}&a=${encodeURIComponent(anomalyId)}${
              isVerdict(verdict) ? `&v=${verdict}` : ""
            }`;
            const returnTo = safeReturnPath(back);
            return HttpServerResponse.redirect(
              `/api/auth/sign-in?return_to=${encodeURIComponent(returnTo ?? "/")}`,
            );
          }
          const resolved = yield* resolve(organizationId, anomalyId);
          if (!resolved.ok) return resolved.response;
          const { anomaly } = resolved;
          const preselected: CostAnomalyVerdict = isVerdict(verdict)
            ? verdict
            : (anomaly.feedback?.verdict ?? "expected");

          const csrf = randomUUID();

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
            ...COST_ANOMALY_RECURRENCES.map((r) =>
              option(r, COST_ANOMALY_RECURRENCE_LABELS[r], false),
            ),
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

          const response = html(
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
          return HttpServerResponse.setCookieUnsafe(response, CSRF_COOKIE, csrf, {
            path: PATH,
            httpOnly: true,
            sameSite: "lax",
            secure: appUrl().startsWith("https://"),
            maxAge: Duration.minutes(15),
          });
        }),
      )
      .handleRaw("submit", ({ request }) =>
        Effect.gen(function* () {
          // The form posts `application/x-www-form-urlencoded`, read as text
          // here as the Hono route read it (nothing decoded it ahead of us).
          const form = new URLSearchParams(yield* Effect.orDie(request.text));
          const organizationId = form.get("o") ?? "";
          const anomalyId = form.get("a") ?? "";
          const formCsrf = form.get("csrf") ?? "";
          const cookieCsrf = request.cookies[CSRF_COOKIE] ?? "";
          if (!formCsrf || !cookieCsrf || !safeEqual(formCsrf, cookieCsrf)) {
            return errorPage("This form expired. Open the link from the alert again.");
          }
          const verdict = form.get("verdict");
          if (!organizationId || !anomalyId || !isVerdict(verdict)) {
            return errorPage("Choose expected or unexpected.");
          }
          const resolved = yield* resolve(organizationId, anomalyId);
          if (!resolved.ok) return resolved.response;
          const { userId } = resolved;

          const rawReason = form.get("reason") ?? "";
          const reason = COST_ANOMALY_FEEDBACK_REASONS.find((r) => r === rawReason) ?? null;
          const note = (form.get("note") ?? "").trim().slice(0, 500) || null;
          const rawRecurrence = form.get("recurrence") ?? "";
          const recurrence = COST_ANOMALY_RECURRENCES.find((r) => r === rawRecurrence) ?? null;
          const input: CostAnomalyFeedbackInput = {
            verdict,
            reason,
            note,
            ...(verdict === "expected" && recurrence ? { suppress: { recurrence } } : {}),
          };

          const submitted = yield* Effect.result(
            legacyTry(
              () =>
                withPrincipalCostVisibility(organizationId, { userId }, () =>
                  submitCostAnomalyFeedback(organizationId, anomalyId, input, userId),
                ),
              (e) => (e instanceof CostAnomalyFeedbackError ? e : undefined),
            ),
          );
          if (submitted._tag === "Failure") return errorPage(submitted.failure.message);
          const result = submitted.success;
          if (!result) return errorPage("That anomaly no longer exists.", 404);
          yield* fireAndForget(() =>
            logAudit({
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
            }),
          );
          // Cleared byte for byte as Hono's `deleteCookie(c, name, { path })`:
          // `Max-Age=0`, no `Expires`.
          return HttpServerResponse.setCookieUnsafe(
            HttpServerResponse.redirect(`${appUrl()}/org/${organizationId}/costs`),
            CSRF_COOKIE,
            "",
            { path: PATH, maxAge: 0 },
          );
        }),
      ),
);

export const anomalyFeedbackLinkDomain = makeDomain(
  "anomaly-feedback-link",
  AnomalyFeedbackLinkApi,
  AnomalyFeedbackLinkHandlers,
);
