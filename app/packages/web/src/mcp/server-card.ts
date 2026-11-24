/**
 * Pre-connection discovery for the MCP endpoint: the MCP Server Card
 * (SEP-2127, served at `<mcp-url>/server-card`) and the AI Catalog that lists it
 * (`/.well-known/ai-catalog.json`). Registries and crawlers such as MCPNow
 * (https://mcpnow.app) read both before they connect, so they can describe the
 * server without credentials; the live connection (`server/discover`) stays the
 * authority on everything the card also says.
 *
 * Kept free of the MCP SDK: the discovery domain runs on the edge Worker,
 * which must not pull the SDK in for a static document.
 */

/** `serverInfo.name` the MCP server reports; the card must not contradict it. */
export const MCP_SERVER_NAME = "infrawrench";
/** `serverInfo.version` the MCP server reports; the card must not contradict it. */
export const MCP_SERVER_VERSION = "0.1.0";

export const SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json";
export const AI_CATALOG_MEDIA_TYPE = "application/ai-catalog+json";

const SERVER_CARD_SCHEMA =
  "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";

/**
 * The company's public pages. Fixed rather than derived from the request's
 * origin: they live on the marketing site, not on the app host.
 */
const WEBSITE_URL = "https://infrawrench.com";
const PRIVACY_POLICY_URL = `${WEBSITE_URL}/privacy`;
const SUPPORT_EMAIL = "astrid@infrawrench.com";

/** The MCP endpoint on a public origin. */
export const mcpEndpointUrl = (baseUrl: string) => `${baseUrl}/api/mcp`;

/** Where the card is served: the SEP-2127 reserved `<streamable-http-url>/server-card`. */
export const serverCardUrl = (baseUrl: string) => `${mcpEndpointUrl(baseUrl)}/server-card`;

/**
 * The card's reverse-DNS namespace, from the public host: `app.infrawrench.com`
 * becomes `com.infrawrench.app`. Derived rather than fixed so a self-hosted
 * instance names itself, not us.
 */
function reverseDnsNamespace(baseUrl: string): string {
  return new URL(baseUrl).hostname.split(".").reverse().join(".");
}

export function serverCard(baseUrl: string) {
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: `${reverseDnsNamespace(baseUrl)}/${MCP_SERVER_NAME}`,
    version: MCP_SERVER_VERSION,
    title: "Infrawrench",
    description:
      "List, search, inspect, create and edit cloud resources, query costs and run workflows across the providers connected to your Infrawrench organization.",
    websiteUrl: WEBSITE_URL,
    icons: [
      { src: `${WEBSITE_URL}/icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
      { src: `${WEBSITE_URL}/icon.png`, mimeType: "image/png" },
    ],
    remotes: [{ type: "streamable-http", url: mcpEndpointUrl(baseUrl) }],
    _meta: {
      // MCPNow's provider extension: the legal and support details a card has
      // no standard field for. https://mcpnow.app/#server-cards--provider-metadata
      "app.mcpnow/provider": {
        privacyPolicyUrl: PRIVACY_POLICY_URL,
        supportEmail: SUPPORT_EMAIL,
        documentationUrl: `${baseUrl}/docs/features/mcp`,
      },
    },
  };
}

/** The domain's AI Catalog: one entry, pointing at the card by URL. */
export function aiCatalog(baseUrl: string) {
  return {
    specVersion: "1.0",
    entries: [
      {
        identifier: `urn:air:${new URL(baseUrl).hostname}:mcp:${MCP_SERVER_NAME}`,
        type: SERVER_CARD_MEDIA_TYPE,
        url: serverCardUrl(baseUrl),
      },
    ],
  };
}

/**
 * The RFC 9728 fields that describe the resource to a person, which MCPNow
 * also reads into a server's provider details when the card is unavailable.
 */
export const resourceDescription = {
  resource_name: "Infrawrench",
  resource_policy_uri: PRIVACY_POLICY_URL,
} as const;
