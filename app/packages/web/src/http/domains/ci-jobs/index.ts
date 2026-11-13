/**
 * `/api/ci-jobs`: the callback a cloud job's machine calls (see the contract
 * in `@infrawrench/api-contract`, `domains/ci-jobs.ts`). The per-job token
 * in the `X-Infrawrench-Ci-Job` header is the credential (never the URL, so
 * never a request log); the logic, and the relay to the runner, is
 * `server-core/src/ci/cloud-jobs.ts`.
 *
 * A gateway route (`NODE_ROUTES`): the relay writes to Postgres and the CI
 * proxy, and the source archive needs the GitHub App's key.
 */
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { CiJobsApi, conflict, notFound } from "@infrawrench/api-contract";
import { CI_JOB_TOKEN_HEADER } from "@infrawrench/server-core/ci/bootstrap";
import {
  CloudJobCallbackError,
  cloudJobFinish,
  cloudJobLog,
  cloudJobScript,
  cloudJobSource,
} from "@infrawrench/server-core/ci/cloud-jobs";
import { makeDomain } from "../../domain";
import { legacyTry } from "../../legacy";
import { json } from "../../middleware";

/** A log call carries at most this much: the job script sends 512 KiB at a time. */
const MAX_LOG_BYTES = 1_000_000;
/** `$IWCI_OUTPUT` and the changed paths. */
const MAX_FINISH_BYTES = 4_000_000;

const refusal = (err: unknown) =>
  err instanceof CloudJobCallbackError
    ? err.status === 409
      ? conflict(err.message)
      : notFound(err.message)
    : undefined;

/** The job's token, from its header. */
function tokenOf(headers: Record<string, string | undefined>): string {
  return headers[CI_JOB_TOKEN_HEADER.toLowerCase()] ?? "";
}

function query(url: string): URLSearchParams {
  const at = url.indexOf("?");
  return new URLSearchParams(at === -1 ? "" : url.slice(at + 1));
}

const CiJobHandlers = HttpApiBuilder.group(CiJobsApi, "ciJobCallback", (handlers) =>
  handlers
    .handleRaw("script", ({ request }) =>
      Effect.gen(function* () {
        const script = yield* legacyTry(() => cloudJobScript(tokenOf(request.headers)), refusal);
        return HttpServerResponse.text(script, {
          contentType: "text/x-shellscript",
          headers: { "Cache-Control": "no-store" },
        });
      }),
    )
    .handleRaw("source", ({ request }) =>
      Effect.gen(function* () {
        const location = yield* legacyTry(() => cloudJobSource(tokenOf(request.headers)), refusal);
        return HttpServerResponse.empty({
          status: 302,
          headers: { Location: location, "Cache-Control": "no-store" },
        });
      }),
    )
    .handleRaw("log", ({ request }) =>
      Effect.gen(function* () {
        const text = yield* Effect.orDie(request.text);
        if (text.length > MAX_LOG_BYTES) return json({ error: "Too large" }, 413);
        const stream = query(request.url).get("stream") === "stderr" ? "stderr" : "stdout";
        yield* legacyTry(() => cloudJobLog(tokenOf(request.headers), stream, text), refusal);
        return HttpServerResponse.empty({ status: 204 });
      }),
    )
    .handleRaw("finish", ({ request }) =>
      Effect.gen(function* () {
        const body = yield* Effect.orDie(request.text);
        if (body.length > MAX_FINISH_BYTES) return json({ error: "Too large" }, 413);
        const q = query(request.url);
        const status = q.get("status");
        const exitCode = Number(q.get("exit") ?? "0");
        yield* legacyTry(
          () =>
            cloudJobFinish(tokenOf(request.headers), {
              status: status === "passed" || status === "failed" ? status : "error",
              exitCode: Number.isInteger(exitCode) ? exitCode : 1,
              timedOut: q.get("timed_out") === "1",
              body,
            }),
          refusal,
        );
        return HttpServerResponse.empty({ status: 204 });
      }),
    ),
);

export const ciJobsDomain = makeDomain("ci-jobs", CiJobsApi, CiJobHandlers);
