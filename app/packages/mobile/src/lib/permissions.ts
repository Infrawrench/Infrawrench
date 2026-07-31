import { useQuery } from "@tanstack/react-query";
import { fetchOrgPermissions, hasPermission } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The viewer's permissions in the selected org — the mobile counterpart of
 * web's `PermissionsProvider`/`usePermissions`.
 *
 * A hook rather than a context because react-query already dedupes and caches
 * the request across every screen that asks, and one org is selected at a
 * time. `has()` returns false while loading, so a gated control renders hidden
 * and then appears; check `loading` when the difference matters.
 *
 * This is presentation only. Every route enforces its own permission on the
 * server, so being wrong here can hide a button but never grant an action.
 */
export function useOrgPermissions(): {
  has: (permission: string) => boolean;
  permissions: string[];
  loading: boolean;
  error: Error | null;
} {
  const { api, orgId } = useOrgApi();
  const query = useQuery({
    queryKey: ["org-permissions", orgId],
    queryFn: () => fetchOrgPermissions(api, orgId),
    staleTime: 5 * 60_000,
  });
  const permissions = query.data?.permissions ?? [];
  return {
    has: (permission: string) => hasPermission(permissions, permission),
    permissions,
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error : null,
  };
}
