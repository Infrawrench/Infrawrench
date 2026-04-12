import { useState } from "react";
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
  account: { id: string; pluginId: string; pluginLabel: string; displayName: string };
  categories: CategoryState[];
  pluginLabel: string;
  pluginLogoSvg: string;
}

export function AccountDetailView({ account, categories, pluginLabel, pluginLogoSvg }: Props) {
  const navigate = useNavigate();
  const orgId = useOrgId();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [createTarget, setCreateTarget] = useState<ResourceTypeInfo | null>(null);

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
          <p className="text-xs text-gray-500">{pluginLabel}</p>
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

      {/* Resource categories — per-type loading like desktop */}
      {categories.map((cat) => {
        const createOnly = isCreateOnlyType(cat.typeDef);
        if (!cat.loading && cat.resources.length === 0 && !cat.typeDef.supportsCreate) return null;
        if (createOnly && !cat.typeDef.supportsCreate) return null;

        return (
          <div key={cat.typeDef.id} className="mb-8">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              {cat.typeDef.pluralDisplayName}
            </h2>

            {createOnly ? (
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setCreateTarget(cat.typeDef)}
                  className="flex items-center gap-1.5 pl-3 pr-3 py-1.5 rounded-full border border-dashed border-gray-700 text-gray-600 hover:border-blue-600 hover:text-blue-400 transition-colors text-sm"
                >
                  <span className="text-base leading-none">+</span>
                  <span>Create {cat.typeDef.displayName}</span>
                </button>
              </div>
            ) : cat.loading ? (
              <div className="flex flex-wrap gap-2">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-8 rounded-full bg-gray-800 animate-pulse"
                    style={{ width: `${5 + i * 1.5}rem` }}
                  />
                ))}
              </div>
            ) : cat.error ? (
              <div className="text-xs text-red-400">{cat.error}</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {cat.resources.map((resource) => {
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
                {cat.typeDef.supportsCreate && (
                  <button
                    onClick={() => setCreateTarget(cat.typeDef)}
                    className="flex items-center gap-1.5 pl-3 pr-3 py-1.5 rounded-full border border-dashed border-gray-700 text-gray-600 hover:border-blue-600 hover:text-blue-400 transition-colors text-sm"
                  >
                    <span className="text-base leading-none">+</span>
                    <span>Create {cat.typeDef.displayName}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {categories.length > 0 &&
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
