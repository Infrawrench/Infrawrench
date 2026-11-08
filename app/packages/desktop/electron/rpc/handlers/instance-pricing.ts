import { Effect, Layer } from "effect";
import { InstancePricingRpcs } from "../../../shared/rpc/groups/instance-pricing";
import { InstancePricing } from "../../instance-pricing";

export const InstancePricingHandlers = InstancePricingRpcs.toLayer(
  Effect.gen(function* () {
    const pricing = yield* InstancePricing;
    return InstancePricingRpcs.of({
      InstancePricingQuery: ({ sql, maxRows }) => pricing.query(sql, maxRows),
    });
  }),
).pipe(Layer.provide(InstancePricing.layer));
