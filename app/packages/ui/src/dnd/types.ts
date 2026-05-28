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
  /** True when this resource declares an `sshEndpoint` — a valid SSH-tunnel drop target. */
  isSshHost?: boolean | undefined;
  /** True when this resource can be dragged onto an SSH host to set up a tunnel (e.g. a Cloudflare Tunnel). */
  isTunnelSshSource?: boolean | undefined;
}
