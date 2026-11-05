/**
 * Server-side Revnu purchase events.
 *
 * The browser tag is diagnostic. A purchase is reported only after the signed
 * Stripe webhook has confirmed `payment_status=paid`; the webhook queues the
 * event and `revnu-report-pass.ts` sends it. This module never sends
 * `test: true`; the `revnu:test` script is the only caller that does.
 */

const REVNU_EVENTS_URL = "https://revnu.com/api/measurement/events";

/** Stripe's zero-decimal currencies: the API amount is already a major unit. */
const ZERO_DECIMAL = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

/** Stripe's three-decimal currencies: the API amount is in thousandths. */
const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

const ANONYMOUS_ID = /^ra_[0-9a-f]{32}$/;
const CONSENT_STATES = new Set(["granted", "denied", "pending"]);

export type RevnuConsentState = "granted" | "denied" | "pending";

export interface ParsedMeasurement {
  anonymousId: string | null;
  consentState: RevnuConsentState | null;
}

export interface PaymentSucceededInput {
  eventId: string;
  occurredAt: unknown;
  anonymousId?: string | null;
  consentState?: string | null;
  /** Stripe `amount_total`, in minor units. */
  amountMinor?: number | null;
  currency?: string | null;
  email?: string | null;
  phone?: string | null;
  purchaseKind?: string | null;
}

export interface PaymentSucceededEvent {
  event_id: string;
  event_name: "payment_succeeded";
  occurred_at: string;
  anonymous_id?: string;
  consent_state?: RevnuConsentState;
  amount?: number;
  currency?: string;
  email?: string;
  phone?: string;
  properties?: { purchase_kind: "subscription" | "capacity_slot" };
}

export type RevnuPostResult = "accepted" | "rejected" | "retry" | "unconfigured";

export function parseMeasurement(raw: unknown): ParsedMeasurement {
  const empty: ParsedMeasurement = { anonymousId: null, consentState: null };
  if (!raw || typeof raw !== "object") return empty;
  const value = raw as Record<string, unknown>;
  return {
    anonymousId: anonymousIdOrNull(value["anonymousId"]),
    consentState: consentOrNull(value["consentState"]),
  };
}

/**
 * Stripe minor units to major units.
 *
 * Two-decimal currencies, including USD, are divided by 100. Stripe's
 * zero-decimal list is already in major units, and its three-decimal list is
 * divided by 1000. UGX is on some zero-decimal lists but Stripe's currency docs
 * say UGX and ISK amounts are still two-decimal (an amount of 500 is 5), so both
 * are divided by 100.
 */
export function stripeMinorToMajor(
  amountMinor: number,
  currency: string,
): { amount: number; currency: string } | null {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) return null;
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  const decimals = ZERO_DECIMAL.has(code) ? 0 : THREE_DECIMAL.has(code) ? 3 : 2;
  return { amount: minorToMajor(amountMinor, decimals), currency: code };
}

export function occurredAtIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }
  return null;
}

/** Null when the timestamp cannot be sent. Callers skip the event rather than guess. */
export function buildPaymentSucceededEvent(
  input: PaymentSucceededInput,
): PaymentSucceededEvent | null {
  if (!input.eventId) return null;
  const occurredAt = occurredAtIso(input.occurredAt);
  if (!occurredAt) return null;

  const event: PaymentSucceededEvent = {
    event_id: input.eventId,
    event_name: "payment_succeeded",
    occurred_at: occurredAt,
  };

  const anonymousId = anonymousIdOrNull(input.anonymousId);
  if (anonymousId) event.anonymous_id = anonymousId;
  const consent = consentOrNull(input.consentState);
  if (consent) event.consent_state = consent;

  if (input.amountMinor != null && input.currency) {
    const money = stripeMinorToMajor(input.amountMinor, input.currency);
    if (money) {
      event.amount = money.amount;
      event.currency = money.currency;
    }
  }

  const email = cleanEmail(input.email);
  if (email) event.email = email;
  const phone = cleanPhone(input.phone);
  if (phone) event.phone = phone;
  if (input.purchaseKind === "subscription" || input.purchaseKind === "capacity_slot") {
    event.properties = { purchase_kind: input.purchaseKind };
  }
  return event;
}

/**
 * POST one confirmed event. 200 and 202 are acceptance, and a duplicate of an
 * event already recorded answers 200. 429, 5xx and a timeout ask the caller to
 * retry with the same event id and body. So does 401: a rotated key is fixed by
 * a person within the retry window, and the purchase should survive that. Any
 * other 4xx is final, including the 409 for an id sent with different values.
 */
export async function postRevnuEvent(event: PaymentSucceededEvent): Promise<RevnuPostResult> {
  const key = process.env["REVNU_EVENT_KEY"];
  if (!key) {
    console.warn("[revnu] REVNU_EVENT_KEY is unset; the confirmed purchase was not reported");
    return "unconfigured";
  }

  let response: Response;
  try {
    response = await fetch(REVNU_EVENTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    console.error("[revnu] measurement request failed");
    return "retry";
  }

  if (response.status === 200 || response.status === 202) return "accepted";
  console.error(`[revnu] measurement request returned ${response.status}`);
  if (response.status === 401 || response.status === 429 || response.status >= 500) return "retry";
  return "rejected";
}

export function anonymousIdOrNull(value: unknown): string | null {
  return typeof value === "string" && ANONYMOUS_ID.test(value) ? value : null;
}

function consentOrNull(value: unknown): RevnuConsentState | null {
  return typeof value === "string" && CONSENT_STATES.has(value)
    ? (value as RevnuConsentState)
    : null;
}

function minorToMajor(amountMinor: number, decimals: number): number {
  if (decimals === 0) return amountMinor;
  const digits = Math.abs(amountMinor)
    .toString()
    .padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  return Number(`${whole}.${fraction}`);
}

function cleanEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  if (!email || email.length > 320 || /\s/.test(email) || !email.includes("@")) return null;
  return email;
}

function cleanPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const phone = value.trim();
  if (!phone || phone.length > 32 || /[\r\n]/.test(phone) || !/\d/.test(phone)) return null;
  return phone;
}
