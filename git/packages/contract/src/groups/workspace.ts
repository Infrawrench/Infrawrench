/**
 * `/api/workspace`: the viewer's work across repositories. Everything here
 * is of the repositories they have a tie to (their own, their
 * organisations', the ones they collaborate on), so a private repository
 * they cannot read is in none of it.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiresUser, SuccessDescription } from "../http/annotations";
import { Authentication } from "../http/auth";
import { NamespaceSlug, PageQuery } from "../schemas/common";
import { ChangeList, MentionList, WorkspaceHome } from "../schemas/workspace";

const InNamespace = Schema.optionalKey(
  NamespaceSlug.annotate({
    description:
      "Only this namespace's repositories. One the viewer has no tie to answers as an empty workspace.",
  }),
);

export class WorkspaceGroup extends HttpApiGroup.make("workspace")
  .add(
    HttpApiEndpoint.get("home", "/home", {
      query: {
        namespace: InNamespace,
        days: Schema.optionalKey(
          Schema.Literals(["1", "7", "30"]).annotate({
            description: "How far back `pushed` and `activity` look. 7 when omitted.",
          }),
        ),
      },
      success: WorkspaceHome,
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "The viewer's home")
      .annotate(
        OpenApi.Description,
        "Counts of open branches, the newest of the viewer's and of everyone else's, branches suggested for their review with why, and what happened lately.",
      )
      .annotate(SuccessDescription, "The home page's data"),
    HttpApiEndpoint.get("changes", "/changes", {
      query: {
        ...PageQuery,
        namespace: InNamespace,
        state: Schema.optionalKey(
          Schema.Literals(["open", "merged", "all"]).annotate({
            description: "`open` when omitted.",
          }),
        ),
        author: Schema.optionalKey(
          Schema.Literals(["mine", "team", "all"]).annotate({
            description:
              "`mine`: the viewer wrote it or connected its agent. `team`: everyone else's. `all` when omitted.",
          }),
        ),
      },
      success: ChangeList,
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Branches across the viewer's repositories")
      .annotate(SuccessDescription, "Branches, the most recently active first"),
    HttpApiEndpoint.get("mentions", "/mentions", { query: PageQuery, success: MentionList })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Comments that mention the viewer")
      .annotate(
        OpenApi.Description,
        "Comments and review comments by other people that name the viewer with `@username`, newest first.",
      )
      .annotate(SuccessDescription, "Mentions"),
  )
  .prefix("/api/workspace")
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Workspace") {}
