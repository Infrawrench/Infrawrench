import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { SearchObjectKind } from "@infrawrench/client-core";

/**
 * What the palette asks of a page after opening it. Opening a tab is all the
 * palette can do on its own; the creation flows ("New report", the sidebar's
 * new-dashboard field, the add-account modal) and the sub-tabs of larger pages
 * belong to the components that render them. Rather than lift each one's
 * state into a store, the palette leaves a short-lived note and the component
 * that owns the flow picks it up when it is (or next becomes) mounted.
 */
export type PaletteCreateKind = "cost_report" | "dashboard" | "budget" | "slo" | "account";

export type PaletteIntent =
  | { type: "create"; kind: PaletteCreateKind }
  | { type: "focus"; kind: SearchObjectKind; id: string };

interface PendingIntent {
  intent: PaletteIntent;
  at: number;
}

/**
 * How long an unclaimed intent waits. Long enough for a lazily mounted panel
 * to load; short enough that a note nobody claimed (the caller lacked the
 * permission the flow needs, say) cannot fire minutes later on an unrelated
 * visit.
 */
export const PALETTE_INTENT_TTL_MS = 10_000;

const usePaletteIntentStore = create<{ pending: PendingIntent[] }>(() => ({ pending: [] }));

function live(pending: PendingIntent[], now: number): PendingIntent[] {
  return pending.filter((p) => now - p.at < PALETTE_INTENT_TTL_MS);
}

/** Leave a note for whichever component handles it. */
export function requestPaletteIntent(intent: PaletteIntent): void {
  const now = Date.now();
  usePaletteIntentStore.setState((s) => ({
    pending: [...live(s.pending, now), { intent, at: now }],
  }));
}

/** Test seam: drop every pending intent. */
export function clearPaletteIntents(): void {
  usePaletteIntentStore.setState({ pending: [] });
}

/**
 * Claim intents `match` accepts, now and whenever one arrives while mounted.
 * Each intent is handled once, by the first mounted claimant.
 */
export function usePaletteIntent(
  match: (intent: PaletteIntent) => boolean,
  handler: (intent: PaletteIntent) => void,
): void {
  const matchRef = useRef(match);
  const handlerRef = useRef(handler);
  // Declared first, so on mount it runs before the subscription's first claim.
  useEffect(() => {
    matchRef.current = match;
    handlerRef.current = handler;
  });

  useEffect(() => {
    const consume = () => {
      const now = Date.now();
      const pending = usePaletteIntentStore.getState().pending;
      const claimed = pending.find(
        (p) => now - p.at < PALETTE_INTENT_TTL_MS && matchRef.current(p.intent),
      );
      if (!claimed) return;
      usePaletteIntentStore.setState({ pending: live(pending, now).filter((p) => p !== claimed) });
      handlerRef.current(claimed.intent);
    };
    consume();
    return usePaletteIntentStore.subscribe(consume);
  }, []);
}
