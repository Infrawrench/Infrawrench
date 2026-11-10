import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { firstSettingsSection, useUIStore, type ProductId } from "@infrawrench/ui";
import { navigateToWorkspaceTarget, settingsTabTarget } from "./workspace-tabs";

/**
 * An app's settings shortcut: opens the first section of the app's group in
 * Settings. Settings are the organization's, so there is no shortcut without
 * one. The shell holds no permission list, so a section the caller may not
 * read is left to the page to refuse, as the Settings tile already does.
 */
export function useAppSettingsShortcut(): (product: ProductId) => (() => void) | undefined {
  const navigate = useNavigate();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  return useCallback(
    (product) => {
      if (!activeCloudOrgId) return undefined;
      const section = firstSettingsSection(product);
      if (section === undefined) return undefined;
      return () =>
        void navigateToWorkspaceTarget(navigate, settingsTabTarget(section), {
          label: "Settings",
        });
    },
    [navigate, activeCloudOrgId],
  );
}
