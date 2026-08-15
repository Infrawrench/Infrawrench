import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDesktopCostApi } from "../cost-api";
import { createDesktopCostsClient } from "../costs-client";
import { createDesktopCostReportsClient } from "../cost-reports-client";

/**
 * The optional `CostApi` members the shared cost components gate their pickers
 * on. Each one is `foo?: …` on the interface, so a host that leaves it out
 * still typechecks — the control simply never renders, which is how the
 * dashboard's cost graph editor silently lost the scenario and saved-filter
 * pickers while the Costs panel kept them.
 *
 * Presence, not behaviour, is the invariant worth pinning: every surface that
 * opens `CostGraphConfigModal` must be handed the same loaders. Mirrors web's
 * `cost-client.test.ts`.
 */
const PICKER_LOADERS = [
  "listSavedFilters",
  "createSavedFilter",
  "listScenarioModels",
  "listBusinessMetrics",
  "queryUnitCosts",
  "listCostAnnotations",
] as const;

describe("desktop cost clients", () => {
  it.each(PICKER_LOADERS)("the dashboard's cost API wires %s", (method) => {
    expect(typeof (createDesktopCostApi() as unknown as Record<string, unknown>)[method]).toBe(
      "function",
    );
  });

  // Rendering the dashboard to inspect the object it hands the modal would mean
  // standing up the router, the stores and the plugin loader; the thing that
  // regressed is one line of wiring, so that is what this reads.
  it("the dashboard builds its cost API from the shared factory", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../components/DashboardView.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("createDesktopCostApi()");
    expect(source).not.toMatch(/^\s*queryCosts:/m);
  });

  it("gives the Costs panel and the Cost reports page the same loaders", () => {
    const base = createDesktopCostApi() as unknown as Record<string, unknown>;
    for (const client of [createDesktopCostsClient(), createDesktopCostReportsClient()]) {
      const wired = client as unknown as Record<string, unknown>;
      for (const key of Object.keys(base)) {
        expect(typeof wired[key], `${key} missing`).toBe("function");
      }
    }
  });
});
