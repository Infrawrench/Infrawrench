import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const APIGatewayResourceType: ResourceTypeDefinition = {
  id: "api-gateway",
  displayName: "API Gateway",
  pluralDisplayName: "API Gateways",
  description: "An Amazon API Gateway REST/HTTP/WebSocket API",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "apiId", label: "API ID", kind: "string", required: true },
    {
      key: "protocolType",
      label: "Protocol",
      kind: "enum",
      required: true,
      enumValues: ["HTTP", "WEBSOCKET", "REST"],
    },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "routeCount", label: "Routes", kind: "number", required: false },
    { key: "createdDate", label: "Created", kind: "string", required: false },
  ],
  outputs: [
    { key: "apiEndpoint", label: "API Endpoint", sensitive: false },
    { key: "apiId", label: "API ID", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "api",
};
