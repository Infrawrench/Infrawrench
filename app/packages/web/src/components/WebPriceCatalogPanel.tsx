import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  PriceCatalogPanel,
  dispatchResourcesChanged,
  type PriceCatalogAccount,
  type PriceCatalogClient,
  type PriceCatalogEstimateTarget,
} from "@infrawrench/ui";
import {
  priceCatalogQueryString,
  type PriceCatalogCompareQuery,
  type PriceCatalogCompareResponse,
  type PriceCatalogSearchQuery,
  type PriceCatalogSearchResponse,
} from "@infrawrench/client-core";
import type { AccountListItem } from "@/lib/api-types";
import { apiGet } from "@/lib/api";
import { CreateResourceModal } from "./CreateResourceModal";

/**
 * The Price catalog on web: the shared panel plus this host's fetch and its
 * create form for "use in estimate". Rendered as a workspace tab (the
 * "price-catalog" kind) by WebWorkspaceTabsViewport.
 */
export function WebPriceCatalogPanel({ orgId }: { orgId: string }) {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<PriceCatalogAccount[]>([]);
  const [target, setTarget] = useState<PriceCatalogEstimateTarget | null>(null);

  useEffect(() => {
    apiGet<AccountListItem[]>(`/api/org/${encodeURIComponent(orgId)}/accounts`).then(
      (rows) => setAccounts(rows),
      () => setAccounts([]),
    );
  }, [orgId]);

  const client = useMemo<PriceCatalogClient>(() => {
    const base = `/api/org/${encodeURIComponent(orgId)}/price-catalog`;
    return {
      search: (query: PriceCatalogSearchQuery) =>
        apiGet<PriceCatalogSearchResponse>(`${base}/search${priceCatalogQueryString(query)}`),
      compare: (query: PriceCatalogCompareQuery) =>
        apiGet<PriceCatalogCompareResponse>(`${base}/compare${priceCatalogQueryString(query)}`),
    };
  }, [orgId]);

  return (
    <>
      <PriceCatalogPanel
        client={client}
        accounts={accounts}
        onUseInEstimate={setTarget}
        onOpenExternal={(url) => window.open(url, "_blank", "noopener,noreferrer")}
      />
      {target && (
        <CreateResourceModal
          accountId={target.accountId}
          pluginId={target.pluginId}
          resourceTypeId={target.resourceTypeId}
          resourceTypeDisplayName={target.label}
          initialFields={target.fields}
          onClose={() => setTarget(null)}
          onCreated={(resource) => {
            const created = target;
            setTarget(null);
            dispatchResourcesChanged({
              accountId: created.accountId,
              resourceTypeId: created.resourceTypeId,
            });
            void navigate({
              to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
              params: {
                orgId,
                pluginId: created.pluginId,
                resourceTypeId: created.resourceTypeId,
                resourceId: resource.id,
              },
              search: { accountId: created.accountId },
            });
          }}
        />
      )}
    </>
  );
}
