/**
 * `/api/ci-jobs`: the callback a cloud job's machine calls.
 *
 * A cloud job (`cloud:` in a pipeline) runs on a machine in one of the
 * organization's connected accounts. The machine starts with only this URL;
 * the token it sends in the `X-Infrawrench-Ci-Job` header (64 hex
 * digits, random per job, stored only as a hash; never in a URL, so never in
 * a request log) is the credential. It fetches the job script once, the commit's source, and
 * posts its output and result, which Infrawrench relays to the runner. Every
 * route answers 409 once the job has ended, which tells the machine to stop.
 *
 * Called by machines, not by clients, so left out of the published spec.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { Security } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, NotFound } from "../http/errors";

const Script = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/x-shellscript" }));
const errors = [BadRequest, NotFound, Conflict] as const;

export class CiJobCallbackGroup extends HttpApiGroup.make("ciJobCallback")
  .add(
    HttpApiEndpoint.get("script", "/api/ci-jobs/script", {
      success: Script,
      error: errors,
    })
      .annotate(OpenApi.Summary, "A cloud job's script, once")
      .annotate(Security, []),
    HttpApiEndpoint.get("source", "/api/ci-jobs/source", {
      success: HttpApiSchema.NoContent,
      error: errors,
    })
      .annotate(OpenApi.Summary, "A redirect to the commit's source archive")
      .annotate(Security, []),
    HttpApiEndpoint.post("log", "/api/ci-jobs/log", {
      success: HttpApiSchema.NoContent,
      error: errors,
    })
      .annotate(OpenApi.Summary, "Output from a cloud job, or a heartbeat")
      .annotate(Security, []),
    HttpApiEndpoint.post("finish", "/api/ci-jobs/finish", {
      success: HttpApiSchema.NoContent,
      error: errors,
    })
      .annotate(OpenApi.Summary, "How a cloud job ended")
      .annotate(Security, []),
  )
  .annotate(OpenApi.Title, "CI cloud jobs")
  .annotate(OpenApi.Exclude, true) {}

export class CiJobsApi extends withApiDefaults(HttpApi.make("ciJobs").add(CiJobCallbackGroup)) {}
