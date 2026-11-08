/**
 * Resources: `/api/org/:orgId/resources`, the handlers.
 *
 * Every handler ends in a call to the resource's plugin through the host
 * client (`HostPluginClient`, whose methods run on call and return promises,
 * each inside its own egress scope). Those calls, and everything else that
 * reads AsyncLocalStorage (held secret writes, the edge request scope), are
 * made inside `legacy` so they start synchronously within the request's
 * scopes. The multi-step flows (the detail payload, create, update, the
 * create form's lookups) are promise code in `./operations.ts`, each run as
 * one `legacy` call.
 */
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { parseOutputRef, type OutputRefValue } from "@infrawrench/plugin-base";
import { carbonHintFor } from "@infrawrench/server-core/cost/carbon";
import { resourceIdBelongsToAccount } from "@infrawrench/server-core/resource-ids";
import { maxLength, minLength } from "@infrawrench/api-contract/schemas";
import {
  BadRequest,
  badRequest,
  CostEstimateResponse,
  CreatePricing,
  CreateResourceResponse,
  CredentialExport,
  DescribeResponse,
  FieldActionResponse,
  InternalServerError,
  JsonObject,
  LogsResponse,
  Manifest,
  MetricsResponse,
  NoSqlCommandResult,
  NotFound,
  notFound,
  ok,
  PeerPanes,
  PickerResources,
  ResourceDetail,
  ResourcesApi,
  SecretAccessResponse,
  SecretVersionResponse,
  SecretVersionsResponse,
  SshInstallAccounts,
  SshInstallResult,
  TagPolicyBlocked,
  TerraformExport,
  TunnelSshAttachResult,
  Undocumented,
  UpdateResourceResponse,
} from "@infrawrench/api-contract";
import { getActiveChangeFreeze, isActionDestructive } from "../../../services/change-freezes";
import { getClientForAccount, getClientForResource } from "../../../services/plugin-clients";
import { listSshInstallAccounts, runSshInstall } from "../../../services/ssh-install";
import { HostKeyTrustRequiredError } from "../../../services/ssh-host-keys";
import { evaluateTagPolicyOnCreate } from "../../../services/tag-policy";
import { runTunnelSshAttach } from "../../../services/tunnel-ssh-attach";
import { logAudit } from "../../../services/audit";
import { TAG_POLICY_OVERRIDE_HEADER } from "@infrawrench/client-core";
import { requireNoChangeFreeze } from "../../change-freeze";
import { makeDomain } from "../../domain";
import { decodeFirstIssue, readJson } from "../../request-body";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal, requirePermission } from "../../principal";
import { respond } from "../../response";
import { hostKeyTrustRequired } from "../ssh-host-key-trust";
import {
  ACCOUNT_OR_PEER_NOT_FOUND,
  captureDeletion,
  costEstimate,
  createResource,
  exportResourceTerraform,
  loadResourceDetail,
  peerPanes,
  pickerResources,
  resourceMetrics,
  updateResource,
  type ResourceClient,
} from "./operations";

/** The refusals `./operations.ts` throws, brought back into the typed channel. */
const operation = <A>(fn: () => Promise<A>) =>
  legacyTry(fn, (error): BadRequest | NotFound | InternalServerError | undefined =>
    error instanceof BadRequest || error instanceof NotFound || error instanceof InternalServerError
      ? error
      : undefined,
  );

/** A plugin call whose failure the route answers as a 400 carrying the error's message. */
const pluginCall = <A>(fn: () => Promise<A>, fallback: string) =>
  legacyTry(
    fn,
    (error) => new BadRequest({ error: error instanceof Error ? error.message : fallback }),
  );

/** The account's client, or its peer plugin's for a resource under `parentResourceId`. */
const resolveClient = Effect.fnUntraced(function* (
  pluginId: string,
  accountId: string,
  parentResourceId: string | undefined,
  missing: string = ACCOUNT_OR_PEER_NOT_FOUND,
) {
  const { organizationId } = yield* OrgPrincipal;
  const ctx = yield* legacy(() =>
    getClientForResource(pluginId, accountId, organizationId, parentResourceId),
  );
  if (!ctx) return yield* notFound(missing);
  return ctx;
});

