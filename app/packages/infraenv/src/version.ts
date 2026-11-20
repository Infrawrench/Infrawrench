/**
 * The package's version, read from its own package.json: `src/` and `dist/`
 * both sit one level under the package root, so the same relative path works
 * in the tests and in the published package.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  try {
    const text = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === "string" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** The package's root directory (where package.json and skills/ are). */
export const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
