/**
 * Org config as code: `/api/org/:orgId/config/*`, the handlers.
 *
 * Three verbs: `GET /export` produces the document, `POST /plan` says what
 * applying one would do, `POST /apply` does it. The logic lives in
 * `services/org-config/`, so this file is transport plus authorization only.
 *
 * ## Permissions
 *
 * Every route needs `config:read` (export/plan) or `config:write` (apply),
 * enforced at the gate, **and** the per-section permission for each section
 * involved, checked here. That second check is the point: `config:write` on
 * its own would otherwise be a way around a role that deliberately withholds
 * `workflows:write`, since a document can carry workflow source. A document
 * is only allowed to touch the sections its caller could have edited by hand.
 *
 * Export refuses rather than quietly omitting sections the caller cannot read.
 * A partial document looks complete, and applying it in `replace` mode would
 * delete everything the exporter was not allowed to see.
 *
 * ## Validation
 *
 * `plan` and `apply` hand the raw body to `parseOrgConfigDocument` (the Zod
 * schema in `services/org-config/schema.ts`, which the CLI's error output is
 * worded by), exactly as before; the Effect schemas in its contract
 * definition (`@infrawrench/api-contract`, `domains/org-config.ts`) only
 * document the document.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { eq } from "drizzle-orm";
import {
  ORG_CONFIG_SECTIONS,
  ORG_CONFIG_SECTION_READ_PERMISSIONS,
  ORG_CONFIG_SECTION_WRITE_PERMISSIONS,
  type OrgConfigSection,
} from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import {
  forbidden,
  OrgConfigApi,
  OrgConfigApplyResult,
  OrgConfigDocument,
  OrgConfigPlan,
} from "@infrawrench/api-contract";
import { db } from "../../../db/client";
import { organizations } from "../../../db/schema";
import { logAudit } from "../../../services/audit";
import { PlanRequiredError } from "../../../services/entitlements";
import {
  OrgConfigError,
  applyOrgConfig,
  exportOrgConfig,
  orgConfigDocumentSections,
  parseOrgConfigDocument,
  planOrgConfig,
} from "../../../services/org-config";
import { makeDomain } from "../../domain";
import { fieldsOf, readJson } from "../../request-body";
import { refuse, refusalCall, type ReadRefusal } from "../../refusals";
import { fireAndForget } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

/** `fail(c, e)`: the service's refusal with its status, a plan gate as 402. */
const orgConfigRefusal: ReadRefusal = (error) => {
  if (error instanceof OrgConfigError) return error;
  if (error instanceof PlanRequiredError) return { status: 402, message: error.message };
  return undefined;
};

const isSection = (value: string): value is OrgConfigSection =>
  ORG_CONFIG_SECTIONS.some((section) => section === value);

/**
 * Require the per-section permission for each section, naming the first one the
 * caller is missing. A 403 that says which section and which permission is the
 * difference between "fix your role" and "guess".
 */
const requireSectionPermissions = Effect.fnUntraced(function* (
  sections: readonly OrgConfigSection[],
  table: Record<OrgConfigSection, string>,
) {
  const { permissions } = yield* OrgPrincipal;
  for (const section of sections) {
    const permission = table[section];
    if (!hasPermission(permissions, permission)) {
      return yield* forbidden(
        `Missing permission: ${permission} (required for the "${section}" section)`,
      );
    }
  }
});

/** `?sections=budgets,workflows`: the export's optional narrowing. */
function parseSections(raw: string | undefined): OrgConfigSection[] {
  if (!raw) return [...ORG_CONFIG_SECTIONS];
  const wanted = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = wanted.filter((s) => !isSection(s));
  if (unknown.length > 0) {
    throw new OrgConfigError(
      `Unknown section(s): ${unknown.join(", ")}. Valid sections: ${ORG_CONFIG_SECTIONS.join(", ")}.`,
    );
  }
  return wanted.filter(isSection);
}

