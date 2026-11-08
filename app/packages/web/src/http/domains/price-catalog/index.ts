/**
 * The org-level price catalog: `/api/org/:orgId/price-catalog`, the handlers.
 * The service lives in server-core; the query normalizers in client-core.
 */
import { Effect } from "effect";
import type { HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  getPriceCatalogService,
  PriceCatalogNotFoundError,
  PriceCatalogQueryError,
} from "@infrawrench/server-core/price-catalog";
import {
  normalizePriceCatalogCompareQuery,
  normalizePriceCatalogSearchQuery,
} from "@infrawrench/client-core";
import {
  BadRequest,
  NotFound,
  PriceCatalogApi,
  PriceCatalogCompareResponse,
  PriceCatalogProviders,
  PriceCatalogSearchResponse,
} from "@infrawrench/api-contract";
import { makeDomain } from "../../domain";
import { legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

/**
 * The query as the normalizers have always received it: every parameter,
 * documented or not, at its first value.
 */
function rawQuery(request: HttpServerRequest.HttpServerRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URL(request.url, "http://localhost").searchParams) {
    if (!Object.hasOwn(out, key)) out[key] = value;
  }
  return out;
}

const PriceCatalogHandlers = HttpApiBuilder.group(PriceCatalogApi, "priceCatalog", (handlers) =>
  handlers
    .handle("providers", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const providers = yield* legacy(() =>
          getPriceCatalogService().listProviders(organizationId),
        );
        return yield* respond(PriceCatalogProviders)({ providers });
      }),
    )
    .handle("search", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const query = normalizePriceCatalogSearchQuery(rawQuery(request));
        const result = yield* legacy(() => getPriceCatalogService().search(organizationId, query));
        return yield* respond(PriceCatalogSearchResponse)(result);
      }),
    )
    .handle("compare", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const query = normalizePriceCatalogCompareQuery(rawQuery(request));
        const result = yield* legacyTry(
          () => getPriceCatalogService().compare(organizationId, query),
          (error) =>
            error instanceof PriceCatalogQueryError
              ? new BadRequest({ error: error.message })
              : error instanceof PriceCatalogNotFoundError
                ? new NotFound({ error: error.message })
                : undefined,
        );
        return yield* respond(PriceCatalogCompareResponse)(result);
      }),
    ),
);

export const priceCatalogDomain = makeDomain(
  "price-catalog",
  PriceCatalogApi,
  PriceCatalogHandlers,
);
