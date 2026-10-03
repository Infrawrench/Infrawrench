import crypto from "node:crypto";
import { ipcMain } from "electron";
import type { ParamsObject } from "sql.js";
import { z } from "zod";

import { getSqlite, persist } from "./db";
import { buildAad, decryptValue, encryptValue, getEncryptionKey } from "./main-utils";

const Identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/,
    "Secret name must be a JavaScript dot identifier",
  );
const UpsertArgs = z.object({
  id: z.string().uuid().optional(),
  name: Identifier,
  value: z
    .string()
    .min(1)
    .max(1024 * 1024),
});
const IdArgs = z.object({ id: z.string().uuid() });

interface SecretRow {
  id: string;
  name: string;
  encrypted_value: string | null;
  value_iv: string | null;
}

/** A nullable TEXT column, as sql.js hands it back. */
function textOrNull(value: ParamsObject[string] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Narrow a `workflow_secrets` row. `id` and `name` are NOT NULL TEXT; the
 * value columns are nullable and absent when the query did not select them.
 */
function toSecretRow(row: ParamsObject): SecretRow {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    encrypted_value: textOrNull(row["encrypted_value"]),
    value_iv: textOrNull(row["value_iv"]),
  };
}

function metadata(row: SecretRow) {
  return { id: row.id, name: row.name, hasValue: Boolean(row.encrypted_value) };
}

function readSecret(db: Awaited<ReturnType<typeof getSqlite>>, id: string): SecretRow | null {
  const stmt = db.prepare(
    "SELECT id, name, encrypted_value, value_iv FROM workflow_secrets WHERE id = ? LIMIT 1",
  );
  stmt.bind([id]);
  const row = stmt.step() ? toSecretRow(stmt.getAsObject()) : null;
  stmt.free();
  return row;
}

function assertNameAvailable(
  db: Awaited<ReturnType<typeof getSqlite>>,
  name: string,
  excludeId?: string,
): void {
  const stmt = db.prepare("SELECT id, name FROM workflow_secrets");
  let conflict: SecretRow | null = null;
  while (stmt.step()) {
    const row = toSecretRow(stmt.getAsObject());
    if (
      row.id !== excludeId &&
      (row.name === name || row.name.startsWith(`${name}.`) || name.startsWith(`${row.name}.`))
    ) {
      conflict = row;
      break;
    }
  }
  stmt.free();
  if (conflict) {
    throw new Error(`Workflow secret "${name}" conflicts with existing secret "${conflict.name}".`);
  }
}

async function loadLocalWorkflowSecretValues(
  secretIds: readonly string[],
): Promise<Record<string, string>> {
  const db = await getSqlite();
  const values: Record<string, string> = {};
  for (const id of [...new Set(secretIds)]) {
    const row = readSecret(db, id);
    if (!row) throw new Error(`Assigned workflow secret ${id} no longer exists.`);
    if (!row.encrypted_value || !row.value_iv) {
      throw new Error(`Assigned workflow secret "${row.name}" has no value.`);
    }
    values[row.name] = decryptValue(
      row.encrypted_value,
      row.value_iv,
      getEncryptionKey(),
      buildAad("workflowSecret", row.id, "value"),
    );
  }
  return values;
}

/** Load assignments from SQLite and decrypt their run-start snapshot in main. */
export async function loadLocalWorkflowSecretValuesForWorkflow(
  workflowId: string,
): Promise<Record<string, string>> {
  const db = await getSqlite();
  const stmt = db.prepare(
    "SELECT assigned_secret_ids FROM workflows WHERE id = ? AND deleted_at IS NULL LIMIT 1",
  );
  stmt.bind([workflowId]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  if (!row) throw new Error("Workflow not found");
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(String(row["assigned_secret_ids"] ?? "[]"));
    if (Array.isArray(parsed)) {
      ids = parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    throw new Error("Workflow secret assignments are invalid.");
  }
  return loadLocalWorkflowSecretValues(ids);
}

ipcMain.handle("workflow_secrets_list", async () => {
  const db = await getSqlite();
  const stmt = db.prepare(
    "SELECT id, name, encrypted_value FROM workflow_secrets ORDER BY name ASC",
  );
  const rows: SecretRow[] = [];
  while (stmt.step()) rows.push(toSecretRow(stmt.getAsObject()));
  stmt.free();
  return rows.map(metadata);
});

ipcMain.handle("workflow_secret_upsert", async (_event, raw: unknown) => {
  const input = UpsertArgs.parse(raw);
  const db = await getSqlite();
  const id = input.id ?? crypto.randomUUID();
  if (input.id && !readSecret(db, id)) throw new Error("Workflow secret not found");
  assertNameAvailable(db, input.name, input.id);

  const { ciphertext, iv } = encryptValue(
    input.value,
    getEncryptionKey(),
    buildAad("workflowSecret", id, "value"),
  );
  const now = new Date().toISOString();
  try {
    if (input.id) {
      db.run(
        `UPDATE workflow_secrets
         SET name = ?, encrypted_value = ?, value_iv = ?, updated_at = ?
         WHERE id = ?`,
        [input.name, ciphertext, iv, now, id],
      );
    } else {
      db.run(
        `INSERT INTO workflow_secrets
          (id, name, encrypted_value, value_iv, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, input.name, ciphertext, iv, now, now],
      );
    }
    persist();
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      throw new Error("A workflow secret with that name already exists.");
    }
    throw error;
  }
  return metadata(readSecret(db, id)!);
});

ipcMain.handle("workflow_secret_delete", async (_event, raw: unknown) => {
  const { id } = IdArgs.parse(raw);
  const db = await getSqlite();
  db.run("BEGIN");
  try {
    db.run("DELETE FROM workflow_secrets WHERE id = ?", [id]);
    const stmt = db.prepare("SELECT id, assigned_secret_ids FROM workflows");
    const workflows: { id: string; assigned_secret_ids: string }[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      // Both NOT NULL TEXT columns.
      workflows.push({
        id: String(row["id"]),
        assigned_secret_ids: String(row["assigned_secret_ids"]),
      });
    }
    stmt.free();
    for (const workflow of workflows) {
      let ids: string[] = [];
      try {
        const parsed = JSON.parse(workflow.assigned_secret_ids);
        if (Array.isArray(parsed))
          ids = parsed.filter((value): value is string => typeof value === "string");
      } catch {
        // Repair malformed legacy assignment data while removing the secret.
      }
      const next = ids.filter((secretId) => secretId !== id);
      if (next.length !== ids.length) {
        db.run("UPDATE workflows SET assigned_secret_ids = ?, updated_at = ? WHERE id = ?", [
          JSON.stringify(next),
          new Date().toISOString(),
          workflow.id,
        ]);
      }
    }
    db.run("COMMIT");
    persist();
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
  return { ok: true };
});
