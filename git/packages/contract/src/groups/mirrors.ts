/**
 * A repository's push mirrors (`/api/repos/:owner/:repo/mirrors`): all
 * `admin`, and a signed-in person only, since each holds a credential for
 * another host.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  AllowedWhenArchived,
  RequiredAccess,
  RequiresUser,
  SuccessDescription,
} from "../http/annotations";
import { Authentication, RepositoryAccess } from "../http/auth";
import { BadRequest, Conflict, Forbidden, NotFound, UnprocessableEntity } from "../http/errors";
import { Ok, RepoParams } from "../schemas/common";
import { Mirror, MirrorCreate, MirrorUpdate } from "../schemas/mirrors";

const MirrorParams = { ...RepoParams, mirrorId: Schema.String } as const;

export class MirrorsGroup extends HttpApiGroup.make("mirrors")
  .add(
    HttpApiEndpoint.get("list", "/mirrors", {
      params: RepoParams,
      success: Schema.Struct({ mirrors: Schema.Array(Mirror) }),
    })
      .annotate(RequiredAccess, "admin")
      .annotate(RequiresUser, true)
      .annotate(AllowedWhenArchived, true)
      .annotate(OpenApi.Summary, "A repository's push mirrors")
      .annotate(SuccessDescription, "Push mirrors, with each one's last run"),
    HttpApiEndpoint.post("create", "/mirrors", {
      params: RepoParams,
      payload: MirrorCreate,
      success: Mirror,
      error: [BadRequest, Conflict, Forbidden, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "admin")
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Add a push mirror")
      .annotate(
        OpenApi.Description,
        "The target is pushed to at once and after every push here. 422 for an address a mirror may not push to (not HTTPS, not public, with a credential in it) or an exclude pattern that is not one; 409 when the repository already mirrors to that address, or has as many mirrors as it may.",
      )
      .annotate(SuccessDescription, "The mirror"),
    HttpApiEndpoint.patch("update", "/mirrors/:mirrorId", {
      params: MirrorParams,
      payload: MirrorUpdate,
      success: Mirror,
      error: [BadRequest, Conflict, Forbidden, NotFound, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "admin")
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Change a push mirror")
      .annotate(
        OpenApi.Description,
        "A change asks for a run. Changing the address needs the credential again, so a stored one is never sent to a host it was not entered for.",
      )
      .annotate(SuccessDescription, "The mirror"),
    HttpApiEndpoint.delete("delete", "/mirrors/:mirrorId", {
      params: MirrorParams,
      success: Ok,
      error: [Forbidden, NotFound],
    })
      .annotate(RequiredAccess, "admin")
      .annotate(RequiresUser, true)
      .annotate(AllowedWhenArchived, true)
      .annotate(OpenApi.Summary, "Remove a push mirror")
      .annotate(OpenApi.Description, "The target keeps what it has. The credential is deleted.")
      .annotate(SuccessDescription, "Removed"),
    HttpApiEndpoint.post("sync", "/mirrors/:mirrorId/sync", {
      params: MirrorParams,
      success: Mirror,
      error: [Forbidden, NotFound],
    })
      .annotate(RequiredAccess, "admin")
      .annotate(RequiresUser, true)
      .annotate(AllowedWhenArchived, true)
      .annotate(OpenApi.Summary, "Run a push mirror now")
      .annotate(SuccessDescription, "The mirror, owed a run"),
  )
  .prefix("/api/repos/:owner/:repo")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Push mirrors") {}
