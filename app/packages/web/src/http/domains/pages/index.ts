/**
 * Paging: `/api/org/:orgId/pages`, the handlers.
 *
 * Each authenticates before reading its input, as the Hono routes did: a
 * session, a WorkOS bearer token or an `iwk_` key holding `pages:write`,
 * pinned to the path's org. Repeat pages under the same `(source, key)` are
 * suppressed for the cooldown window rather than rejected, which the pager
 * reports as `suppressed: true` with the `retryAt` it can page again.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { DEFAULT_PAGE_KEY, type PageSpec } from "@infrawrench/workflow-runtime";
import {
  clearExternalPage,
  pageFromExternal,
} from "@infrawrench/server-core/paging/external-pages";
import { isValidSourceName, SOURCE_NAME_HELP } from "@infrawrench/server-core/source-name";
import {
  badRequest,
  PageClearResponse,
  PageRequest,
  PageResponse,
  PagesApi,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { decodeAsPayload, readJsonOr } from "../../request-body";
import { fireAndForget, legacy } from "../../legacy";
import { asOrgRequestCaller } from "../../org-request-caller";
import { respond } from "../../response";

const PagesHandlers = HttpApiBuilder.group(PagesApi, "pages", (handlers) =>
  handlers
    .handleRaw("raise", ({ request, params }) =>
      asOrgRequestCaller("pages:write", (auth) =>
        Effect.gen(function* () {
          const body = yield* readJsonOr(request, null);
          const { source, message, title, key, cooldownMinutes, voice } = yield* decodeAsPayload(
            PageRequest,
            body,
          );
          if (!isValidSourceName(source)) return yield* badRequest(SOURCE_NAME_HELP);

          // Spread conditionally rather than passing the decoded object through:
          // under exactOptionalPropertyTypes an explicit `title: undefined` is not a PageSpec.
          const spec: PageSpec = {
            message,
            ...(title !== undefined ? { title } : {}),
            ...(key !== undefined ? { key } : {}),
            ...(cooldownMinutes !== undefined ? { cooldownMinutes } : {}),
            ...(voice !== undefined ? { voice } : {}),
          };

          const result = yield* legacy(() =>
            pageFromExternal({ organizationId: params.orgId, source }, spec),
          );

          yield* fireAndForget(() =>
            logAudit({
              organizationId: params.orgId,
              userId: auth.userId,
              apiKeyId: auth.apiKeyId,
              action: "page.raise",
              entityType: "page",
              entityId: `${source}/${key ?? DEFAULT_PAGE_KEY}`,
              metadata: {
                delivered: result.delivered,
                suppressed: result.suppressed,
                sms: result.sms,
                push: result.push,
                slack: result.slack,
                msTeams: result.msTeams,
              },
            }),
          );

          return yield* respond(PageResponse)(result);
        }),
      ),
    )
    // Clear a key's cooldown so the next page under it delivers immediately;
    // the workflow equivalent is `infra.page.clear(key)`.
    .handleRaw("clear", ({ params, query }) =>
      asOrgRequestCaller("pages:write", (auth) =>
        Effect.gen(function* () {
          const source = query.source ?? "";
          if (!isValidSourceName(source)) return yield* badRequest(SOURCE_NAME_HELP);
          const key = query.key || DEFAULT_PAGE_KEY;

          const cleared = yield* legacy(() => clearExternalPage(params.orgId, source, key));

          yield* fireAndForget(() =>
            logAudit({
              organizationId: params.orgId,
              userId: auth.userId,
              apiKeyId: auth.apiKeyId,
              action: "page.clear",
              entityType: "page",
              entityId: `${source}/${key}`,
              metadata: { cleared },
            }),
          );

          return yield* respond(PageClearResponse)({ cleared });
        }),
      ),
    ),
);

export const pagesDomain = makeDomain("pages", PagesApi, PagesHandlers);
