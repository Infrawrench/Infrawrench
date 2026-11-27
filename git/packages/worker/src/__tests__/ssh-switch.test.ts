import { describe, expect, it } from "vitest";
import { sshEnabled } from "../env";

describe("the SSH switch", () => {
  it("is on unless SSH_ENABLED is exactly false", () => {
    expect(sshEnabled({})).toBe(true);
    expect(sshEnabled({ SSH_ENABLED: "true" })).toBe(true);
    expect(sshEnabled({ SSH_ENABLED: "false" })).toBe(false);
  });
});
