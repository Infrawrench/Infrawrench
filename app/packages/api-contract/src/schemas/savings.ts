/** Realized savings bodies (PUT /savings/settings, /savings/events), as Effect schemas. */
import { Schema } from "effect";
import {
  REALIZED_SAVINGS_LIMITS,
  type RealizedSavingsSettings as RealizedSavingsSettingsContract,
  type SavingsEventAnnotationInput as SavingsEventAnnotationInputContract,
  type SavingsEventInput as SavingsEventInputContract,
} from "@infrawrench/client-core";
import { maxLength, minLength, trimmed } from "./checks";
import type { Exact } from "./contract";
import { CurrencyCode, IsoDate, NonEmptyString } from "./primitives";

const L = REALIZED_SAVINGS_LIMITS;
const between = (minimum: number, maximum: number) => Schema.isBetween({ minimum, maximum });

/** PUT /savings/settings. */
export const RealizedSavingsSettings = Schema.Struct({
  horizonMonths: Schema.Int.check(between(L.minHorizonMonths, L.maxHorizonMonths)).annotate({
    description: "How long a one-off action keeps accruing, in months. Default 12.",
  }),
  shortfallThresholdPercent: Schema.Int.check(
    between(L.minShortfallThresholdPercent, L.maxShortfallThresholdPercent),
  ).annotate({
    description: "Below this share of the projected rate an action is flagged short. Default 70.",
  }),
  baselineWindowDays: Schema.Int.check(
    between(L.minBaselineWindowDays, L.maxBaselineWindowDays),
  ).annotate({
    description: "Days before the action whose spend makes up the baseline. Default 14.",
  }),
}).annotate({ identifier: "RealizedSavingsSettings" });

const SavingsDay = IsoDate.annotate({ examples: ["2026-07-01"] });
const SavingsNote = Schema.NullOr(Schema.String.check(maxLength(L.noteMaxLength)));
const SavingsHorizon = Schema.NullOr(
  Schema.Int.check(between(L.minHorizonMonths, L.maxHorizonMonths)),
);
const Reference = Schema.NullOr(NonEmptyString);

/** POST /savings/events and PUT /savings/events/:id (manual entries). */
export const SavingsEventInput = Schema.Struct({
  title: trimmed([minLength(1), maxLength(L.titleMaxLength)]),
  note: Schema.optionalKey(SavingsNote),
  occurredOn: SavingsDay,
  endedOn: Schema.optionalKey(Schema.NullOr(SavingsDay)),
  projectedMonthlyAmount: Schema.Finite.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(L.maxMonthlyAmount),
  ),
  currency: CurrencyCode,
  resourceId: Schema.optionalKey(
    Reference.annotate({
      description: "Link a resource: the realized figure is then measured from its billing.",
    }),
  ),
  accountId: Schema.optionalKey(Reference),
  costCentreId: Schema.optionalKey(Reference),
  horizonMonths: Schema.optionalKey(SavingsHorizon),
}).annotate({ identifier: "SavingsEventInput" });

/** PATCH /savings/events/:id: the context any event takes, automatic ones included. */
export const SavingsEventAnnotation = Schema.Struct({
  note: Schema.optionalKey(SavingsNote),
  costCentreId: Schema.optionalKey(Reference),
  horizonMonths: Schema.optionalKey(SavingsHorizon),
  endedOn: Schema.optionalKey(Schema.NullOr(SavingsDay)),
}).annotate({ identifier: "SavingsEventAnnotation" });

export type SavingsSchemasMatchContract = [
  Exact<typeof RealizedSavingsSettings.Type, RealizedSavingsSettingsContract>,
  Exact<typeof SavingsEventInput.Type, SavingsEventInputContract>,
  Exact<typeof SavingsEventAnnotation.Type, SavingsEventAnnotationInputContract>,
];
[true, true, true] satisfies SavingsSchemasMatchContract;
