/**
 * Servers baked into the checked-in `openapi.json`.
 *
 * Production first, because generators (ours and third-party ones) take the
 * first entry as the client's default base URL — an SDK that defaults to
 * `localhost:3000` is a bug report waiting to happen. A *running* server
 * advertises its own origin instead; see `defaultServers()` in
 * `src/api/openapi/index.ts`.
 */
export const SPEC_SERVERS = [
  { url: "https://app.infrawrench.com", description: "Production" },
  { url: "http://localhost:3000", description: "Local dev" },
] as const;
