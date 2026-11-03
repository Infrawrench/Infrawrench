/**
 * One-off connection check. Sends a single event with test: true, which Revnu
 * does not count. The live webhook never sets test.
 *
 *   pnpm --filter @infrawrench/web revnu:test
 *
 * Reads REVNU_EVENT_KEY from the server environment (web/.env.local or web/.env
 * via the env loader). Prints the status and response body only.
 */
import { buildPaymentSucceededEvent } from "../src/services/revnu";

const key = process.env["REVNU_EVENT_KEY"];
if (!key) {
  console.error("REVNU_EVENT_KEY is not set");
  process.exit(1);
}

const event = buildPaymentSucceededEvent({
  eventId: `revnu_test_${crypto.randomUUID()}`,
  occurredAt: new Date().toISOString(),
  amountMinor: 100,
  currency: "usd",
  purchaseKind: "subscription",
  googleAdUserData: "unknown",
  googleAdPersonalization: "unknown",
});
if (!event) {
  console.error("Could not build the test event");
  process.exit(1);
}

const response = await fetch("https://revnu.com/api/measurement/events", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ ...event, test: true }),
});
const text = await response.text();
console.log(String(response.status));
console.log(text);
if (response.status !== 200 && response.status !== 202) process.exit(1);
