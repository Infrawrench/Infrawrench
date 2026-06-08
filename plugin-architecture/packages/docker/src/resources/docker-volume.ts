import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DockerVolumeResourceType: ResourceTypeDefinition = {
  id: "docker-volume",
  displayName: "Volume",
  pluralDisplayName: "Volumes",
  description: "A Docker volume managed by the local or remote Docker daemon.",
  fields: [
    { key: "name", label: "Name", kind: "string", required: false },
    { key: "driver", label: "Driver", kind: "string", required: false },
    { key: "mountpoint", label: "Mountpoint", kind: "string", required: false },
    { key: "scope", label: "Scope", kind: "string", required: false },
  ],
  outputs: [{ key: "volumeName", label: "Volume Name", sensitive: false }],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "database",
};
