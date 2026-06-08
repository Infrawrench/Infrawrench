import { f, o, rt } from "@infrawrench/plugin-base";

export const DockerImageResourceType = rt({
  name: "Image",
  id: "docker-image",
  description: "A Docker image available to the local or remote Docker daemon.",
  fields: [
    f("tags", "Tags", { required: false }),
    f("size", "Size", { required: false }),
    f("containers", "Containers", { kind: "number", required: false }),
  ],
  outputs: [o("imageId", "Image ID")],
  iconKey: "container",
});
