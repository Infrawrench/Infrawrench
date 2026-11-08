/**
 * Linux application host setup: `/api/org/:orgId/apps`, the handlers.
 *
 * Plain requests, and they have to be: the check exists to answer on a host
 * where opening a session would fail (the missing piece may be the `gunzip`
 * that unpacks the app server), so it cannot live inside the session it is
 * there to protect.
 *
 * `POST /setup` is the only route in the app-streaming surface that changes
 * the customer's machine. It takes requirement ids, never a command; it needs
 * `resources:execute`; it respects change freezes, because installing packages
 * on a production host is a change; and it is audited either way. Its body is
 * the progress: the install is started inside the request's scopes before the
 * response is returned, and the stream's pulls only drain what it wrote.
 */
import { PassThrough } from "node:stream";
import { Effect, Schema } from "effect";
import type { HttpServerRequest } from "effect/http";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { HostKeyTrustRequiredError } from "../../../services/ssh-host-keys";
import { AppsKeyMissingError } from "../../../services/apps-host";
import { checkAppsHost, installAppsHostRequirements } from "../../../services/apps-preflight";
import { requireNoChangeFreeze } from "../../change-freeze";
import { makeDomain } from "../../domain";
import { BadGateway, NotFound } from "../../errors";
import { readJson, decodeFirstIssue } from "../../request-body";
import { fireAndForget, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond, webStream } from "../../response";
import { hostKeyTrustBody, hostKeyTrustRefusal } from "../ssh-host-key-trust";
import { LinuxAppHostCheck, LinuxAppHostTarget, LinuxAppSetupRequest, LinuxAppsApi } from "./api";

const messageOr = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/** The JSON body (a non-JSON one is a 500), judged as the route's zod schema judged it. */
const decodeBody = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  request: HttpServerRequest.HttpServerRequest,
) => Effect.flatMap(readJson(request), (body) => decodeFirstIssue(schema, body));

const LinuxAppsHandlers = HttpApiBuilder.group(LinuxAppsApi, "linuxApps", (handlers) =>
  handlers
    /**
     * A POST rather than a GET because it opens an SSH connection to somewhere
     * the caller named, which is not something to leave sitting in a URL, and
     * because it must not be cached: its value is what the host is *now*.
     */
    .handleRaw("check", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const input = yield* decodeBody(LinuxAppHostTarget, request);
        const result = yield* legacyTry(
          () =>
            checkAppsHost({
              organizationId,
              sshKeyId: input.sshKeyId,
              host: input.host,
              username: input.username,
              ...(input.port !== undefined ? { port: input.port } : {}),
            }),
          (error) =>
            hostKeyTrustRefusal(error) ??
            (error instanceof AppsKeyMissingError
              ? new NotFound({ error: "SSH key not found" })
              : new BadGateway({ error: messageOr(error, "Check failed") })),
        );
        return yield* respond(LinuxAppHostCheck)(result);
      }),
    )
    /**
     * Streams NDJSON: one `{"line":"…"}` per line of package-manager output,
     * then a final `{"outcome":{…}}`. Streamed because an `apt-get install` is
     * tens of seconds of silence otherwise, which reads as a hang.
     */
    .handleRaw("setup", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const input = yield* decodeBody(LinuxAppSetupRequest, request);

        // Installing packages on a host is a change to production, and the org
        // may have declared that changes are not happening right now.
        yield* requireNoChangeFreeze(request, {
          action: "linux_app.host_setup",
          entityType: "resource",
          entityId: input.resourceId,
          metadata: { accountId: input.accountId, host: input.host },
        });

        const stream = new PassThrough();
        const write = (payload: unknown) => {
          if (!stream.writableEnded) stream.write(`${JSON.stringify(payload)}\n`);
        };

        // Started before the response is returned, and deliberately not awaited:
        // the body is the progress. A failure has to reach the client *in* the
        // stream, since the status line has gone by the time anything can fail.
        yield* fireAndForget(async () => {
          try {
            const outcome = await installAppsHostRequirements({
              organizationId,
              ...(session.userId ? { userId: session.userId } : {}),
              accountId: input.accountId,
              resourceId: input.resourceId,
              sshKeyId: input.sshKeyId,
              host: input.host,
              username: input.username,
              ...(input.port !== undefined ? { port: input.port } : {}),
              ...(input.requirements ? { include: [...input.requirements] } : {}),
              onOutput: (line) => write({ line }),
            });
            write({ outcome });
          } catch (error) {
            // A host key that changed between the check and the install cannot
            // use the 409 the other route sends, so the same fields travel
            // inside the stream and the client can still prompt with them.
            if (error instanceof HostKeyTrustRequiredError) {
              write(hostKeyTrustBody(error));
            } else {
              write({
                error:
                  error instanceof AppsKeyMissingError
                    ? "SSH key not found"
                    : messageOr(error, "Install failed"),
              });
            }
          } finally {
            stream.end();
          }
        });

        return HttpServerResponse.raw(
          new Response(webStream(stream), {
            headers: {
              "Content-Type": "application/x-ndjson",
              "Cache-Control": "no-store",
              // Progress that a proxy holds until the end is not progress.
              "X-Accel-Buffering": "no",
            },
          }),
        );
      }),
    ),
);

export const linuxAppsDomain = makeDomain("linux-apps", LinuxAppsApi, LinuxAppsHandlers);
