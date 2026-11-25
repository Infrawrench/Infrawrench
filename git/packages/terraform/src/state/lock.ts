import { clamp, isRecord } from "../util/bytes.js";
import type { LockInfo } from "./types.js";

/**
 * Terraform's lock info, read from a request body. Only the `ID` matters to
 * the backend; the rest is kept so the next person who meets the lock is told
 * who holds it and since when, which is all Terraform prints.
 */

const MAX_ID_LENGTH = 128;
const MAX_FIELD_LENGTH = 1024;

export type LockInfoResult =
  { readonly ok: true; readonly info: LockInfo } | { readonly ok: false; readonly reason: string };

function field(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? clamp(value, MAX_FIELD_LENGTH) : "";
}

export function parseLockInfo(body: unknown): LockInfoResult {
  if (!isRecord(body)) return { ok: false, reason: "The lock info is not a JSON object." };
  const id = body["ID"];
  if (typeof id !== "string" || id === "" || id.length > MAX_ID_LENGTH) {
    return { ok: false, reason: "The lock info has no ID." };
  }
  return {
    ok: true,
    info: {
      ID: id,
      Operation: field(body, "Operation"),
      Info: field(body, "Info"),
      Who: field(body, "Who"),
      Version: field(body, "Version"),
      Created: field(body, "Created"),
      Path: field(body, "Path"),
    },
  };
}
