import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { IacPanel } from "@infrawrench/ui";
import { usePermissions } from "@/auth/permissions-context";
import { createWebIacClient } from "@/lib/iac-client";

/**
 * Infrastructure as Code — the IaC reconciliation page. The panel lives in
 * `@infrawrench/ui` so desktop renders the identical thing; this component is
 * the web host: an `api*`-backed client, the permission gate, and the resource
 * link. Rendered as a workspace tab (the "iac" kind) by the viewport.
 */
export function WebIacPanel({ orgId }: { orgId: string }) {
  const navigate = useNavigate();
  const client = useMemo(() => createWebIacClient(orgId), [orgId]);
  // Until the shell's permission read lands `has()` is false, so upload stays
  // hidden rather than offering an action that would 403.
  const { has } = usePermissions();
  const canWrite = has("iac:write");

  return (
    <IacPanel
      // Keyed by org so switching org refetches rather than showing the
      // previous org's classification.
      key={orgId}
      client={client}
      canWrite={canWrite}
      onOpenResource={(entry) =>
        void navigate({
          to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
          params: {
            orgId,
            pluginId: entry.pluginId,
            resourceTypeId: entry.resourceTypeId,
            resourceId: entry.resourceId,
          },
          search: { accountId: entry.accountId },
        })
      }
    />
  );
}
