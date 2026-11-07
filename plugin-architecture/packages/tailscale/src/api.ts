import {
  createApiClient,
  type ApiClient,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { components, operations, paths } from "./api-types.gen.js";

export type { operations };

// Wire shapes for https://api.tailscale.com/api/v2, generated from the published
// OpenAPI document (https://api.tailscale.com/api/v2?outputOpenapiSchema=true).

type Schemas = components["schemas"];

export type Device = Schemas["Device"];
export type User = Schemas["User"];
export type UserInvite = Schemas["UserInvite"];
export type Key = Schemas["Key"];
export type Webhook = Schemas["Webhook"];
export type Service = Schemas["VIPServiceInfo"];
export type ServiceHost = Schemas["ServiceHostInfo"];
export type PostureIntegration = Schemas["PostureIntegration"];
export type TailnetSettings = Schemas["TailnetSettings"];
export type DnsConfiguration = Schemas["DnsConfiguration"];
export type Contact = Schemas["Contact"];
export type Contacts = ApiResponse<operations["getContacts"]>;
export type LogStreamConfig = Schemas["LogstreamEndpointConfiguration"];
export type LogStreamStatus = Schemas["LogstreamEndpointPublishingStatus"];
/** One direction-pair of a flow, counted from the logging node's side. */
export type ConnectionCounts = Schemas["ConnectionCounts"];
/** One node's traffic over one logging window (about five seconds). */
export type NetworkFlowLog = Schemas["NetworkFlowLog"];
export type ConfigurationAuditLog = Schemas["ConfigurationAuditLog"];

/** Settings keys that `PATCH /tailnet/{tailnet}/settings` accepts as booleans. */
export const BOOLEAN_SETTINGS = [
  "devicesApprovalOn",
  "devicesAutoUpdatesOn",
  "usersApprovalOn",
  "networkFlowLoggingOn",
  "regionalRoutingOn",
  "postureIdentityCollectionOn",
  "httpsEnabled",
  "aclsExternallyManagedOn",
] as const;

export type TailscaleApi = ApiClient<paths>;

type HostRequest = Parameters<HttpHostServices["request"]>[0];

/**
 * Every call reads this one transport, which is also what keeps a token out of
 * any message that leaves it: the error of a failed status, a dropped connection
 * or a body that is not JSON.
 */
export function createTailscaleApi(
  apiKey: string | undefined,
  http: HttpHostServices | undefined,
): TailscaleApi {
  const token = apiKey?.trim() ?? "";
  const overFetch = async ({ url, method, headers, body }: HostRequest) => {
    const response = await fetch(url, {
      method,
      headers,
      ...(typeof body === "string" ? { body } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, headers: {}, body: await response.text() };
  };
  const transport: HttpHostServices = {
    request: async (request) => {
      try {
        const response = http ? await http.request(request) : await overFetch(request);
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Tailscale API error ${response.status}: ${response.body}`);
        }
        // Several device mutations return 200 with an empty body, not 204.
        const body = response.body.trim() ? response.body : "";
        // The client parses this again, past the redaction below: a parse failure
        // quotes the body, so it has to surface here.
        if (body) JSON.parse(body);
        // The status has done its job, and the client ignores the body of a 204.
        return { ...response, status: 200, body };
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error);
        if (token) message = message.replaceAll(token, "[redacted]");
        throw new Error(message.replace(/tskey-[\w-]+/g, "[redacted]"));
      }
    },
  };
  return createApiClient<paths>({
    vendor: "Tailscale",
    baseUrl: "https://api.tailscale.com/api/v2",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    contentType: "with-body",
    http: transport,
  });
}
