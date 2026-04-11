import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { useUIStore, RESOURCES_CHANGED_EVENT, getAccountResourceTypes, getListableResourceTypes, isCreateOnlyType } from "@infrawrench/ui";
import { AccountDetailView, type CategoryState, type ResourceTypeInfo } from "@/components/AccountDetailView";
import { apiGet, apiPost } from "@/lib/api";

export const Route = createFileRoute("/org/$orgId/accounts/$accountId")({
  component: AccountPage,
});

interface AccountMeta {
  account: { id: string; pluginId: string; displayName: string };
  resourceTypes: ResourceTypeInfo[];
  pluginDisplayName: string;
  pluginLogoSvg: string;
}

interface ResourceRow {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  externalId: string | null;
  fieldsJson: unknown;
  outputsJson: unknown;
  parentResourceId: string | null;
}

function AccountPage() {
  const { orgId, accountId } = Route.useParams();
  const [meta, setMeta] = useState<AccountMeta | null>(null);
  const [categories, setCategories] = useState<CategoryState[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const backgroundLoadRef = useRef(false);
  const [loadVersion, setLoadVersion] = useState(0);

  // Refresh on RESOURCES_CHANGED_EVENT
  useEffect(() => {
    function handler() {
      backgroundLoadRef.current = true;
      setLoadVersion((v) => v + 1);
    }
    window.addEventListener(RESOURCES_CHANGED_EVENT, handler);
    return () => window.removeEventListener(RESOURCES_CHANGED_EVENT, handler);
  }, [accountId]);

  // Auto-refresh every 30s
  useEffect(() => {
    const id = setInterval(() => {
      backgroundLoadRef.current = true;
      setLoadVersion((v) => v + 1);
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const isBackground = backgroundLoadRef.current;
    backgroundLoadRef.current = false;

    async function load() {
      try {
        // Fetch account metadata + resource types (lightweight, no sync)
        const detail = await apiGet<AccountMeta>(
          `/api/org/${orgId}/accounts/${accountId}/detail`,
        );
        if (cancelled) return;
        setMeta(detail);

        const { activeWorkspaceTabId, setWorkspaceTabTitle } = useUIStore.getState();
        if (activeWorkspaceTabId) setWorkspaceTabTitle(activeWorkspaceTabId, detail.account.displayName);

        const visibleTypes = getAccountResourceTypes(detail.resourceTypes);
        const listableTypes = getListableResourceTypes(detail.resourceTypes);

        // Show category headers immediately with loading skeletons (foreground only)
        if (!isBackground && !cancelled) {
          setCategories(visibleTypes.map((t) => ({
            typeDef: t,
            loading: true,
            error: null,
            resources: [],
          })));
          setInitialLoading(false);
        }

        // Fire off per-type syncs in parallel — each resolves independently
        for (const typeDef of visibleTypes) {
          if (!listableTypes.some((t) => t.id === typeDef.id)) {
            // Create-only child type — no resources to list
            if (!cancelled) {
              setCategories((prev) => prev.map((cat) =>
                cat.typeDef.id === typeDef.id ? { ...cat, loading: false } : cat,
              ));
            }
            continue;
          }

          apiPost<ResourceRow[]>(
            `/api/org/${orgId}/accounts/${accountId}/sync-type/${typeDef.id}`,
          ).then((rows) => {
            if (cancelled) return;
            setCategories((prev) => prev.map((cat) =>
              cat.typeDef.id === typeDef.id
                ? { ...cat, loading: false, error: null, resources: rows }
                : cat,
            ));
          }).catch((err) => {
            if (cancelled) return;
            if (isBackground) {
              setCategories((prev) => prev.map((cat) =>
                cat.typeDef.id === typeDef.id ? { ...cat, loading: false } : cat,
              ));
            } else {
              setCategories((prev) => prev.map((cat) =>
                cat.typeDef.id === typeDef.id
                  ? { ...cat, loading: false, error: err instanceof Error ? err.message : "Failed to load" }
                  : cat,
              ));
            }
          });
        }
      } catch {
        if (!cancelled && !isBackground) setInitialLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [accountId, loadVersion]);

  if (initialLoading) return <div className="p-6 text-gray-500 text-sm animate-pulse">Loading…</div>;
  if (!meta) return <div className="p-6 text-red-400 text-sm">Failed to load account.</div>;

  return (
    <AccountDetailView
      account={meta.account}
      categories={categories}
      pluginDisplayName={meta.pluginDisplayName}
      pluginLogoSvg={meta.pluginLogoSvg}
    />
  );
}
