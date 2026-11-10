import { useCallback } from "react";
import { useDisabledProductsFrom } from "@infrawrench/ui";
import type { ProductId } from "@infrawrench/client-core";
import { apiGet } from "@/lib/api";

/**
 * The apps the organization has turned off (Settings, Apps). Follows a save
 * made in this window without a reload; see `useDisabledProductsFrom`.
 */
export function useDisabledProducts(orgId: string | undefined): ProductId[] {
  const load = useCallback(
    () => apiGet<{ disabled: string[] }>(`/api/org/${orgId}/products`),
    [orgId],
  );
  return useDisabledProductsFrom(orgId, load);
}
