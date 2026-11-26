// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TerraformAccount } from "@infrawrench/git-contract";
import { offeredAccounts } from "../AccountsPicker";
import { terraformEventSentence } from "../PlanSummary";
import { emptyResourcesLine } from "../ResourcesTab";
import { stateFilename } from "../state-actions";
import { canRunPlan } from "../WorkspaceLayout";

const account = (accountId: string, name: string): TerraformAccount => ({
  accountId,
  name,
  pluginId: "aws",
  pluginName: "AWS",
});

describe("emptyResourcesLine", () => {
  it("does not say a state with resources has none while they are still to be listed", () => {
    expect(emptyResourcesLine(false, 0)).toBe("The state has no resources");
    expect(emptyResourcesLine(false, 3)).toBe(
      "The resources of the current state are not listed yet",
    );
    expect(emptyResourcesLine(true, 3)).toBe("No resources match");
  });
});

describe("offeredAccounts", () => {
  it("offers the organisation's accounts by name", () => {
    expect(
      offeredAccounts([account("2", "staging"), account("1", "production")], []).map(
        (item) => item.name,
      ),
    ).toEqual(["production", "staging"]);
  });

  it("keeps what the workspace links when the list is empty, once each", () => {
    const linked = [account("1", "production")];
    expect(offeredAccounts([], linked)).toEqual(linked);
    expect(offeredAccounts([account("1", "production")], linked)).toHaveLength(1);
  });
});

describe("terraformEventSentence", () => {
  const base = { operation: "plan" as const, add: null, change: null, destroy: null, reason: null };

  it("counts a plan the way Terraform's last line does", () => {
    expect(
      terraformEventSentence({ ...base, outcome: "planned", add: 2, change: 1, destroy: 0 }),
    ).toEqual({ text: "planned: 2 to add, 1 to change, 0 to destroy", tone: "success" });
    expect(terraformEventSentence({ ...base, outcome: "no_changes" }).text).toBe(
      "planned: no changes",
    );
  });

  it("says why a run failed or was never started", () => {
    expect(terraformEventSentence({ ...base, outcome: "failed", reason: "exit status 1" })).toEqual(
      { text: "plan failed: exit status 1", tone: "danger" },
    );
    const skipped = terraformEventSentence({
      ...base,
      outcome: "skipped",
      reason: "Branches from forks are not planned",
    });
    expect(skipped.tone).toBe("neutral");
    expect(skipped.text).toBe("plan skipped: Branches from forks are not planned");
    expect(terraformEventSentence({ ...base, operation: "apply", outcome: "applied" }).text).toBe(
      "applied",
    );
  });
});

describe("canRunPlan", () => {
  const viewer = (canPush: boolean) => ({
    access: "write" as const,
    canAdminister: false,
    canPush,
    canTriage: true,
    canFork: true,
    hasStarred: false,
  });
  const owner = (kind: "org" | "user") => ({ slug: "x", kind, displayName: null, avatarUrl: null });

  it("is for someone who can push to an organisation's repository", () => {
    expect(canRunPlan({ owner: owner("org"), viewer: viewer(true) })).toBe(true);
    expect(canRunPlan({ owner: owner("org"), viewer: viewer(false) })).toBe(false);
    // A personal namespace has the state backend only.
    expect(canRunPlan({ owner: owner("user"), viewer: viewer(true) })).toBe(false);
  });
});

describe("stateFilename", () => {
  it("names a download by workspace and serial", () => {
    expect(stateFilename("staging", 43)).toBe("staging-43.tfstate");
  });
});
