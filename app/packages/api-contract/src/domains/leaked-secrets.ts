/**
 * Leaked credentials: `/api/org/:orgId/leaked-secrets`, the endpoint
 * definitions. Secrets a scanner plugin found committed to code, and the
 * actions that close them.
 *
 * Reading is `resources:read`, the posture stance (the list shows where a
 * secret leaked and a four-character hint, never the value). Every action is
 * `secrets:write`: rotating reissues or replaces a stored secret, and
 * dismissing decides one does not need it. The mutations are gateway-routed
 * (`edge/gateway-routes.ts`) because they call plugin code.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { maxLength } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgIdParams, OrgParams, Uuid } from "../http/schemas/common";
import { documentedAs, optionalRequestBody } from "../http/schemas/documented";

const LeakStatus = Schema.Literals(["open", "rotated", "dismissed", "resolved"]).annotate({
  description:
    "`open` needs rotating; `rotated` was rotated through Infrawrench or detected because the " +
    "stored value changed; `dismissed` was accepted as not a risk; `resolved` was closed on the " +
    "scanner by someone else before it was rotated here.",
});

const DismissReason = Schema.Literals(["false-positive", "wont-fix", "used-in-tests"]);

const LeakedSecret = Schema.Struct({
  id: Uuid,
  status: LeakStatus,
  scannerAccountId: Uuid.annotate({
    description: "The scanner account (GitHub, GitLab) the finding came from.",
  }),
  scannerAccountName: Schema.String,
  scannerPluginId: Schema.String,
  tokenType: Schema.String.annotate({
    description: "The scanner's identifier for the token type.",
    examples: ["github_personal_access_token"],
  }),
  tokenTypeLabel: Schema.String,
  ownerPluginId: Schema.NullOr(Schema.String).annotate({
    description: "The plugin that issues this kind of token.",
  }),
  ownerPluginName: Schema.NullOr(Schema.String),
  secretHint: Schema.NullOr(Schema.String).annotate({
    description:
      "At most the first and last four characters. The secret itself is never stored or returned.",
  }),
  repository: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  line: Schema.NullOr(Schema.Int),
  commitSha: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String).annotate({ description: "The finding on the scanner." }),
  upstreamState: Schema.Literals(["open", "resolved"]),
  upstreamResolution: Schema.NullOr(Schema.String),
  validity: Schema.NullOr(Schema.Literals(["active", "inactive", "unknown"])),
  publiclyLeaked: Schema.Boolean,
  detectedAt: IsoDateTime,
  firstSeenAt: IsoDateTime,
  matchKind: Schema.Literals(["account", "secret-field", "output", "none"]).annotate({
    description:
      "What the leak was matched to: an account credential, a secret stored on a resource, a " +
      "resource output other resources reference, or nothing Infrawrench holds.",
  }),
  matchConfidence: Schema.Literals(["fingerprint", "token-type", "none"]).annotate({
    description:
      "`fingerprint`: the leaked value equals a stored one (compared by keyed hash, never by " +
      "value). `token-type`: the scanner withheld the value, so only the token's issuer is known.",
  }),
  matchedAccountId: Schema.NullOr(Schema.String),
  matchedAccountName: Schema.NullOr(Schema.String),
  matchedResourceId: Schema.NullOr(Schema.String),
  matchedResourceName: Schema.NullOr(Schema.String),
  matchedResourceTypeId: Schema.NullOr(Schema.String),
  matchedPluginId: Schema.NullOr(Schema.String),
  matchedFieldKey: Schema.NullOr(Schema.String),
  candidateAccountIds: Schema.Array(Schema.String).annotate({
    description: "Accounts it may belong to when a token-type match is ambiguous.",
  }),
  rotation: Schema.Struct({
    mode: Schema.Literals(["reissue", "replace", "account", "manual"]).annotate({
      description:
        "`reissue`: one call rotates it. `replace`: send the new value. `account`: rotate it at " +
        "the provider and update the account; the change is detected. `manual`: rotate it at " +
        "the provider and mark it rotated.",
    }),
    manageUrl: Schema.NullOr(Schema.String).annotate({
      description: "The provider's own key management page.",
    }),
  }),
  rotatedAt: Schema.NullOr(IsoDateTime),
  rotatedBy: Schema.NullOr(Schema.String),
  rotationMethod: Schema.NullOr(Schema.Literals(["reissued", "replaced", "detected", "manual"])),
  dismissedReason: Schema.NullOr(DismissReason),
  dismissedComment: Schema.NullOr(Schema.String),
  dismissedAt: Schema.NullOr(IsoDateTime),
  dismissedBy: Schema.NullOr(Schema.String),
  upstreamResolvedAt: Schema.NullOr(IsoDateTime),
  upstreamResolveError: Schema.NullOr(Schema.String),
  canResolveUpstream: Schema.Boolean,
}).annotate({ identifier: "LeakedSecret" });

const LeakedSecretScanner = Schema.Struct({
  accountId: Uuid,
  accountName: Schema.String,
  pluginId: Schema.String,
  label: Schema.String,
  canResolve: Schema.Boolean,
  returnsSecretValue: Schema.Boolean,
  lastScannedAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  lastCount: Schema.NullOr(Schema.Int),
  lastPartial: Schema.Boolean.annotate({
    description:
      "The last scan read only part of the scanner's findings (more than one scan reads, or some could not be read), so a leak may be missing from the list.",
  }),
}).annotate({ identifier: "LeakedSecretScanner" });

export const LeakedSecretList = Schema.Struct({
  leaks: Schema.Array(LeakedSecret).annotate({
    description: "Open first, newest first within a status. At most 500.",
  }),
  counts: Schema.Struct({
    open: Schema.Int,
    rotated: Schema.Int,
    dismissed: Schema.Int,
    resolved: Schema.Int,
  }),
  scanners: Schema.Array(LeakedSecretScanner),
  generatedAt: IsoDateTime,
}).annotate({ identifier: "LeakedSecretList" });

export const LeakedSecretResponse = Schema.Struct({ leak: LeakedSecret }).annotate({
  identifier: "LeakedSecretResponse",
});

export const LeakedSecretScanResult = Schema.Struct({
  scanned: Schema.Int,
  newLeaks: Schema.Int,
  errors: Schema.Int,
}).annotate({ identifier: "LeakedSecretScanResult" });

const ResolveUpstream = Schema.optionalKey(
  Schema.Boolean.annotate({
    description: "Close the finding on the scanner afterwards, when it can. Defaults to true.",
  }),
);

/** The action bodies are documented; the handlers check each field themselves. */
const LeakedSecretRotate = Schema.Struct({
  value: Schema.optionalKey(
    Schema.String.annotate({ description: "The new value, for a `replace` rotation." }),
  ),
  resolveUpstream: ResolveUpstream,
}).annotate({ identifier: "LeakedSecretRotate" });

