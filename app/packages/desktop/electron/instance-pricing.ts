/**
 * The renderer's way to the instance pricing warehouse. In the main process
 * because, unlike the other cloud calls, it needs no signed-in account (a
 * local-only install has it too), and the renderer's CSP stays closed to the
 * cloud host. Served as `InstancePricingQuery` (`shared/rpc/groups/instance-pricing.ts`).
 */
import { Context, Effect, Layer, Schema } from "effect";
import { errorMessage } from "../shared/rpc/errors";
import { InstancePricingError, InstancePricingResult } from "../shared/rpc/groups/instance-pricing";
import { mainInstancePricing } from "./instance-pricing-client";

const decodeResult = Schema.decodeUnknownEffect(InstancePricingResult);

export class InstancePricing extends Context.Service<
  InstancePricing,
  {
    readonly query: (
      sql: string,
      maxRows: number,
    ) => Effect.Effect<typeof InstancePricingResult.Type, InstancePricingError>;
  }
>()("infrawrench/desktop/InstancePricing") {
  static readonly layer = Layer.succeed(InstancePricing)(
    InstancePricing.of({
      query: (sql, maxRows) =>
        Effect.tryPromise({
          try: () => mainInstancePricing.query(sql, maxRows),
          catch: (cause) => new InstancePricingError({ message: errorMessage(cause) }),
        }).pipe(
          Effect.flatMap((raw) =>
            decodeResult(raw).pipe(
              Effect.mapError(
                (issue) =>
                  new InstancePricingError({
                    message: `The pricing warehouse answered in an unexpected shape: ${issue.message}`,
                  }),
              ),
            ),
          ),
        ),
    }),
  );
}
