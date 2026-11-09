import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `useGT()` must return the same function across renders, or every effect
// that lists `gt` in its deps re-runs on every render (#925). Without a
// GTProvider (both apps call initializeGTSPA() only), react-core handed back
// a new empty translations snapshot on every call; the pnpm patch on
// @generaltranslation/react-core makes it one shared object. Checked in
// production mode, in a process of its own, as the apps run it. Here rather
// than in ui, which has no Node types; the renderer is one of the two apps.
describe("useGT", () => {
  it("returns one function across renders in production", () => {
    const probe = fileURLToPath(new URL("./fixtures/gt-identity-probe.mjs", import.meta.url));
    const out = execFileSync(process.execPath, ["--conditions=browser", probe], {
      env: { ...process.env, NODE_ENV: "production" },
      encoding: "utf8",
      timeout: 60_000,
    });
    const last = out.trim().split("\n").pop() ?? "";
    expect(JSON.parse(last)).toEqual({ distinct: 1 });
  });
});
