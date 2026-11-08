/**
 * Anomaly feedback from a link (`/api/anomaly-feedback`), the endpoint
 * definitions: the page behind the Expected / Unexpected buttons on Microsoft
 * Teams anomaly cards.
 *
 * Teams cards arrive through one-way incoming webhooks, so a card button can
 * only open a URL. The URL names the org, the anomaly and the preselected
 * verdict, none of which is a secret: everything is decided by the signed-in
 * session, exactly as the org-tree route decides it. No auth middleware,
 * because every answer is the page's own (a sign-in bounce, an HTML page):
 * the handlers check the session themselves.
 *
 * The GET only renders a small form: a state-changing write must not ride a
 * URL that link unfurlers, prefetchers and mail scanners follow. The write is
 * the POST, guarded by a double-submit CSRF pair (a cookie bound to this
 * browser plus the same value echoed by the form). Both re-check membership,
 * `costs:write`, and the member's cost visibility before touching anything.
 *
 * The hand-written spec never documented the page (a browser is its only
 * caller), so both operations stay out of the document.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { Security } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";

const HtmlPage = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/html" }));

export class AnomalyFeedbackLinkGroup extends HttpApiGroup.make("anomalyFeedbackLink")
  .add(
    HttpApiEndpoint.get("form", "/", { success: HtmlPage })
      .annotate(OpenApi.Summary, "Anomaly feedback form (from a Teams card)")
      .annotate(Security, []),
    HttpApiEndpoint.post("submit", "/", { success: HttpApiSchema.Empty(302) })
      .annotate(OpenApi.Summary, "Save anomaly feedback from the form")
      .annotate(Security, []),
  )
  .prefix("/api/anomaly-feedback")
  .annotate(OpenApi.Title, "Costs")
  // Undocumented, as the hand-written spec left it: no operations, no tag.
  .annotate(OpenApi.Exclude, true) {}

export class AnomalyFeedbackLinkApi extends withApiDefaults(
  HttpApi.make("anomalyFeedbackLink").add(AnomalyFeedbackLinkGroup),
) {}
