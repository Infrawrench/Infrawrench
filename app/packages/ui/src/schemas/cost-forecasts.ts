/**
 * Named forecasts on a report and the inputs that drive them, as Effect
 * schemas: POST/PUT /cost-reports/{id}/forecasts, POST
 * /cost-reports/{id}/forecasted-costs and POST
 * /business-metrics/{id}/forecast-values.
 */
import { Effect, Schema } from "effect";
import {
  BUSINESS_METRIC_LIMITS,
  COST_FORECAST_CONFIDENCE_LEVELS,
  COST_FORECAST_LIMITS,
  type BusinessMetricForecastValueInput as BusinessMetricForecastValueInputContract,
  type CostForecastInput as CostForecastInputContract,
  type CostForecastRunRequest as CostForecastRunRequestContract,
} from "@infrawrench/client-core";
import { maxLength, minLength } from "./checks";
import type { Exact } from "./contract";
import { IsoDate } from "./primitives";

const ForecastDay = IsoDate.annotate({ examples: ["2026-11-01"] });
const Ref = (max: number) => Schema.String.check(minLength(1), maxLength(max));

export const CostForecastConfidenceLevel = Schema.Literals(
  COST_FORECAST_CONFIDENCE_LEVELS,
).annotate({
  identifier: "CostForecastConfidenceLevel",
  description:
    "Two-sided level of the band, in percent. The band is the least-squares prediction " +
    "interval: it widens with distance from the data and with how badly a straight line fits " +
    "the last 30 days.",
});

/** Create/update body for a report's named forecast. */
export const CostForecastInput = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(COST_FORECAST_LIMITS.maxNameLength)),
  description: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(maxLength(COST_FORECAST_LIMITS.maxDescriptionLength))),
  ),
  scenarioModelIds: Schema.mutable(Schema.Array(Ref(200)))
    .check(maxLength(COST_FORECAST_LIMITS.maxScenarioModels))
    .annotate({
      description:
        "Scenario models to apply, **in priority order**. Each model is applied to the line the " +
        "previous ones produced, so an org-wide percentage in a later model also scales amounts " +
        "an earlier one added. Deleting a model a forecast names is refused.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
  driverMetricId: Schema.optionalKey(
    Schema.NullOr(Ref(200)).annotate({
      description:
        "A business metric whose forecasted values drive the baseline: projected unit cost (the " +
        "report's spend per unit, trended) times the forecasted value. Null keeps the trend.",
    }),
  ),
  isDefault: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Make this the report's default forecast, clearing any other. On update, absent keeps the " +
        "current setting and false makes the report fall back to the automatic forecast.",
    }),
  ),
}).annotate({ identifier: "CostForecastInput" });

/** Body for the forecasted-costs read; every field optional. */
export const CostForecastRunRequest = Schema.Struct({
  from: Schema.optionalKey(
    ForecastDay.annotate({
      description:
        "First projected day; defaults to (and is never earlier than) the day after the last day " +
        "with observed spend.",
    }),
  ),
  to: Schema.optionalKey(
    ForecastDay.annotate({
      description:
        "Last projected day; defaults to 90 days after the last observed day, at most 366.",
    }),
  ),
  forecastId: Schema.optionalKey(
    Ref(200).annotate({
      description:
        'A forecast id, `"baseline"` for the automatic forecast, or absent for the report\'s ' +
        "default (the automatic forecast when none is set).",
    }),
  ),
  providers: Schema.optionalKey(
    Schema.mutable(Schema.Array(Ref(200)))
      .check(maxLength(50))
      .annotate({
        description: "Narrow to these providers (plugin ids), ANDed with the report's filters.",
      }),
  ),
  services: Schema.optionalKey(
    Schema.mutable(Schema.Array(Ref(500)))
      .check(maxLength(100))
      .annotate({ description: "Narrow to these services, ANDed with the report's filters." }),
  ),
  confidenceLevel: Schema.optionalKey(CostForecastConfidenceLevel),
  all: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Also return every named forecast, side by side." }),
  ),
}).annotate({ identifier: "CostForecastRunRequest" });

export const BusinessMetricForecastValueInput = Schema.Struct({
  date: ForecastDay,
  value: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** The batch envelope for `POST /business-metrics/{id}/forecast-values`. */
export const BusinessMetricForecastValuesBody = Schema.Struct({
  values: Schema.mutable(Schema.Array(BusinessMetricForecastValueInput)).check(
    minLength(1),
    maxLength(BUSINESS_METRIC_LIMITS.maxValuesPerCall),
  ),
}).annotate({ identifier: "BusinessMetricForecastValuesInput" });

export type CostForecastSchemasMatchContract = [
  Exact<typeof CostForecastInput.Type, CostForecastInputContract>,
  Exact<typeof CostForecastRunRequest.Type, CostForecastRunRequestContract>,
  Exact<typeof BusinessMetricForecastValueInput.Type, BusinessMetricForecastValueInputContract>,
];
[true, true, true] satisfies CostForecastSchemasMatchContract;
