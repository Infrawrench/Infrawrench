/**
 * `/api/ci-notify`: a CI runner's notice that a run changed (see the
 * contract in `@infrawrench/api-contract`, `domains/ci-notify.ts`). The
 * run's token, sent as a bearer key, is the credential; the work is
 * `acceptRunNotice` (server-core `ci/runs.ts`), which follows the run as the
 * poller's pass does and posts its GitHub checks.
 *
 * Served on the edge: following a run is Postgres, the CI proxy and
 * GitHub's API, as the status pass is. It is answered once the run has
 * been followed, not after, so nothing outlives the response; the runner
 * sends a run's notices one at a time, each after the last was answered.
 */
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  CiNotifyApi,
  conflict,
  notFound,
  ServiceUnavailable,
  Unauthorized,
} from "@infrawrench/api-contract";
import { CiNoticeError, acceptRunNotice } from "@infrawrench/server-core/ci/runs";
import { makeDomain } from "../../domain";
import { legacyTry } from "../../legacy";

const refusal = (err: unknown) => {
  if (!(err instanceof CiNoticeError)) return undefined;
  switch (err.status) {
    case 401:
      return new Unauthorized({ error: err.message });
    case 404:
      return notFound(err.message);
    case 409:
      return conflict(err.message);
    case 503:
      return new ServiceUnavailable({ error: err.message });
  }
};

/** The bearer token, or nothing. */
function tokenOf(headers: Record<string, string | undefined>): string {
  const header = headers["authorization"] ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

const CiNotifyHandlers = HttpApiBuilder.group(CiNotifyApi, "ciNotify", (handlers) =>
  handlers.handleRaw("runChanged", ({ params, request }) =>
    Effect.gen(function* () {
      yield* legacyTry(() => acceptRunNotice(params.runId, tokenOf(request.headers)), refusal);
      return HttpServerResponse.empty({ status: 204 });
    }),
  ),
);

export const ciNotifyDomain = makeDomain("ci-notify", CiNotifyApi, CiNotifyHandlers);
