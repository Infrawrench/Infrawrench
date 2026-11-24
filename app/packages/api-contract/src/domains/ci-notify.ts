/**
 * `/api/ci-notify`: where a CI runner tells Infrawrench that a run changed.
 *
 * Each run is dispatched with `notify`, this route for that run and a token
 * (server-core `ci/notify.ts`). The runner that has the run posts here as
 * its pipelines and jobs start and end, and once it has ended, so the run
 * and its GitHub checks are brought up to date within a second rather than
 * on the poller's next pass. The token, sent as a bearer key, is the
 * credential; a notice carries nothing else that is trusted, since the run
 * is then read from the CI proxy as always. `409` and `503` are answers the
 * runner tries the notice of a run's end again on.
 *
 * Called by runners, not by clients, so left out of the published spec.
 */
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { Security } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, NotFound, ServiceUnavailable, Unauthorized } from "../http/errors";
import { Uuid } from "../http/schemas/common";

export class CiNotifyGroup extends HttpApiGroup.make("ciNotify")
  .add(
    HttpApiEndpoint.post("runChanged", "/api/ci-notify/runs/:runId", {
      params: { runId: Uuid },
      success: HttpApiSchema.NoContent,
      error: [BadRequest, Unauthorized, NotFound, Conflict, ServiceUnavailable],
    })
      .annotate(OpenApi.Summary, "A runner's notice that a CI run changed")
      .annotate(Security, []),
  )
  .annotate(OpenApi.Title, "CI run notices")
  .annotate(OpenApi.Exclude, true) {}

export class CiNotifyApi extends withApiDefaults(HttpApi.make("ciNotify").add(CiNotifyGroup)) {}
