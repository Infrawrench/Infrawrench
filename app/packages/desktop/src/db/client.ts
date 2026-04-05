import Database from "@tauri-apps/plugin-sql";
import { MIGRATIONS } from "./schema.js";

let _db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (_db) return _db;

  _db = await Database.load("sqlite:infrawrench.db");

  // Run migrations (idempotent — all use CREATE IF NOT EXISTS)
  for (const migration of MIGRATIONS) {
    await _db.execute(migration);
  }

  return _db;
}
