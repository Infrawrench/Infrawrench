import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ResourcePill, ConfirmDeleteModal, dispatchResourcesChanged, type DraggableResource, useUIStore } from "@infrawrench/ui";
import { apiDelete } from "@/lib/api";
import { CreateResourceModal } from "./CreateResourceModal";

interface ResourceType {
  id: string;
  displayName: string;
  pluralDisplayName: string;
  parentTypeId: string | undefined;
  supportsCreate: boolean | undefined;
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

interface Props {
  account: { id: string; pluginId: string; displayName: string };
  resources: Resource[];
  resourceTypes: ResourceType[];
  pluginDisplayName: string;
  pluginLogoSvg: string;
}

export function AccountDetailView({
  account,
  resources,
  resourceTypes,
  pluginDisplayName,
  pluginLogoSvg,
}: Props) {
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [createTarget, setCreateTarget] = useState<ResourceType | null>(null);

  async function handleDeleteAccount() {
    await apiDelete(`/api/accounts/${account.id}`);
    useUIStore.getState().bumpAccounts();
    dispatchResourcesChanged();
    void navigate({ to: "/" });
  }

  // Group ALL resources by type
  const groupedResources = new Map<string, Resource[]>();
  for (const resource of resources) {
    const group = groupedResources.get(resource.resourceTypeId) ?? [];
    group.push(resource);
    groupedResources.set(resource.resourceTypeId, group);
  }

  // Mirror desktop's getAccountResourceTypes: show top-level types, plus
  // child types with supportsCreate (create-only — no resource listing).
  const visibleTypes = resourceTypes.filter(
    (rt) => !rt.parentTypeId || rt.supportsCreate,
  );

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

      {/* Resource categories — mirrors desktop layout */}
      {visibleTypes.map((type) => {
        const isCreateOnly = !!type.parentTypeId && !!type.supportsCreate;
        const items = groupedResources.get(type.id) ?? [];

        // Hide categories with no resources and no create support
        if (items.length === 0 && !type.supportsCreate) return null;

        return (
          <div key={type.id} className="mb-8">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              {type.pluralDisplayName}
            </h2>

            {isCreateOnly ? (
              /* Child type — only show create button, resources shown on parent detail page */
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setCreateTarget(type)}
                  className="flex items-center gap-1.5 pl-3 pr-3 py-1.5 rounded-full border border-dashed border-gray-700 text-gray-600 hover:border-blue-600 hover:text-blue-400 transition-colors text-sm"
                >
                  <span className="text-base leading-none">+</span>
                  <span>Create {type.displayName}</span>
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {items.map((resource) => {
                  const subtitle = String(
                    (resource.fieldsJson as Record<string, unknown>)?.["host"]
                      ?? (resource.fieldsJson as Record<string, unknown>)?.["region"]
                      ?? (resource.fieldsJson as Record<string, unknown>)?.["engine"]
                      ?? "",
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
                          to: "/resources/$pluginId/$resourceTypeId/$resourceId",
                          params: { pluginId: resource.pluginId, resourceTypeId: resource.resourceTypeId, resourceId: resource.id },
                        })
                      }
                    />
                  );
                })}
                {type.supportsCreate && (
                  <button
                    onClick={() => setCreateTarget(type)}
                    className="flex items-center gap-1.5 pl-3 pr-3 py-1.5 rounded-full border border-dashed border-gray-700 text-gray-600 hover:border-blue-600 hover:text-blue-400 transition-colors text-sm"
                  >
                    <span className="text-base leading-none">+</span>
                    <span>Create {type.displayName}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {visibleTypes.every((t) => {
        const items = groupedResources.get(t.id) ?? [];
        return items.length === 0 && !t.supportsCreate;
      }) && (
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
              to: "/resources/$pluginId/$resourceTypeId/$resourceId",
              params: { pluginId: account.pluginId, resourceTypeId: createTarget.id, resourceId: resource.id },
              search: { accountId: account.id },
            });
          }}
        />
      )}
    </div>
  );
}
