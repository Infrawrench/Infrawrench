import { f, o, rt } from "@infrawrench/plugin-base";

export const ManagedEndpointResourceType = rt({
  name: "Managed Endpoint",
  id: "managed-endpoint",
  description:
    "A Dedicated Managed Inference endpoint (the newer v2 API) — a named route that splits traffic across one or more deployments. Deleting one deletes its deployments first.",
  fields: [
    f("name", "Name"),
    f("endpointId", "Endpoint ID"),
    f("projectId", "Project ID", { required: false }),
    f("endpointType", "Endpoint Type", { required: false }),
    f("visibility", "Visibility", { required: false }),
    f("deploymentCount", "Deployments", { kind: "number", required: false }),
    f("etag", "ETag", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("updatedAt", "Updated", { required: false }),
  ],
  outputs: [
    o("endpointId", "Endpoint ID"),
    o("endpointName", "Endpoint Name", {
      description: "`<project_slug>/<endpoint_name>` — the value you pass as `model`",
    }),
  ],
  iconKey: "load-balancer",
});
