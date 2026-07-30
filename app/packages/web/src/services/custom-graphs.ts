/**
 * Org-scoped custom-graph CRUD, rendering, typings, and source checking —
 * shared by the HTTP routes (api/routes/custom-graphs.ts) and the tool
 * registry (tools/custom-graphs.ts), mirroring services/workflows.ts.
 *
 * Custom graphs are a paid-plan feature: writes and renders call
 * `requirePaidPlan`, so a free org sees a 402/tool error naming the upgrade
 * path. Reads and deletes stay open — a lapsed org can still see and clean up
 * what it made.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { CustomGraphControlState, CustomGraphRenderResult } from "@infrawrench/client-core";
import {
  generateGraphDts,
  runGraph,
  typecheckWorkflow,
  type TypecheckResult,
} from "@infrawrench/workflow-runtime";

import { db } from "../db/client";
import { customGraphData, customGraphs, dashboardWidgets } from "../db/schema";
import { buildOrgCustomGraphHost } from "./custom-graph-host";
import { requirePaidPlan } from "./entitlements";

export type CustomGraphRow = typeof customGraphs.$inferSelect;

const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_SOURCE_BYTES = 128 * 1024;

/** A caller-correctable problem (bad input, missing row). */
export class CustomGraphError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "CustomGraphError";
  }
}

export interface CustomGraphBody {
  name?: string;
  description?: string | null;
  source?: string;
}

function validateBody(body: CustomGraphBody): void {
  if (body.name !== undefined && (!body.name.trim() || body.name.length > MAX_NAME_LENGTH)) {
    throw new CustomGraphError(`name must be 1–${MAX_NAME_LENGTH} characters.`);
  }
  if (body.description && body.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new CustomGraphError(`description is limited to ${MAX_DESCRIPTION_LENGTH} characters.`);
  }
  if (body.source !== undefined && body.source.length > MAX_SOURCE_BYTES) {
    throw new CustomGraphError(`source is limited to ${MAX_SOURCE_BYTES} bytes.`);
  }
}

export async function listCustomGraphs(organizationId: string): Promise<CustomGraphRow[]> {
  return db
    .select()
    .from(customGraphs)
    .where(and(eq(customGraphs.organizationId, organizationId), isNull(customGraphs.deletedAt)))
    .orderBy(asc(customGraphs.name));
}

export async function getCustomGraph(
  organizationId: string,
  id: string,
): Promise<CustomGraphRow | null> {
  const [row] = await db
    .select()
    .from(customGraphs)
    .where(
      and(
        eq(customGraphs.id, id),
        eq(customGraphs.organizationId, organizationId),
        isNull(customGraphs.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function requireCustomGraph(
  organizationId: string,
  id: string,
): Promise<CustomGraphRow> {
  const row = await getCustomGraph(organizationId, id);
  if (!row) throw new CustomGraphError(`Custom graph not found: ${id}`, 404);
  return row;
}

export async function createCustomGraph(
  organizationId: string,
  body: CustomGraphBody,
  createdByUserId?: string,
): Promise<CustomGraphRow> {
  await requirePaidPlan(organizationId, "Custom graphs");
  validateBody(body);
  if (!body.name?.trim()) throw new CustomGraphError("name is required.");
  const [row] = await db
    .insert(customGraphs)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      name: body.name.trim(),
      description: body.description?.trim() || null,
      source: body.source ?? "",
      createdByUserId: createdByUserId ?? null,
    })
    .returning();
  return row!;
}

export async function updateCustomGraph(
  organizationId: string,
  id: string,
  body: CustomGraphBody,
): Promise<CustomGraphRow> {
  await requirePaidPlan(organizationId, "Custom graphs");
  validateBody(body);
  const existing = await requireCustomGraph(organizationId, id);
  const [row] = await db
    .update(customGraphs)
    .set({
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.description !== undefined ? { description: body.description?.trim() || null } : {}),
      ...(body.source !== undefined ? { source: body.source } : {}),
      updatedAt: new Date(),
    })
    .where(eq(customGraphs.id, existing.id))
    .returning();
  return row!;
}

/**
 * Soft-delete a graph — and every dashboard card pointing at it. Nothing else
 * ever would: a `custom_graph` widget resolves its graph by `config.graphId`
 * with no FK (the budget precedent), so a card left behind renders as a
 * permanent "graph unavailable" tile. The graph's stored data stays until the
 * row is hard-deleted with the org.
 */
export async function softDeleteCustomGraph(organizationId: string, id: string): Promise<void> {
  const existing = await requireCustomGraph(organizationId, id);
  const now = new Date();
  await db.update(customGraphs).set({ deletedAt: now }).where(eq(customGraphs.id, existing.id));
  await db
    .update(dashboardWidgets)
    .set({ deletedAt: now })
    .where(
      and(
        eq(dashboardWidgets.organizationId, organizationId),
        eq(dashboardWidgets.kind, "custom_graph"),
        isNull(dashboardWidgets.deletedAt),
        sql`${dashboardWidgets.config} ->> 'graphId' = ${existing.id}`,
      ),
    );
  await db
    .delete(customGraphData)
    .where(
      and(
        eq(customGraphData.organizationId, organizationId),
        eq(customGraphData.graphId, existing.id),
      ),
    );
}

/** The ambient d.ts for graph source — static, unlike workflow typings. */
export function generateCustomGraphTypings(): string {
  return generateGraphDts();
}

export function checkCustomGraphSource(source: string): TypecheckResult {
  return typecheckWorkflow({ source, dts: generateGraphDts() });
}

export interface RenderCustomGraphOptions {
  controls?: CustomGraphControlState;
  button?: string;
  /** What started this run, surfaced as `graph.event.kind`. */
  trigger?: "manual" | "refresh" | "interaction";
}

/** Run a graph's script and return the validated render result. */
export async function renderOrgCustomGraph(
  organizationId: string,
  id: string,
  opts: RenderCustomGraphOptions = {},
): Promise<CustomGraphRenderResult> {
  await requirePaidPlan(organizationId, "Custom graphs");
  const row = await requireCustomGraph(organizationId, id);
  const result = await runGraph({
    source: row.source,
    host: buildOrgCustomGraphHost(organizationId, row.id),
    ...(opts.controls ? { controls: opts.controls } : {}),
    ...(opts.button ? { button: opts.button } : {}),
    ...(opts.trigger ? { trigger: opts.trigger } : {}),
  });
  return {
    ok: result.status === "success",
    spec: result.spec ?? null,
    error: result.error?.message ?? null,
    logs: result.logs.map((l) => ({
      level: l.level === "warn" || l.level === "error" ? l.level : "info",
      message: l.message,
    })),
    renderedAt: new Date(result.finishedAt).toISOString(),
    durationMs: result.durationMs,
  };
}
