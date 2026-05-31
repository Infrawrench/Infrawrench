import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const TurnstileWidgetResourceType: ResourceTypeDefinition = {
  id: "turnstile-widget",
  displayName: "Turnstile Widget",
  pluralDisplayName: "Turnstile Widgets",
  description: "A Cloudflare Turnstile widget (CAPTCHA alternative) sitekey/secret pair",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "mode", label: "Mode", kind: "string", required: false },
    { key: "domains", label: "Domains", kind: "string", required: false },
    { key: "region", label: "Region", kind: "string", required: false, editable: false },
    { key: "botFightMode", label: "Bot Fight Mode", kind: "boolean", required: false },
    {
      key: "clearanceLevel",
      label: "Clearance Level",
      kind: "string",
      required: false,
      editable: false,
    },
    { key: "offlabel", label: "Hide Cloudflare Branding", kind: "boolean", required: false },
  ],
  outputs: [
    {
      key: "siteKey",
      label: "Site Key",
      sensitive: false,
      description: "Public Turnstile sitekey",
    },
    {
      key: "secretKey",
      label: "Secret Key",
      sensitive: true,
      description: "Turnstile secret used by the siteverify endpoint",
    },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "firewall",
  secretExportTemplates: [
    {
      id: "turnstile-keys",
      displayName: "Turnstile Keys",
      description: "Turnstile sitekey + secret for client embed and server verification",
      entries: [
        { envKey: "TURNSTILE_SITE_KEY", outputKey: "siteKey" },
        { envKey: "TURNSTILE_SECRET_KEY", outputKey: "secretKey" },
      ],
    },
  ],
};
