/**
 * Test helper for the edge Workers: read a wrangler.jsonc and report how its
 * `alias` map differs from `gateway-only-modules.json`. Each Worker package
 * runs it in a test, so adding a library to the canonical list without
 * aliasing it (or the reverse) fails CI instead of shipping a Worker that
 * crashes on a native addon.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STUB = "@infrawrench/server-core/edge/gateway-only-stub.cjs";

/** JSONC to JSON: drop comments outside strings, then trailing commas. */
function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** @returns {{ missing: string[], extra: string[] }} */
export function compareWranglerAliases(wranglerPath) {
  const config = parseJsonc(readFileSync(wranglerPath, "utf8"));
  const { modules } = JSON.parse(
    readFileSync(fileURLToPath(new URL("./gateway-only-modules.json", import.meta.url)), "utf8"),
  );
  const aliased = Object.entries(config.alias ?? {})
    .filter(([, target]) => target === STUB)
    .map(([name]) => name);
  return {
    missing: modules.filter((m) => !aliased.includes(m)),
    extra: aliased.filter((m) => !modules.includes(m)),
  };
}
