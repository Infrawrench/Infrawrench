import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef, useCallback } from "react";
import {
  useUIStore,
  useTabId,
  getAccountRootType,
  RESOURCES_CHANGED_EVENT,
  type ResourcesChangedDetail,
} from "@infrawrench/ui";
import {
  AccountDetailView,
  type AccountResource,
  type CategoryState,
  type ResourceTypeInfo,
} from "@/components/AccountDetailView";
import { ResourcePanel } from "@/routes/org.$orgId.resources.$pluginId.$resourceTypeId.$resourceId";
import { apiGet, apiPost } from "@/lib/api";
import type { AccountListItem } from "@/lib/api-types";

export const Route = createFileRoute("/org/$orgId/accounts/$accountId")({
  // Rendering is handled by WorkspaceTabsViewport in __root.tsx, which mounts
  // every open tab simultaneously and keeps them alive across tab switches.
  component: () => null,
  validateSearch: (search: Record<string, unknown>): { type?: string; q?: string } => {
    const result: { type?: string; q?: string } = {};
    if (typeof search.type === "string") result.type = search.type;
    if (typeof search.q === "string") result.q = search.q;
    return result;
  },
});

interface AccountMeta {
  account: AccountListItem;
  resourceTypes: ResourceTypeInfo[];
  pluginDisplayName: string;
  pluginLogoSvg: string;
}

type ResourceRow = AccountResource;

/** Update URL search params without going through the router (avoids re-render cycles). */
function patchSearchParams(patch: Record<string, string | undefined>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(patch)) {
    if (value) {
      url.searchParams.set(key, value);
    } else {
      url.searchParams.delete(key);
    }
  }
  window.history.replaceState(window.history.state, "", url);
}

interface AccountPanelProps {
  orgId: string;
  accountId: string;
  /** Initial values from URL search params; only honoured if this tab is the
   * one currently driving the URL (otherwise the tab keeps its own state). */
  initialActiveType?: string | null;
  initialSearchQuery?: string;
}

