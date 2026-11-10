import { useNavigate } from "@tanstack/react-router";
import { ProductsHomePanel } from "@infrawrench/ui/products/ProductsHomePanel";
import { apiGet } from "@/lib/api";
import { useOrgTools } from "@/lib/org-tools";
import {
  chatTabTarget,
  dashboardTabTarget,
  homeTabTarget,
  navigateToWorkspaceTarget,
} from "@/lib/workspace-tabs";

interface WebHomePanelProps {
  orgId: string;
  productId?: string | undefined;
}

/** Web host for Home and the product pages. */
export function WebHomePanel({ orgId, productId }: WebHomePanelProps) {
  const navigate = useNavigate();
  const tools = useOrgTools(orgId);

  // The dashboard the server resolves for this member: their own default,
  // else their role's, else the organization's.
  async function openDashboards() {
    try {
      const data = await apiGet<{ dashboard: { id: string; name: string } }>(
        `/api/org/${orgId}/dashboards/default/full`,
      );
      void navigateToWorkspaceTarget(navigate, dashboardTabTarget(data.dashboard.id), {
        label: data.dashboard.name,
      });
    } catch (err) {
      console.error("[home] Failed to resolve the default dashboard:", err);
    }
  }

  return (
    <ProductsHomePanel
      productId={productId}
      tools={tools}
      onOpenProduct={(id) => void navigateToWorkspaceTarget(navigate, homeTabTarget(id))}
      onOpenDashboards={() => void openDashboards()}
      onOpenChat={() => void navigateToWorkspaceTarget(navigate, chatTabTarget())}
    />
  );
}
