/**
 * Client-registration support probe for the OAuth authorization server.
 *
 * The 2026-07-28 MCP spec deprecates Dynamic Client Registration (RFC 7591) in
 * favour of Client ID Metadata Documents (CIMD), where the client's `client_id`
 * is an HTTPS URL the authorization server fetches metadata from. Both are
 * authorization-server mechanisms — for WorkOS AuthKit each is a Dashboard
 * toggle under Connect → Configuration, and clients discover them from the
 * AS metadata (`client_id_metadata_document_supported` / `registration_endpoint`)
 * that our `/.well-known/oauth-authorization-server` redirect points at.
 *
 * The resource server has no protocol role in either mechanism, but it is the
 * first thing an operator debugs when clients "can't sign in": a client that
 * finds neither mechanism advertised dies inside its own OAuth flow, far from
 * our logs. So whenever discovery metadata is served, we probe the upstream
 * AS document once (TTL-cached, fire-and-forget) and say out loud which
 * registration mechanisms it advertises — and warn when it advertises none.
 */

const PROBE_TTL_MS = 5 * 60 * 1000;

let lastProbe: { authServer: string; at: number } | null = null;
let lastOutcome: string | null = null;
let fetchImpl: typeof fetch = (...args) => fetch(...args);

/** Test hook: clears the TTL cache and restores/overrides the fetch used. */
export function resetRegistrationProbeForTests(fetchOverride?: typeof fetch): void {
  lastProbe = null;
  lastOutcome = null;
  fetchImpl = fetchOverride ?? ((...args) => fetch(...args));
}

/**
 * Fire-and-forget from the well-known handlers (`void probe(...)`); returns
 * the promise so tests can await the log side effects. Never throws, never
 * delays or alters a response.
 */
export async function probeClientRegistrationSupport(authServer: string): Promise<void> {
  const now = Date.now();
  if (lastProbe && lastProbe.authServer === authServer && now - lastProbe.at < PROBE_TTL_MS) {
    return;
  }
  lastProbe = { authServer, at: now };

  try {
    const res = await fetchImpl(`${authServer}/.well-known/oauth-authorization-server`, {
      signal: AbortSignal.timeout(5000),
      redirect: "follow",
    });
    if (!res.ok) {
      console.warn(
        `[mcp-auth] authorization server metadata at ${authServer}/.well-known/oauth-authorization-server ` +
          `answered ${res.status}; cannot verify client-registration support. MCP clients will fail the same fetch.`,
      );
      return;
    }
    const doc = (await res.json()) as {
      client_id_metadata_document_supported?: unknown;
      registration_endpoint?: unknown;
    };
    const cimd = doc.client_id_metadata_document_supported === true;
    const dcr = typeof doc.registration_endpoint === "string";
    const outcome = `cimd=${cimd} dcr=${dcr}`;
    if (outcome === lastOutcome) return;
    lastOutcome = outcome;

    if (!cimd && !dcr) {
      console.warn(
        `[mcp-auth] authorization server ${authServer} advertises neither Client ID Metadata ` +
          `Documents nor Dynamic Client Registration — MCP clients without pre-registered ` +
          `credentials cannot connect. Enable "Client ID Metadata Document" (the current MCP ` +
          `standard) and/or "Dynamic Client Registration" under Connect → Configuration in the ` +
          `WorkOS Dashboard, or register an OAuth client manually and configure clients with its id.`,
      );
      return;
    }
    console.log(
      `[mcp-auth] authorization server ${authServer} client registration: ` +
        `Client ID Metadata Documents ${cimd ? "yes" : "no"}, ` +
        `Dynamic Client Registration ${dcr ? "yes" : "no (deprecated by the 2026-07-28 MCP spec)"}` +
        (cimd
          ? ""
          : " — CIMD is the current standard; consider enabling it in the WorkOS Dashboard"),
    );
  } catch (e) {
    // Unreachable AS (offline dev, egress-restricted deploys): worth a line,
    // not a warning — the operator may know exactly why.
    console.log(
      `[mcp-auth] could not probe ${authServer}/.well-known/oauth-authorization-server for ` +
        `client-registration support: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
