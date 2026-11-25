/**
 * Namespaces: a user's or an organisation's page, an organisation claiming
 * its namespace, and looking people up by name.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  HandlerGate,
  RequiredOrgPermission,
  RequiresUser,
  SuccessDescription,
} from "../http/annotations";
import { Authentication } from "../http/auth";
import { BadRequest, Conflict, NotFound } from "../http/errors";
import { NamespaceSlug, Uuid } from "../schemas/common";
import { Namespace, NamespaceUpdate, UserRef } from "../schemas/people";

const NamespaceParams = { namespace: NamespaceSlug } as const;
const SlugBody = Schema.Struct({ slug: Schema.String });

export class NamespacesGroup extends HttpApiGroup.make("namespaces")
  .add(
    HttpApiEndpoint.get("get", "/namespaces/:namespace", {
      params: NamespaceParams,
      success: Namespace,
      error: NotFound,
    })
      .annotate(OpenApi.Summary, "A user's or an organisation's profile")
      .annotate(SuccessDescription, "The namespace"),
    HttpApiEndpoint.patch("update", "/namespaces/:namespace", {
      params: NamespaceParams,
      payload: NamespaceUpdate,
      success: Namespace,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The namespace's own user, or `git:admin` in its organisation.")
      .annotate(OpenApi.Summary, "Edit a profile")
      .annotate(SuccessDescription, "The namespace"),
    HttpApiEndpoint.post("claimForOrganization", "/orgs/:orgId/namespace", {
      params: { orgId: Uuid.annotate({ description: "Infrawrench organisation id" }) },
      payload: SlugBody,
      success: Namespace,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredOrgPermission, "git:admin")
      .annotate(OpenApi.Summary, "Claim an organisation's namespace")
      .annotate(
        OpenApi.Description,
        "409 `namespace_taken` when the slug is in use, 409 `namespace_already_claimed` when the organisation has one.",
      )
      .annotate(SuccessDescription, "The namespace"),
    HttpApiEndpoint.put("renameForOrganization", "/orgs/:orgId/namespace", {
      params: { orgId: Uuid.annotate({ description: "Infrawrench organisation id" }) },
      payload: SlugBody,
      success: Namespace,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredOrgPermission, "git:admin")
      .annotate(OpenApi.Summary, "Rename an organisation's namespace")
      .annotate(SuccessDescription, "The namespace"),
    HttpApiEndpoint.get("searchUsers", "/users", {
      query: {
        q: Schema.String.annotate({ description: "The start of a username or display name." }),
        repository: Schema.optionalKey(
          Schema.String.annotate({
            description:
              "`owner/name`: rank people who can reach this repository first (for assignee and collaborator pickers).",
          }),
        ),
      },
      success: Schema.Struct({ users: Schema.Array(UserRef) }),
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Find people by username")
      .annotate(
        OpenApi.Description,
        "Only people who have claimed a username, and at most ten of them.",
      )
      .annotate(SuccessDescription, "People"),
  )
  .prefix("/api")
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Namespaces") {}
