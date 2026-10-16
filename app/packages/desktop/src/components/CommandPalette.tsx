import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  hasPermission,
  isSearchObjectKind,
  type CloudOrg,
  type OrgMembership,
  type StarRef,
} from "@infrawrench/client-core";
import {
  CommandPalette,
  usePaletteActions,
  type PaletteOrg,
  type WorkspaceTabTarget,
} from "@infrawrench/ui";
import { createDesktopSettingsApi } from "../lib/settings-client";
import { navigateToWorkspaceTarget } from "../lib/workspace-tabs";
import { useLocalSpotlightResults } from "./SpotlightSearch";

/** Stars are kept server-side, so only the org's saved objects can carry one. */
const canStar = (ref: StarRef) => isSearchObjectKind(ref.kind);

/**
 * The desktop's Cmd/Ctrl+K. Local mode keeps the spotlight's behaviour
 * (local resources and workflows) and gains recents and local actions; with
 * a cloud org selected it also searches the org's saved objects and shows
 * the member's stars, through the `cloud_palette_*` IPC channels the shared
 * host in `__root.tsx` provides.
 */
export function DesktopCommandPalette({
  cloudOrgId,
  cloudOrgs,
  onSwitchOrg,
  onClose,
}: {
  cloudOrgId: string | null;
  cloudOrgs: readonly CloudOrg[];
  onSwitchOrg: (orgId: string | null) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { results, loading } = useLocalSpotlightResults("navigate");
  const [permissions, setPermissions] = useState<readonly string[]>([]);

  // Cloud actions are gated like the pages they open; local mode has no roles.
  useEffect(() => {
    if (!cloudOrgId) return;
    let cancelled = false;
    createDesktopSettingsApi()
      .get<OrgMembership>(`/api/org/${cloudOrgId}/team/me`)
      .then((me) => {
        if (!cancelled) setPermissions(me.permissions);
      })
      .catch(() => {
        if (!cancelled) setPermissions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [cloudOrgId]);

  const has = useCallback(
    (permission: string) => (cloudOrgId ? hasPermission(permissions, permission) : true),
    [cloudOrgId, permissions],
  );
  const open = useCallback(
    (target: WorkspaceTabTarget, label: string) =>
      void navigateToWorkspaceTarget(navigate, target, { label }),
    [navigate],
  );
  const orgs = useMemo<PaletteOrg[]>(
    () => cloudOrgs.map((o) => ({ id: o.id, name: o.displayName })),
    [cloudOrgs],
  );

  const actions = usePaletteActions({
    open,
    has,
    cloud: Boolean(cloudOrgId),
    orgs,
    activeOrgId: cloudOrgId,
    switchOrg: onSwitchOrg,
    localOption: true,
  });

  return (
    <CommandPalette
      onClose={onClose}
      actions={actions}
      localResults={results}
      localLoading={loading}
      canStar={canStar}
      onOpenTarget={(target, label, { newTab }) =>
        void navigateToWorkspaceTarget(navigate, target, {
          label,
          mode: newTab ? "pin" : "reuse-active",
        })
      }
    />
  );
}
