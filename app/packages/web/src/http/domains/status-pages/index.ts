/**
 * Public status pages, the handlers for the org-tree half (managing the
 * rows). The public reader is `./public.ts`, kept apart so it can reach
 * nothing but the public payload assembler.
 */
import { Effect, Layer, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  StatusPageInputError,
  createStatusPageRecord,
  deleteStatusPageRecord,
  listStatusPages,
  rotateStatusPageSlugRecord,
  updateStatusPageRecord,
} from "@infrawrench/server-core/status-pages/store";
import type {
  StatusPageComponentInput,
  StatusPageCreate,
  StatusPagePatch,
} from "@infrawrench/client-core";
import {
  badRequest,
  StatusPage,
  StatusPageListResponse,
  StatusPagesApi,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy } from "../../legacy";
import { readObjectBody } from "../../request-body";
import { refusalCall, inputRefusals, refusalsOf } from "../../refusals";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { PublicStatusHandlers } from "./public";

type Body = { readonly [key: string]: unknown };

const statusPageStore = refusalsOf(StatusPageInputError, {
  logPrefix: "[status-pages]",
  failure: "Status page operation failed",
});

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isOptionalNullableString = (value: unknown): value is string | null | undefined =>
  value === undefined || isNullableString(value);

/** Parse the `components` array, or return the boundary's complaint. */
function readComponents(
  raw: unknown,
): { ok: true; components: StatusPageComponentInput[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "components must be an array" };
  const components: StatusPageComponentInput[] = [];
  for (const entry of raw) {
    if (!Predicate.isObject(entry) || Array.isArray(entry)) {
      return { ok: false, error: "Each component must be an object" };
    }
    const probeId = entry["probeId"];
    if (typeof probeId !== "string" || !probeId) {
      return { ok: false, error: "Each component needs a probeId" };
    }
    const label = entry["label"];
    const groupName = entry["groupName"];
    if (!isOptionalNullableString(label)) {
      return { ok: false, error: "Component label must be a string" };
    }
    if (!isOptionalNullableString(groupName)) {
      return { ok: false, error: "Component groupName must be a string" };
    }
    components.push({
      probeId,
      ...(label !== undefined ? { label } : {}),
      ...(groupName !== undefined ? { groupName } : {}),
    });
  }
  return { ok: true, components };
}

/** The optional page fields both writes accept; a field of the wrong type is ignored. */
function pickSettings(body: Body): Omit<StatusPagePatch, "title" | "components"> {
  const description = body["description"];
  const supportUrl = body["supportUrl"];
  return {
    ...(isNullableString(description) ? { description } : {}),
    ...(typeof body["published"] === "boolean" ? { published: body["published"] } : {}),
    ...(typeof body["showHistory"] === "boolean" ? { showHistory: body["showHistory"] } : {}),
    ...(typeof body["showUptime"] === "boolean" ? { showUptime: body["showUptime"] } : {}),
    ...(isNullableString(supportUrl) ? { supportUrl } : {}),
  };
}

/** `components` when the body has it: the parsed list, or the 400 that refuses it. */
const bodyComponents = Effect.fnUntraced(function* (body: Body) {
  if (body["components"] === undefined) return undefined;
  const parsed = readComponents(body["components"]);
  if (!parsed.ok) return yield* badRequest(parsed.error);
  return parsed.components;
});

const StatusPagesHandlers = HttpApiBuilder.group(StatusPagesApi, "statusPages", (h) =>
  h
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const pages = yield* legacy(() => listStatusPages(organizationId));
        return yield* respond(StatusPageListResponse)(pages);
      }),
    )
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const body = read.body;
        const title = body["title"];
        if (typeof title !== "string") return yield* badRequest("title is required");
        const components = yield* bodyComponents(body);
        const input: StatusPageCreate = {
          title,
          ...pickSettings(body),
          ...(components ? { components } : {}),
        };
        const created = yield* refusalCall(statusPageStore, inputRefusals, () =>
          createStatusPageRecord(organizationId, input, session.userId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "status_page.create",
            entityType: "status_page",
            entityId: created.id,
            metadata: { title: created.title, published: created.published },
          }),
        );
        return yield* respond(StatusPage, { status: 201 })(created);
      }),
    )
    .handleRaw("update", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const body = read.body;
        const components = yield* bodyComponents(body);
        const title = body["title"];
        const patch: StatusPagePatch = {
          ...(typeof title === "string" ? { title } : {}),
          ...pickSettings(body),
          ...(components ? { components } : {}),
        };
        const updated = yield* refusalCall(statusPageStore, inputRefusals, () =>
          updateStatusPageRecord(organizationId, params.id, patch),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "status_page.update",
            entityType: "status_page",
            entityId: updated.id,
            // Publishing is the state change that matters in an audit trail: it
            // is the moment the page became readable by anyone with the link.
            metadata: { published: updated.published, componentCount: updated.components.length },
          }),
        );
        return yield* respond(StatusPage)(updated);
      }),
    )
    .handle("rotateSlug", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const rotated = yield* refusalCall(statusPageStore, inputRefusals, () =>
          rotateStatusPageSlugRecord(organizationId, params.id),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "status_page.rotate_slug",
            entityType: "status_page",
            entityId: rotated.id,
          }),
        );
        return yield* respond(StatusPage)(rotated);
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const removed = yield* refusalCall(statusPageStore, inputRefusals, () =>
          deleteStatusPageRecord(organizationId, params.id),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "status_page.delete",
            entityType: "status_page",
            entityId: removed.id,
            metadata: { title: removed.title },
          }),
        );
      }),
    ),
);

export const statusPagesDomain = makeDomain(
  "status-pages",
  StatusPagesApi,
  Layer.mergeAll(StatusPagesHandlers, PublicStatusHandlers),
);
