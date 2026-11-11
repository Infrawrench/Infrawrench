/**
 * `/api/org/:orgId/products`: the organization's app policy, the handlers.
 * The store is server-core's `products/settings`, which is also what the
 * tool gate (`tools/permissions.ts`) reads, so the page and the assistant
 * cannot disagree about which apps are off.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { BadRequest, OrgProductPolicy, ProductsApi } from "@infrawrench/api-contract";
import {
  disabledProducts,
  ProductSettingsError,
  setDisabledProducts,
} from "@infrawrench/server-core/products/settings";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

const ProductsHandlers = HttpApiBuilder.group(ProductsApi, "products", (handlers) =>
  handlers
    .handle("get", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const disabled = yield* legacy(() => disabledProducts(organizationId));
        return yield* respond(OrgProductPolicy)({ disabled });
      }),
    )
    .handle("update", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const disabled = yield* legacyTry(
          () => setDisabledProducts(organizationId, payload.disabled),
          (error) =>
            error instanceof ProductSettingsError
              ? new BadRequest({ error: error.message })
              : undefined,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "product_settings.update",
            entityType: "product_settings",
            entityId: organizationId,
            metadata: { disabled },
          }),
        );
        return yield* respond(OrgProductPolicy)({ disabled });
      }),
    ),
);

export const productsDomain = makeDomain("products", ProductsApi, ProductsHandlers);
