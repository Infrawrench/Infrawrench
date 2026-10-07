import { useMemo } from "react";
import { JitAccessPanel, type SettingsApi } from "@infrawrench/ui";
import { usePermissions } from "@/auth/permissions-context";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "@/lib/api";

interface WebJitAccessPanelProps {
  orgId: string;
  openPolicies: () => void;
}

/**
 * Web host for the shared just-in-time access panel: cookie-authenticated
 * fetch as the transport and the shell's permissions for the gates. The panel
 * itself owns loading, polling and every action.
 */
export function WebJitAccessPanel({ orgId, openPolicies }: WebJitAccessPanelProps) {
  const { has } = usePermissions();
  const api = useMemo<SettingsApi>(
    () => ({
      get: apiGet,
      post: apiPost,
      put: apiPut,
      patch: apiPatch,
      delete: apiDelete,
    }),
    [],
  );
  return (
    <JitAccessPanel
      orgId={orgId}
      api={api}
      canRead={has("access:read")}
      canRequest={has("access:request")}
      onOpenPolicies={has("org:settings:write") ? openPolicies : undefined}
    />
  );
}
