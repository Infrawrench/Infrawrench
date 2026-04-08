"use client";

import { useRouter } from "next/navigation";
import { ResourcePill, type DraggableResource } from "@infrawrench/ui";

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
  const router = useRouter();

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
        <div>
          <h1 className="text-xl font-semibold">{account.displayName}</h1>
          <p className="text-xs text-gray-500">{pluginDisplayName}</p>
        </div>
      </div>

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
                        router.push(
                          `/resources/${resource.pluginId}/${resource.resourceTypeId}/${encodeURIComponent(resource.id)}`,
                        )
                      }
                    />
                  );
                })}
                {type.supportsCreate && (
                  <button
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
    </div>
  );
}
