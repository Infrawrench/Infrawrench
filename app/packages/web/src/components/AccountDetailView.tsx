"use client";

import { useRouter } from "next/navigation";

interface ResourceType {
  id: string;
  displayName: string;
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

  // Show types that have resources, ordered by the plugin's type definition order
  const typesWithResources = resourceTypes.filter(
    (rt) => (groupedResources.get(rt.id)?.length ?? 0) > 0,
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

      {/* Resource groups */}
      {typesWithResources.map((type) => {
        const items = groupedResources.get(type.id) ?? [];
        return (
          <div key={type.id} className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-medium text-gray-400">{type.displayName}</h2>
              <span className="text-xs text-gray-600">{items.length}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {items.map((resource) => (
                <button
                  key={resource.id}
                  onClick={() =>
                    router.push(
                      `/resources/${resource.pluginId}/${resource.resourceTypeId}/${encodeURIComponent(resource.id)}`,
                    )
                  }
                  className="flex items-center gap-2 px-3 py-2 rounded-full border border-gray-700 hover:border-gray-500 hover:bg-gray-800 transition-colors"
                >
                  <span className="text-sm text-gray-200">{resource.displayName}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}

      {resources.length === 0 && (
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
