/**
 * The pricing pipeline's report pieces, shared by `POST /billing-rules/preview`
 * and the managed-account invoices (an invoice's derivation carries the same
 * effects, coverage and expression failures). Defined once here so both
 * domains document one component each.
 */
import { Schema } from "effect";
import { BILLING_RULE_KINDS } from "@infrawrench/client-core";

const CurrencyMap = Schema.Record(Schema.String, Schema.Finite);

export const PricingEffect = Schema.Struct({
  key: Schema.String.annotate({
    description:
      "A billing rule id, or one of `rerate:list`, `rerate:fallback`, `treatment:discounts`, " +
      "`treatment:credits`, `treatment:commitment_benefits`.",
  }),
  ruleId: Schema.NullOr(Schema.String),
  label: Schema.String,
  kind: Schema.Literals([
    "rerate_list",
    "rerate_fallback",
    "discounts",
    "credits",
    "commitment_benefits",
    ...BILLING_RULE_KINDS,
  ]),
  totals: CurrencyMap.annotate({ description: "Currency → what it added or removed." }),
}).annotate({
  identifier: "PricingEffect",
  description: "One rule or setting that moved money, in pipeline order.",
});

export const RerateCoverage = Schema.Struct({
  byCurrency: Schema.Record(
    Schema.String,
    Schema.Struct({
      listPriced: Schema.Finite.annotate({
        description: "Collected spend priced from a provider-reported list price.",
      }),
      listTotal: Schema.Finite.annotate({ description: "What that spend lists at." }),
      fallback: Schema.Finite.annotate({
        description: "Collected spend with no list price, priced at the uplift.",
      }),
    }),
  ),
  services: Schema.Array(
    Schema.Struct({
      pluginId: Schema.String,
      service: Schema.String,
      currency: Schema.String,
      listPriced: Schema.Finite,
      fallback: Schema.Finite,
    }),
  ),
}).annotate({ identifier: "RerateCoverage" });

export const PricingExpressionFailure = Schema.Struct({
  ruleId: Schema.String,
  name: Schema.String,
  lines: Schema.Int,
  message: Schema.String,
}).annotate({
  identifier: "PricingExpressionFailure",
  description:
    "An expression rule that could not price some lines (division by zero, a non-finite " +
    "result). Those lines kept their previous cost rather than becoming zero.",
});
