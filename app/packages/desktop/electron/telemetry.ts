import { app } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TELEMETRY_URL } from "../env";

const TOKEN_FILENAME = "telemetry-token";

function readOrCreateToken(): string {
  const userData = app.getPath("userData");
  const tokenPath = path.join(userData, TOKEN_FILENAME);
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing.length > 0) return existing;
  } catch {
    /* fall through to create */
  }
  const token = crypto.randomUUID();
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  return token;
}

function describeCpu(): string {
  const cpus = os.cpus();
  const first = cpus[0];
  if (!first) return "unknown";
  return `${first.model} (${cpus.length} cores)`;
}

// Fires a single fire-and-forget telemetry ping. Any failure (network, server,
// missing URL) is swallowed — telemetry must never affect app startup.
export function reportTelemetry(): void {
  try {
    if (!TELEMETRY_URL) return;
    const url = `${TELEMETRY_URL.replace(/\/$/, "")}/api/hello`;
    const payload = {
      token: readOrCreateToken(),
      osVersion: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      cpu: describeCpu(),
      ram: os.totalmem(),
    };

    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {
      /* silent */
    });
  } catch {
    /* silent */
  }
}