const LeakedSecretMarkRotated = Schema.Struct({ resolveUpstream: ResolveUpstream }).annotate({
  identifier: "LeakedSecretMarkRotated",
});

const LeakedSecretDismiss = Schema.Struct({
  reason: DismissReason,
  comment: Schema.optionalKey(Schema.String.check(maxLength(500))),
  resolveUpstream: ResolveUpstream,
}).annotate({ identifier: "LeakedSecretDismiss" });

const actionErrors = [BadRequest, NotFound, Conflict] as const;

export class LeakedSecretsGroup extends HttpApiGroup.make("leakedSecrets")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      query: {
        status: Schema.optionalKey(documentedAs(LeakStatus)),
        accountId: Schema.optionalKey(
          Schema.String.annotate({
            description: "Only leaks matched to, or possibly belonging to, this account.",
          }),
        ),
      },
      success: LeakedSecretList,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List leaked credentials")
      .annotate(
        OpenApi.Description,
        "Secrets a scanner account (GitHub secret scanning, GitLab secret detection) found committed " +
          "to code, attributed to the account or stored secret they belong to. Read from the last scan; " +
          "no provider call is made.",
      )
      .annotate(SuccessDescription, "Leaks and scanners"),
    HttpApiEndpoint.post("scan", "/scan", {
      params: OrgParams,
      success: LeakedSecretScanResult,
    })
      .annotate(RequiredPermission, "secrets:write")
      .annotate(OpenApi.Summary, "Scan every scanner account now")
      .annotate(
        OpenApi.Description,
        "Reads every scanner account's findings now instead of waiting for the next 30-minute scan.",
      )
      .annotate(SuccessDescription, "Scan totals"),
    HttpApiEndpoint.post("rotate", "/:id/rotate", {
      params: OrgIdParams,
      payload: LeakedSecretRotate,
      success: LeakedSecretResponse,
      error: actionErrors,
    })
      .annotate(RequiredPermission, "secrets:write")
      .annotate(OpenApi.Summary, "Rotate a leaked credential")
      .annotate(
        OpenApi.Description,
        "For `reissue` leaks the provider mints a new value and every output reference consuming it " +
          "is updated at once; for `replace` leaks send the new `value`, which the provider receives " +
          "first when it can. Refused with 409 when the stored value still equals the leaked one " +
          "afterwards. Records the rotation, raises `secret.rotated` and closes the finding upstream " +
          "as revoked unless `resolveUpstream` is false.",
      )
      .annotate(SuccessDescription, "The updated leak")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("markRotated", "/:id/mark-rotated", {
      params: OrgIdParams,
      payload: LeakedSecretMarkRotated,
      success: LeakedSecretResponse,
      error: actionErrors,
    })
      .annotate(RequiredPermission, "secrets:write")
      .annotate(OpenApi.Summary, "Record a rotation done at the provider")
      .annotate(
        OpenApi.Description,
        "For an account credential, the account must have been updated first: the request is refused " +
          "with 409 while the stored credential still equals the leaked one.",
      )
      .annotate(SuccessDescription, "The updated leak")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("dismiss", "/:id/dismiss", {
      params: OrgIdParams,
      payload: LeakedSecretDismiss,
      success: LeakedSecretResponse,
      error: actionErrors,
    })
      .annotate(RequiredPermission, "secrets:write")
      .annotate(OpenApi.Summary, "Dismiss a leaked credential")
      .annotate(
        OpenApi.Description,
        "Accept the finding as not a risk. Closes it upstream with the matching reason unless " +
          "`resolveUpstream` is false.",
      )
      .annotate(SuccessDescription, "The updated leak")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("reopen", "/:id/reopen", {
      params: OrgIdParams,
      success: LeakedSecretResponse,
      error: actionErrors,
    })
      .annotate(RequiredPermission, "secrets:write")
      .annotate(OpenApi.Summary, "Reopen a leaked credential")
      .annotate(
        OpenApi.Description,
        "Undo a dismissal or a rotation recorded by mistake. Does not reopen the finding on the scanner.",
      )
      .annotate(SuccessDescription, "The updated leak"),
  )
  .prefix("/api/org/:orgId/leaked-secrets")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Leaked credentials") {}

export class LeakedSecretsApi extends withApiDefaults(
  HttpApi.make("leakedSecrets").add(LeakedSecretsGroup),
) {}