/** {@link resolveClient} when a `pluginId` is given, else the account's own client. */
const resolveOptionalPluginClient = Effect.fnUntraced(function* (input: {
  readonly accountId: string;
  readonly pluginId?: string | undefined;
  readonly parentResourceId?: string | undefined;
}) {
  const { organizationId } = yield* OrgPrincipal;
  const { pluginId, accountId, parentResourceId } = input;
  const ctx = yield* legacy(() =>
    pluginId
      ? getClientForResource(pluginId, accountId, organizationId, parentResourceId)
      : getClientForAccount(accountId, organizationId),
  );
  if (!ctx) return yield* notFound(ACCOUNT_OR_PEER_NOT_FOUND);
  return ctx;
});

/** A client method the plugin may not implement, bound to its client, or the route's 400. */
const capability = <F>(method: F | undefined, unsupported: string) =>
  method === undefined ? Effect.fail(badRequest(unsupported)) : Effect.succeed(method);

/**
 * The SSH installer's body, checked as its Zod schema did: unknown keys refused
 * at every level, so a caller cannot steer the connection (a host, a command).
 */
const SshInstallInput = Schema.Struct({
  installerAccountId: Schema.String.check(minLength(1)),
  target: Schema.Struct({
    accountId: Schema.String.check(minLength(1)),
    resourceTypeId: Schema.String.check(minLength(1)),
    resourceId: Schema.String.check(minLength(1)),
  }),
  sshKeyId: Schema.optionalKey(Schema.String.check(minLength(1))),
  username: Schema.optionalKey(Schema.String.check(minLength(1), maxLength(64))),
  port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
});

/**
 * Serialise each event a plugin's chat turn yields as one NDJSON line, flushed
 * as it arrives so the browser sees tokens as they come. Built inside the
 * request's scopes: the stream starts the plugin call synchronously, and the
 * iteration that follows keeps them. Aborting the response (Stop, or
 * navigating away) closes the iterator on the next backpressure cycle;
 * plugins currently ignore aborts, so the in-flight provider call finishes.
 */
function chatStreamBody(
  stream: NonNullable<ResourceClient["client"]["streamChatMessage"]>,
  input: {
    readonly resourceTypeId: string;
    readonly resourceId: string;
    readonly accountId: string;
    readonly messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    readonly model?: string | undefined;
  },
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const writeEvent = (event: unknown): void => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        const iter = stream(
          input.resourceTypeId,
          input.resourceId,
          input.accountId,
          input.messages,
          input.model ? { model: input.model } : undefined,
        );
        for await (const event of iter) {
          writeEvent(event);
        }
      } catch (err) {
        writeEvent({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });
}

