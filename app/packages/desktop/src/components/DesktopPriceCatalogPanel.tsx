import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import {
  PriceCatalogPanel,
  dispatchResourcesChanged,
  toast,
  useUIStore,
  type PriceCatalogAccount,
  type PriceCatalogClient,
  type PriceCatalogEstimateTarget,
} from "@infrawrench/ui";
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { invoke } from "@/lib/invoke";
import { listCloudAccounts } from "@/lib/cloud-accounts";
import { getPlugin } from "@/plugins/loader";
import { navigateToWorkspaceTarget, resourceTabTarget } from "@/lib/workspace-tabs";
import { CreateResourceModal } from "./CreateResourceModal";

/**
 * The Price catalog on desktop: the same screen web renders, as a workspace
 * tab (the "price-catalog" kind).
 *
 * Cloud-only. The catalog is assembled server-side, where a credentialed
 * provider's price list is fetched with one of the org's accounts and cached
 * on its declared cadence; a local workspace has no org to borrow an account
 * from and no shared cache, so without an org the tab explains rather than
 * fetching.
 */
export function DesktopPriceCatalogPanel() {
  const gt = useGT();
  const navigate = useNavigate();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [accounts, setAccounts] = useState<PriceCatalogAccount[]>([]);
  const [target, setTarget] = useState<{
    estimate: PriceCatalogEstimateTarget;
    resourceType: ResourceTypeDefinition;
  } | null>(null);

  useEffect(() => {
    if (!activeCloudOrgId) return;
    listCloudAccounts(activeCloudOrgId).then(
      (rows) => setAccounts(rows ?? []),
      () => setAccounts([]),
    );
  }, [activeCloudOrgId]);

  const client = useMemo<PriceCatalogClient | null>(() => {
    if (!activeCloudOrgId) return null;
    const orgId = activeCloudOrgId;
    return {
      search: (query) => invoke("cloud_price_catalog_search", { orgId, query }),
      compare: (query) => invoke("cloud_price_catalog_compare", { orgId, query }),
    };
  }, [activeCloudOrgId]);

  if (!activeCloudOrgId || !client) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        {gt("The price catalog requires cloud mode: sign in to sync.")}
      </div>
    );
  }

  const openEstimate = async (estimate: PriceCatalogEstimateTarget) => {
    const loaded = await getPlugin(estimate.pluginId);
    const resourceType = loaded?.plugin.resourceTypes.find((t) => t.id === estimate.resourceTypeId);
    if (!resourceType) {
      toast.error(gt("This build cannot open that create form."));
      return;
    }
    setTarget({ estimate, resourceType });
  };

  return (
    <>
      <PriceCatalogPanel
        key={activeCloudOrgId}
        client={client}
        accounts={accounts}
        onUseInEstimate={(estimate) => void openEstimate(estimate)}
        onOpenExternal={(url) => void invoke("open_external_url", { url })}
      />
      {target && (
        <CreateResourceModal
          accountId={target.estimate.accountId}
          pluginId={target.estimate.pluginId}
          resourceType={target.resourceType}
          initialFields={target.estimate.fields}
          onClose={() => setTarget(null)}
          onCreated={(resource) => {
            const { accountId, resourceTypeId } = target.estimate;
            setTarget(null);
            dispatchResourcesChanged({ accountId, resourceTypeId });
            void navigateToWorkspaceTarget(navigate, resourceTabTarget(accountId, resource.id), {
              label: resource.displayName,
            });
          }}
        />
      )}
    </>
  );
}
