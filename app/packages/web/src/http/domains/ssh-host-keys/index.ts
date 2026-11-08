/**
 * SSH host-key trust: `/api/org/:orgId/ssh-host-keys`, the handlers.
 *
 * Replaces silent trust-on-first-use: a connection to an unknown host answers
 * 409 `ssh_host_key_trust_required` with the presented fingerprint, the client
 * prompts the user, POSTs `/trust` if they accept, and retries.
 */
import { and, asc, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { db } from "../../../db/client";
import { sshHostKeys } from "../../../db/schema";
import { HostKeyMismatchError, trustHostKey } from "../../../services/ssh-host-keys";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { notFound } from "../../errors";
import { decodeAsPayload, readJsonOr } from "../../request-body";
import { legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import { hostKeyTrustRequired } from "../ssh-host-key-trust";
import { SshHostKeysApi, TrustHostKeyInput } from "./api";

const SshHostKeysHandlers = HttpApiBuilder.group(SshHostKeysApi, "sshHostKeys", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rows = yield* legacy(() =>
          db
            .select({
              id: sshHostKeys.id,
              host: sshHostKeys.host,
              port: sshHostKeys.port,
              fingerprint: sshHostKeys.fingerprint,
              createdAt: sshHostKeys.createdAt,
            })
            .from(sshHostKeys)
            .where(eq(sshHostKeys.organizationId, organizationId))
            .orderBy(asc(sshHostKeys.host)),
        );
        return yield* respond(Schema.Unknown)({ pins: rows });
      }),
    )
    // Raw: a body that is absent or not JSON was always judged as `{}`.
    .handleRaw("trust", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const input = yield* decodeAsPayload(TrustHostKeyInput, yield* readJsonOr(request, {}));
        const { host, port, fingerprint, previousFingerprint } = input;
        // A concurrent connect can observe a different fingerprint than the one
        // the user just accepted: the 409 lets the client re-prompt with it.
        yield* legacyTry(
          () => trustHostKey(organizationId, host, port, fingerprint),
          (error) =>
            error instanceof HostKeyMismatchError ? hostKeyTrustRequired(error) : undefined,
        );
        yield* legacy(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: previousFingerprint ? "ssh_host_key.replaced" : "ssh_host_key.trusted",
            entityType: "ssh_host_key",
            entityId: `${host}:${port}`,
            metadata: previousFingerprint
              ? { host, port, fingerprint, previousFingerprint }
              : { host, port, fingerprint },
          }),
        );
        return HttpServerResponse.jsonUnsafe(ok);
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const where = and(
          eq(sshHostKeys.id, params.id),
          eq(sshHostKeys.organizationId, organizationId),
        );
        const [existing] = yield* legacy(() =>
          db
            .select({
              host: sshHostKeys.host,
              port: sshHostKeys.port,
              fingerprint: sshHostKeys.fingerprint,
            })
            .from(sshHostKeys)
            .where(where)
            .limit(1),
        );
        if (!existing) return yield* notFound("not_found");
        yield* legacy(() => db.delete(sshHostKeys).where(where));
        yield* legacy(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ssh_host_key.removed",
            entityType: "ssh_host_key",
            entityId: `${existing.host}:${existing.port}`,
            metadata: {
              host: existing.host,
              port: existing.port,
              fingerprint: existing.fingerprint,
            },
          }),
        );
        return HttpServerResponse.jsonUnsafe(ok);
      }),
    ),
);

export const sshHostKeysDomain = makeDomain("ssh-host-keys", SshHostKeysApi, SshHostKeysHandlers);
