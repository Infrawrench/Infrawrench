import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// `useGT()` must return the same function across renders, or every effect
// that lists `gt` in its deps re-runs on every render (#925). Without a
// GTProvider (both apps call initializeGTSPA() only), react-core handed back
// a new empty translations snapshot on every call; the pnpm patch on
// @generaltranslation/react-core makes it one shared object. Checked in
// production mode, in a process of its own, as the apps run it.
describe("useGT", () => {
  it("returns one function across renders in production", () => {
    // vitest runs from the package directory; `import.meta.url` is not a
    // file URL under the jsdom environment.
    const probe = resolve(process.cwd(), "src/__tests__/fixtures/gt-identity-probe.mjs");
    const out = execFileSync(process.execPath, ["--conditions=browser", probe], {
      env: { ...process.env, NODE_ENV: "production" },
      encoding: "utf8",
      timeout: 60_000,
    });
    const last = out.trim().split("\n").pop() ?? "";
    expect(JSON.parse(last)).toEqual({ distinct: 1 });
  });
});
