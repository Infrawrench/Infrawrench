/**
 * Fan-out SSH: `/api/org/:orgId/ssh-fanout`, the handlers.
 *
 * Runs are freeze-gated (running arbitrary commands on fleet hosts is a
 * mutating operation) and audit-logged like the other privileged exec paths.
 * Bodies are judged as the zod validators judged them: strict, refused with
 * the first issue's sentence.
 */
import { and, asc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { Effect, Schema } from "effect";
import type { HttpServerRequest } from "effect/http";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { db } from "../../../db/client";
import { sshSnippets } from "../../../db/schema";
import { logAudit } from "../../../services/audit";
import { FanoutInputError, listFanoutTargets, runFanout } from "../../../services/ssh-fanout";
import { requireNoChangeFreeze } from "../../change-freeze";
import { makeDomain } from "../../domain";
import { BadRequest, conflict, notFound } from "../../errors";
import { readJson } from "../../json-body";
import { decodeFirstIssueStrict } from "../first-issue-body";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import {
  SnippetCreated,
  SnippetList,
  SshFanoutApi,
  SshFanoutRunRequest,
  SshFanoutRunResponse,
  SshFanoutTargetsResponse,
  SshSnippetInput,
} from "./api";

/** The JSON body (a non-JSON one is a 500), judged as the route's zod schema judged it. */
const decodeBody = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  request: HttpServerRequest.HttpServerRequest,
) => Effect.flatMap(readJson(request), (body) => decodeFirstIssueStrict(schema, body));

const SshFanoutHandlers = HttpApiBuilder.group(SshFanoutApi, "sshFanout", (handlers) =>
  handlers
    /**
     * Every SSH-capable target in the org: `ssh` plugin accounts plus resources
     * whose type declares an sshEndpoint with a resolvable host.
     */
    .handle("targets", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const targets = yield* legacy(() => listFanoutTargets(organizationId));
        return yield* respond(SshFanoutTargetsResponse)({ targets });
      }),
    )
    /**
     * Run one command across the selected targets. Per-host results carry
     * stdout, stderr and exit code; transport failures are per-host too.
     */
    .handleRaw("run", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const input = yield* decodeBody(SshFanoutRunRequest, request);
        const commandSnippet = input.command.slice(0, 200);

        // Fan-out exec is a mutating operation: respect change freezes, with the
        // standard override header for holders of freezes:override.
        yield* requireNoChangeFreeze(request, {
          action: "ssh.fanout.run",
          entityType: "organization",
          entityId: organizationId,
          metadata: { targetCount: input.targets.length, commandSnippet },
        });

        const results = yield* legacyTry(
          () =>
            runFanout(organizationId, session.userId, {
              command: input.command,
              targets: [...input.targets],
              sshKeyId: input.sshKeyId,
              username: input.username,
              concurrency: input.concurrency,
            }),
          (error) =>
            error instanceof FanoutInputError
              ? new BadRequest({ error: error.message })
              : undefined,
        );

        const failed = results.filter((r) => r.status !== "done" || r.exitCode !== 0).length;
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ssh.fanout.run",
            entityType: "organization",
            entityId: organizationId,
            metadata: {
              commandSnippet,
              targetCount: input.targets.length,
              failedCount: failed,
              ...(input.sshKeyId ? { sshKeyId: input.sshKeyId } : {}),
            },
          }),
        );
        return yield* respond(SshFanoutRunResponse)({ results });
      }),
    )
    .handle("listSnippets", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rows = yield* legacy(() =>
          db
            .select()
            .from(sshSnippets)
            .where(eq(sshSnippets.organizationId, organizationId))
            .orderBy(asc(sshSnippets.name)),
        );
        return yield* respond(SnippetList)({
          snippets: rows.map((r) => ({
            id: r.id,
            name: r.name,
            command: r.command,
            description: r.description,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
          })),
        });
      }),
    )
    .handleRaw("createSnippet", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const input = yield* decodeBody(SshSnippetInput, request);
        const [existing] = yield* legacy(() =>
          db
            .select({ id: sshSnippets.id })
            .from(sshSnippets)
            .where(
              and(eq(sshSnippets.organizationId, organizationId), eq(sshSnippets.name, input.name)),
            )
            .limit(1),
        );
        if (existing) return yield* conflict("A snippet with this name already exists");

        const id = uuid();
        yield* legacy(() =>
          db.insert(sshSnippets).values({
            id,
            organizationId,
            name: input.name,
            command: input.command,
            description: input.description ?? null,
            createdByUserId: session.userId ?? null,
          }),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ssh.snippet.create",
            entityType: "ssh_snippet",
            entityId: id,
            metadata: { name: input.name },
          }),
        );
        return yield* respond(SnippetCreated)({ id });
      }),
    )
    .handleRaw("updateSnippet", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const input = yield* decodeBody(SshSnippetInput, request);
        const updated = yield* legacy(() =>
          db
            .update(sshSnippets)
            .set({
              name: input.name,
              command: input.command,
              description: input.description ?? null,
              updatedAt: new Date(),
            })
            .where(
              and(eq(sshSnippets.id, params.id), eq(sshSnippets.organizationId, organizationId)),
            )
            .returning({ id: sshSnippets.id }),
        );
        if (updated.length === 0) return yield* notFound("Snippet not found");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ssh.snippet.update",
            entityType: "ssh_snippet",
            entityId: params.id,
            metadata: { name: input.name },
          }),
        );
        return HttpServerResponse.jsonUnsafe(ok);
      }),
    )
    .handle("deleteSnippet", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* legacy(() =>
          db
            .delete(sshSnippets)
            .where(
              and(eq(sshSnippets.id, params.id), eq(sshSnippets.organizationId, organizationId)),
            )
            .returning({ name: sshSnippets.name }),
        );
        const [row] = deleted;
        if (!row) return yield* notFound("Snippet not found");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ssh.snippet.delete",
            entityType: "ssh_snippet",
            entityId: params.id,
            metadata: { name: row.name },
          }),
        );
        return ok;
      }),
    ),
);

export const sshFanoutDomain = makeDomain("ssh-fanout", SshFanoutApi, SshFanoutHandlers);
