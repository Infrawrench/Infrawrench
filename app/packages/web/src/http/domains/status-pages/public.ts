/**
 * The public status page reader (`GET /api/status/:slug`), on its own so the
 * boundary is visible in the imports: this module reaches the public payload
 * assembler and nothing else. No session, no org, no credential; the slug is
 * the only thing the caller supplies.
 *
 * Caching is short and public on purpose: a status page is exactly the thing
 * that gets hammered during an incident, and a minute of CDN cache is the
 * difference between the page absorbing that traffic and the database doing
 * it. A minute is also short enough that a recovery shows up promptly.
 */
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { getPublicStatusPage } from "@infrawrench/server-core/status-pages/store";
import { HttpFailure, notFound } from "../../errors";
import { legacy } from "../../legacy";
import { respond } from "../../response";
import { PublicStatusPage, StatusPagesApi } from "./api";

export const PublicStatusHandlers = HttpApiBuilder.group(StatusPagesApi, "publicStatus", (h) =>
  h.handle("read", ({ params }) =>
    Effect.gen(function* () {
      const page = yield* legacy(() => getPublicStatusPage(params.slug)).pipe(
        Effect.catchDefect((defect) => {
          console.error("[status-pages] public read failed:", defect);
          return Effect.die(new HttpFailure(500, { error: "Status page unavailable" }));
        }),
      );
      if (!page) return yield* notFound("Status page not found");
      const response = yield* respond(PublicStatusPage)(page);
      return HttpServerResponse.setHeaders(response, {
        "Cache-Control": "public, max-age=60",
        // No account, no org: nothing here is per-user, and a search engine
        // indexing a status page someone was given privately is not intended.
        "X-Robots-Tag": "noindex",
      });
    }),
  ),
);
