import { f, o, rt } from "@infrawrench/plugin-base";

export const ManagedEndpointResourceType = rt({
  name: "Managed Endpoint",
  id: "managed-endpoint",
  description:
    "A Dedicated Managed Inference endpoint (v2 API): a named route that splits traffic across deployments, each a model on dedicated GPUs. Deleting one deletes its deployments first.",
  fields: [
    f("name", "Name", {
      description:
        "`<project_slug>/<endpoint_name>`, the value callers pass as `model`. Renaming changes what they must send.",
    }),
    f("endpointId", "Endpoint ID", { editable: false }),
    f("projectId", "Project ID", { required: false, editable: false }),
    f("endpointType", "Endpoint Type", { required: false, editable: false }),
    f("visibility", "Visibility", {
      showcase: true,
      required: false,
      kind: "enum",
      enumValues: ["VISIBILITY_PRIVATE", "VISIBILITY_INTERNAL"],
      description: "Private keeps it to the project; internal shares it with the organization.",
    }),
    f("deploymentCount", "Deployments", {
      showcase: true,
      kind: "number",
      required: false,
      editable: false,
    }),
    f("etag", "ETag", { required: false, editable: false }),
    f("createdAt", "Created", { showcase: true, required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("endpointId", "Endpoint ID"),
    o("endpointName", "Endpoint Name", {
      description: "`<project_slug>/<endpoint_name>`, the value you pass as `model`",
    }),
  ],
  // `GET /v2/projects/{projectId}/endpoints/{id}/analytics` time series.
  supportsMetrics: true,
  supportsCreate: true,
  // Name and visibility here. Deployments and the traffic split are edited from the detail page.
  supportsUpdate: true,
  iconKey: "load-balancer",
});
