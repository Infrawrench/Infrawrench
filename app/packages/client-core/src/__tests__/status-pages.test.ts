import { describe, expect, it } from "vitest";
import {
  STATUS_PAGE_LIMITS,
  componentStateFromProbe,
  groupStatusComponents,
  rollUpStatusPageState,
  statusComponentLabel,
  statusPageSummary,
  statusPageUrl,
  validateStatusPageInput,
  type StatusComponentState,
} from "../status-pages";

describe("componentStateFromProbe", () => {
  it("maps a running probe's status straight through", () => {
    expect(componentStateFromProbe("up", true)).toBe("operational");
    expect(componentStateFromProbe("down", true)).toBe("down");
    expect(componentStateFromProbe("unknown", true)).toBe("unknown");
  });

  it("reads a paused probe as unknown, whatever it last reported", () => {
    // Showing the green from before someone paused the check would be a false
    // claim about what is currently being monitored.
    expect(componentStateFromProbe("up", false)).toBe("unknown");
    expect(componentStateFromProbe("down", false)).toBe("unknown");
  });
});

describe("rollUpStatusPageState", () => {
  const states = (...list: StatusComponentState[]) => list.map((state) => ({ state }));

  it("is operational when everything known is up", () => {
    expect(rollUpStatusPageState(states("operational", "operational"))).toBe("operational");
  });

  it("is degraded when some but not all are down", () => {
    expect(rollUpStatusPageState(states("operational", "down"))).toBe("degraded");
  });

  it("is a major outage when everything known is down", () => {
    expect(rollUpStatusPageState(states("down", "down"))).toBe("major_outage");
  });

  it("ignores unknown components rather than blanking the page", () => {
    // One newly-added component must not drag a reporting page to unknown.
    expect(rollUpStatusPageState(states("operational", "unknown"))).toBe("operational");
    expect(rollUpStatusPageState(states("down", "unknown"))).toBe("major_outage");
  });

  it("is unknown when nothing is known", () => {
    expect(rollUpStatusPageState(states("unknown", "unknown"))).toBe("unknown");
    expect(rollUpStatusPageState([])).toBe("unknown");
  });

  it("counts a degraded component toward the outage side", () => {
    expect(rollUpStatusPageState(states("operational", "degraded"))).toBe("degraded");
  });
});

describe("summaries and labels", () => {
  it("gives every page state one sentence", () => {
    expect(statusPageSummary("operational")).toBe("All systems operational");
    expect(statusPageSummary("degraded")).toBe("Some systems are experiencing issues");
    expect(statusPageSummary("major_outage")).toBe("Major outage");
    expect(statusPageSummary("unknown")).toBe("Status unavailable");
  });

  it("labels a component with no data honestly", () => {
    expect(statusComponentLabel("unknown")).toBe("No data");
    expect(statusComponentLabel("operational")).toBe("Operational");
  });
});

describe("groupStatusComponents", () => {
  it("keeps the org's order — groups appear where their first member does", () => {
    const grouped = groupStatusComponents([
      { groupName: "Core", id: 1 },
      { groupName: null, id: 2 },
      { groupName: "Core", id: 3 },
    ]);
    expect(grouped.map((g) => g.groupName)).toEqual(["Core", null]);
    expect(grouped[0]!.components.map((c) => c.id)).toEqual([1, 3]);
    expect(grouped[1]!.components.map((c) => c.id)).toEqual([2]);
  });

  it("treats an empty group name as ungrouped", () => {
    const grouped = groupStatusComponents([{ groupName: "" }, { groupName: null }]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.groupName).toBeNull();
  });
});

describe("validateStatusPageInput", () => {
  it("accepts a minimal page", () => {
    expect(validateStatusPageInput({ title: "Acme status" })).toBeNull();
  });

  it("requires a non-blank title when the title is being set", () => {
    expect(validateStatusPageInput({ title: "   " })).toMatch(/title is required/);
  });

  it("ignores the title when the patch does not touch it", () => {
    expect(validateStatusPageInput({ description: "hi" })).toBeNull();
  });

  it("rejects a support link that isn't http(s)", () => {
    expect(validateStatusPageInput({ supportUrl: "javascript:alert(1)" })).toMatch(/http or https/);
    expect(validateStatusPageInput({ supportUrl: "acme.com" })).toMatch(/full URL/);
  });

  it("treats a blank support link as cleared", () => {
    expect(validateStatusPageInput({ supportUrl: "  " })).toBeNull();
  });

  it("rejects the same probe listed twice", () => {
    expect(
      validateStatusPageInput({
        components: [{ probeId: "p1" }, { probeId: "p1" }],
      }),
    ).toMatch(/twice/);
  });

  it("rejects a component with no probe", () => {
    expect(validateStatusPageInput({ components: [{ probeId: "" }] })).toMatch(/name a probe/);
  });

  it("enforces the component cap", () => {
    const components = Array.from({ length: STATUS_PAGE_LIMITS.maxComponents + 1 }, (_, i) => ({
      probeId: `p${i}`,
    }));
    expect(validateStatusPageInput({ components })).toMatch(/at most/);
  });
});

describe("statusPageUrl", () => {
  it("joins origin and slug", () => {
    expect(statusPageUrl("https://app.infrawrench.com", "abc")).toBe(
      "https://app.infrawrench.com/status/abc",
    );
  });

  it("tolerates a trailing slash on the origin", () => {
    expect(statusPageUrl("https://app.infrawrench.com/", "abc")).toBe(
      "https://app.infrawrench.com/status/abc",
    );
  });
});
