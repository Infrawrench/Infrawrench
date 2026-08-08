/**
 * Baseline security response headers, applied to every response this server
 * emits — API JSON, the SPA shell, and static assets alike.
 *
 * Applied in two places because two different Hono apps serve responses (see
 * `server.ts`): `api` handles the API surface in both dev and prod, and the
 * prod-only `prodApp` wraps it to also serve `dist/client`. Both mount this, so
 * a response cannot escape the headers by which app produced it. Setting them
 * twice on the same response is a no-op — identical values.
 *
 * What is deliberately NOT here
 * -----------------------------
 * There is no `default-src`/`script-src` CSP. The clickjacking defence that
 * motivated this module is `frame-ancestors`, which is included and is inert
 * with respect to what the page may load. A script CSP is a genuinely separate
 * piece of work, because three things in this app load or generate script from
 * outside the bundle:
 *
 *   - `@monaco-editor/react` fetches the Monaco AMD loader from jsdelivr unless
 *     it is explicitly configured with a bundled `monaco` instance, and Monaco
 *     spawns its language workers from `blob:` URLs.
 *   - The `/docs` page loads the Scalar standalone bundle from jsdelivr
 *     (`SCALAR_VERSION` in `api/index.ts`).
 *   - Vite's dev server serves inline module scripts and uses `eval` for HMR.
 *
 * A `script-src` that covers those honestly needs nonce plumbing through
 * `index.html`, pinning Monaco to the bundle, and a route-specific relaxation
 * for `/docs` — then testing against the editor, the terminal, and the docs
 * page. Shipping `'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net` in
 * the meantime would read as a CSP while permitting exactly the injection a CSP
 * exists to stop, so this module states the gap instead of pretending to close
 * it.
 */
import { secureHeaders } from "hono/secure-headers";

/**
 * HSTS is set only in production. On `http://localhost:3000` the header is
 * ignored by browsers over plain HTTP anyway, but a developer who once hits a
 * local HTTPS proxy would pin `localhost` to HTTPS for two years across every
 * project on the machine.
 */
const isProduction = () => process.env["NODE_ENV"] === "production";

export const securityHeaders = () =>
  secureHeaders({
    // The clickjacking fix. `frame-ancestors` is the directive modern browsers
    // honour; `X-Frame-Options` below covers anything that predates it. This
    // app drives SSH terminals and resource deletion from a session cookie, so
    // being framed at all is the risk.
    contentSecurityPolicy: { frameAncestors: ["'none'"] },
    xFrameOptions: "DENY",

    xContentTypeOptions: "nosniff",
    // Send the origin cross-site, the full path same-origin. Resource ids and
    // org ids live in our paths and should not ride along to a third party in
    // a `Referer` — but stripping the header entirely breaks same-origin
    // analytics and OAuth flows that check it.
    referrerPolicy: "strict-origin-when-cross-origin",
    strictTransportSecurity: isProduction()
      ? "max-age=63072000; includeSubDomains; preload"
      : false,
    xDnsPrefetchControl: "off",
    xPermittedCrossDomainPolicies: "none",
    removePoweredBy: true,

    // Left off deliberately, not overlooked.
    //
    // COOP/CORP would sever `window.opener` and cross-origin resource reads.
    // The browser app never needs either, but the OAuth round trips (WorkOS
    // sign-in, "Add to Slack", the GitHub App setup callback) are full-page
    // redirects whose behaviour under COOP is worth verifying against a real
    // WorkOS tenant before turning on, and neither header closes a gap this
    // audit found. Enabling them is a follow-up with a test, not a default.
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
  });
