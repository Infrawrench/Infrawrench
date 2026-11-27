/**
 * Paying for a short username: the price as the forms word it, and what the
 * page says to someone who comes back from the payment page without the name.
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { invalidate, queries } from "../../api/queries";

/** `$50`, or `$49.50`: US cents as a price. */
export const priceLabel = (cents: number): string =>
  `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;

/**
 * Shown on the page the app sends the browser back to, with the `?checkout=`
 * it added. A payment that got the name needs no words (the page shows the
 * name), and neither does leaving the payment page. A payment that did not
 * get the name is refunded, and says so; that is read from the forge, never
 * from the URL.
 */
export function UsernameCheckoutNotice({ state }: { state: string }) {
  // Whatever the page knew of the person before they left to pay is stale.
  useEffect(() => {
    void invalidate("session");
    void invalidate("namespaces");
  }, []);
  const checkout = useQuery({ ...queries.session.usernameCheckout(), staleTime: 0 });
  const purchase = checkout.data?.purchase;
  const message =
    state === "unavailable"
      ? "Payments are not available right now. Nothing was charged."
      : state === "expired"
        ? "The payment page expired before it was opened. Nothing was charged."
        : state === "return" && purchase && purchase.status !== "claimed"
          ? `${purchase.username} was taken before your payment went through. ${
              purchase.status === "refunded"
                ? "The payment has been refunded."
                : "The payment is being refunded."
            }`
          : null;
  if (message === null) return null;
  return (
    <p
      role="status"
      className="mb-4 rounded border border-border px-3 py-2 text-xs text-on-surface"
    >
      {message}
    </p>
  );
}
