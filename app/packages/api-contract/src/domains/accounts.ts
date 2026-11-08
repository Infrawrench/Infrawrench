/**
 * Accounts: `/api/org/:orgId/accounts`, the endpoint definitions. A connected
 * account is a set of provider credentials (encrypted at rest) plus the
 * resources synced through them; the plugin catalog, credential preflight and
 * provider-filled credential pickers that the add-account form uses live here
 * too.
 *
 * The request bodies are documented, not decoded: every handler reads its
 * body raw, exactly as the Hono route did, so a request the old route took is
 * still taken (`index.ts`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { minLength } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, InternalServerError, NotFound, PaymentRequired } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import {
  IsoDateTime,
  JsonObject,
  Ok,
  OrgIdParams,
  OrgParams,
  ResourceId,
  Uuid,
} from "../http/schemas/common";
import { enumQuery } from "../http/schemas/query";
import { PluginId, ResourceTypeId } from "../http/schemas/plugin-registry";
import { TerraformExport } from "../http/schemas/terraform-export";

const StringMap = Schema.Record(Schema.String, Schema.String);

const HelpLink = Schema.Struct({ label: Schema.String, url: Schema.String });

const TemplateLanguage = Schema.Literals(["json", "yaml", "text"]);

const CredentialFieldRegion = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  location: Schema.optionalKey(Schema.String),
  flag: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "CredentialFieldRegion" });

const CredentialField = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  placeholder: Schema.optionalKey(Schema.String),
  sensitive: Schema.optionalKey(Schema.Boolean),
  multiline: Schema.optionalKey(Schema.Boolean),
  defaultValue: Schema.optionalKey(Schema.String),
  regions: Schema.optionalKey(Schema.Array(CredentialFieldRegion)),
  providerOptions: Schema.optionalKey(
    Schema.Struct({
      dependsOn: Schema.Array(Schema.String),
      emptyLabel: Schema.optionalKey(Schema.String),
      multiple: Schema.optionalKey(
        Schema.Boolean.annotate({
          description:
            "Several options may be picked; the stored value is their ids joined with `, `.",
        }),
      ),
    }).annotate({
      description:
        "Present when the field's choices come from the provider. Once every field in `dependsOn` has a value, `POST /accounts/credential-options` returns them.",
    }),
  ),
  helpLink: Schema.optionalKey(HelpLink),
  advanced: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "A rarely needed optional setting (a custom CA bundle, say) that forms show under a collapsed advanced section.",
    }),
  ),
}).annotate({ identifier: "CredentialField" });

/** Documented; the handler reads the body raw. */
const CredentialOptionsRequest = Schema.Struct({
  pluginId: Schema.String,
  fieldKey: Schema.String.annotate({
    description: "A credential field that declares `providerOptions`.",
  }),
  credentials: StringMap.annotate({
    description:
      "The credential values entered so far. Used for the lookup only; nothing is stored.",
  }),
  bastionId: Schema.optionalKey(
    Schema.NullOr(Uuid).annotate({
      description:
        "Look up through this bastion, matching how the account will egress once created.",
    }),
  ),
  accountId: Schema.optionalKey(
    Schema.NullOr(Uuid).annotate({
      description:
        "When editing an existing account, its id; the lookup then egresses through that account's bastion binding.",
    }),
  ),
}).annotate({ identifier: "CredentialOptionsRequest" });

const CredentialFieldOption = Schema.Struct({
  id: Schema.String.annotate({ description: "The value to store in the credential field." }),
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "CredentialFieldOption" });

export const CredentialOptionsResponse = Schema.Struct({
  options: Schema.Array(CredentialFieldOption),
}).annotate({ identifier: "CredentialOptionsResponse" });

const PreflightPermission = Schema.Struct({
  id: Schema.String.annotate({
    description: "Provider-native permission string, e.g. `ce:GetCostAndUsage`.",
  }),
  label: Schema.String,
}).annotate({ identifier: "PreflightPermission" });

const PreflightCapability = Schema.Struct({
  id: Schema.String.annotate({ examples: ["costs"] }),
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  requiredPermissions: Schema.Array(PreflightPermission),
  essential: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "PreflightCapability" });

const PreflightDeclaration = Schema.Struct({
  capabilities: Schema.Array(PreflightCapability),
  templateFormat: Schema.optionalKey(
    Schema.Struct({ label: Schema.String, language: TemplateLanguage }),
  ),
}).annotate({ identifier: "PreflightDeclaration" });

