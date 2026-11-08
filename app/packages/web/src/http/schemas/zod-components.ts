/**
 * Components the hand-written Zod registry still defines, referenced rather
 * than redefined.
 *
 * Some response bodies embed a component whose owning route is still on Hono
 * (`CostQueryResponse` is `/costs/query`'s, the VS Code and Raycast
 * extensions' contract; `CostAnomaly` is `/costs/anomalies`'). Defining it
 * again here would replace the Zod definition for every operation in the
 * document, so a domain refers to it by name: the document carries a bare
 * `$ref` to the registry's definition, and on the wire it is whatever the
 * service sent. When the owning route moves, its domain defines the component
 * and the reference here becomes an import of that schema.
 */
import { Schema } from "effect";

// The reference rides the encoded side, as `plugin-registry.ts`'s does: a
// check on `Schema.Unknown` itself is dropped from the JSON Schema.
const zodComponent = (name: string) =>
  Schema.Unknown.pipe(
    Schema.encodeTo(
      Schema.Any.check(
        Schema.makeFilter(() => true, {
          toJsonSchema: () => ({ $ref: `#/components/schemas/${name}` }),
        }),
      ),
    ),
  );

/** `POST /costs/query`'s result (`api/openapi/paths/costs.ts`). */
export const CostQueryResponse = zodComponent("CostQueryResponse");

/** One detected cost anomaly, as `GET /costs/anomalies` lists it. */
export const CostAnomaly = zodComponent("CostAnomaly");

/** A change's measured cost impact, as `POST /changes/cost-impacts` reports it. */
export const ChangeCostImpact = zodComponent("ChangeCostImpact");

/** The charge-type basis a change's cost impact is read on. */
export const ChangeCostBasis = zodComponent("ChangeCostBasis");

/**
 * The pricing pipeline's report pieces, shared by `POST /billing-rules/preview`
 * and the managed-account invoices (`api/openapi/paths/billing-rules.ts`,
 * documented under `/invoices`).
 */
export const PricingEffect = zodComponent("PricingEffect");
export const RerateCoverage = zodComponent("RerateCoverage");
export const PricingExpressionFailure = zodComponent("PricingExpressionFailure");
