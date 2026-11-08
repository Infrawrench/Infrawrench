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
 * The org group is documented: its answers are what the web and desktop git
 * trigger and agent repo pickers read. The setup callback stays out of the
 * document, since its every answer is a browser redirect.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { RequiredPermission, Security, SuccessDescription } from "../http/annotations";
import { documentedAs } from "../http/schemas/documented";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { Ok, OrgParams } from "../http/schemas/common";

/** The permission connecting a GitHub installation takes, checked at both ends. */
export const CONNECT_PERMISSION = "dashboards:write";

export const GithubAppStatus = Schema.Struct({
  configured: Schema.Boolean.annotate({
    description: "Whether this server has a GitHub App configured at all.",
  }),
  appSlug: Schema.NullOr(Schema.String).annotate({
    description: "The GitHub App's slug, as in `github.com/apps/<slug>`.",
  }),
  installations: Schema.Array(
    Schema.Struct({
      installationId: Schema.Int,
      accountLogin: Schema.NullOr(Schema.String).annotate({
        description: "The GitHub user or organization the app is installed on.",
      }),
    }),
  ).annotate({ description: "The organization's connected installations." }),
}).annotate({ identifier: "GithubAppStatus" });

export const GithubInstallUrl = Schema.Struct({
  url: Schema.String.annotate({
    description:
      "GitHub's install page for the app, carrying a signed state bound to this organization and the caller.",
  }),
}).annotate({ identifier: "GithubInstallUrl" });

export const GithubAppRepos = Schema.Struct({
  repos: Schema.Array(
    Schema.Struct({
      installationId: Schema.Int,
      id: Schema.Int,
      fullName: Schema.String.annotate({ examples: ["acme/infra"] }),
      defaultBranch: Schema.String,
      private: Schema.Boolean,
    }),
  ).annotate({
    description:
      "Every repository the organization's installations can access, by full name. An installation GitHub refused to list is left out.",
  }),
}).annotate({ identifier: "GithubAppRepos" });

export class GithubGroup extends HttpApiGroup.make("github")
  .add(
    HttpApiEndpoint.get("status", "/status", { params: OrgParams, success: GithubAppStatus })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "GitHub App connection status")
      .annotate(SuccessDescription, "Status"),
    HttpApiEndpoint.get("installUrl", "/install-url", {
      params: OrgParams,
      query: {
        // Read as sent: a page not on the list returns to the agents page.
        return: Schema.optionalKey(
          documentedAs(
            Schema.Literals(["agents", "workflows", "settings/github-issues"]).annotate({
              description:
                "The page (under the organization) the install flow returns to. Anything else: `agents`.",
            }),
          ),
        ),
      },
      success: GithubInstallUrl,
      error: BadRequest,
    })
      .annotate(RequiredPermission, CONNECT_PERMISSION)
      .annotate(OpenApi.Summary, "GitHub App install URL")
      .annotate(SuccessDescription, "Install URL"),
    HttpApiEndpoint.get("repos", "/repos", { params: OrgParams, success: GithubAppRepos })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "Repositories the organization's installations can access")
      .annotate(SuccessDescription, "Repositories"),
    HttpApiEndpoint.delete("disconnect", "/installations/:installationId", {
      params: { ...OrgParams, installationId: Schema.String },
      success: Ok,
    })
      .annotate(RequiredPermission, CONNECT_PERMISSION)
      .annotate(OpenApi.Summary, "Disconnect a GitHub App installation")
      .annotate(
        OpenApi.Description,
        "Drops the connection here; the app stays installed on GitHub until uninstalled there.",
      )
      .annotate(SuccessDescription, "Disconnected"),
  )
  .prefix("/api/org/:orgId/github")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "GitHub") {}

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
