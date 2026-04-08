export interface DraggableResource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  fields: Record<string, unknown>;
  externalId?: string | undefined;
}
