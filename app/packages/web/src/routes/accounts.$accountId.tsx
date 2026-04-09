import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { AccountDetailView } from "@/components/AccountDetailView";
import { apiGet } from "@/lib/api";

export const Route = createFileRoute("/accounts/$accountId")({
  component: AccountPage,
});

function AccountPage() {
  const { accountId } = Route.useParams();
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
    apiGet<typeof data>(`/api/accounts/${accountId}/detail`).then(setData);
  }, [accountId]);

  useEffect(() => {
    function onChanged() {
      apiGet<typeof data>(`/api/accounts/${accountId}/detail`).then(setData);
    }
    window.addEventListener("iw:resources-changed", onChanged);
    return () => window.removeEventListener("iw:resources-changed", onChanged);
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
