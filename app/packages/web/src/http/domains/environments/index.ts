/**
 * Ephemeral environments: `/api/org/:orgId/environments`, the handlers. The
 * stores are promise code and run through `legacy`; the write bodies are read
 * here exactly as the routes read them.
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  EnvironmentInputError,
  createEnvironmentTemplateRecord,
  deleteEnvironmentTemplateRecord,
  getEnvironmentInstance,
  getEnvironmentSettings,
  getEnvironmentTemplate,
  listEnvironmentInstances,
  listEnvironmentTemplates,
  setEnvironmentSettings,
  updateEnvironmentTemplateRecord,
} from "@infrawrench/server-core/environments/store";
import { captureEnvironmentDraft } from "@infrawrench/server-core/environments/capture";
import {
  estimateEnvironmentInstantiation,
  forgetEnvironmentInstance,
  instantiateEnvironment,
  reconcileEnvironmentInstances,
  tearDownEnvironment,
} from "@infrawrench/server-core/environments/instantiate";
import { runEnvironmentRepairPass } from "@infrawrench/server-core/environments/pass";
import type { EnvironmentTemplateInput } from "@infrawrench/client-core";
import {
  badRequest,
  CaptureDraft,
  EnvironmentCostEstimate,
  EnvironmentInstance,
  EnvironmentInstanceConflict,
  EnvironmentInstanceList,
  EnvironmentsApi,
  EnvironmentSettings,
  EnvironmentStillLive,
  EnvironmentTemplate,
  EnvironmentTemplateConflict,
  EnvironmentTemplateList,
  notFound,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { requireNoChangeFreeze } from "../../change-freeze";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy } from "../../legacy";
import { readObjectBody } from "../../request-body";
import { refuse, refusalCall, type RefusalPolicy, refusalsOf } from "../../refusals";
import { OrgPrincipal, requirePermission } from "../../principal";
import { respond } from "../../response";

type Body = { readonly [key: string]: unknown };

const store: RefusalPolicy = refusalsOf(EnvironmentInputError, {
  logPrefix: "[environments]",
  failure: "Environment operation failed",
});

/** A JSON object's string, number and boolean values, as strings; anything else is `{}`. */
function stringRecord(value: unknown): Record<string, string> {
  if (!Predicate.isObject(value) || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (Predicate.isString(raw)) out[key] = raw;
    else if (Predicate.isNumber(raw) || Predicate.isBoolean(raw)) out[key] = String(raw);
  }
  return out;
}

/**
 * The template body as the store's input. The arrays are passed through as
 * sent: the store's `validateTemplate` is what judges their contents.
 */
function readTemplateInput(body: Body): EnvironmentTemplateInput | string {
  const name = body["name"];
  const members: unknown = body["members"];
  const parameters: unknown = body["parameters"] ?? [];
  if (!Predicate.isString(name)) return "name is required";
  if (!isArrayOf<EnvironmentTemplateInput["members"][number]>(members)) {
    return "members must be an array";
  }
  if (!isArrayOf<EnvironmentTemplateInput["parameters"][number]>(parameters)) {
    return "parameters must be an array";
  }
  const description = body["description"];
  return {
    name,
    ...(description === undefined
      ? {}
      : { description: Predicate.isString(description) ? description : null }),
    parameters,
    members,
  };
}

/**
 * An array, taken to hold `T` unchecked: the routes cast the body's arrays to
 * the store's input type and left their contents to the store's validation.
 */
function isArrayOf<T>(value: unknown): value is T[] {
  return Array.isArray(value);
}

const readBody = Effect.fnUntraced(function* (request: Parameters<typeof readObjectBody>[0]) {
  const parsed = yield* readObjectBody(request);
  if (!parsed.ok) return yield* badRequest(parsed.error);
  return parsed.body;
});

