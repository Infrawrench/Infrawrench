import { useNavigate } from "@tanstack/react-router";
import { useUIStore } from "@infrawrench/ui";
import { ProductsHomePanel } from "@infrawrench/ui/products/ProductsHomePanel";
import { resolveDefaultDashboard } from "../lib/default-dashboard";
import { useAppSettingsShortcut } from "../lib/app-settings";
import { useDisabledProducts } from "../lib/disabled-products";
import { useOrgTools } from "../lib/org-tools";
import {
  chatTabTarget,
  dashboardTabTarget,
  homeTabTarget,
  navigateToWorkspaceTarget,
} from "../lib/workspace-tabs";

/**
 * Desktop host for Home and the product pages. Without a cloud organization
 * the tool list is the local one, so a product whose tools are all
 * cloud-only still shows what it offers and says it needs an organization.
 */
export function DesktopHomePanel({ productId }: { productId?: string | undefined }) {
  const navigate = useNavigate();
  const tools = useOrgTools();
  const disabledProducts = useDisabledProducts();
  const settingsFor = useAppSettingsShortcut();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);

  async function openDashboards() {
    try {
      const home = await resolveDefaultDashboard(activeCloudOrgId);
      // Only the local side can fall back to a synthesized id; a cloud
      // dashboard id has to come from the organization.
      if (!home && activeCloudOrgId) return;
      void navigateToWorkspaceTarget(
        navigate,
        dashboardTabTarget(home?.id ?? "dashboard-home"),
        home ? { label: home.name } : undefined,
      );
    } catch (err) {
      console.error("[home] Failed to resolve the default dashboard:", err);
    }
  }

  return (
    <ProductsHomePanel
      productId={productId}
      tools={tools}
      disabledProducts={disabledProducts}
      settingsFor={settingsFor}
      onOpenProduct={(id) => void navigateToWorkspaceTarget(navigate, homeTabTarget(id))}
      onOpenDashboards={() => void openDashboards()}
      // Chat is the cloud agent; there is none without an organization.
      onOpenChat={
        activeCloudOrgId
          ? () => void navigateToWorkspaceTarget(navigate, chatTabTarget())
          : undefined
      }
    />
  );
}
