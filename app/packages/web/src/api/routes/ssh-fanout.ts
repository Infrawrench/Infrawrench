/**
 * Fan-out SSH API routes — list SSH-capable targets, run one command across
 * many of them, and CRUD org-shared saved command snippets.
 *
 * Runs are freeze-gated (running arbitrary commands on fleet hosts is a
 * mutating operation) and audit-logged like the other privileged exec paths.
 */
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { eq, and, asc } from "drizzle-orm";
import { db } from "../../db/client";
import { sshSnippets } from "../../db/schema";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import { checkChangeFreeze } from "../../services/change-freezes";
import { listFanoutTargets, runFanout, FanoutInputError } from "../../services/ssh-fanout";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * GET /api/org/:orgId/ssh-fanout/targets
 * Every SSH-capable target in the org: `ssh` plugin accounts plus resources
 * whose type declares an sshEndpoint with a resolvable host.
 */
app.get("/targets", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const targets = await listFanoutTargets(organizationId);
  return c.json({ targets });
});

const runInputSchema = z
  .object({
    command: z.string().min(1).max(4000),
    targets: z
      .array(z.object({ kind: z.enum(["account", "resource"]), id: z.string().min(1) }).strict())
      .min(1),
    sshKeyId: z.string().optional(),
    username: z.string().max(64).optional(),
    concurrency: z.number().int().min(1).max(16).optional(),
  })
  .strict();

/**
 * POST /api/org/:orgId/ssh-fanout/run
 * Run one command across the selected targets. Per-host results carry stdout,
 * stderr, and exit code; transport failures are per-host too.
 */
app.post("/run", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = runInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
  }
  const input = parsed.data;
  const commandSnippet = input.command.slice(0, 200);

  // Fan-out exec is a mutating operation — respect change freezes, with the
  // standard override header for holders of freezes:override.
  const frozen = await checkChangeFreeze(c, {
    action: "ssh.fanout.run",
    entityType: "organization",
    entityId: organizationId,
    metadata: { targetCount: input.targets.length, commandSnippet },
  });
  if (frozen) return frozen;

  let results;
  try {
    results = await runFanout(organizationId, session.userId, {
      command: input.command,
      targets: input.targets,
      sshKeyId: input.sshKeyId,
      username: input.username,
      concurrency: input.concurrency,
    });
  } catch (e) {
    if (e instanceof FanoutInputError) return c.json({ error: e.message }, 400);
    throw e;
  }

  const failed = results.filter((r) => r.status !== "done" || r.exitCode !== 0).length;
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "ssh.fanout.run",
    entityType: "organization",
    entityId: organizationId,
    metadata: {
      commandSnippet,
      targetCount: input.targets.length,
      failedCount: failed,
      ...(input.sshKeyId ? { sshKeyId: input.sshKeyId } : {}),
    },
  });

  return c.json({ results });
});

const snippetInputSchema = z
  .object({
    name: z.string().min(1).max(100),
    command: z.string().min(1).max(4000),
    description: z.string().max(500).optional(),
  })
  .strict();

/** GET /api/org/:orgId/ssh-fanout/snippets — org-shared saved commands. */
app.get("/snippets", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const rows = await db
    .select()
    .from(sshSnippets)
    .where(eq(sshSnippets.organizationId, organizationId))
    .orderBy(asc(sshSnippets.name));
  return c.json({
    snippets: rows.map((r) => ({
      id: r.id,
      name: r.name,
      command: r.command,
      description: r.description,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  });
});

/** POST /api/org/:orgId/ssh-fanout/snippets — save a command for reuse. */
app.post("/snippets", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = snippetInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
  }
  const [existing] = await db
    .select({ id: sshSnippets.id })
    .from(sshSnippets)
    .where(
      and(eq(sshSnippets.organizationId, organizationId), eq(sshSnippets.name, parsed.data.name)),
    )
    .limit(1);
  if (existing) return c.json({ error: "A snippet with this name already exists" }, 409);

  const id = uuid();
  await db.insert(sshSnippets).values({
    id,
    organizationId,
    name: parsed.data.name,
    command: parsed.data.command,
    description: parsed.data.description ?? null,
    createdByUserId: session.userId ?? null,
  });
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "ssh.snippet.create",
    entityType: "ssh_snippet",
    entityId: id,
    metadata: { name: parsed.data.name },
  });
  return c.json({ id });
});

/** PUT /api/org/:orgId/ssh-fanout/snippets/:id — update a saved command. */
app.put("/snippets/:id", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const id = c.req.param("id");
  const parsed = snippetInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
  }
  const updated = await db
    .update(sshSnippets)
    .set({
      name: parsed.data.name,
      command: parsed.data.command,
      description: parsed.data.description ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(sshSnippets.id, id), eq(sshSnippets.organizationId, organizationId)))
    .returning({ id: sshSnippets.id });
  if (updated.length === 0) return c.json({ error: "Snippet not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "ssh.snippet.update",
    entityType: "ssh_snippet",
    entityId: id,
    metadata: { name: parsed.data.name },
  });
  return c.json({ ok: true });
});

/** DELETE /api/org/:orgId/ssh-fanout/snippets/:id */
app.delete("/snippets/:id", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const id = c.req.param("id");
  const deleted = await db
    .delete(sshSnippets)
    .where(and(eq(sshSnippets.id, id), eq(sshSnippets.organizationId, organizationId)))
    .returning({ name: sshSnippets.name });
  if (deleted.length === 0) return c.json({ error: "Snippet not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "ssh.snippet.delete",
    entityType: "ssh_snippet",
    entityId: id,
    metadata: { name: deleted[0]!.name },
  });
  return c.json({ ok: true });
});

export { app as sshFanoutRoutes };