const EnvironmentsHandlers = HttpApiBuilder.group(EnvironmentsApi, "environments", (handlers) =>
  handlers
    .handle("getSettings", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const settings = yield* legacy(() => getEnvironmentSettings(organizationId));
        return yield* respond(EnvironmentSettings)(settings);
      }),
    )
    .handleRaw("setSettings", ({ request }) =>
      Effect.gen(function* () {
        const body = yield* readBody(request);
        const { organizationId, session } = yield* OrgPrincipal;
        const maxTtlHours = body["maxTtlHours"];
        const defaultTtlHours = body["defaultTtlHours"];
        const settings = yield* legacy(() =>
          setEnvironmentSettings(
            organizationId,
            {
              ...(Predicate.isNumber(maxTtlHours) ? { maxTtlHours } : {}),
              ...(Predicate.isNumber(defaultTtlHours) ? { defaultTtlHours } : {}),
            },
            session.userId,
          ),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "environment_settings.update",
            entityType: "environment_settings",
            entityId: organizationId,
            metadata: { ...settings },
          }),
        );
        return yield* respond(EnvironmentSettings)(settings);
      }),
    )
    /**
     * Preview a capture. Persists nothing: the draft is what the editor shows
     * so the user can pick which fields to vary before anything is saved.
     */
    .handleRaw("capture", ({ request }) =>
      Effect.gen(function* () {
        const body = yield* readBody(request);
        const { organizationId } = yield* OrgPrincipal;
        const rawIds: unknown = body["resourceIds"];
        const resourceIds = Array.isArray(rawIds) ? rawIds.filter(Predicate.isString) : undefined;
        const accountId = body["accountId"];
        const tagKey = body["tagKey"];
        const tagValue = body["tagValue"];
        const draft = yield* refusalCall(store, { 400: refuse[400], 404: refuse[404] }, () =>
          captureEnvironmentDraft(organizationId, {
            ...(resourceIds && resourceIds.length > 0 ? { resourceIds } : {}),
            ...(Predicate.isString(accountId) ? { accountId } : {}),
            ...(Predicate.isString(tagKey) ? { tagKey } : {}),
            ...(Predicate.isString(tagValue) ? { tagValue } : {}),
          }),
        );
        return yield* respond(CaptureDraft)(draft);
      }),
    )
    .handle("listTemplates", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const templates = yield* legacy(() => listEnvironmentTemplates(organizationId));
        return yield* respond(EnvironmentTemplateList)(templates);
      }),
    )
    .handleRaw("createTemplate", ({ request }) =>
      Effect.gen(function* () {
        const body = yield* readBody(request);
        const input = readTemplateInput(body);
        if (Predicate.isString(input)) return yield* badRequest(input);
        const { organizationId, session } = yield* OrgPrincipal;
        const created = yield* refusalCall(
          store,
          {
            400: refuse[400],
            409: (error: string) => new EnvironmentTemplateConflict({ error }),
          },
          async () => {
            const template = await createEnvironmentTemplateRecord(
              organizationId,
              input,
              session.userId,
            );
            void logAudit({
              organizationId,
              userId: session.userId,
              action: "environment_template.create",
              entityType: "environment_template",
              entityId: template.id,
              metadata: { name: template.name, memberCount: template.members.length },
            });
            return template;
          },
        );
        return yield* respond(EnvironmentTemplate, { status: 201 })(created);
      }),
    )
    .handle("getTemplate", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const template = yield* legacy(() =>
          getEnvironmentTemplate(organizationId, params.templateId),
        );
        if (!template) return yield* notFound("Template not found");
        return yield* respond(EnvironmentTemplate)(template);
      }),
    )
    .handleRaw("updateTemplate", ({ params, request }) =>
      Effect.gen(function* () {
        const body = yield* readBody(request);
        const input = readTemplateInput(body);
        if (Predicate.isString(input)) return yield* badRequest(input);
        const { organizationId, session } = yield* OrgPrincipal;
        const updated = yield* refusalCall(
          store,
          { 400: refuse[400], 404: refuse[404] },
          async () => {
            const template = await updateEnvironmentTemplateRecord(
              organizationId,
              params.templateId,
              input,
            );
            void logAudit({
              organizationId,
              userId: session.userId,
              action: "environment_template.update",
              entityType: "environment_template",
              entityId: template.id,
              metadata: { name: template.name, memberCount: template.members.length },
            });
            return template;
          },
        );
        return yield* respond(EnvironmentTemplate)(updated);
      }),
    )
    .handle("deleteTemplate", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        yield* refusalCall(store, { 404: refuse[404] }, async () => {
          const deleted = await deleteEnvironmentTemplateRecord(organizationId, params.templateId);
          void logAudit({
            organizationId,
            userId: session.userId,
            action: "environment_template.delete",
            entityType: "environment_template",
            entityId: deleted.id,
            metadata: { name: deleted.name },
          });
        });
      }),
    )
    /** What this instantiation would cost per month, before it runs. */
    .handleRaw("estimate", ({ params, request }) =>
      Effect.gen(function* () {
        const body = yield* readBody(request);
        const { organizationId } = yield* OrgPrincipal;
        const estimate = yield* refusalCall(store, { 400: refuse[400], 404: refuse[404] }, () =>
          estimateEnvironmentInstantiation(
            organizationId,
            params.templateId,
            stringRecord(body["parameters"]),
            stringRecord(body["accountOverrides"]),
          ),
        );
        return yield* respond(EnvironmentCostEstimate)(estimate);
      }),
    )
    .handleRaw("instantiate", ({ params, request }) =>
      Effect.gen(function* () {
        // Creating an environment is a write (the endpoint's gate); the
        // mandatory auto-delete lease it carries is a standing deletion, which
        // is the permission POST /leases gates `autoDelete: true` on.
        yield* requirePermission("resources:delete");
        const { organizationId, session } = yield* OrgPrincipal;
        const templateId = params.templateId;
        const body = yield* readBody(request);

        // Instantiation spends real money and schedules a deletion; a freeze
        // covers both halves of that.
        yield* requireNoChangeFreeze(request, {
          action: "environment.instantiate",
          entityType: "environment_template",
          entityId: templateId,
          metadata: { name: body["name"] },
        });

        const name = body["name"];
        const ttlHours = body["ttlHours"];
        const note = body["note"];
        if (!Predicate.isString(name)) return yield* badRequest("name is required");
        if (!Predicate.isNumber(ttlHours)) {
          return yield* badRequest("ttlHours is required; environments must expire");
        }

        const instance = yield* refusalCall(
          store,
          {
            400: refuse[400],
            404: refuse[404],
            409: (error: string) => new EnvironmentInstanceConflict({ error }),
          },
          async () => {
            const created = await instantiateEnvironment(
              organizationId,
              templateId,
              {
                name,
                ttlHours,
                parameters: stringRecord(body["parameters"]),
                ...(Predicate.isString(note) ? { note } : {}),
              },
              {
                userId: session.userId,
                accountOverrides: stringRecord(body["accountOverrides"]),
              },
            );
            void logAudit({
              organizationId,
              userId: session.userId,
              action: "environment_instance.create",
              entityType: "environment_instance",
              entityId: created.id,
              metadata: {
                templateId,
                status: created.status,
                expiresAt: created.expiresAt,
                memberCount: created.members.length,
              },
            });
            return created;
          },
        );
        return yield* respond(EnvironmentInstance, { status: 201 })(instance);
      }),
    )
    .handle("listInstances", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        // A **fast path**, not the guarantee. The poller runs both of these
        // on every tick (`server-core/src/environments/pass.ts`); doing them
        // here as well makes the page self-healing and gives an operator who
        // is looking at a broken environment an immediate repair. Repair goes
        // through the same claim the poller uses, so the two cannot race.
        const instances = yield* legacy(async () => {
          await runEnvironmentRepairPass({ organizationId, limit: 4 }).catch((err: unknown) => {
            console.error("[environments] repair failed:", err);
          });
          await reconcileEnvironmentInstances(organizationId).catch((err: unknown) => {
            console.error("[environments] reconcile failed:", err);
          });
          return listEnvironmentInstances(organizationId);
        });
        return yield* respond(EnvironmentInstanceList)(instances);
      }),
    )
    .handle("getInstance", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const instance = yield* legacy(() =>
          getEnvironmentInstance(organizationId, params.instanceId),
        );
        if (!instance) return yield* notFound("Environment not found");
        return yield* respond(EnvironmentInstance)(instance);
      }),
    )
    .handle("teardown", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const instanceId = params.instanceId;
        yield* requireNoChangeFreeze(request, {
          action: "environment.teardown",
          entityType: "environment_instance",
          entityId: instanceId,
        });
        const instance = yield* refusalCall(store, { 404: refuse[404] }, async () => {
          const torn = await tearDownEnvironment(organizationId, instanceId, {
            userId: session.userId,
          });
          void logAudit({
            organizationId,
            userId: session.userId,
            action: "environment_instance.teardown",
            entityType: "environment_instance",
            entityId: instanceId,
            metadata: { status: torn.status, memberCount: torn.members.length },
          });
          return torn;
        });
        return yield* respond(EnvironmentInstance)(instance);
      }),
    )
    .handle("deleteInstance", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        yield* refusalCall(
          store,
          {
            404: refuse[404],
            409: (error: string) => new EnvironmentStillLive({ error }),
          },
          async () => {
            await forgetEnvironmentInstance(organizationId, params.instanceId);
            void logAudit({
              organizationId,
              userId: session.userId,
              action: "environment_instance.delete",
              entityType: "environment_instance",
              entityId: params.instanceId,
            });
          },
        );
      }),
    ),
);

export const environmentsDomain = makeDomain("environments", EnvironmentsApi, EnvironmentsHandlers);
