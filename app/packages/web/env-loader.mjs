import { readFileSync } from "node:fs";
import { resolve } from "node:path";

for (const name of [".env.local", ".env"]) {
  try {
    const content = readFileSync(resolve(process.cwd(), name), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* file doesn't exist — skip */
  }
}
