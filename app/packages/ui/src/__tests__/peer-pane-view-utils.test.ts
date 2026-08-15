import { describe, expect, it } from "vitest";
import {
  peerPaneCreateLabel,
  peerPaneGroupName,
  peerPaneGroupTitle,
  replacePeerPaneCount,
} from "../components/detail/PeerPaneView.utils";

describe("replacePeerPaneCount", () => {
  it("replaces an existing trailing count", () => {
    expect(replacePeerPaneCount("Documents (3)", 5)).toBe("Documents (5)");
  });
  it("leaves titles without a count unchanged", () => {
    expect(replacePeerPaneCount("Documents", 5)).toBe("Documents");
  });
  it("ignores a parenthesised number that is not the group's count", () => {
    expect(replacePeerPaneCount("(2) Documents", 5)).toBe("(2) Documents");
  });
  it("handles multi-digit counts", () => {
    expect(replacePeerPaneCount("Items (12)", 100)).toBe("Items (100)");
  });
  it("replaces a count that is followed by an ordering suffix", () => {
    // The Kubernetes namespace group: `Namespaces (5) · by cost`.
    expect(replacePeerPaneCount("Namespaces (5) · by cost", 3)).toBe("Namespaces (3) · by cost");
  });
});

describe("peerPaneGroupTitle", () => {
  it("rewrites the plugin's count with the number actually rendered", () => {
    expect(peerPaneGroupTitle("Pods (12)", 4)).toBe("Pods (4)");
  });

  it("does not append a second count to a title whose count precedes a suffix", () => {
    // Regression: the old trailing-only check read this as uncounted and
    // produced `Namespaces (5) · by cost (5)`.
    expect(peerPaneGroupTitle("Namespaces (5) · by cost", 5)).toBe("Namespaces (5) · by cost");
  });

  it("rewrites rather than appends when the rendered count differs", () => {
    const title = peerPaneGroupTitle("Namespaces (7) · by cost", 5);
    expect(title).toBe("Namespaces (5) · by cost");
    expect(title.match(/\(\d+\)/g)).toEqual(["(5)"]);
  });

  it("appends a count when the plugin supplied none", () => {
    expect(peerPaneGroupTitle("Tables", 9)).toBe("Tables (9)");
  });

  it("is idempotent", () => {
    expect(peerPaneGroupTitle(peerPaneGroupTitle("Tables", 9), 9)).toBe("Tables (9)");
    expect(peerPaneGroupTitle(peerPaneGroupTitle("Namespaces (7) · by cost", 5), 5)).toBe(
      "Namespaces (5) · by cost",
    );
  });
});

describe("peerPaneGroupName", () => {
  it("strips the count", () => {
    expect(peerPaneGroupName("Deployments (3)")).toBe("Deployments");
  });
  it("strips the count and the ordering suffix", () => {
    expect(peerPaneGroupName("Namespaces (5) · by cost")).toBe("Namespaces");
  });
  it("leaves a bare name alone", () => {
    expect(peerPaneGroupName("Tables")).toBe("Tables");
  });
});

describe("peerPaneCreateLabel", () => {
  it("singularises the group name", () => {
    expect(peerPaneCreateLabel("Pods (12)")).toBe("Pod");
    expect(peerPaneCreateLabel("Deployments (0)")).toBe("Deployment");
  });
  it("does not leak the ordering suffix into the button label", () => {
    expect(peerPaneCreateLabel("Namespaces (5) · by cost")).toBe("Namespace");
  });
});
