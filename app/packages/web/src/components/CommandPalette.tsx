import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CommandPalette,
  usePaletteActions,
  type OrgEntry,
  type PaletteOrg,
  type WorkspaceTabTarget,
} from "@infrawrench/ui";
import { usePermissions } from "@/auth/permissions-context";
import { apiGet } from "@/lib/api";
import { navigateToWorkspaceTarget } from "@/lib/workspace-tabs";

/**
 * Web's Cmd/Ctrl+K. The palette itself, its index client and the star cache
 * are shared (`@infrawrench/ui`, host from `OrgProviders`); this binds the
 * web's navigation, permissions and org list.
 */
export function WebCommandPalette({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const { has } = usePermissions();
  const [orgs, setOrgs] = useState<PaletteOrg[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiGet<OrgEntry[]>("/api/auth/orgs")
      .then((list) => {
        if (!cancelled) setOrgs(list.map((o) => ({ id: o.id, name: o.displayName })));
      })
      // Switching orgs is one action among many; the rest still work without it.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const open = useCallback(
    (target: WorkspaceTabTarget, label: string) =>
      void navigateToWorkspaceTarget(navigate, target, { label }),
    [navigate],
  );
  const switchOrg = useCallback(
    (next: string | null) => {
      if (next && next !== orgId) void navigate({ to: "/org/$orgId", params: { orgId: next } });
    },
    [navigate, orgId],
  );

  const actions = usePaletteActions({
    open,
    has,
    cloud: true,
    orgs,
    activeOrgId: orgId,
    switchOrg,
  });

  return (
    <CommandPalette
      onClose={onClose}
      actions={actions}
      onOpenTarget={(target, label, { newTab }) =>
        void navigateToWorkspaceTarget(navigate, target, {
          label,
          mode: newTab ? "pin" : "reuse-active",
        })
      }
    />
  );
}
