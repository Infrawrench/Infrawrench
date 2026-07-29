import { WorkOS } from "@workos-inc/node";

const apiKey = process.env["WORKOS_API_KEY"];
if (!apiKey) throw new Error("WORKOS_API_KEY environment variable is required");

const clientIdEnv = process.env["WORKOS_CLIENT_ID"];
if (!clientIdEnv) throw new Error("WORKOS_CLIENT_ID environment variable is required");

export const clientId = clientIdEnv;

// Custom Authentication API domain (WorkOS Dashboard > Domains). Hostname
// only, no scheme — e.g. "auth-api.infrawrench.com". Routes every SDK call
// (user management, authorize/token, JWKS) through the custom domain; unset
// falls back to api.workos.com. Once the custom domain is live in WorkOS,
// requests to api.workos.com are unsupported, so prod must set this.
const apiHostname = process.env["WORKOS_API_HOSTNAME"];

export const workos = new WorkOS({ apiKey, clientId, ...(apiHostname ? { apiHostname } : {}) });