export function AccountPanel({
  orgId,
  accountId,
  initialActiveType,
  initialSearchQuery,
}: AccountPanelProps) {
  const tabId = useTabId();

  const [activeType, setActiveTypeState] = useState<string | null>(initialActiveType ?? null);
  const [searchQuery, setSearchQueryState] = useState(initialSearchQuery ?? "");
  const prevAccountIdRef = useRef(accountId);

  // Reset URL-synced state when switching accounts
  useEffect(() => {
    if (prevAccountIdRef.current !== accountId) {
      prevAccountIdRef.current = accountId;
      setActiveTypeState(null);
      setSearchQueryState("");
      patchSearchParams({ type: undefined, q: undefined });
    }
  }, [accountId]);

  const setActiveType = useCallback((id: string | null) => {
    setActiveTypeState(id);
    patchSearchParams({ type: id ?? undefined });
  }, []);

  const setSearchQuery = useCallback((q: string) => {
    setSearchQueryState(q);
    patchSearchParams({ q: q || undefined });
  }, []);

  const [meta, setMeta] = useState<AccountMeta | null>(null);
  const [categories, setCategories] = useState<CategoryState[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadVersion, setLoadVersion] = useState(0);

  const groupRows = useCallback(
    (rows: ResourceRow[], allTypes: ResourceTypeInfo[]): CategoryState[] => {
      const byType = new Map<string, ResourceRow[]>();
      for (const row of rows) {
        const list = byType.get(row.resourceTypeId) ?? [];
        list.push(row);
        byType.set(row.resourceTypeId, list);
      }
      return allTypes.map((typeDef) => ({
        typeDef,
        loading: false,
        error: null,
        resources: byType.get(typeDef.id) ?? [],
      }));
    },
    [],
  );

  // Re-sync a single resource type via the server and merge its rows into state.
  const resyncType = useCallback(
    async (typeId: string) => {
      try {
        const rows = await apiPost<ResourceRow[]>(
          `/api/org/${orgId}/accounts/${accountId}/sync-type/${typeId}`,
        );
        setCategories((prev) =>
          prev.map((cat) =>
            cat.typeDef.id === typeId ? { ...cat, resources: rows, error: null } : cat,
          ),
        );
      } catch (err) {
        setCategories((prev) =>
          prev.map((cat) =>
            cat.typeDef.id === typeId
              ? { ...cat, error: err instanceof Error ? err.message : "Failed to refresh" }
              : cat,
          ),
        );
      }
    },
    [orgId, accountId],
  );

  // Refresh on RESOURCES_CHANGED_EVENT. If a resourceTypeId is supplied, re-sync that
  // one type against the provider for immediate feedback; otherwise reload from DB.
  useEffect(() => {
    function handler(event: Event) {
      const detail = (event as CustomEvent<ResourcesChangedDetail>).detail;
      if (detail?.accountId && detail.accountId !== accountId) return;
      if (detail?.resourceTypeId) {
        void resyncType(detail.resourceTypeId);
      } else {
        setLoadVersion((v) => v + 1);
      }
    }
    window.addEventListener(RESOURCES_CHANGED_EVENT, handler);
    return () => window.removeEventListener(RESOURCES_CHANGED_EVENT, handler);
  }, [accountId, resyncType]);

  // Auto-refresh every 30s — just re-reads the DB, no provider calls.
  useEffect(() => {
    const id = setInterval(() => {
      setLoadVersion((v) => v + 1);
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  // When the user focuses a section, kick off a fresh provider-side sync for
  // that type so slow-to-poll groups get priority loading. Each type only
  // gets one auto-resync per mount; explicit RESOURCES_CHANGED events still
  // re-trigger as before.
  const prioritizedTypesRef = useRef<Set<string> | null>(null);
  if (prioritizedTypesRef.current === null) prioritizedTypesRef.current = new Set();
  const prioritizedTypes = prioritizedTypesRef.current;
  useEffect(() => {
    if (!activeType) return;
    if (prioritizedTypes.has(activeType)) return;
    prioritizedTypes.add(activeType);
    void resyncType(activeType);
  }, [activeType, resyncType, prioritizedTypes]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [detail, rows] = await Promise.all([
          apiGet<AccountMeta>(`/api/org/${orgId}/accounts/${accountId}/detail`),
          apiGet<ResourceRow[]>(`/api/org/${orgId}/accounts/${accountId}/resources`),
        ]);
        if (cancelled) return;

        setMeta(detail);
        if (tabId) {
          useUIStore.getState().setWorkspaceTabTitle(tabId, detail.account.displayName);
        }

        setCategories(groupRows(rows, detail.resourceTypes));
        setInitialLoading(false);
      } catch {
        if (!cancelled) setInitialLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [accountId, orgId, loadVersion, groupRows, tabId]);

  const rootTypeId = meta ? getAccountRootType(meta.resourceTypes)?.id : undefined;
  const accountRoot = rootTypeId
    ? categories.find((cat) => cat.typeDef.id === rootTypeId)?.resources[0]
    : undefined;

  if (initialLoading)
    return <div className="p-6 text-on-surface-muted text-sm animate-pulse">Loading…</div>;
  if (!meta) return <div className="p-6 text-red-400 text-sm">Failed to load account.</div>;

  // Account-root plugins (UploadThing) hold exactly one instance of their root
  // type, and that instance *is* the account — so the account opens straight
  // to its detail view rather than to an inventory whose only content is a
  // section holding one pill.
  //
  // The tab, the URL, and the sidebar selection all stay the account's: only
  // the body is swapped. That matters because the root is discovered from
  // already-loaded rows — if the sync hasn't produced one yet we fall through
  // to the normal inventory instead of rendering a detail page for a resource
  // id we don't have.
  if (accountRoot) {
    return (
      <ResourcePanel
        orgId={orgId}
        pluginId={meta.account.pluginId}
        resourceTypeId={accountRoot.resourceTypeId}
        resourceId={accountRoot.id}
        accountId={accountId}
        view="details"
      />
    );
  }

  return (
    <AccountDetailView
      account={meta.account}
      categories={categories}
      pluginDisplayName={meta.pluginDisplayName}
      pluginLogoSvg={meta.pluginLogoSvg}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      activeSectionId={activeType}
      onActiveSectionIdChange={setActiveType}
      onAccountUpdated={(displayName) => {
        setMeta((prev) => (prev ? { ...prev, account: { ...prev.account, displayName } } : prev));
        if (tabId) useUIStore.getState().setWorkspaceTabTitle(tabId, displayName);
      }}
    />
  );
}
