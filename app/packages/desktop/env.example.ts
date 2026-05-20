export const PROTOCOL = "infrawrench";
export const CLIENT_ID = "workos-client-id";
export const CLOUD_URL = "http://localhost:3000";
// Telemetry worker URL (e.g. https://telemetry.infrawrench.com). Empty disables telemetry.
export const TELEMETRY_URL: string = "";
export const WORKOS_API_URL = "https://api.workos.com";
export const SHOW_SIGN_IN_BUTTON = true;
export const BANNERS: { message: string; variant?: "info" | "warning" }[] = [];

// Plugins to hide entirely. Example: ["azure", "vercel"].
export const DISABLED_PLUGINS: string[] = [];

// Per-plugin resource type allowlist. Plugins not listed expose every
// resource type they define. Example: { aws: ["ec2-instance", "eks-cluster"] }.
export const ENABLED_RESOURCE_TYPES: Record<string, string[]> = {};