const PluginOAuthSummary = Schema.Struct({
  access: Schema.Literals(["read-only", "read-write", "full"]).annotate({
    description:
      "What the granted token can do. `full` means the provider offers no narrower scope.",
  }),
  refresh: Schema.Literals(["rotating", "reusable", "none"]).annotate({
    description:
      "How the server keeps the access token valid: `rotating` and `reusable` refresh it before expiry, `none` means it does not expire.",
  }),
  docsUrl: Schema.optionalKey(Schema.String.annotate({ format: "uri" })),
  tokenField: Schema.String.annotate({
    description: "The credential field the connection fills with the access token.",
  }),
  clients: Schema.Array(Schema.Literals(["server", "desktop"])).annotate({
    description:
      "OAuth clients the plugin declares. Always contains `server` here; `desktop` means the desktop app can also connect accounts it stores locally.",
  }),
}).annotate({ identifier: "PluginOAuthSummary" });

const AccountOAuthStatus = Schema.NullOr(
  Schema.Literals(["connected", "reconnect_required"]),
).annotate({
  identifier: "AccountOAuthStatus",
  description:
    "Provider OAuth connection state. `null` for pasted credentials; `reconnect_required` when the provider revoked the connection or its refresh token expired, and the account needs `POST /provider-oauth/{pluginId}/authorize` with its `accountId` again.",
});

export const PluginSummary = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  logoSvg: Schema.String,
  credentialFields: Schema.Array(CredentialField),
  preflight: Schema.NullOr(PreflightDeclaration).annotateKey({
    description:
      "Declared when the plugin supports credential preflight (per-capability permission checks). `null` for plugins without it.",
  }),
  oauth: Schema.optionalKey(PluginOAuthSummary).annotateKey({
    description:
      "Present only when this server can connect the plugin through provider OAuth (the plugin supports it and the server has a client configured). See `POST /provider-oauth/{pluginId}/authorize`.",
  }),
  sshTunnel: Schema.optionalKey(
    Schema.Struct({
      label: Schema.String,
      defaultPort: Schema.Int,
      credentials: StringMap.annotate({
        description:
          "What an account tunneled to this service stores; `{port}` stands for the local end of the tunnel.",
      }),
    }).annotate({
      description: "Present when the plugin can be reached through an SSH tunnel to a remote host.",
    }),
  ),
  jumpHost: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "This plugin's accounts are SSH hosts that other accounts can connect through.",
    }),
  ),
  kvBrowser: Schema.optionalKey(
    Schema.Literals(["keys", "documents"]).annotate({
      description:
        "Which browser the plugin's connections open: `documents` for collections of JSON documents, `keys` for the key-value console. Absent means `keys`, or that the plugin has no key-value driver.",
    }),
  ),
}).annotate({ identifier: "PluginSummary" });

const PreflightCheck = Schema.Struct({
  capabilityId: Schema.String,
  status: Schema.Literals(["ok", "missing", "unknown"]),
  missingPermissions: Schema.Array(PreflightPermission),
  message: Schema.NullOr(Schema.String),
  helpLink: Schema.NullOr(HelpLink),
}).annotate({ identifier: "PreflightCheck" });

export const PreflightReport = Schema.Struct({
  pluginId: Schema.String,
  supported: Schema.Boolean,
  identity: Schema.NullOr(Schema.String).annotate({
    description: "Provider-side identity the credential resolved to (ARN, service account…).",
  }),
  checks: Schema.Array(PreflightCheck),
}).annotate({ identifier: "PreflightReport" });

/** Documented; the handler reads the body raw. */
const PreflightRequest = Schema.Struct({
  pluginId: Schema.String,
  credentials: StringMap,
  bastionId: Schema.optionalKey(
    Schema.NullOr(Uuid).annotate({
      description: "Probe through this bastion, matching how the account will egress once created.",
    }),
  ),
}).annotate({ identifier: "PreflightRequest" });

const PolicyTemplate = Schema.Struct({
  formatLabel: Schema.String,
  language: TemplateLanguage,
  document: Schema.String,
  instructions: Schema.optionalKey(Schema.String),
  helpLink: Schema.optionalKey(HelpLink),
}).annotate({ identifier: "PolicyTemplate" });

