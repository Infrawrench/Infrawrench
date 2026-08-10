/**
 * Which parts of the org route tree an `iwk_` API key may never reach, whatever
 * scopes it holds.
 *
 * Letting keys authenticate against the org tree widens *who can present
 * credentials*. It must not widen *what a credential may do* — every route
 * keeps the `requirePermission` gate it already had, and the key's effective
 * permissions are its scopes intersected with its owner's current role (see
 * `auth/effective-permissions.ts`). That covers authorization.
 *
 * It does not cover a smaller, separate question: a handful of endpoints are
 * *acts a person performs*, where "the permission was held" is not the whole
 * control. Approving a colleague's break-glass request is one. Minting a
 * credential is another — a key that can mint keys can mint a longer-lived,
 * differently-scoped one and outlive its own revocation, which turns "revoke
 * that key" from a decision into a race.
 *
 * Those live here, as an explicit table with a reason per entry, rather than as
 * an accident of which router something happens to sit under. The table is
 * matched on the path *below* `/api/org/:orgId`, so moving a handler between
 * routers cannot silently change its answer.
 *
 * Three surfaces the task would otherwise list are absent because they are
 * already unreachable: `/api/profile/*` (session management, MFA, email
 * change), `/api/orgs/*` (org creation and deletion) and `/api/admin/*` sit
 * under the `authed` group, not the org tree, and that group still runs the
 * unmodified `sessionMiddleware` — it 401s an `iwk_` key exactly as it does
 * today. `auth/step-up.ts` denies bearer principals independently on top.
 */

/** Methods that change state. Reads of the same prefix may still be allowed. */
const MUTATING = ["POST", "PUT", "PATCH", "DELETE"] as const;

interface DenyRule {
  /**
   * Path prefix relative to `/api/org/:orgId`, with no trailing slash. Matches
   * the prefix itself and everything below it.
   */
  prefix: string;
  /** Methods this rule denies. `"*"` denies every method. */
  methods: readonly string[] | "*";
  /** Shown to the caller, so write it as an explanation rather than a code. */
  reason: string;
}

/**
 * Ordered only for readability — every rule is evaluated, first match wins.
 */
export const API_KEY_DENY_RULES: readonly DenyRule[] = [
  {
    // Key minting is the escalation the whole feature has to avoid. A key
    // holding `apikeys:write` could mint a second key with a later expiry and
    // a different name, so revoking the first would not end the access — the
    // credential inventory would stop being an inventory. Reads go with it:
    // there is no automation that needs to enumerate the org's credentials,
    // and listing them (name, prefix, scopes, owner) is reconnaissance that
    // makes the minting problem worse if the write gate is ever loosened.
    prefix: "/api-keys",
    methods: "*",
    reason: "API keys cannot manage API keys. Mint and revoke keys from the web UI.",
  },
  {
    // Checkout sessions, the customer portal, plan changes and payment
    // methods. Commercial state, largely irreversible, and every endpoint here
    // answers with a Stripe URL meant to be opened by a person in a browser —
    // an unattended caller has nothing to do with the response but leak it.
    prefix: "/billing",
    methods: "*",
    reason: "API keys cannot change billing. Manage the subscription from the web UI.",
  },
  {
    // Push registration binds a device token to a human's phone, and the
    // preferences say which alerts that phone rings for. There is no
    // unattended principal that owns a device, and a key writing another
    // person's notification preferences is a way to silence an alert quietly.
    prefix: "/push",
    methods: "*",
    reason: "API keys cannot register devices or change push preferences.",
  },
  {
    // Invites, role assignment, custom-role definition, member removal and
    // seat changes: all of them manufacture or destroy durable authority for
    // *other* principals. `isSubsetOfCallerPerms` already stops a key granting
    // more than it holds, which bounds the damage but does not change its
    // kind — a key should not be able to create a new person who holds what it
    // holds, nor remove one who does. Reads stay open: inventorying members and
    // roles is ordinary automation (offboarding checks, drift reports).
    prefix: "/team",
    methods: MUTATING,
    reason: "API keys cannot change team membership or roles. They may read them.",
  },
  {
    // Break-glass. `auth/effective-permissions.ts` already refuses to let a
    // live elevation flow *into* a key; this is the other half. An elevation
    // is authority handed to a person for a bounded window on a stated reason,
    // and a key requesting, approving, denying or revoking one removes the
    // human from the loop the control exists to keep. Reads stay open so a
    // monitor can watch the queue — an elevation nobody can see is not a
    // control.
    prefix: "/access-requests",
    methods: MUTATING,
    reason:
      "API keys cannot request, approve, deny or revoke break-glass access. They may read the queue.",
  },
];

/**
 * The path below `/api/org/:orgId`, or `null` when `pathname` is not an
 * org-tree path.
 *
 * Split on segments rather than string-slicing a known org id: the org id is a
 * path segment of unknown content, and a prefix comparison against it is the
 * kind of thing that quietly stops matching the day an id gains a character
 * that needs escaping.
 */
export function orgSubPath(pathname: string): string | null {
  const segments = pathname.split("/").filter((s) => s.length > 0);
  if (segments[0] !== "api" || segments[1] !== "org" || segments.length < 3) return null;
  const rest = segments.slice(3).join("/");
  return rest.length > 0 ? `/${rest}` : "/";
}

function matchesPrefix(subPath: string, prefix: string): boolean {
  return subPath === prefix || subPath.startsWith(`${prefix}/`);
}

/**
 * The reason this request is closed to API keys, or `null` if it is open.
 *
 * `pathname` is the full request path (`/api/org/<id>/api-keys`). A path that
 * is not under the org tree is never denied here — this function only speaks
 * for routes the API-key middleware actually guards.
 */
export function apiKeyRouteDenial(method: string, pathname: string): string | null {
  const subPath = orgSubPath(pathname);
  if (subPath === null) return null;
  const verb = method.toUpperCase();
  for (const rule of API_KEY_DENY_RULES) {
    if (!matchesPrefix(subPath, rule.prefix)) continue;
    if (rule.methods === "*" || rule.methods.includes(verb)) return rule.reason;
  }
  return null;
}
