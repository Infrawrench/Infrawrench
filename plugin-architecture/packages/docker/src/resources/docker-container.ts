import { f, o, rt } from "@infrawrench/plugin-base";

export const DockerContainerResourceType = rt({
  name: "Container",
  id: "docker-container",
  description: "A Docker container managed by the local or remote Docker daemon.",
  fields: [
    f("name", "Name", { required: false }),
    f("image", "Image", { required: false }),
    f("status", "Status", { required: false }),
    f("ports", "Ports", { required: false }),
    f("networks", "Networks", {
      required: false,
      description: "Names of the Docker networks this container is attached to",
    }),
    f("volumes", "Volumes", {
      required: false,
      description: "Names of the Docker volumes this container mounts — bind mounts excluded",
    }),
  ],
  outputs: [o("containerId", "Container ID"), o("status", "Status")],
  dependsOn: [
    // `image` holds whatever the container was created from: usually a tag
    // ("nginx:latest"), which lands in the image's comma-joined `tags`, but a
    // container started from a digest carries the image id instead.
    { fieldKey: "image", targetTypeId: "docker-image", targetKey: "tags", label: "runs image" },
    { fieldKey: "image", targetTypeId: "docker-image", label: "runs image" },
    // `NetworkSettings.Networks` is keyed by network name, while a network's
    // external id is its 64-char id — match the network's `name` field.
    {
      fieldKey: "networks",
      targetTypeId: "docker-network",
      targetKey: "name",
      label: "attached to",
    },
    // A mount's `Name` is the volume's name, which is also its external id.
    { fieldKey: "volumes", targetTypeId: "docker-volume", label: "mounts" },
  ],
  supportsCreate: true,
  iconKey: "container",
});
