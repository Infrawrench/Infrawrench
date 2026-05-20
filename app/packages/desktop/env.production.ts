export const PROTOCOL = "infrawrench";
export const CLIENT_ID = "client_01KNCYFN2YP2RVC0S2HR63EQVC";
export const CLOUD_URL = "https://web.infrawrench.com";
export const TELEMETRY_URL = "https://telemetry.infrawrench.com";
export const WORKOS_API_URL = "https://api.workos.com";
export const SHOW_SIGN_IN_BUTTON = false;
export const BANNERS: { message: string; variant?: "info" | "warning" }[] = [
  {
    message:
      "Infrawrench is in alpha and therefore a lot of providers and resources are still being tested and are right now off.",
    variant: "warning",
  },
];

export const DISABLED_PLUGINS: string[] = [
  "azure",
  "digitalocean",
  "hetzner",
  "scaleway",
  "cloudflare",
  "ovh",
  "databricks",
  "turso",
  "planetscale",
  "fly",
  "vercel",
  "netlify",
  "cloudinary",
];

export const ENABLED_RESOURCE_TYPES: Record<string, string[]> = {
  aws: ["ec2-instance", "eks-cluster"],
};
