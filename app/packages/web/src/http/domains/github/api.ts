/**
 * GitHub App connect and repo listing for git-triggered workflows, the
 * endpoint definitions.
 *
 * - `github` (`/api/org/:orgId/github`): report connection status, hand back
 *   the install URL (with a signed `state` binding the install to this org
 *   and the requesting user), list the repos the org's installations can
 *   access, and drop a connection.
 * - `githubSetup` (`/api/github/setup`): GitHub redirects the browser here
 *   after the user installs or configures the app. Outside the org tree and
 *   with no auth middleware, because its answers are all redirects: it checks
 *   the session itself (bouncing a signed-out browser through sign-in) and
 *   verifies the installation over the GitHub App user-authorization flow.
 *
 * The hand-written spec never documented any of these (the web and desktop
 * apps are their only callers), so every operation stays out of the document.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { RequiredPermission, Security } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { OrgParams } from "../../schemas/common";

/** The permission connecting a GitHub installation takes, checked at both ends. */
export const CONNECT_PERMISSION = "dashboards:write";

export class GithubGroup extends HttpApiGroup.make("github")
  .add(
    HttpApiEndpoint.get("status", "/status", { params: OrgParams, success: Schema.Unknown })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "GitHub App connection status"),
    HttpApiEndpoint.get("installUrl", "/install-url", {
      params: OrgParams,
      success: Schema.Unknown,
      error: BadRequest,
    })
      .annotate(RequiredPermission, CONNECT_PERMISSION)
      .annotate(OpenApi.Summary, "GitHub App install URL"),
    HttpApiEndpoint.get("repos", "/repos", { params: OrgParams, success: Schema.Unknown })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "Repositories the organization's installations can access"),
    HttpApiEndpoint.delete("disconnect", "/installations/:installationId", {
      params: { ...OrgParams, installationId: Schema.String },
      success: Schema.Unknown,
    })
      .annotate(RequiredPermission, CONNECT_PERMISSION)
      .annotate(OpenApi.Summary, "Disconnect a GitHub App installation"),
  )
  .prefix("/api/org/:orgId/github")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "GitHub")
  // Undocumented, as the hand-written spec left it: no operations, no tag.
  .annotate(OpenApi.Exclude, true) {}

export class GithubSetupGroup extends HttpApiGroup.make("githubSetup")
  .add(
    HttpApiEndpoint.get("setup", "/setup", { success: HttpApiSchema.Empty(302) })
      .annotate(OpenApi.Summary, "GitHub App setup and authorization callback")
      .annotate(Security, []),
  )
  .prefix("/api/github")
  .annotate(OpenApi.Title, "GitHub")
  // Undocumented, as the hand-written spec left it: no operations, no tag.
  .annotate(OpenApi.Exclude, true) {}

export class GithubApi extends withApiDefaults(
  HttpApi.make("github").add(GithubGroup).add(GithubSetupGroup),
) {}