const ResourcesHandlers = HttpApiBuilder.group(ResourcesApi, "resources", (handlers) =>
  handlers
    .handle("sshInstallAccounts", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const listed = yield* legacy(() => listSshInstallAccounts(organizationId));
        return yield* respond(SshInstallAccounts)(listed);
      }),
    )
    .handleRaw("sshInstall", ({ request }) =>
      Effect.gen(function* () {
        yield* requirePermission("resources:write");
        yield* requirePermission("resources:execute");
        const input = yield* decodeFirstIssue(SshInstallInput, yield* readJson(request));
        const { organizationId, session } = yield* OrgPrincipal;
        const metadata = {
          installerAccountId: input.installerAccountId,
          targetAccountId: input.target.accountId,
        };
        yield* requireNoChangeFreeze(request, {
          action: "resource.ssh_install",
          entityType: "resource",
          entityId: input.target.resourceId,
          metadata,
        });
        const audit = (success: boolean) =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "resource.ssh_install",
            entityType: "resource",
            entityId: input.target.resourceId,
            metadata: { ...metadata, success },
          });
        const outcome = yield* legacy(async () => {
          try {
            const result = await runSshInstall(organizationId, input);
            await audit(true);
            return { ok: true as const, result };
          } catch (error) {
            if (error instanceof HostKeyTrustRequiredError) {
              return { ok: false as const, trust: error };
            }
            await audit(false);
            return {
              ok: false as const,
              error: error instanceof Error ? error.message : "SSH installation failed",
            };
          }
        });
        if (outcome.ok) return yield* respond(SshInstallResult)(outcome.result);
        if ("trust" in outcome) {
          const { trust } = outcome;
          return yield* hostKeyTrustRequired(trust);
        }
        return yield* badRequest(outcome.error);
      }),
    )
    .handle("detail", ({ params, query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const resourceId = query.resourceId;
        if (!resourceId) return yield* badRequest("Missing resourceId");
        const detail = yield* operation(() =>
          loadResourceDetail({
            organizationId,
            pluginId: params.pluginId,
            resourceTypeId: params.typeId,
            resourceId,
            accountId: query.accountId,
            parentResourceId: query.parentResourceId,
            includePeerPanes: query.includePeerPanes !== "false",
          }),
        );
        return yield* respond(ResourceDetail)(detail);
      }),
    )
    .handle("getManifest", ({ params, query }) =>
      Effect.gen(function* () {
        const { resourceId, accountId, parentResourceId } = query;
        if (!resourceId) return yield* badRequest("Missing resourceId");
        if (!accountId) return yield* badRequest("Missing accountId");
        const { client } = yield* resolveClient(params.pluginId, accountId, parentResourceId);
        const getManifest = yield* capability(
          client.getManifest?.bind(client),
          "Plugin does not support manifest viewing",
        );
        const manifest = yield* legacy(() => getManifest(resourceId, accountId));
        return yield* respond(Manifest)({ manifest });
      }),
    )
    .handle("applyManifest", ({ params, payload }) =>
      Effect.gen(function* () {
        const { accountId, resourceId, manifest, parentResourceId } = payload;
        const { client } = yield* resolveClient(params.pluginId, accountId, parentResourceId);
        const applyManifest = yield* capability(
          client.applyManifest?.bind(client),
          "Plugin does not support manifest editing",
        );
        yield* legacy(() => applyManifest(resourceId, accountId, manifest));
        return ok;
      }),
    )
    .handle("importYaml", ({ params, payload }) =>
      Effect.gen(function* () {
        const { accountId, yaml, parentResourceId } = payload;
        const { client } = yield* resolveClient(params.pluginId, accountId, parentResourceId);
        const importYaml = yield* capability(
          client.importYaml?.bind(client),
          "Plugin does not support YAML import",
        );
        const result = yield* legacy(() => importYaml(accountId, yaml));
        return yield* respond(JsonObject)(result);
      }),
    )
    .handle("describe", ({ params, payload }) =>
      Effect.gen(function* () {
        const { accountId, resourceId, parentResourceId } = payload;
        const { client } = yield* resolveClient(params.pluginId, accountId, parentResourceId);
        const describe = yield* capability(
          client.describeResource?.bind(client),
          "Plugin does not support describe",
        );
        const text = yield* legacy(() => describe(params.typeId, resourceId, accountId));
        return yield* respond(DescribeResponse)({ text });
      }),
    )
    .handle("logs", ({ params, payload }) =>
      Effect.gen(function* () {
        const { accountId, resourceId, parentResourceId, tailLines, container, previous } = payload;
        const { client } = yield* resolveClient(params.pluginId, accountId, parentResourceId);
        const getLogs = yield* capability(
          client.getLogs?.bind(client),
          "Plugin does not support logs",
        );
        const result = yield* legacy(() =>
          getLogs(params.typeId, resourceId, accountId, {
            ...(tailLines !== undefined ? { tailLines } : {}),
            ...(container !== undefined ? { container } : {}),
            ...(previous !== undefined ? { previous } : {}),
          }),
        );
        return yield* respond(LogsResponse)(result);
      }),
    )
    .handle("listSecretVersions", ({ params, query }) =>
      Effect.gen(function* () {
        const { resourceId, accountId, parentResourceId } = query;
        if (!resourceId) return yield* badRequest("Missing resourceId");
        if (!accountId) return yield* badRequest("Missing accountId");
        const { client } = yield* resolveClient(params.pluginId, accountId, parentResourceId);
        const list = yield* capability(
          client.listSecretVersions?.bind(client),
          "Plugin does not support secret versions",
        );
        const versions = yield* legacy(() => list(params.typeId, resourceId, accountId));
        return yield* respond(SecretVersionsResponse)({ versions });
      }),
    )
    .handle("accessSecretVersion", ({ params, payload }) =>
      Effect.gen(function* () {
        const { accountId, resourceId, versionId, parentResourceId } = payload;
        const { client } = yield* resolveClient(params.pluginId, accountId, parentResourceId);
        const access = yield* capability(
          client.accessSecretVersion?.bind(client),
          "Plugin does not support secret versions",
        );
        const value = yield* legacy(() => access(params.typeId, resourceId, accountId, versionId));
        return yield* respond(SecretAccessResponse)({ value });
      }),
    )
    .handle("addSecretVersion", ({ params, payload }) =>
      Effect.gen(function* () {
        const { accountId, resourceId, value, parentResourceId } = payload;
        const { client } = yield* resolveClient(params.pluginId, accountId, parentResourceId);
        const add = yield* capability(
          client.addSecretVersion?.bind(client),
          "Plugin does not support secret versions",
        );
        const version = yield* legacy(() => add(params.typeId, resourceId, accountId, value));
        return yield* respond(SecretVersionResponse)({ version });
      }),
    )
    .handle("modifySecretVersion", ({ params, payload, request }) =>
      Effect.gen(function* () {
        const { accountId, resourceId, versionId, action, parentResourceId } = payload;
        const { client } = yield* resolveClient(params.pluginId, accountId, parentResourceId);
        const modify = yield* capability(
          client.modifySecretVersion?.bind(client),
          "Plugin does not support secret versions",
        );
        // Destroying a secret version is irreversible: gate it behind the org's
        // change freeze. Enable/disable stay allowed (they're recoverable).
        if (action === "destroy") {
          yield* requireNoChangeFreeze(request, {
            action: "secret_version.destroy",
            entityType: "resource",
            entityId: resourceId,
            metadata: { pluginId: params.pluginId, resourceTypeId: params.typeId, versionId },
          });
        }
        const version = yield* legacy(() =>
          modify(params.typeId, resourceId, accountId, versionId, action),
        );
        return yield* respond(SecretVersionResponse)({ version });
      }),
    )
    .handle("delete", ({ params, query, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const { pluginId, typeId: resourceTypeId } = params;
        const { resourceId, accountId, parentResourceId } = query;
        if (!resourceId) return yield* badRequest("Missing resourceId");
        if (!accountId) return yield* badRequest("Missing accountId");
        const ctx = yield* resolveClient(pluginId, accountId, parentResourceId);
        const deleteResource = yield* capability(
          ctx.client.deleteResource?.bind(ctx.client),
          "Plugin does not support deletion",
        );
        yield* requireNoChangeFreeze(request, {
          action: "resource.delete",
          entityType: "resource",
          entityId: resourceId,
          metadata: { pluginId, resourceTypeId },
        });
        yield* legacy(() => deleteResource(resourceTypeId, resourceId, accountId));
        yield* fireAndForget(() =>
          captureDeletion(ctx, {
            organizationId,
            userId: session.userId,
            pluginId,
            resourceTypeId,
            resourceId,
            accountId,
          }),
        );
        return ok;
      }),
    )
    .handle("invokeAction", ({ payload: input, request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const { client } = yield* resolveClient(
          input.pluginId,
          input.accountId,
          input.parentResourceId,
          "Account not found",
        );
        const invoke = yield* capability(
          client.invokeAction?.bind(client),
          "Plugin does not support custom actions",
        );
        // The freeze only blocks actions the plugin flagged `destructive: true`
        // in its detail schema; telling requires a schema re-render, so the
        // check sits behind the (cheap) active-freeze lookup and costs nothing
        // outside a freeze window.
        const active = yield* legacy(() => getActiveChangeFreeze(organizationId));
        if (active) {
          const destructive = yield* legacy(() =>
            isActionDestructive(
              client,
              input.resourceTypeId,
              input.resourceId,
              input.accountId,
              input.actionId,
            ),
          );
          if (destructive) {
            yield* requireNoChangeFreeze(request, {
              action: "resource.invoke_action",
              entityType: "resource",
              entityId: input.resourceId,
              metadata: {
                pluginId: input.pluginId,
                resourceTypeId: input.resourceTypeId,
                actionId: input.actionId,
              },
            });
          }
        }
        yield* pluginCall(
          () => invoke(input.resourceTypeId, input.resourceId, input.actionId, input.accountId),
          "Action failed",
        );
        return ok;
      }),
    )
    .handle("nosqlCommand", ({ payload: input }) =>
      Effect.gen(function* () {
        const { client } = yield* resolveClient(
          input.pluginId,
          input.accountId,
          input.parentResourceId,
          "Account not found",
        );
        const command = yield* capability(
          client.executeNoSqlCommand?.bind(client),
          "Plugin does not support NoSQL commands",
        );
        const result = yield* pluginCall(
          () =>
            command(
              input.resourceTypeId,
              input.resourceId,
              input.accountId,
              input.command,
              input.args,
            ),
          "Command failed",
        );
        return yield* respond(NoSqlCommandResult)({ result });
      }),
    )
    .handle("chatStream", ({ payload: input }) =>
      Effect.gen(function* () {
        const { client } = yield* resolveClient(
          input.pluginId,
          input.accountId,
          input.parentResourceId,
          "Account not found",
        );
        const stream = yield* capability(
          client.streamChatMessage?.bind(client),
          "Plugin does not support chat",
        );
        const body = yield* legacy(async () => chatStreamBody(stream, input));
        return HttpServerResponse.raw(
          new Response(body, {
            headers: {
              "Content-Type": "application/x-ndjson",
              "Cache-Control": "no-cache, no-store",
              "X-Accel-Buffering": "no",
            },
          }),
        );
      }),
    )
    .handle("publishMessage", ({ payload: input }) =>
      Effect.gen(function* () {
        const { client } = yield* resolveClient(
          input.pluginId,
          input.accountId,
          input.parentResourceId,
          "Account not found",
        );
        const publish = yield* capability(
          client.publishMessage?.bind(client),
          "Plugin does not support publishing",
        );
        const result = yield* pluginCall(
          () => publish(input.resourceTypeId, input.resourceId, input.accountId, input.payload),
          "Publish failed",
        );
        return yield* respond(Undocumented)({ result });
      }),
    )
    .handle("synthesizeSpeech", ({ payload: input }) =>
      Effect.gen(function* () {
        const { client } = yield* resolveClient(
          input.pluginId,
          input.accountId,
          input.parentResourceId,
          "Account not found",
        );
        const synthesize = yield* capability(
          client.synthesizeSpeech?.bind(client),
          "Plugin does not support speech synthesis",
        );
        const result = yield* pluginCall(
          () => synthesize(input.resourceTypeId, input.resourceId, input.accountId, input.payload),
          "Synthesis failed",
        );
        return yield* respond(Undocumented)({ result });
      }),
    )
    // The clip arrives base64 in the JSON body; `SpeechPanelCapability.maxAudioBytes`
    // keeps that body within the request limit, enforced browser-side before the encode.
    .handle("transcribeAudio", ({ payload: input }) =>
      Effect.gen(function* () {
        const { client } = yield* resolveClient(
          input.pluginId,
          input.accountId,
          input.parentResourceId,
          "Account not found",
        );
        const transcribe = yield* capability(
          client.transcribeAudio?.bind(client),
          "Plugin does not support transcription",
        );
        const result = yield* pluginCall(
          () => transcribe(input.resourceTypeId, input.resourceId, input.accountId, input.payload),
          "Transcription failed",
        );
        return yield* respond(Undocumented)({ result });
      }),
    )
    .handle("attach", ({ payload: input }) =>
      Effect.gen(function* () {
        const { client } = yield* resolveClient(
          input.pluginId,
          input.accountId,
          undefined,
          "Account not found",
        );
        const attach = yield* capability(
          client.attachResource?.bind(client),
          "Plugin does not support attach",
        );
        yield* pluginCall(
          () =>
            attach(
              input.sourceTypeId,
              input.sourceResourceId,
              input.targetTypeId,
              input.targetResourceId,
              input.accountId,
            ),
          "Attach failed",
        );
        return ok;
      }),
    )
    // SSH over a Cloudflare Tunnel: tunnel ingress + routing DNS, then
    // cloudflared installed and run on the host over SSH. Spans the tunnel's
    // account and the host's; the tunnel token never leaves the server.
    .handle("tunnelSshAttach", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* pluginCall(
          () => runTunnelSshAttach({ organizationId, ...input }),
          "Tunnel SSH setup failed",
        );
        return yield* respond(TunnelSshAttachResult)(result);
      }),
    )
    .handle("exportCredential", ({ params, payload: input }) =>
      Effect.gen(function* () {
        if (!input.resourceId || !input.accountId || !input.formatId) {
          return yield* badRequest("Missing resourceId, accountId, or formatId");
        }
        const { client } = yield* resolveClient(
          params.pluginId,
          input.accountId,
          input.parentResourceId,
        );
        const exportCredential = yield* capability(
          client.exportCredential?.bind(client),
          "Plugin does not support credential export",
        );
        const result = yield* pluginCall(
          () => exportCredential(params.typeId, input.resourceId, input.accountId, input.formatId),
          "Credential export failed",
        );
        return yield* respond(CredentialExport)(result);
      }),
    )
    .handle("exportTerraform", ({ params, payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        if (!input.resourceId || !input.accountId) {
          return yield* badRequest("Missing resourceId or accountId");
        }
        const outcome = yield* operation(() =>
          exportResourceTerraform({
            organizationId,
            pluginId: params.pluginId,
            resourceId: input.resourceId,
            accountId: input.accountId,
          }),
        );
        return yield* respond(TerraformExport)(outcome);
      }),
    )
    .handle("create", ({ payload: input, request }) =>
      Effect.gen(function* () {
        const { organizationId, session, permissions } = yield* OrgPrincipal;
        const ctx = yield* resolveClient(input.pluginId, input.accountId, input.parentResourceId);
        yield* capability(ctx.client.createResource, "Plugin does not support creation");

        // Reference-mode picker fields arrive encoded. Flatten them to the
        // literal value resolved at pick time so the plugin sees a normal
        // string, but remember the identity so a live output-ref association
        // can be persisted.
        const resolvedFields: Record<string, string> = {};
        const refFields: Array<{ fieldKey: string; ref: OutputRefValue }> = [];
        for (const [fieldKey, value] of Object.entries(input.fields)) {
          const ref = parseOutputRef(value);
          if (ref) {
            resolvedFields[fieldKey] = ref.value;
            refFields.push({ fieldKey, ref });
          } else {
            resolvedFields[fieldKey] = value;
          }
        }

        // Org tag policy: refuse creates missing required tags (422, code
        // `tag_policy_unmet`) the same way the change freeze refuses
        // destructive mutations. Types that cannot carry tags are exempt.
        const blocked = yield* legacy(() =>
          evaluateTagPolicyOnCreate(
            {
              organizationId,
              userId: session.userId,
              permissions,
              overrideHeader: request.headers[TAG_POLICY_OVERRIDE_HEADER],
            },
            {
              client: ctx.client,
              pluginId: input.pluginId,
              resourceTypeId: input.resourceTypeId,
              accountId: input.accountId,
              parentResourceId: input.parentResourceId,
              fields: resolvedFields,
            },
          ),
        );
        if (blocked) {
          return yield* new TagPolicyBlocked({
            error: blocked.error,
            code: "tag_policy_unmet",
            // The same values, without the `allowedValues: undefined` the
            // client-core types allow and the schema's optional keys do not.
            violations: blocked.violations.map(({ allowedValues, ...violation }) =>
              allowedValues === undefined ? violation : { ...violation, allowedValues },
            ),
            requiredTags: blocked.requiredTags.map(({ key, allowedValues }) =>
              allowedValues === undefined ? { key } : { key, allowedValues },
            ),
          });
        }

        const created = yield* operation(() =>
          createResource(ctx, {
            organizationId,
            accountId: input.accountId,
            pluginId: input.pluginId,
            resourceTypeId: input.resourceTypeId,
            parentResourceId: input.parentResourceId,
            resolvedFields,
            refFields,
          }),
        );
        return yield* respond(CreateResourceResponse)(created);
      }),
    )
    .handle("update", ({ payload: input, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const ctx = yield* resolveClient(input.pluginId, input.accountId, input.parentResourceId);
        yield* capability(ctx.client.updateResource, "Plugin does not support updates");
        // The plugin acts on the external id alone, against the account checked
        // above, so the id's account prefix is what ties the provider call to the
        // row mirrored afterwards. A foreign prefix would edit the caller's own
        // resource and then write the result into someone else's row.
        if (!resourceIdBelongsToAccount(input.resourceId, input.accountId)) {
          return yield* notFound("Resource not found");
        }
        // Same gate as delete: a change freeze means no provider mutations, and
        // an edit (rename, resize) is one. The right-sizing "Apply resize" flow
        // rides this route on purpose so it inherits the gate and the audit trail.
        yield* requireNoChangeFreeze(request, {
          action: "resource.update",
          entityType: "resource",
          entityId: input.resourceId,
          metadata: {
            pluginId: input.pluginId,
            resourceTypeId: input.resourceTypeId,
            fieldKeys: Object.keys(input.fields),
          },
        });
        const updated = yield* operation(() =>
          updateResource(ctx, {
            organizationId,
            userId: session.userId,
            accountId: input.accountId,
            pluginId: input.pluginId,
            resourceTypeId: input.resourceTypeId,
            resourceId: input.resourceId,
            fields: input.fields,
          }),
        );
        return yield* respond(UpdateResourceResponse)(updated);
      }),
    )
    .handle("createConfig", ({ payload: input }) =>
      Effect.gen(function* () {
        const ctx = yield* resolveOptionalPluginClient(input);
        const getCreateConfig = yield* capability(
          ctx.client.getCreateConfig?.bind(ctx.client),
          "Plugin does not support dynamic create config",
        );
        // The host, not the plugin, attaches the carbon hint: it is read from
        // the type's declaration, so the form can show CO2e beside each size's
        // price without another request.
        const [config, carbon] = yield* legacy(() =>
          Promise.all([
            getCreateConfig(input.resourceTypeId, input.parentResourceId),
            carbonHintFor(input.pluginId ?? ctx.account.pluginId, input.resourceTypeId),
          ]),
        );
        return yield* respond(JsonObject)(carbon ? { ...config, carbon } : config);
      }),
    )
    .handle("pickerResources", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const results = yield* legacy(() =>
          pickerResources({
            organizationId,
            sources: input.sources,
            accountId: input.accountId,
            regionHint: input.regionHint,
            crossAccount: input.crossAccount,
          }),
        );
        return yield* respond(PickerResources)(results);
      }),
    )
    .handle("createPricing", ({ payload: input }) =>
      Effect.gen(function* () {
        const ctx = yield* resolveOptionalPluginClient(input);
        const getPricing = ctx.client.getCreateSizePricing?.bind(ctx.client);
        if (!getPricing) return yield* respond(CreatePricing)({});
        const pricing = yield* legacy(() =>
          getPricing(input.resourceTypeId, {
            ...(input.regionId ? { regionId: input.regionId } : {}),
            sizes: input.sizes,
          }),
        );
        return yield* respond(CreatePricing)(pricing ?? {});
      }),
    )
    .handle("fieldAction", ({ payload: input }) =>
      Effect.gen(function* () {
        const ctx = yield* resolveOptionalPluginClient(input);
        const execute = yield* capability(
          ctx.client.executeFieldAction?.bind(ctx.client),
          "Plugin does not support field actions",
        );
        const result = yield* legacy(() =>
          execute(
            input.resourceTypeId,
            input.fieldKey,
            input.actionId,
            input.accountId,
            input.fields,
            input.actionFields,
          ),
        );
        return yield* respond(FieldActionResponse)(result);
      }),
    )
    .handle("costEstimate", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* operation(() =>
          costEstimate({
            organizationId,
            accountId: input.accountId,
            resourceTypeId: input.resourceTypeId,
            fields: input.fields,
            resourceId: input.resourceId,
            pluginId: input.pluginId,
            parentResourceId: input.parentResourceId,
          }),
        );
        return yield* respond(CostEstimateResponse)(result);
      }),
    )
    .handle("peerPanes", ({ params, payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const panes = yield* operation(() =>
          peerPanes({
            organizationId,
            pluginId: params.pluginId,
            resourceTypeId: params.typeId,
            accountId: input.accountId,
            resourceId: input.resourceId,
            parentResourceId: input.parentResourceId,
          }),
        );
        return yield* respond(PeerPanes)(panes);
      }),
    )
    .handle("metrics", ({ params, payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* legacy(() =>
          resourceMetrics({
            organizationId,
            pluginId: params.pluginId,
            resourceTypeId: params.typeId,
            accountId: input.accountId,
            resourceId: input.resourceId,
            startMs: input.startMs,
            endMs: input.endMs,
            parentResourceId: input.parentResourceId,
          }),
        );
        return yield* respond(MetricsResponse)(result);
      }),
    ),
);

export const resourcesDomain = makeDomain("resources", ResourcesApi, ResourcesHandlers);
