/**
 * What we publish, versus what the spec knows about.
 *
 * The full document describes every route and both auth mechanisms. The one we
 * serve at `/openapi.json` (and render at `/docs`) is narrower:
 *
 * 1. **Internal routes are removed.** Some routes exist purely so the
 *    first-party clients (browser UI, desktop app, mobile app) and third-party
 *    webhook senders can talk to us. They carry no stability promise, several
 *    are gated on a platform-operator allowlist, and a couple are browser
 *    redirect endpoints that make no sense to call programmatically.
 * 2. **`sessionCookie` auth is removed.** The cookie still works — it's how the
 *    browser UI authenticates — but the only way to obtain one is the browser
 *    redirect flow, which is itself internal. Advertising it just makes Scalar
 *    default to a scheme nobody outside the UI can use, and generates client
 *    snippets with a `Cookie` header instead of `Authorization: Bearer`.
 *
 * Everything stays in the Zod path files (the code is source-available, and the
 * committed `openapi.json` keeps it all) — internal operations are merely
 * tagged `x-internal: true` and dropped on the way out.
 */

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head"] as const;

/**
 * Whole route trees that are internal.
 * - `/api/admin/` — platform-operator surface (email allowlist), 403 for everyone else.
 * - `/api/v1/webhooks/` — inbound from third parties, signature-verified, never called by users.
 * - `/api/v1/sync/` — bi-directional resource sync used by the desktop app.
 * - `/api/push/` — mobile device registration for push notifications.
 */
const INTERNAL_PATH_PREFIXES = [
  "/api/admin/",
  "/api/v1/webhooks/",
  "/api/v1/sync/",
  "/api/push/",
] as const;

/**
 * Individual internal routes.
 * - Browser auth redirects — `sign-in` bounces to WorkOS, `callback` consumes
 *   the code, `sign-out` clears the cookie. All three are cookie-flow only.
 * - `ws-token` mints a short-lived token for our own WebSocket gateway.
 * - Org-scoped push preferences/recipients/test back the mobile notification UI.
 */
const INTERNAL_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/sign-in",
  "/api/auth/sign-out",
  "/callback",
  // Inbound Slack — called by Slack (signature-verified) and, for the link
  // landing, by a browser redirect; never by API clients.
  "/api/slack/commands",
  "/api/slack/interactions",
  "/api/slack/link",
  "/api/org/{orgId}/ws-token",
  "/api/org/{orgId}/push/preferences",
  "/api/org/{orgId}/push/recipients",
  "/api/org/{orgId}/push/test",
]);

/** Whether a documented path is internal (all methods on a path share the verdict). */
function isInternalPath(path: string): boolean {
  if (INTERNAL_PATHS.has(path)) return true;
  return INTERNAL_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Tag `x-internal: true` on every operation of an internal path. Runs on the
 * full document, so the committed `openapi.json` records which routes are
 * withheld from the published spec.
 */
export function injectInternalMarkers(doc: { paths?: Record<string, unknown> }) {
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    if (!isInternalPath(path)) continue;
    const pathItem = item as Record<string, Record<string, unknown> | undefined>;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      op["x-internal"] = true;
    }
  }
}

/**
 * Security schemes the published spec doesn't advertise. `sessionCookie` is
 * still accepted by the server — it just isn't obtainable outside the browser
 * flow, so documenting it only misleads programmatic clients.
 */
const UNPUBLISHED_SECURITY_SCHEMES = ["sessionCookie"] as const;

type SecurityRequirement = Record<string, string[]>;

interface StrippableDoc {
  paths?: Record<string, Record<string, unknown> | undefined>;
  tags?: Array<{ name: string }>;
  security?: SecurityRequirement[];
  components?: Record<string, Record<string, unknown> | undefined>;
}

/**
 * Return the copy of `doc` we publish: every `x-internal` operation removed,
 * `sessionCookie` auth removed, plus the fallout — paths left with no
 * operations, tags left with no operations, and component schemas no longer
 * reachable from anything that survived.
 */
