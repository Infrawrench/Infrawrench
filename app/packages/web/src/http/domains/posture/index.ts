/**
 * Posture checks: `/api/org/:orgId/posture`, the handlers.
 *
 * The findings are assembled in server-core (`posture/feed.ts`) so the web
 * API, the MCP tool, the weekly digest and the poller's alert pass share one
 * computation: a read over already-synced state, no provider API calls. The
 * dismissal handlers are the ones the access review uses, over the same
 * decision store, under the `posture` audit prefix.
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { listPosture } from "@infrawrench/server-core/posture/feed";
import {
  getPostureSettings,
  updatePostureSettings,
  type PostureSettingsPatch,
  type PostureSettingsRecord,
} from "@infrawrench/server-core/posture/settings";
import { makeDomain } from "../../domain";
import { BadRequest } from "../../errors";
import { legacy, legacyTry } from "../../legacy";
import { invalidBody, readObjectBody } from "../../object-body";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { dismissFinding, restoreFinding } from "../access-review/dismissals";
import { PostureAlertSettings, PostureApi, PostureDismissal, PostureListResponse } from "./api";

function toWire(s: PostureSettingsRecord) {
  return {
    enabled: s.enabled,
    lastNotifiedAt: s.lastNotifiedAt ? s.lastNotifiedAt.toISOString() : null,
  };
}

const PostureHandlers = HttpApiBuilder.group(PostureApi, "posture", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const feed = yield* legacy(() => listPosture(organizationId));
        return yield* respond(PostureListResponse)(feed);
      }),
    )
    .handleRaw("dismiss", ({ request }) =>
      dismissFinding("posture", request).pipe(Effect.flatMap(respond(PostureDismissal))),
    )
    .handle("restore", ({ query }) => restoreFinding("posture", query))
    .handle("getSettings", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const settings = yield* legacy(() => getPostureSettings(organizationId));
        return yield* respond(PostureAlertSettings)(toWire(settings));
      }),
    )
    /** `lastNotifiedAt` is deliberately not writable: it is the poller's cooldown claim. */
    .handleRaw("updateSettings", ({ request }) =>
      Effect.gen(function* () {
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* invalidBody(read.error);
        const body = read.body;
        const patch: PostureSettingsPatch = {};
        const enabled = body["enabled"];
        if (enabled !== undefined) {
          if (!Predicate.isBoolean(enabled)) return yield* invalidBody("enabled must be a boolean");
          patch.enabled = enabled;
        }
        if (Object.keys(patch).length === 0) return yield* invalidBody("No settings supplied");

        const { organizationId } = yield* OrgPrincipal;
        const saved = yield* legacyTry(
          () => updatePostureSettings(organizationId, patch),
          (error) =>
            new BadRequest({
              error:
                error instanceof Error ? error.message : "Failed to save posture alert settings",
            }),
        );
        return yield* respond(PostureAlertSettings)(toWire(saved));
      }),
    ),
);

export const postureDomain = makeDomain("posture", PostureApi, PostureHandlers);