export const PolicyTemplateResponse = Schema.Struct({ template: PolicyTemplate }).annotate({
  identifier: "PolicyTemplateResponse",
});

export const Account = Schema.Struct({
  id: Uuid,
  pluginId: Schema.String,
  displayName: Schema.String,
  bastionId: Schema.NullOr(Uuid).annotate({
    description:
      "Bastion this account's cloud-API egress is routed through. `null` ⇒ direct egress.",
  }),
  oauthStatus: AccountOAuthStatus,
  createdAt: IsoDateTime,
}).annotate({ identifier: "Account" });

const OAUTH_CREDENTIALS_NOTE =
  "An `__oauth` key may only carry the sealed grant returned by the provider OAuth callback (for this organization, the calling user and this plugin, within 30 minutes) or the redacted grant `GET .../credentials` returned, which counts as no grant (the stored one is kept while the token is unchanged). Any other value is rejected with 400.";

/** Documented; the handler reads the body raw. */
const CreateAccountRequest = Schema.Struct({
  pluginId: PluginId,
  displayName: Schema.String.check(minLength(1)),
  credentials: StringMap.annotate({ description: OAUTH_CREDENTIALS_NOTE }),
  bastionId: Schema.optionalKey(
    Schema.NullOr(Uuid).annotate({
      description: "Optional bastion id to route this account's cloud API traffic through.",
    }),
  ),
}).annotate({ identifier: "CreateAccountRequest" });

export const CreateAccountResponse = Schema.Struct({
  id: Uuid,
  syncError: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
}).annotate({ identifier: "CreateAccountResponse" });

/** Documented; the handler reads the body raw. */
const UpdateAccountRequest = Schema.Struct({
  displayName: Schema.optionalKey(Schema.String.check(minLength(1))),
  bastionId: Schema.optionalKey(
    Schema.NullOr(Uuid).annotate({
      description:
        "Pass `null` to unbind, a uuid to bind, or omit the field to leave the binding unchanged.",
    }),
  ),
}).annotate({ identifier: "UpdateAccountRequest" });

export const UpdatedAccount = Schema.Struct({
  id: Uuid,
  displayName: Schema.String,
  bastionId: Schema.NullOr(Uuid),
}).annotate({ identifier: "UpdatedAccount" });

/** Documented; the handler reads the body raw. */
const RotateCredentialsRequest = Schema.Struct({
  credentials: StringMap.annotate({
    description:
      "Complete credentials map. Sensitive fields the caller doesn't want " +
      "to change should be re-sent with their previous value (the server " +
      "doesn't merge with the existing blob). " +
      "For an account connected through provider OAuth, the stored connection is kept when the token field is omitted or unchanged; a different token switches the account to that pasted token. " +
      OAUTH_CREDENTIALS_NOTE,
  }),
});

const resourceFields = {
  id: ResourceId,
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  displayName: Schema.String,
  externalId: Schema.NullOr(Schema.String),
  fieldsJson: JsonObject,
  outputsJson: JsonObject,
  parentResourceId: Schema.NullOr(ResourceId),
};

export const Resource = Schema.Struct({
  id: resourceFields.id,
  pluginId: resourceFields.pluginId,
  resourceTypeId: resourceFields.resourceTypeId,
  accountId: Uuid,
  displayName: resourceFields.displayName,
  externalId: resourceFields.externalId,
  fieldsJson: resourceFields.fieldsJson,
  outputsJson: resourceFields.outputsJson,
  parentResourceId: resourceFields.parentResourceId,
}).annotate({ identifier: "Resource" });

/**
 * What `sync-type` hands back: the same rows as `Resource`, minus `accountId`;
 * the caller named the account in the path, so the route doesn't echo it.
 */
export const SyncedResource = Schema.Struct(resourceFields).annotate({
  identifier: "SyncedResource",
});

export const SyncResponse = Schema.Struct({
  synced: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  incompleteLists: Schema.optionalKey(
    Schema.Array(Schema.Struct({ resourceTypeId: Schema.String, message: Schema.String })).annotate(
      {
        description:
          "Resource types left as they were because their list could not be read whole: too long to read, or a page from the provider that was not a list. The stored rows are kept rather than pruned against part of a list.",
      },
    ),
  ),
}).annotate({ identifier: "SyncResponse" });

