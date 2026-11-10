/**
 * The organization's app policy in the UI: which apps ("products") it has
 * turned off (`GET /api/org/:orgId/products`). A turned-off app leaves Home,
 * the sidebar's Apps tree, Recent and spotlight, because every one
 * of them is drawn from the host's tool list and the host drops a turned-off
 * app's tools from it ({@link withoutDisabledProducts}).
 *
 * The transport is the host's (web `apiGet`, the desktop's cloud client), so
 * each platform has its own `useDisabledProducts` over
 * {@link useDisabledProductsFrom}. The Apps settings section announces a
 * save with {@link notifyProductPolicyChanged}, so the navigation follows
 * without a reload.
 */
import { useEffect, useState } from "react";
import { normalizeDisabledProducts, type ProductId } from "@infrawrench/client-core";
import { productForTool } from "./registry.js";

/** Dispatched on `window` when the active organization's app policy is saved. */
export const PRODUCT_POLICY_CHANGED_EVENT = "infrawrench:product-policy-changed";

interface ProductPolicyChange {
  disabled: ProductId[];
}

/** Tells every mounted `useDisabledProducts` what the organization just saved. */
export function notifyProductPolicyChanged(disabled: readonly string[]): void {
  window.dispatchEvent(
    new CustomEvent<ProductPolicyChange>(PRODUCT_POLICY_CHANGED_EVENT, {
      detail: { disabled: normalizeDisabledProducts([...disabled]) },
    }),
  );
}

const NONE: ProductId[] = [];

// The last answer per organization, so a panel that mounts later (Home, the
// command palette) draws the right apps at once instead of flashing the
// turned-off ones while it asks again. A view cache only: every mount still
// asks, and concurrent mounts share one request.
const known = new Map<string, ProductId[]>();
const inflight = new Map<string, Promise<ProductId[]>>();

function sameIds(a: readonly ProductId[], b: readonly ProductId[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function fetchPolicy(
  scope: string,
  load: () => Promise<{ disabled: readonly string[] }>,
): Promise<ProductId[]> {
  const running = inflight.get(scope);
  if (running) return running;
  const request = load()
    .then((policy) => {
      const disabled = normalizeDisabledProducts([...policy.disabled]);
      known.set(scope, disabled);
      return disabled;
    })
    .finally(() => inflight.delete(scope));
  inflight.set(scope, request);
  return request;
}

/**
 * The apps turned off for `scope` (an organization id), read with the host's
 * `load`. `null` scope (the desktop's local mode) has no policy: nothing is
 * off. A failed read leaves every app showing and is logged; the policy
 * hides entry points, so failing open costs a visible tile, not access.
 * `load` must be stable for a scope (`useCallback`): a new one asks again.
 */
export function useDisabledProductsFrom(
  scope: string | null | undefined,
  load: () => Promise<{ disabled: readonly string[] }>,
): ProductId[] {
  const [disabled, setDisabled] = useState<ProductId[]>(() =>
    scope ? (known.get(scope) ?? NONE) : NONE,
  );

  useEffect(() => {
    if (!scope) {
      setDisabled(NONE);
      return;
    }
    let cancelled = false;
    const apply = (next: ProductId[]) => {
      if (!cancelled) setDisabled((current) => (sameIds(current, next) ? current : next));
    };
    apply(known.get(scope) ?? NONE);
    fetchPolicy(scope, load)
      .then(apply)
      .catch((err: unknown) => {
        console.error("[products] Failed to read the organization's app policy:", err);
      });

    // The settings section edits the active organization, which is this one.
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<ProductPolicyChange | undefined>).detail;
      if (!detail) return;
      known.set(scope, detail.disabled);
      apply(detail.disabled);
    };
    window.addEventListener(PRODUCT_POLICY_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(PRODUCT_POLICY_CHANGED_EVENT, onChanged);
    };
  }, [scope, load]);

  return disabled;
}

/** A host's tool list without the tools of turned-off apps. */
export function withoutDisabledProducts<T extends { key: string }>(
  tools: T[],
  disabled: readonly ProductId[],
): T[] {
  if (disabled.length === 0) return tools;
  return tools.filter((tool) => {
    const product = productForTool(tool.key);
    return !product || !disabled.includes(product);
  });
}
