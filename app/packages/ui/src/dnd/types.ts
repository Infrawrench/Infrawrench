import type { AttachTarget } from "@infrawrench/plugin-base";

export interface DraggableResource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  fields: Record<string, unknown>;
  externalId?: string | undefined;
  /** Resource types this resource can be attached to via drag-drop, if any. */
  attachTargets?: AttachTarget[] | undefined;
}
