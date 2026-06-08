import { f, o, rt } from "@infrawrench/plugin-base";

export const DockerVolumeResourceType = rt({
  name: "Volume",
  id: "docker-volume",
  description: "A Docker volume managed by the local or remote Docker daemon.",
  fields: [
    f("name", "Name", { required: false }),
    f("driver", "Driver", { required: false }),
    f("mountpoint", "Mountpoint", { required: false }),
    f("scope", "Scope", { required: false }),
  ],
  outputs: [o("volumeName", "Volume Name")],
  supportsCreate: true,
  iconKey: "database",
});