export function toPublicDocument<T extends object>(doc: T): T {
  const out = structuredClone(doc) as unknown as StrippableDoc;

  for (const [path, item] of Object.entries(out.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (op && typeof op === "object" && (op as Record<string, unknown>)["x-internal"] === true) {
        delete item[method];
      }
    }
    const remaining = HTTP_METHODS.filter((m) => item[m]);
    if (remaining.length === 0) delete out.paths?.[path];
  }

  stripUnpublishedSecuritySchemes(out);

  // Drop tags nothing points at any more (e.g. Admin, Sync, Push).
  const usedTags = new Set<string>();
  for (const item of Object.values(out.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item?.[method] as { tags?: string[] } | undefined;
      for (const tag of op?.tags ?? []) usedTags.add(tag);
    }
  }
  if (out.tags) out.tags = out.tags.filter((t) => usedTags.has(t.name));

  pruneUnreachableComponents(out);
  return out as unknown as T;
}

/**
 * Drop unpublished schemes from `components.securitySchemes` and from every
 * security requirement that names them, document-level and per-operation. An
 * `[]` requirement list (explicitly public) is left alone; a list that becomes
 * empty only because we removed its last scheme is deleted, so the operation
 * falls back to the document default rather than reading as unauthenticated.
 */
function stripUnpublishedSecuritySchemes(doc: StrippableDoc) {
  const schemes = doc.components?.["securitySchemes"];
  for (const name of UNPUBLISHED_SECURITY_SCHEMES) {
    if (schemes) delete schemes[name];
  }

  const filter = (requirements: SecurityRequirement[]): SecurityRequirement[] =>
    requirements.filter((req) =>
      Object.keys(req).every(
        (name) =>
          !UNPUBLISHED_SECURITY_SCHEMES.includes(
            name as (typeof UNPUBLISHED_SECURITY_SCHEMES)[number],
          ),
      ),
    );

  if (doc.security) doc.security = filter(doc.security);

  for (const item of Object.values(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item?.[method] as { security?: SecurityRequirement[] } | undefined;
      if (!op?.security || op.security.length === 0) continue;
      const kept = filter(op.security);
      if (kept.length === 0) delete op.security;
      else op.security = kept;
    }
  }
}

/** `#/components/<section>/<name>` → `[section, name]`. */
function parseRef(ref: string): [string, string] | null {
  const match = /^#\/components\/([^/]+)\/(.+)$/.exec(ref);
  return match ? [match[1]!, match[2]!] : null;
}

function collectRefs(node: unknown, into: Set<string>) {
  if (Array.isArray(node)) {
    for (const child of node) collectRefs(child, into);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$ref" && typeof value === "string") into.add(value);
    else collectRefs(value, into);
  }
}

/**
 * Delete component entries unreachable from the surviving paths, so internal-only
 * schemas (e.g. `AdminOrganization`) don't show up in the published Models list.
 * `securitySchemes` are always kept — they're referenced by name, not by `$ref`.
 */
function pruneUnreachableComponents(doc: StrippableDoc) {
  if (!doc.components) return;

  const reachable = new Set<string>();
  const queue: string[] = [];
  const seed = new Set<string>();
  collectRefs(doc.paths ?? {}, seed);
  for (const ref of seed) queue.push(ref);

  while (queue.length > 0) {
    const ref = queue.pop()!;
    if (reachable.has(ref)) continue;
    reachable.add(ref);
    const parsed = parseRef(ref);
    if (!parsed) continue;
    const [section, name] = parsed;
    const entry = doc.components[section]?.[name];
    if (entry === undefined) continue;
    const nested = new Set<string>();
    collectRefs(entry, nested);
    for (const child of nested) queue.push(child);
  }

  for (const [section, entries] of Object.entries(doc.components)) {
    if (section === "securitySchemes" || !entries) continue;
    for (const name of Object.keys(entries)) {
      if (!reachable.has(`#/components/${section}/${name}`)) delete entries[name];
    }
    if (Object.keys(entries).length === 0) delete doc.components[section];
  }
}