async function organizationName(organizationId: string): Promise<string> {
  const [row] = await db
    .select({ name: organizations.displayName })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row?.name ?? organizationId;
}

/**
 * The body as `await c.req.json<{ document?, mode? }>()` read it: not JSON (or
 * `null`) is a 500, `mode` is `replace` only when it says so, and the document
 * is `body.document`, or the whole body when it has none.
 */
const readRequest = (request: Parameters<typeof readJson>[0]) =>
  Effect.gen(function* () {
    const raw = yield* readJson(request);
    const fields = yield* fieldsOf(raw);
    const mode: "merge" | "replace" = fields["mode"] === "replace" ? "replace" : "merge";
    return { mode, document: fields["document"] ?? raw };
  });

const OrgConfigHandlers = HttpApiBuilder.group(OrgConfigApi, "orgConfig", (handlers) =>
  handlers
    // The whole configuration as one document. `?sections=` narrows it, which
    // matters for more than payload size: a document that carries only
    // `budgets` can be applied in `replace` mode without touching anything
    // else, which is how you keep one file per concern in git.
    .handle("export", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const sections = yield* refusalCall(orgConfigRefusal, { 400: refuse[400] }, async () =>
          parseSections(query.sections),
        );
        yield* requireSectionPermissions(sections, ORG_CONFIG_SECTION_READ_PERMISSIONS);
        const document = yield* refusalCall(orgConfigRefusal, { 400: refuse[400] }, async () =>
          exportOrgConfig(organizationId, {
            organizationName: await organizationName(organizationId),
            sections,
          }),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "org_config.export",
            entityType: "org_config",
            entityId: organizationId,
            metadata: { sections },
          }),
        );
        return yield* respond(OrgConfigDocument)(document);
      }),
    )
    // What applying this document would do. Read-only, so it rides
    // `config:read` plus each named section's *read* permission: previewing a
    // change is not making one, and a reviewer on a PR needs to be able to run it.
    .handleRaw("plan", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* readRequest(request);
        const document = yield* refusalCall(orgConfigRefusal, { 400: refuse[400] }, async () =>
          parseOrgConfigDocument(body.document),
        );
        yield* requireSectionPermissions(
          orgConfigDocumentSections(document),
          ORG_CONFIG_SECTION_READ_PERMISSIONS,
        );
        const plan = yield* refusalCall(orgConfigRefusal, { 400: refuse[400] }, () =>
          planOrgConfig(organizationId, document, {
            mode: body.mode,
            userId: session.userId ?? null,
          }),
        );
        return yield* respond(OrgConfigPlan)(plan);
      }),
    )
    // Apply the document, in one transaction. `mode: "replace"` also deletes
    // what the document does not name *within the sections it carries*. It is
    // never the default, and the CLI puts a confirmation in front of it.
    .handleRaw("apply", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* readRequest(request);
        const document = yield* refusalCall(orgConfigRefusal, { 400: refuse[400] }, async () =>
          parseOrgConfigDocument(body.document),
        );
        const sections = orgConfigDocumentSections(document);
        yield* requireSectionPermissions(sections, ORG_CONFIG_SECTION_WRITE_PERMISSIONS);
        const result = yield* refusalCall(
          orgConfigRefusal,
          { 400: refuse[400], 402: refuse[402] },
          () =>
            applyOrgConfig(organizationId, document, {
              mode: body.mode,
              userId: session.userId ?? null,
            }),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "org_config.apply",
            entityType: "org_config",
            entityId: organizationId,
            metadata: {
              mode: body.mode,
              sections,
              created: result.counts.create,
              updated: result.counts.update,
              deleted: result.counts.delete,
            },
          }),
        );
        return yield* respond(OrgConfigApplyResult)(result);
      }),
    ),
);

export const orgConfigDomain = makeDomain("org-config", OrgConfigApi, OrgConfigHandlers);
