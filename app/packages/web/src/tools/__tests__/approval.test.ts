import { describe, expect, it, vi } from "vitest";
import { needsApproval } from "../approval";

const auth = { userId: "u1", organizationId: "o1", source: "chat" as const };

describe("needsApproval", () => {
  it("always gates destructive tools", async () => {
    const requiresApproval = vi.fn().mockResolvedValue(false);
    expect(await needsApproval({ risk: "destructive", requiresApproval }, {}, auth)).toBe(true);
    expect(requiresApproval).not.toHaveBeenCalled();
  });

  it("auto-runs read and write tools without an escalation hook", async () => {
    expect(await needsApproval({ risk: "read" }, {}, auth)).toBe(false);
    expect(await needsApproval({ risk: "write" }, {}, auth)).toBe(false);
  });

  it("follows the tool's per-call escalation", async () => {
    const requiresApproval = vi.fn().mockResolvedValue(true);
    expect(await needsApproval({ risk: "read", requiresApproval }, { a: 1 }, auth)).toBe(true);
    expect(requiresApproval).toHaveBeenCalledWith({ a: 1 }, auth);
  });

  it("fails closed when the escalation check throws", async () => {
    const requiresApproval = vi.fn().mockRejectedValue(new Error("db down"));
    expect(await needsApproval({ risk: "read", requiresApproval }, {}, auth)).toBe(true);
  });
});
