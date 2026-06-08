export const PROTOCOL = "infrawrench";
export const CLIENT_ID = "client_01KNCYFN2YP2RVC0S2HR63EQVC";
export const CLOUD_URL = "https://web.infrawrench.com";
export const TELEMETRY_URL = "https://telemetry.infrawrench.com";
export const WORKOS_API_URL = "https://api.workos.com";
export const SHOW_SIGN_IN_BUTTON = false;
export const BANNERS: { message: string; variant?: "info" | "warning" }[] = [
  {
    message:
      "Infrawrench is in alpha. Scaleway and OVH remain hidden while broader API coverage is finished; other bundled providers are available.",
    variant: "warning",
  },
];

export const DISABLED_PLUGINS: string[] = ["scaleway", "ovh"];

export const ENABLED_RESOURCE_TYPES: Record<string, string[]> = {};
