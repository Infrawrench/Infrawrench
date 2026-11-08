/**
 * Connect: `/api/org/:orgId/connect`, the endpoint definitions. Moving a
 * source resource's outputs into a target: as a secret (Kubernetes and other
 * plugins with `supportsSecretImport`) or as environment variables written to
 * a file over SSH.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { Ok, OrgParams, ResourceId, Uuid } from "../http/schemas/common";
import { SshHostKeyTrustRequired } from "../http/schemas/ssh-host-key-trust";

export const ConnectTemplatesRequest = Schema.Struct({
  sourcePluginId: Schema.String,
  sourceResourceTypeId: Schema.String,
  targetAccountId: Uuid,
  targetPluginId: Schema.String,
}).annotate({ identifier: "ConnectTemplatesRequest" });

const SecretExportTemplate = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  entries: Schema.Array(Schema.Struct({ outputKey: Schema.String, envKey: Schema.String })),
}).annotate({ identifier: "SecretExportTemplate" });

export const ConnectTemplatesResponse = Schema.Struct({
  templates: Schema.Array(SecretExportTemplate),
  effectiveResourceTypeId: Schema.String,
  supportsSecretImport: Schema.Boolean,
  namespaces: Schema.Array(Schema.String),
}).annotate({ identifier: "ConnectTemplatesResponse" });

const KeyOverrides = Schema.Record(Schema.String, Schema.String);

export const ConnectSecretExportRequest = Schema.Struct({
  sourceAccountId: Uuid,
  sourceResourceId: ResourceId,
  sourcePluginId: Schema.String,
  sourceResourceTypeId: Schema.String,
  sourceExternalId: Schema.optionalKey(Schema.String),
  targetAccountId: Uuid,
  targetPluginId: Schema.String,
  templateId: Schema.String,
  namespace: Schema.String,
  secretName: Schema.String,
  keyOverrides: KeyOverrides,
}).annotate({ identifier: "ConnectSecretExportRequest" });

export const ConnectEnvDeployRequest = Schema.Struct({
  sourceAccountId: Uuid,
  sourceResourceId: ResourceId,
  sourcePluginId: Schema.String,
  sourceResourceTypeId: Schema.String,
  sourceExternalId: Schema.optionalKey(Schema.String),
  targetSshHost: Schema.String,
  sshKeyId: Uuid,
  sshUsername: Schema.String,
  templateId: Schema.String,
  keyOverrides: KeyOverrides,
  format: Schema.Literals(["dotenv", "profile"]),
  filePath: Schema.String,
  append: Schema.Boolean,
}).annotate({ identifier: "ConnectEnvDeployRequest" });

export class ConnectGroup extends HttpApiGroup.make("connect")
  .add(
    HttpApiEndpoint.post("templates", "/templates", {
      params: OrgParams,
      payload: ConnectTemplatesRequest,
      success: ConnectTemplatesResponse,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List secret-export templates and target capabilities")
      .annotate(SuccessDescription, "Templates"),
    HttpApiEndpoint.post("secretExport", "/secret-export", {
      params: OrgParams,
      payload: ConnectSecretExportRequest,
      success: Ok,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Materialize source outputs as a secret in the target (e.g. K8s)")
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.post("envDeploy", "/env-deploy", {
      params: OrgParams,
      payload: ConnectEnvDeployRequest,
      success: Ok,
      error: [BadRequest, NotFound, SshHostKeyTrustRequired],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Deploy env vars from a source resource to an SSH target")
      .annotate(SuccessDescription, "Deployed"),
  )
  .prefix("/api/org/:orgId/connect")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Connect") {}

export class ConnectApi extends withApiDefaults(HttpApi.make("connect").add(ConnectGroup)) {}
