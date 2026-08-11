import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { IacPanel } from "@infrawrench/ui";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { createWebIacClient } from "@/lib/iac-client";
import { apiGet } from "@/lib/api";

/**
 * Infrastructure as Code — the IaC reconciliation page. The panel lives in
 * `@infrawrench/ui` so desktop renders the identical thing; this component is
 * the web host: an `api*`-backed client, the permission read, and the resource
 * link. Rendered as a workspace tab (the "iac" kind) by the viewport.
 */
export function WebIacPanel({ orgId }: { orgId: string }) {
  const navigate = useNavigate();
  const client = useMemo(() => createWebIacClient(orgId), [orgId]);
  const [canWrite, setCanWrite] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCanWrite(false);
    apiGet<{ permissions: string[] }>(`/api/org/${orgId}/team/me`)
      .then((me) => {
        if (!cancelled) setCanWrite(hasPermission(me.permissions, "iac:write"));
      })
      // A failed permission read leaves upload hidden. The server enforces it
      // anyway; guessing "allowed" would only offer an action that 403s.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [orgId]);

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
