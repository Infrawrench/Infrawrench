import type { CheckoutMeasurement } from "./host.js";

/** What starting a checkout takes from its host: its transport and its way out of the app. */
export interface ProCheckoutHost {
  orgId: string;
  /** Authenticated POST to the cloud (`SettingsApi.post`, or the host's own fetch). */
  post<T>(path: string, body?: unknown): Promise<T>;
  /** `SettingsHostValue.openExternal`: web navigates the tab, desktop opens the browser. */
  openExternal(url: string, options?: { sameTab?: boolean }): void;
  readCheckoutMeasurement?: (() => CheckoutMeasurement | undefined) | undefined;
}

/**
 * Starts the upgrade to Pro: asks the billing domain for a Stripe Checkout
 * session and sends the member there. The one path every Upgrade button
 * takes (Settings > Billing, the CI tab's plan gate), so they cannot drift.
 * Takes `billing:write`; the server refuses anyone else.
 */
export async function startProCheckout(host: ProCheckoutHost): Promise<void> {
  const measurement = host.readCheckoutMeasurement?.();
  const { url } = await host.post<{ url: string }>(
    `/api/org/${host.orgId}/billing/checkout`,
    measurement ? { measurement } : undefined,
  );
  host.openExternal(url, { sameTab: true });
}
