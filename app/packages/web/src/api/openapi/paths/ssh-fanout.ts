import { z } from "../zod";
import { strict, ErrorResponses, Uuid, Ok, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";
import { FreezeLockedResponse } from "./change-freezes";

const FanoutTarget = strict({
  kind: z.enum(["account", "resource"]),
  id: z.string(),
  accountId: z.string(),
  label: z.string(),
  pluginId: z.string(),
  resourceTypeId: z.string().optional(),
  host: z.string().optional(),
  defaultUsername: z.string().optional(),
  running: z.boolean(),
  needsKey: z.boolean(),
  tags: z.array(z.string()),
}).openapi("SshFanoutTarget");

const TargetsResponse = strict({ targets: z.array(FanoutTarget) }).openapi(
  "SshFanoutTargetsResponse",
);

const RunRequest = strict({
  command: z.string().min(1).max(4000),
  targets: z
    .array(strict({ kind: z.enum(["account", "resource"]), id: z.string() }))
    .min(1)
    .max(100),
  sshKeyId: Uuid.optional(),
  username: z.string().max(64).optional(),
  concurrency: z.number().int().min(1).max(16).optional(),
}).openapi("SshFanoutRunRequest");

const HostResult = strict({
  kind: z.enum(["account", "resource"]),
  targetId: z.string(),
  label: z.string(),
  status: z.enum(["done", "error", "blocked"]),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  error: z.string().optional(),
  durationMs: z.number(),
  hostKeyTrust: strict({
    kind: z.enum(["unknown", "mismatch"]),
    host: z.string(),
    port: z.number().int(),
    presentedFingerprint: z.string(),
    storedFingerprint: z.string().nullable(),
  }).optional(),
}).openapi("SshFanoutHostResult");

const RunResponse = strict({ results: z.array(HostResult) }).openapi("SshFanoutRunResponse");

const Snippet = strict({
  id: Uuid,
  name: z.string(),
  command: z.string(),
  description: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("SshSnippet");

const SnippetInput = strict({
  name: z.string().min(1).max(100),
  command: z.string().min(1).max(4000),
  description: z.string().max(500).optional(),
}).openapi("SshSnippetInput");

export function registerSshFanoutPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/ssh-fanout/targets",
    tags: ["SSH fan-out"],
    summary: "List SSH-capable fan-out targets",
    description:
      "Every SSH-capable target in the org: `ssh` plugin accounts (native credentials) plus resources whose type declares an sshEndpoint with a resolvable host (EC2 instances, droplets, Hetzner servers, …).",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Targets",
        content: { "application/json": { schema: TargetsResponse } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/ssh-fanout/run",
    tags: ["SSH fan-out"],
    summary: "Run one command across many SSH hosts",
    description:
      "Executes the command on every selected target under a concurrency cap (default 8, max 16). Per-host results carry stdout, stderr, and exit code; transport failures (unreachable, untrusted host key, blocked internal host) are per-host too. Resource targets need `sshKeyId` (an org SSH key owned by the caller). Blocked with HTTP 423 while a change freeze is in effect; audit-logged.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: RunRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Per-host results",
        content: { "application/json": { schema: RunResponse } },
      },
      400: ErrorResponses[400],
      423: FreezeLockedResponse,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/ssh-fanout/snippets",
    tags: ["SSH fan-out"],
    summary: "List saved command snippets",
    description: "Org-shared saved commands for reuse from the fan-out screen and CLI.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Snippets",
        content: { "application/json": { schema: strict({ snippets: z.array(Snippet) }) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/ssh-fanout/snippets",
    tags: ["SSH fan-out"],
    summary: "Save a command snippet",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SnippetInput } }, required: true },
    },
    responses: {
      200: {
        description: "Created",
        content: { "application/json": { schema: strict({ id: Uuid }) } },
      },
      400: ErrorResponses[400],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/ssh-fanout/snippets/{id}",
    tags: ["SSH fan-out"],
    summary: "Update a saved command snippet",
    request: {
      params: OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) }),
      body: { content: { "application/json": { schema: SnippetInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: Ok } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/ssh-fanout/snippets/{id}",
    tags: ["SSH fan-out"],
    summary: "Delete a saved command snippet",
    request: { params: OrgIdParam.extend({ id: Uuid }) },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });
}
