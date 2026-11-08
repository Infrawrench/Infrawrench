/**
 * Cross-cloud access review: `/api/org/:orgId/access-review`, the handlers.
 *
 * The review is assembled in server-core (`access-review/feed.ts`) so the web
 * API, the CSV export, the weekly digest and the poller's alert pass share one
 * computation: a read over already-synced state, no provider API calls. There
 * is no settings route; its critical and high findings ride the posture alert
 * window (`/posture/settings`).
 */
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  accessReviewToCsv,
  normalizeStaleDays,
  ACCESS_REVIEW_STALE_DAYS_MAX,
  ACCESS_REVIEW_STALE_DAYS_MIN,
} from "@infrawrench/client-core";
import { listAccessReview } from "@infrawrench/server-core/access-review/feed";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { badRequest } from "../../errors";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { AccessReviewApi, AccessReviewDismissal, AccessReviewResponse } from "./api";
import { dismissFinding, restoreFinding } from "./dismissals";

/**
 * Read `?staleDays=`. An absent value takes the shared default; a present but
 * unparseable one is an error rather than a silent fallback, because the
 * window is printed on the screen and a caller that asked for 30 and got 90
 * would be reading a report it did not request.
 */
const readStaleDays = (raw: string | undefined) => {
  if (raw === undefined || raw === "") return Effect.succeed(normalizeStaleDays(undefined));
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return Effect.fail(badRequest("staleDays must be a number"));
  if (parsed < ACCESS_REVIEW_STALE_DAYS_MIN || parsed > ACCESS_REVIEW_STALE_DAYS_MAX) {
    return Effect.fail(
      badRequest(
        `staleDays must be between ${ACCESS_REVIEW_STALE_DAYS_MIN} and ${ACCESS_REVIEW_STALE_DAYS_MAX}`,
      ),
    );
  }
  return Effect.succeed(normalizeStaleDays(parsed));
};

const AccessReviewHandlers = HttpApiBuilder.group(AccessReviewApi, "accessReview", (handlers) =>
  handlers
    .handle("review", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const staleDays = yield* readStaleDays(query.staleDays);
        const review = yield* legacy(() => listAccessReview(organizationId, { staleDays }));
        return yield* respond(AccessReviewResponse)(review);
      }),
    )
    /**
     * The review as a downloadable evidence file. Its own route because it
     * answers with a different content type and a `Content-Disposition`, and
     * an auditor's link should be a URL you can paste into a ticket.
     * Dismissed findings are included and labelled in both formats.
     */
    .handle("export", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const staleDays = yield* readStaleDays(query.staleDays);
        const format = query.format ?? "csv";
        if (format !== "csv" && format !== "json") {
          return yield* badRequest('format must be "csv" or "json"');
        }

        const review = yield* legacy(() => listAccessReview(organizationId, { staleDays }));
        // The date is in the filename so a folder of these sorts and an auditor
        // can see which one is current without opening any of them.
        const stamp = review.generatedAt.slice(0, 10);
        const filename = `access-review-${stamp}.${format}`;

        // Exporting the review discloses who holds standing access across every
        // connected account: worth an audit row even though the screen shows it.
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "access_review.exported",
            entityType: "organization",
            entityId: organizationId,
            metadata: {
              format,
              staleDays,
              principals: review.principals.length,
              findings: review.totalCount,
              dismissed: review.dismissedCount,
            },
          }),
        );

        const headers = { "content-disposition": `attachment; filename="${filename}"` };
        return format === "json"
          ? HttpServerResponse.text(JSON.stringify(review, null, 2), {
              contentType: "application/json; charset=utf-8",
              headers,
            })
          : HttpServerResponse.text(accessReviewToCsv(review), {
              contentType: "text/csv; charset=utf-8",
              headers,
            });
      }),
    )
    .handleRaw("dismiss", ({ request }) =>
      dismissFinding("access_review", request).pipe(Effect.flatMap(respond(AccessReviewDismissal))),
    )
    .handle("restore", ({ query }) => restoreFinding("access_review", query)),
);

export const accessReviewDomain = makeDomain("accessReview", AccessReviewApi, AccessReviewHandlers);
