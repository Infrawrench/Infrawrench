import { f, o, rt } from "@infrawrench/plugin-base";

export const APIGatewayResourceType = rt({
  name: "API Gateway",
  id: "api-gateway",
  description: "An Amazon API Gateway REST/HTTP/WebSocket API",
  fields: [
    f("name", "Name"),
    f("apiId", "API ID"),
    f("protocolType", "Protocol", { kind: "enum", enumValues: ["HTTP", "WEBSOCKET", "REST"] }),
    f("description", "Description", { required: false }),
    f("routeCount", "Routes", { kind: "number", required: false }),
    f("createdDate", "Created", { required: false }),
  ],
  outputs: [o("apiEndpoint", "API Endpoint"), o("apiId", "API ID")],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "api",
});
