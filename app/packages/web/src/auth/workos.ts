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

// Dev-only companions to WORKOS_API_HOSTNAME for the WorkOS emulator
// (github.com/workos/emulate), which speaks plain HTTP on port 4100 — the SDK
// otherwise assumes https on the default port. Leave both unset against real
// WorkOS; docker-compose.dev.yml sets them.
const apiHttps = process.env["WORKOS_API_HTTPS"];
const apiPort = process.env["WORKOS_API_PORT"];

export const workos = new WorkOS({
  apiKey,
  clientId,
  ...(apiHostname ? { apiHostname } : {}),
  ...(apiHttps ? { https: apiHttps !== "false" } : {}),
  ...(apiPort ? { port: Number.parseInt(apiPort, 10) } : {}),
});
