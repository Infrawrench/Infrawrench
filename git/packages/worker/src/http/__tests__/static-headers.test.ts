/**
 * The UI's files skip the Worker (`run_worker_first` in wrangler.jsonc) and
 * get their headers from `git/packages/web/public/_headers`. Those must be
 * what the Worker would have put on them, and the patterns must cover every
 * path the Worker no longer sees.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Env } from "../../env";
import { withSecurityHeaders } from "../security-headers";

const headersFile = readFileSync(
  new URL("../../../../web/public/_headers", import.meta.url),
  "utf8",
);
const wrangler = readFileSync(new URL("../../../wrangler.jsonc", import.meta.url), "utf8");

/** `_headers` as blocks: a path pattern and its headers, lower-cased names. */
const blocks = (): Map<string, Map<string, string>> => {
  const out = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const line of headersFile.split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!line.startsWith(" ")) {
      current = new Map();
      out.set(line.trim(), current);
      continue;
    }
    const colon = line.indexOf(":");
    current!.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return out;
};

describe("the UI's files served without the Worker", () => {
  it("carry the headers the Worker gives an answer that is not a page", () => {
    const fromWorker = withSecurityHeaders(
      new Response("x", { headers: { "content-type": "text/javascript" } }),
      { url: "https://git.infrawrench.com/assets/app.js" },
      {} as Env,
      "id",
    );
    for (const [pattern, headers] of blocks()) {
      fromWorker.headers.forEach((value, name) => {
        if (name === "x-request-id" || name === "content-type") return;
        expect(headers.get(name), `${pattern} ${name}`).toBe(value);
      });
    }
  });

  it("are exactly the paths the Worker no longer sees", () => {
    const skipped = [...wrangler.matchAll(/"!(\/[^"]*)"/g)].map((match) => match[1]);
    expect(skipped.sort()).toEqual([...blocks().keys()].sort());
  });
});
