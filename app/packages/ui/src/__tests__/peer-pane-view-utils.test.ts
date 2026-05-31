import { describe, expect, it } from "vitest";
import { replacePeerPaneTrailingCount } from "../components/detail/PeerPaneView.utils";

describe("replacePeerPaneTrailingCount", () => {
  it("replaces an existing trailing count", () => {
    expect(replacePeerPaneTrailingCount("Documents (3)", 5)).toBe("Documents (5)");
  });
  it("leaves titles without a trailing count unchanged", () => {
    expect(replacePeerPaneTrailingCount("Documents", 5)).toBe("Documents");
  });
  it("only replaces a count at the very end", () => {
    expect(replacePeerPaneTrailingCount("(2) Documents", 5)).toBe("(2) Documents");
  });
  it("handles multi-digit counts", () => {
    expect(replacePeerPaneTrailingCount("Items (12)", 100)).toBe("Items (100)");
  });
});
