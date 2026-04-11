import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useUIStore, RESOURCES_CHANGED_EVENT } from "@infrawrench/ui";
import { AccountDetailView } from "@/components/AccountDetailView";
import { apiGet } from "@/lib/api";

export const Route = createFileRoute("/org/$orgId/accounts/$accountId")({
  component: AccountPage,
});

function AccountPage() {
  const { orgId, accountId } = Route.useParams();
  const [data, setData] = useState<{
    account: { id: string; pluginId: string; displayName: string };
    resources: Array<{
      id: string;
      pluginId: string;
      resourceTypeId: string;
      displayName: string;
      externalId: string | null;
      fieldsJson: unknown;
      outputsJson: unknown;
      parentResourceId: string | null;
    }>;
    resourceTypes: Array<{
      id: string;
      displayName: string;
      pluralDisplayName: string;
      parentTypeId: string | undefined;
      supportsCreate: boolean;
    }>;
    pluginDisplayName: string;
    pluginLogoSvg: string;
  } | null>(null);

  useEffect(() => {
    apiGet<typeof data>(`/api/org/${orgId}/accounts/${accountId}/detail`).then(setData);
  }, [accountId]);

  // Update tab title with real account name
  useEffect(() => {
    if (!data) return;
    const { activeWorkspaceTabId, setWorkspaceTabTitle } = useUIStore.getState();
    if (activeWorkspaceTabId) setWorkspaceTabTitle(activeWorkspaceTabId, data.account.displayName);
  }, [data]);

  // Auto-refresh every 30s + on resource-changed events
  useEffect(() => {
    function refresh() {
      apiGet<typeof data>(`/api/org/${orgId}/accounts/${accountId}/detail`).then(setData).catch(() => {});
    }
    const id = setInterval(refresh, 30_000);
    window.addEventListener(RESOURCES_CHANGED_EVENT, refresh);
    return () => {
      clearInterval(id);
      window.removeEventListener(RESOURCES_CHANGED_EVENT, refresh);
    };
  }, [accountId]);

  if (!data) return <div className="p-6 text-gray-500 text-sm animate-pulse">Loading…</div>;

  return (
    <AccountDetailView
      account={data.account}
      resources={data.resources}
      resourceTypes={data.resourceTypes}
      pluginDisplayName={data.pluginDisplayName}
      pluginLogoSvg={data.pluginLogoSvg}
    />
  );
}
