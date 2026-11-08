/**
 * Slack connection and channel routing, the handlers.
 *
 * `install-url` points at our own `start` hop rather than straight at Slack:
 * the request may come from the desktop main process or the mobile app,
 * neither of which is the browser that will finish the install, so the nonce
 * cookie is set when that browser arrives (the `slack-oauth` domain,
 * `http/domains/slack-oauth/`).
 */
import crypto from "node:crypto";
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { and, eq, isNull } from "drizzle-orm";
import {
  isSlackConfigured,
  listSlackChannels,
  newSlackStateNonce,
  sendSlackTest,
  signSlackState,
} from "@infrawrench/server-core/slack";
import { db } from "../../../db/client";
import { slackChannels, slackInstallations } from "../../../db/schema";
import { makeDomain } from "../../domain";
import { badRequest, notFound } from "../../errors";
import { fieldsOf, readJson } from "../../json-body";
import { legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import {
  SlackApi,
  SlackAvailableChannels,
  SlackChannel,
  SlackInstallUrl,
  SlackStatus,
  SlackTestResult,
} from "./api";

/** The same base the OAuth hops derive their URLs from (`http/domains/slack-oauth/`). */
function appUrl(): string {
  return process.env["APP_URL"] ?? "http://localhost:3000";
}

function liveInstallations(organizationId: string) {
  return db
    .select()
    .from(slackInstallations)
    .where(
      and(
        eq(slackInstallations.organizationId, organizationId),
        isNull(slackInstallations.deletedAt),
      ),
    );
}

const refusedWith = (fallback: string) => (error: unknown) =>
  badRequest(error instanceof Error ? error.message : fallback);

/** `body.x?.trim()` as the route read it: a string, else nothing. */
const trimmed = (value: unknown): string | undefined =>
  Predicate.isString(value) ? value.trim() : undefined;

const SlackHandlers = HttpApiBuilder.group(SlackApi, "slack", (handlers) =>
  handlers
    .handle("status", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const installs = yield* legacy(() => liveInstallations(organizationId));
        const channels = yield* legacy(() =>
          db
            .select()
            .from(slackChannels)
            .where(eq(slackChannels.organizationId, organizationId))
            .orderBy(slackChannels.channelName),
        );
        return yield* respond(SlackStatus)({
          configured: isSlackConfigured(),
          installations: installs.map((i) => ({
            id: i.id,
            teamId: i.teamId,
            teamName: i.teamName,
          })),
          // Hide channels whose install has been disconnected; the rows stay
          // so a re-install restores them.
          channels: channels.flatMap((ch) =>
            installs.some((i) => i.id === ch.installationId)
              ? [
                  {
                    id: ch.id,
                    installationId: ch.installationId,
                    channelId: ch.channelId,
                    channelName: ch.channelName,
                    isPrivate: ch.isPrivate,
                  },
                ]
              : [],
          ),
        });
      }),
    )
    .handle("installUrl", () =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        if (!isSlackConfigured()) {
          return yield* badRequest("Slack is not configured on this server.");
        }
        const userId = session.userId;
        if (!userId) {
          return yield* badRequest("A Slack install must be started by a signed-in user.");
        }
        const state = signSlackState(organizationId, userId, newSlackStateNonce());
        const start = `${appUrl().replace(/\/$/, "")}/api/slack/oauth/start`;
        return yield* respond(SlackInstallUrl)({
          url: `${start}?state=${encodeURIComponent(state)}`,
        });
      }),
    )
    // A live call, not cached.
    .handle("availableChannels", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const channels = yield* legacyTry(
          () => listSlackChannels(organizationId, params.installationId),
          refusedWith("Failed to list Slack channels"),
        );
        return yield* respond(SlackAvailableChannels)({ channels });
      }),
    )
    // Soft-delete so a re-install restores the workspace's channels.
    .handle("deleteInstallation", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* legacy(() =>
          db
            .update(slackInstallations)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(
              and(
                eq(slackInstallations.id, params.installationId),
                eq(slackInstallations.organizationId, organizationId),
              ),
            )
            .returning({ id: slackInstallations.id }),
        );
        if (result.length === 0) return yield* notFound("Slack workspace not found");
        return ok;
      }),
    )
    // Re-adding an existing channel refreshes its cached name. What it
    // receives is an `alert_rules` question, not part of this row.
    .handleRaw("addChannel", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const body = yield* fieldsOf(yield* readJson(request));
        const installationId = body["installationId"];
        const channelId = trimmed(body["channelId"]);
        const channelName = trimmed(body["channelName"])?.replace(/^#/, "");
        const isPrivate = body["isPrivate"];
        if (!installationId) return yield* badRequest("installationId is required");
        if (!channelId) return yield* badRequest("channelId is required");
        if (!channelName) return yield* badRequest("channelName is required");
        if (isPrivate != null && !Predicate.isBoolean(isPrivate)) {
          return yield* badRequest("isPrivate must be a boolean");
        }

        // The install must belong to this org, otherwise a caller could
        // attach a channel to someone else's workspace by guessing an id.
        const installs = yield* legacy(() => liveInstallations(organizationId));
        if (!Predicate.isString(installationId) || !installs.some((i) => i.id === installationId)) {
          return yield* notFound("Slack workspace not found");
        }

        const now = new Date();
        const [row] = yield* legacy(() =>
          db
            .insert(slackChannels)
            .values({
              id: crypto.randomUUID(),
              organizationId,
              installationId,
              channelId,
              channelName,
              isPrivate: isPrivate ?? false,
            })
            .onConflictDoUpdate({
              target: [slackChannels.installationId, slackChannels.channelId],
              // A field the request omitted keeps its stored value.
              set: {
                channelName,
                ...(isPrivate != null ? { isPrivate } : {}),
                updatedAt: now,
              },
            })
            .returning(),
        );
        return yield* respond(SlackChannel)(row);
      }),
    )
    // After a Slack-side rename.
    .handleRaw("renameChannel", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const { channelName: raw } = yield* fieldsOf(yield* readJson(request));
        if (!Predicate.isString(raw)) return yield* badRequest("channelName must be a string");
        const channelName = raw.trim().replace(/^#/, "");
        if (!channelName) return yield* badRequest("channelName is required");
        const result = yield* legacy(() =>
          db
            .update(slackChannels)
            .set({ channelName, updatedAt: new Date() })
            .where(
              and(
                eq(slackChannels.id, params.id),
                eq(slackChannels.organizationId, organizationId),
              ),
            )
            .returning(),
        );
        if (result.length === 0) return yield* notFound("Channel not found");
        return yield* respond(SlackChannel)(result[0]);
      }),
    )
    .handle("deleteChannel", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* legacy(() =>
          db
            .delete(slackChannels)
            .where(
              and(
                eq(slackChannels.id, params.id),
                eq(slackChannels.organizationId, organizationId),
              ),
            )
            .returning({ id: slackChannels.id }),
        );
        if (result.length === 0) return yield* notFound("Channel not found");
        return ok;
      }),
    )
    // Every configured channel gets the message, whatever the routing rules say.
    .handle("test", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const summary = yield* legacyTry(
          () => sendSlackTest(organizationId),
          refusedWith("Failed to send Slack test message"),
        );
        return yield* respond(SlackTestResult)({ ok: true, ...summary });
      }),
    ),
);

export const slackDomain = makeDomain("slack", SlackApi, SlackHandlers);
