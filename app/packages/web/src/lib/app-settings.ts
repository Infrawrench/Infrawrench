import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { firstSettingsSection, settingsTabTarget, type ProductId } from "@infrawrench/ui";
import { usePermissionsIfAny } from "@/auth/permissions-context";
import { navigateToWorkspaceTarget } from "@/lib/workspace-tabs";

/**
 * An app's settings shortcut: opens the first section of the app's group in
 * Settings that the caller may read, or is undefined when there is none.
 */
export function useAppSettingsShortcut(): (product: ProductId) => (() => void) | undefined {
  const navigate = useNavigate();
  // Null while the shell renders without an organization: no shortcut then.
  const has = usePermissionsIfAny()?.has;
  return useCallback(
    (product) => {
      if (!has) return undefined;
      const section = firstSettingsSection(product, has);
      if (section === undefined) return undefined;
      return () =>
        void navigateToWorkspaceTarget(navigate, settingsTabTarget(section), {
          label: "Settings",
        });
    },
    [navigate, has],
  );
}