const ResourceTypeSummary = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  pluralDisplayName: Schema.String,
  iconKey: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "What this type of resource is, in a shared vocabulary (`cpu`, `database`, ...).",
    }),
  ),
  showcase: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, label: Schema.String })).annotate({
      description:
        "The fields this type marked to show on its tile, read from each resource's synced fields.",
    }),
  ),
  parentTypeId: Schema.optionalKey(Schema.String),
  supportsCreate: Schema.Boolean,
  attachTargets: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        pluginId: Schema.String,
        resourceTypeId: Schema.String,
        matchField: Schema.optionalKey(Schema.String),
        verb: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  isSshHost: Schema.optionalKey(Schema.Boolean),
  sshTunnelAttachSource: Schema.optionalKey(Schema.Boolean),
  showInSidebar: Schema.optionalKey(Schema.Boolean),
  accountRoot: Schema.optionalKey(Schema.Boolean),
  schedulable: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "The type declares lifecycle start/stop actions, so its resources can carry a sleep/wake schedule.",
    }),
  ),
}).annotate({ identifier: "ResourceTypeSummary" });

export const AccountDetail = Schema.Struct({
  account: Schema.Struct({
    id: Uuid,
    pluginId: Schema.String,
    displayName: Schema.String,
    oauthStatus: AccountOAuthStatus,
  }),
  resourceTypes: Schema.Array(ResourceTypeSummary),
  pluginDisplayName: Schema.String,
  pluginLogoSvg: Schema.String,
}).annotate({ identifier: "AccountDetail" });

const Credentials = StringMap;

/** `{ ok: true }`, documented inline as the Zod spec had it (not the shared `Ok` component). */
export const RotatedCredentials = Schema.Struct({ ok: Schema.Literal(true) });

