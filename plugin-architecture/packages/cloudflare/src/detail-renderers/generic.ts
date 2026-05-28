import type {
  ResourceInstance,
  DetailViewSchema,
  ResourceTypeDefinition,
} from "@infrawrench/plugin-base";
import { labeledFieldItems } from "@infrawrench/plugin-base";

export function renderGenericDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): DetailViewSchema {
  const fields = resource.fields;
  return {
    title: resource.displayName,
    subtitle: resource.resourceTypeId,
    status: { kind: "status-dot", status: "info" },
    sections: [
      {
        kind: "section",
        title: "Details",
        children: [
          {
            kind: "key-value-list",
            items: labeledFieldItems(fields, resourceTypes, resource.resourceTypeId),
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}
