/**
 * Microsoft Teams channel routing, the handlers. There is no OAuth here,
 * unlike Slack: an org pastes the webhook URL of a Teams "Workflows"
 * automation and we post to it (`server-core/src/msteams.ts` has why). Which
 * alerts reach a channel is an `alert_rules` question (`PUT /alert-rules`).
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { and, eq } from "drizzle-orm";
import {
  addMsTeamsWebhook,
  listMsTeamsWebhooks,
  sendMsTeamsTest,
} from "@infrawrench/server-core/msteams";
import {
  badRequest,
  MsTeamsApi,
  MsTeamsStatus,
  MsTeamsTestResult,
  MsTeamsWebhook,
  notFound,
  ok,
} from "@infrawrench/api-contract";
import { db } from "../../../db/client";
import { msteamsWebhooks } from "../../../db/schema";
import { makeDomain } from "../../domain";
import { fieldsOf, readJson } from "../../request-body";
import { legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

/** Any failure of a write the user started: its message, rendered verbatim by the form. */
const refusedWith = (fallback: string) => (error: unknown) =>
  badRequest(error instanceof Error ? error.message : fallback);

/** `body.x?.trim()` as the route read it: present and non-blank. */
const nonBlank = (value: unknown): value is string =>
  Predicate.isString(value) && value.trim() !== "";

const MsTeamsHandlers = HttpApiBuilder.group(MsTeamsApi, "msteams", (handlers) =>
  handlers
    .handle("status", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const webhooks = yield* legacy(() => listMsTeamsWebhooks(organizationId));
        return yield* respond(MsTeamsStatus)({ webhooks });
      }),
    )
    // A rejected URL (wrong host, not https) is a 400 written for the user.
    .handleRaw("addWebhook", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* fieldsOf(yield* readJson(request));
        const label = body["label"];
        const url = body["url"];
        if (!nonBlank(label)) return yield* badRequest("label is required");
        if (!nonBlank(url)) return yield* badRequest("url is required");
        const webhook = yield* legacyTry(
          () => addMsTeamsWebhook(organizationId, session.userId ?? null, { label, url }),
          refusedWith("Failed to save Teams webhook"),
        );
        return yield* respond(MsTeamsWebhook)(webhook);
      }),
    )
    // The URL is immutable; routing lives in `alert_rules`.
    .handleRaw("renameWebhook", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const { label: raw } = yield* fieldsOf(yield* readJson(request));
        if (!Predicate.isString(raw)) return yield* badRequest("label must be a string");
        const label = raw.trim();
        if (!label) return yield* badRequest("label cannot be empty");
        const [row] = yield* legacy(() =>
          db
            .update(msteamsWebhooks)
            .set({ label, updatedAt: new Date() })
            .where(
              and(
                eq(msteamsWebhooks.id, params.id),
                eq(msteamsWebhooks.organizationId, organizationId),
              ),
            )
            .returning(),
        );
        if (!row) return yield* notFound("Teams channel not found");
        return yield* respond(MsTeamsWebhook)({
          id: row.id,
          label: row.label,
          urlHint: row.urlHint,
        });
      }),
    )
    .handle("deleteWebhook", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const removed = yield* legacy(() =>
          db
            .delete(msteamsWebhooks)
            .where(
              and(
                eq(msteamsWebhooks.id, params.id),
                eq(msteamsWebhooks.organizationId, organizationId),
              ),
            )
            .returning({ id: msteamsWebhooks.id }),
        );
        if (removed.length === 0) return yield* notFound("Teams channel not found");
        return ok;
      }),
    )
    // Every configured channel gets the card, whatever the routing rules say.
    .handle("test", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const summary = yield* legacyTry(
          () => sendMsTeamsTest(organizationId),
          refusedWith("Failed to send Teams test message"),
        );
        return yield* respond(MsTeamsTestResult)({ ok: true, ...summary });
      }),
    ),
);

export const msTeamsDomain = makeDomain("msteams", MsTeamsApi, MsTeamsHandlers);