export class AccountsGroup extends HttpApiGroup.make("accounts")
  .add(
    HttpApiEndpoint.get("plugins", "/plugins", {
      params: OrgParams,
      success: Schema.Array(PluginSummary),
    })
      .annotate(RequiredPermission, "accounts:read")
      .annotate(OpenApi.Summary, "List installed plugins and their credential fields")
      .annotate(SuccessDescription, "Plugins"),
    HttpApiEndpoint.get("policyTemplate", "/plugins/:pluginId/policy-template", {
      params: { orgId: OrgParams.orgId, pluginId: PluginId },
      query: {
        capabilities: Schema.optionalKey(
          Schema.String.annotate({
            description: "Comma-separated capability ids, e.g. `resources,costs`.",
            examples: ["resources,costs"],
          }),
        ),
      },
      success: PolicyTemplateResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "accounts:read")
      .annotate(OpenApi.Summary, "Generate a least-privilege credential template for a plugin")
      .annotate(
        OpenApi.Description,
        "Returns the paste-ready credential document (IAM policy JSON, custom role YAML, token template…) scoped to the requested capability ids. Omitting `capabilities` (or sending it empty) selects every declared capability; any unknown capability id is rejected with 400. 400 also for plugins that don't provide a template.",
      )
      .annotate(SuccessDescription, "Template"),
    HttpApiEndpoint.post("preflight", "/preflight", {
      params: OrgParams,
      payload: PreflightRequest,
      success: PreflightReport,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "accounts:write")
      .annotate(OpenApi.Summary, "Probe credentials before creating an account")
      .annotate(
        OpenApi.Description,
        "Runs the plugin's per-capability permission checks against the submitted credentials. Nothing is stored; use it from the add-account flow before committing.",
      )
      .annotate(SuccessDescription, "Preflight report"),
    HttpApiEndpoint.post("credentialOptions", "/credential-options", {
      params: OrgParams,
      payload: CredentialOptionsRequest,
      success: CredentialOptionsResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "accounts:write")
      .annotate(OpenApi.Summary, "List the provider's choices for a credential field")
      .annotate(
        OpenApi.Description,
        "For credential fields that declare `providerOptions` (an account picker filled from the API key, say): asks the provider for the choices the submitted credentials can see. Nothing is stored. A 400 carries the provider's reason, and clients fall back to a text input.",
      )
      .annotate(SuccessDescription, "Choices for the field"),
    HttpApiEndpoint.post("storedPreflight", "/:id/preflight", {
      params: OrgIdParams,
      success: PreflightReport,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "accounts:write")
      .annotate(OpenApi.Summary, "Re-run credential preflight on a stored account")
      .annotate(SuccessDescription, "Preflight report"),
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(Account),
    })
      .annotate(RequiredPermission, "accounts:read")
      .annotate(OpenApi.Summary, "List accounts in this organization")
      .annotate(SuccessDescription, "Accounts"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: CreateAccountRequest,
      success: CreateAccountResponse,
      error: [BadRequest, PaymentRequired],
    })
      .annotate(RequiredPermission, "accounts:write")
      .annotate(OpenApi.Summary, "Create an account")
      .annotate(
        OpenApi.Description,
        "Stores encrypted credentials and triggers a first sync. `syncError` is set if the initial sync failed (the account row is still created).",
      )
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
    })
      .annotate(RequiredPermission, "accounts:delete")
      .annotate(OpenApi.Summary, "Delete an account")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.patch("update", "/:id", {
      params: OrgIdParams,
      payload: UpdateAccountRequest,
      success: UpdatedAccount,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "accounts:write")
      .annotate(OpenApi.Summary, "Update an account (rename and/or change bastion binding)")
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.get("credentials", "/:id/credentials", {
      params: OrgIdParams,
      success: Credentials,
      error: NotFound,
    })
      .annotate(RequiredPermission, "secrets:read")
      .annotate(OpenApi.Summary, "Fetch the decrypted credentials for an account")
      .annotate(
        OpenApi.Description,
        "Returns the credentials map as it was originally submitted. Sensitive: gate access carefully. " +
          "For an account connected through provider OAuth, the access token is refreshed first when it is about to expire, and `__oauth` comes back redacted: the grant state without its refresh token (or a registered client secret), so plugins can tell an OAuth token from a pasted one. Sending that redacted value back on `PUT .../credentials` keeps the stored connection. " +
          "An account whose connection was revoked (`oauthStatus: reconnect_required`) returns its stored credentials without refreshing.",
      )
      .annotate(SuccessDescription, "Credentials"),
    HttpApiEndpoint.put("rotateCredentials", "/:id/credentials", {
      params: OrgIdParams,
      payload: RotateCredentialsRequest,
      success: RotatedCredentials,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "secrets:write")
      .annotate(
        OpenApi.Summary,
        "Rotate the credentials an account uses to talk to the upstream provider",
      )
      .annotate(
        OpenApi.Description,
        "Replaces the encrypted credentials blob in place. Used to swap a stale or " +
          "narrowly-scoped token for a freshly-minted one without recreating the account " +
          "(preserves existing resources, pins, dashboards, sync history).",
      )
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.get("resources", "/:id/resources", {
      params: OrgIdParams,
      query: {
        topLevelOnly: Schema.optionalKey(
          Schema.String.annotate({
            description: "If `true`, only resources with no `parentResourceId` are returned.",
          }),
        ),
      },
      success: Schema.Array(Resource),
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List cached resources for an account")
      .annotate(SuccessDescription, "Resources")
      // Anything but `true` reads as false, as it always has; the document
      // lists the two values clients send.
      .annotate(OpenApi.Transform, enumQuery({ topLevelOnly: ["true", "false"] })),
    HttpApiEndpoint.get("exportTerraform", "/:id/export-terraform", {
      params: OrgIdParams,
      success: TerraformExport,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Generate Terraform HCL for the account's stored inventory")
      .annotate(SuccessDescription, "Generated Terraform configuration"),
    HttpApiEndpoint.post("sync", "/:id/sync", {
      params: OrgIdParams,
      success: SyncResponse,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Sync all resource types for an account")
      .annotate(SuccessDescription, "Sync result"),
    HttpApiEndpoint.get("detail", "/:id/detail", {
      params: OrgIdParams,
      success: AccountDetail,
      error: NotFound,
    })
      .annotate(RequiredPermission, "accounts:read")
      .annotate(OpenApi.Summary, "Account metadata + resource type list")
      .annotate(SuccessDescription, "Detail"),
    HttpApiEndpoint.post("syncType", "/:id/sync-type/:typeId", {
      params: { ...OrgIdParams, typeId: ResourceTypeId },
      success: Schema.Array(SyncedResource),
      error: [NotFound, InternalServerError],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Sync a single resource type and return its resources")
      .annotate(SuccessDescription, "Resources"),
  )
  .prefix("/api/org/:orgId/accounts")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Accounts") {}

export class AccountsApi extends withApiDefaults(HttpApi.make("accounts").add(AccountsGroup)) {}
