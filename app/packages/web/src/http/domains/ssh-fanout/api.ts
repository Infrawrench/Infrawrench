/**
 * Fan-out SSH: `/api/org/:orgId/ssh-fanout`, the endpoint definitions.
 * Listing SSH-capable targets, running one command across many of them, and
 * the org's saved command snippets.
 *
 * The request bodies are the validators the routes always applied (zod's
 * `.strict()` objects, refused with the first issue's sentence), so the
 * writes are served raw and decode them with `decodeForm`.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { maxLength, minLength } from "@infrawrench/ui/schemas";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Conflict, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";
import { ChangeFreezeBlocked } from "../../schemas/change-freeze";

const TargetKind = Schema.Literals(["account", "resource"]);

export const SshFanoutTarget = Schema.Struct({
  kind: TargetKind,
  id: Schema.String,
  accountId: Schema.String,
  label: Schema.String,
  pluginId: Schema.String,
  resourceTypeId: Schema.optionalKey(Schema.String),
  host: Schema.optionalKey(Schema.String),
  defaultUsername: Schema.optionalKey(Schema.String),
  running: Schema.Boolean,
  needsKey: Schema.Boolean,
  tags: Schema.Array(Schema.String),
}).annotate({ identifier: "SshFanoutTarget" });

export const SshFanoutTargetsResponse = Schema.Struct({
  targets: Schema.Array(SshFanoutTarget),
}).annotate({ identifier: "SshFanoutTargetsResponse" });

/**
 * The service refuses more than 100 targets with its own sentence ("Too many
 * targets (max 100)"), so the bound is stated here and enforced there.
 */
const atMostOneHundredTargets = Schema.makeFilter<ReadonlyArray<unknown>>(() => true, {
  toJsonSchema: () => ({ maxItems: 100 }),
});

export const SshFanoutRunRequest = Schema.Struct({
  command: Schema.String.check(minLength(1), maxLength(4000)),
  targets: Schema.Array(
    Schema.Struct({ kind: TargetKind, id: Schema.String.check(minLength(1)) }),
  ).check(minLength(1), atMostOneHundredTargets),
  sshKeyId: Schema.optionalKey(Uuid),
  username: Schema.optionalKey(Schema.String.check(maxLength(64))),
  concurrency: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 }))),
}).annotate({ identifier: "SshFanoutRunRequest" });

const HostKeyTrust = Schema.Struct({
  kind: Schema.Literals(["unknown", "mismatch"]),
  host: Schema.String,
  port: Schema.Int,
  presentedFingerprint: Schema.String,
  storedFingerprint: Schema.NullOr(Schema.String),
});

export const SshFanoutHostResult = Schema.Struct({
  kind: TargetKind,
  targetId: Schema.String,
  label: Schema.String,
  status: Schema.Literals(["done", "error", "blocked"]),
  exitCode: Schema.NullOr(Schema.Int),
  stdout: Schema.String,
  stderr: Schema.String,
  error: Schema.optionalKey(Schema.String),
  durationMs: Schema.Finite,
  hostKeyTrust: Schema.optionalKey(HostKeyTrust),
}).annotate({ identifier: "SshFanoutHostResult" });

export const SshFanoutRunResponse = Schema.Struct({
  results: Schema.Array(SshFanoutHostResult),
}).annotate({ identifier: "SshFanoutRunResponse" });

export const SshSnippet = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  command: Schema.String,
  description: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "SshSnippet" });

export const SshSnippetInput = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(100)),
  command: Schema.String.check(minLength(1), maxLength(4000)),
  description: Schema.optionalKey(Schema.String.check(maxLength(500))),
}).annotate({ identifier: "SshSnippetInput" });

export const SnippetList = Schema.Struct({ snippets: Schema.Array(SshSnippet) });
export const SnippetCreated = Schema.Struct({ id: Uuid });

export class SshFanoutGroup extends HttpApiGroup.make("sshFanout")
  .add(
    HttpApiEndpoint.get("targets", "/targets", {
      params: OrgParams,
      success: SshFanoutTargetsResponse,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List SSH-capable fan-out targets")
      .annotate(
        OpenApi.Description,
        "Every SSH-capable target in the org: `ssh` plugin accounts (native credentials) plus resources whose type declares an sshEndpoint with a resolvable host (EC2 instances, droplets, Hetzner servers, …).",
      )
      .annotate(SuccessDescription, "Targets"),
    HttpApiEndpoint.post("run", "/run", {
      params: OrgParams,
      payload: SshFanoutRunRequest,
      success: SshFanoutRunResponse,
      error: [BadRequest, ChangeFreezeBlocked],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Run one command across many SSH hosts")
      .annotate(
        OpenApi.Description,
        "Executes the command on every selected target under a concurrency cap (default 8, max 16). Per-host results carry stdout, stderr, and exit code; transport failures (unreachable, untrusted host key, blocked internal host) are per-host too. Resource targets need `sshKeyId` (an org SSH key owned by the caller). Blocked with HTTP 423 while a change freeze is in effect; audit-logged.",
      )
      .annotate(SuccessDescription, "Per-host results"),
    HttpApiEndpoint.get("listSnippets", "/snippets", {
      params: OrgParams,
      success: SnippetList,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List saved command snippets")
      .annotate(
        OpenApi.Description,
        "Org-shared saved commands for reuse from the fan-out screen and CLI.",
      )
      .annotate(SuccessDescription, "Snippets"),
    HttpApiEndpoint.post("createSnippet", "/snippets", {
      params: OrgParams,
      payload: SshSnippetInput,
      success: SnippetCreated,
      error: [BadRequest, Conflict],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Save a command snippet")
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.put("updateSnippet", "/snippets/:id", {
      params: OrgIdParams,
      payload: SshSnippetInput,
      success: Ok,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Update a saved command snippet")
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.delete("deleteSnippet", "/snippets/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Delete a saved command snippet")
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/ssh-fanout")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "SSH fan-out") {}

export class SshFanoutApi extends withApiDefaults(HttpApi.make("ssh-fanout").add(SshFanoutGroup)) {}
