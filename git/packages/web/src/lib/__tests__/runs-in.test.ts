import { describe, expect, it } from "vitest";
import { RUNS_IN_NONE, preselectedRunsIn, runsInHint, runsInOrganizationId } from "../runs-in";

const org = (id: string, paid: boolean) => ({ id, name: id, paid });

describe("where a person's own repositories run", () => {
  it("starts on the paid organisation only when there is exactly one", () => {
    expect(preselectedRunsIn([org("a", true), org("b", false)])).toBe("a");
    expect(preselectedRunsIn([org("a", true)])).toBe("a");
    // Several, or none that can run CI: the person says.
    expect(preselectedRunsIn([org("a", true), org("b", true)])).toBeNull();
    expect(preselectedRunsIn([org("a", false)])).toBeNull();
    expect(preselectedRunsIn([])).toBeNull();
  });

  it("sends None as null and an organisation as its id", () => {
    expect(runsInOrganizationId(RUNS_IN_NONE)).toBeNull();
    expect(runsInOrganizationId("org_acme")).toBe("org_acme");
  });

  it("says when the chosen organisation cannot run CI yet, and nothing otherwise", () => {
    const organizations = [org("a", true), org("b", false)];
    expect(runsInHint(organizations, "b")).toBe("CI needs a paid plan there");
    expect(runsInHint(organizations, "a")).toBeNull();
    expect(runsInHint(organizations, RUNS_IN_NONE)).toBeNull();
    expect(runsInHint(organizations, null)).toBeNull();
  });
});
