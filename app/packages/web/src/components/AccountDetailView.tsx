import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ResourcePill,
  ConfirmDeleteModal,
  dispatchResourcesChanged,
  isCreateOnlyType,
  type DraggableResource,
  useUIStore,
} from "@infrawrench/ui";
import { apiDelete } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";
import { CreateResourceModal } from "./CreateResourceModal";

export interface ResourceTypeInfo {
  id: string;
  displayName: string;
  pluralDisplayName: string;
  parentTypeId: string | undefined;
  supportsCreate: boolean;
}

interface Resource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  externalId: string | null;
  fieldsJson: unknown;
  outputsJson: unknown;
  parentResourceId: string | null;
}

export interface CategoryState {
  typeDef: ResourceTypeInfo;
  loading: boolean;
  error: string | null;
  resources: Resource[];
}

interface Props {
  account: { id: string; pluginId: string; displayName: string };
  categories: CategoryState[];
  pluginDisplayName: string;
  pluginLogoSvg: string;
}

export function AccountDetailView({
  account,
  categories,
  pluginDisplayName,
  pluginLogoSvg,
}: Props) {
  const navigate = useNavigate();
  const orgId = useOrgId();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [createTarget, setCreateTarget] = useState<ResourceTypeInfo | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const initializedSectionRef = useRef(false);

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const visibleCategories = useMemo(
    () =>
      categories
        .filter((cat) => {
          const createOnly = isCreateOnlyType(cat.typeDef);
          if (!cat.loading && cat.resources.length === 0 && !cat.typeDef.supportsCreate)
            return false;
          if (createOnly && !cat.typeDef.supportsCreate) return false;
          return true;
        })
        .map((cat) => {
          const filteredResources =
            normalizedQuery.length === 0
              ? cat.resources
              : cat.resources.filter((resource) => {
                  const fields = (resource.fieldsJson as Record<string, unknown>) ?? {};
                  const searchText = [
                    cat.typeDef.displayName,
                    cat.typeDef.pluralDisplayName,
                    resource.displayName,
                    String(fields["host"] ?? ""),
                    String(fields["region"] ?? ""),
                    String(fields["engine"] ?? ""),
                  ]
                    .join(" ")
                    .toLowerCase();
                  return searchText.includes(normalizedQuery);
                });
          const sectionMatches = [
            cat.typeDef.displayName,
            cat.typeDef.pluralDisplayName,
            cat.typeDef.id,
          ]
            .join(" ")
            .toLowerCase()
            .includes(normalizedQuery);

          if (normalizedQuery.length > 0 && filteredResources.length === 0 && !sectionMatches) {
            return null;
          }

          return {
            ...cat,
            resources: filteredResources,
          };
        })
        .filter((cat): cat is CategoryState => cat !== null)
        .sort((a, b) => a.typeDef.pluralDisplayName.localeCompare(b.typeDef.pluralDisplayName)),
    [categories, normalizedQuery],
  );

  useEffect(() => {
    if (visibleCategories.length === 0) {
      setActiveSectionId(null);
      initializedSectionRef.current = false;
      return;
    }

    if (!initializedSectionRef.current) {
      const firstWithItems = visibleCategories.find((cat) => cat.resources.length > 0);
      setActiveSectionId(firstWithItems?.typeDef.id ?? visibleCategories[0].typeDef.id);
      initializedSectionRef.current = true;
      return;
    }

    if (activeSectionId && visibleCategories.some((cat) => cat.typeDef.id === activeSectionId)) {
      return;
    }
    const firstWithItems = visibleCategories.find((cat) => cat.resources.length > 0);
    setActiveSectionId(firstWithItems?.typeDef.id ?? visibleCategories[0].typeDef.id);
  }, [activeSectionId, visibleCategories]);

  const activeCategory =
    visibleCategories.find((cat) => cat.typeDef.id === activeSectionId) ?? null;

  async function handleDeleteAccount() {
    await apiDelete(`/api/org/${orgId}/accounts/${account.id}`);
    useUIStore.getState().bumpAccounts();
    dispatchResourcesChanged();
    void navigate({ to: "/org/$orgId", params: { orgId } });
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        {pluginLogoSvg && (
          <div
            className="w-8 h-8 flex-shrink-0"
            dangerouslySetInnerHTML={{ __html: pluginLogoSvg }}
          />
        )}
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{account.displayName}</h1>
          <p className="text-xs text-gray-500">{pluginDisplayName}</p>
        </div>
        <button
          onClick={() => setConfirmDelete(true)}
          className="px-3 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-950/50 rounded transition-colors"
        >
          Delete
        </button>
      </div>

      {confirmDelete && (
        <ConfirmDeleteModal
          kind="account"
          name={account.displayName}
          onConfirm={handleDeleteAccount}
          onClose={() => setConfirmDelete(false)}
        />
      )}

      {/* Section search + top scrollable section bar */}
      <div className="mb-6 space-y-3">
        <input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search sections or resources..."
          className="w-full md:max-w-sm bg-gray-900 border border-gray-800 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        {visibleCategories.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {visibleCategories.map((cat) => (
              <button
                key={cat.typeDef.id}
                onClick={() => setActiveSectionId(cat.typeDef.id)}
                className={`px-3 py-1.5 rounded-full border text-xs font-medium whitespace-nowrap transition-colors ${
                  activeSectionId === cat.typeDef.id
                    ? "border-blue-500 bg-blue-500/15 text-blue-300"
                    : "border-gray-800 text-gray-400 hover:border-gray-700 hover:text-gray-200"
                }`}
              >
                {cat.typeDef.pluralDisplayName}
                {cat.resources.length > 0 && (
                  <span className="ml-1 text-[11px] text-gray-500">({cat.resources.length})</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {activeCategory && (
        <div key={activeCategory.typeDef.id} className="mb-8">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            {activeCategory.typeDef.pluralDisplayName}
          </h2>

          {isCreateOnlyType(activeCategory.typeDef) ? (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setCreateTarget(activeCategory.typeDef)}
                className="flex items-center gap-1.5 pl-3 pr-3 py-1.5 rounded-full border border-dashed border-gray-700 text-gray-600 hover:border-blue-600 hover:text-blue-400 transition-colors text-sm"
              >
                <span className="text-base leading-none">+</span>
                <span>Create {activeCategory.typeDef.displayName}</span>
              </button>
            </div>
          ) : activeCategory.loading ? (
            <div className="flex flex-wrap gap-2">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-8 rounded-full bg-gray-800 animate-pulse"
                  style={{ width: `${5 + i * 1.5}rem` }}
                />
              ))}
            </div>
          ) : activeCategory.error ? (
            <div className="text-xs text-red-400">{activeCategory.error}</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {activeCategory.resources.map((resource) => {
                const subtitle = String(
                  (resource.fieldsJson as Record<string, unknown>)?.["host"] ??
                    (resource.fieldsJson as Record<string, unknown>)?.["region"] ??
                    (resource.fieldsJson as Record<string, unknown>)?.["engine"] ??
                    "",
                );
                const draggable: DraggableResource = {
                  id: resource.id,
                  pluginId: resource.pluginId,
                  resourceTypeId: resource.resourceTypeId,
                  accountId: account.id,
                  displayName: resource.displayName,
                  fields: (resource.fieldsJson as Record<string, unknown>) ?? {},
                  ...(resource.externalId != null ? { externalId: resource.externalId } : {}),
                };
                return (
                  <ResourcePill
                    key={resource.id}
                    resource={draggable}
                    subtitle={subtitle || undefined}
                    onOpen={() =>
                      void navigate({
                        to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
                        params: {
                          orgId,
                          pluginId: resource.pluginId,
                          resourceTypeId: resource.resourceTypeId,
                          resourceId: resource.id,
                        },
                      })
                    }
                  />
                );
              })}
              {activeCategory.typeDef.supportsCreate && (
                <button
                  onClick={() => setCreateTarget(activeCategory.typeDef)}
                  className="flex items-center gap-1.5 pl-3 pr-3 py-1.5 rounded-full border border-dashed border-gray-700 text-gray-600 hover:border-blue-600 hover:text-blue-400 transition-colors text-sm"
                >
                  <span className="text-base leading-none">+</span>
                  <span>Create {activeCategory.typeDef.displayName}</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {visibleCategories.length === 0 &&
        categories.length > 0 &&
        categories.every(
          (c) => !c.loading && c.resources.length === 0 && !c.typeDef.supportsCreate,
        ) && (
          <div className="text-center py-12">
            <p className="text-gray-500 text-sm">No resources synced yet.</p>
            <p className="text-gray-600 text-xs mt-1">
              Resources will appear after the first sync.
            </p>
          </div>
        )}

      {visibleCategories.length === 0 && normalizedQuery.length > 0 && (
        <div className="py-8">
          <p className="text-sm text-gray-500">
            No sections or resources match “{searchQuery.trim()}”.
          </p>
        </div>
      )}

      {createTarget && (
        <CreateResourceModal
          accountId={account.id}
          pluginId={account.pluginId}
          resourceTypeId={createTarget.id}
          resourceTypeDisplayName={createTarget.displayName}
          onClose={() => setCreateTarget(null)}
          onCreated={(resource) => {
            setCreateTarget(null);
            dispatchResourcesChanged();
            void navigate({
              to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
              params: {
                orgId,
                pluginId: account.pluginId,
                resourceTypeId: createTarget.id,
                resourceId: resource.id,
              },
              search: { accountId: account.id },
            });
          }}
        />
      )}
    </div>
  );
}
