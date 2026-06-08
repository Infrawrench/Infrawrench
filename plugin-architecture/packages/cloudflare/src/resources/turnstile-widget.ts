import { f, o, rt } from "@infrawrench/plugin-base";

export const TurnstileWidgetResourceType = rt({
  name: "Turnstile Widget",
  id: "turnstile-widget",
  description: "A Cloudflare Turnstile widget (CAPTCHA alternative) sitekey/secret pair",
  fields: [
    f("name", "Name"),
    f("mode", "Mode", { required: false }),
    f("domains", "Domains", { required: false }),
    f("region", "Region", { required: false, editable: false }),
    f("botFightMode", "Bot Fight Mode", { kind: "boolean", required: false }),
    f("clearanceLevel", "Clearance Level", { required: false, editable: false }),
    f("offlabel", "Hide Cloudflare Branding", { kind: "boolean", required: false }),
  ],
  outputs: [
    o("siteKey", "Site Key", { description: "Public Turnstile sitekey" }),
    o("secretKey", "Secret Key", {
      sensitive: true,
      description: "Turnstile secret used by the siteverify endpoint",
    }),
  ],
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
});
