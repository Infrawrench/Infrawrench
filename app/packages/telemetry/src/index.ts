import { Hono } from "hono";
import { Client } from "pg";

type Env = {
  HYPERDRIVE: Hyperdrive;
};

type HelloBody = {
  token?: unknown;
  osVersion?: unknown;
  arch?: unknown;
  cpu?: unknown;
  ram?: unknown;
};

const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

function pickString(value: unknown, maxLen = 256): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLen);
}

function pickRam(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return BigInt(Math.floor(value));
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return null;
}

const app = new Hono<{ Bindings: Env }>();

app.post("/api/hello", async (c) => {
  let body: HelloBody;
  try {
    body = (await c.req.json()) as HelloBody;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const token = pickString(body.token, 128);
  if (!token || !TOKEN_PATTERN.test(token)) {
    return c.json({ error: "invalid_token" }, 400);
  }

  const osVersion = pickString(body.osVersion);
  const arch = pickString(body.arch, 32);
  const cpu = pickString(body.cpu);
  const ramBytes = pickRam(body.ram);

  const client = new Client({ connectionString: c.env.HYPERDRIVE.connectionString });
  await client.connect();
  try {
    await client.query(
      `
        INSERT INTO telemetry_clients (token, os_version, arch, cpu, ram_bytes, first_use, last_use)
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        ON CONFLICT (token) DO UPDATE SET
          os_version = EXCLUDED.os_version,
          arch       = EXCLUDED.arch,
          cpu        = EXCLUDED.cpu,
          ram_bytes  = EXCLUDED.ram_bytes,
          last_use   = NOW()
      `,
      [token, osVersion, arch, cpu, ramBytes],
    );
  } finally {
    c.executionCtx.waitUntil(client.end());
  }

  return c.json({ ok: true });
});

export default app;
