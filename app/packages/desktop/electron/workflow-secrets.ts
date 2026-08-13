import crypto from "node:crypto";
import { ipcMain } from "electron";
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
  value_iv?: string | null;
}

function metadata(row: SecretRow) {
  return { id: row.id, name: row.name, hasValue: Boolean(row.encrypted_value) };
}

function readSecret(db: Awaited<ReturnType<typeof getSqlite>>, id: string): SecretRow | null {
  const stmt = db.prepare(
    "SELECT id, name, encrypted_value, value_iv FROM workflow_secrets WHERE id = ? LIMIT 1",
  );
  stmt.bind([id]);
  const row = stmt.step() ? (stmt.getAsObject() as unknown as SecretRow) : null;
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
    const row = stmt.getAsObject() as unknown as SecretRow;
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
  const row = stmt.step()
    ? (stmt.getAsObject() as unknown as { assigned_secret_ids?: unknown })
    : null;
  stmt.free();
  if (!row) throw new Error("Workflow not found");
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(String(row.assigned_secret_ids ?? "[]"));
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
  while (stmt.step()) rows.push(stmt.getAsObject() as unknown as SecretRow);
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
      workflows.push(stmt.getAsObject() as unknown as { id: string; assigned_secret_ids: string });
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
