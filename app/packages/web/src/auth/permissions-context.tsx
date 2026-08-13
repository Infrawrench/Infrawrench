import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { OrgMembership, OrgRoleSummary } from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { apiGet } from "@/lib/api";

interface PermissionsContextValue {
  loading: boolean;
  error: string | null;
  permissions: readonly string[];
  role: OrgRoleSummary | null;
  has(permission: string): boolean;
  /** Returns true if the user has any of the listed permissions. */
  hasAny(...permissions: string[]): boolean;
  refresh(): Promise<void>;
}

const PermissionsContext = createContext<PermissionsContextValue | null>(null);

interface ProviderProps {
  orgId: string;
  children: ReactNode;
}

export function PermissionsProvider({ orgId, children }: ProviderProps) {
  const [permissions, setPermissions] = useState<readonly string[]>([]);
  const [role, setRole] = useState<OrgRoleSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await apiGet<OrgMembership>(`/api/org/${orgId}/team/me`);
      setPermissions(me.permissions);
      setRole(me.role);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPermissions([]);
      setRole(null);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<PermissionsContextValue>(() => {
    return {
      loading,
      error,
      permissions,
      role,
      has: (permission: string) => hasPermission(permissions, permission),
      hasAny: (...perms: string[]) => perms.some((p) => hasPermission(permissions, p)),
      refresh,
    };
  }, [loading, error, permissions, role, refresh]);

  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

export function usePermissions(): PermissionsContextValue {
  const ctx = useContext(PermissionsContext);
  if (!ctx) {
    throw new Error("usePermissions must be used within a <PermissionsProvider>");
  }
  return ctx;
}

interface CanProps {
  permission?: string;
  any?: string[];
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * Conditionally render `children` only when the current user has the given
 * permission (or any of the listed `any` permissions).
 */
export function Can({ permission, any, fallback = null, children }: CanProps) {
  const { has, hasAny } = usePermissions();
  const allowed = permission ? has(permission) : any ? hasAny(...any) : true;
  return <>{allowed ? children : fallback}</>;
}
