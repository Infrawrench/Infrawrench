import { describe, it, expect } from "vitest";
import { formatErrorMessage } from "@infrawrench/ui";

describe("formatErrorMessage", () => {
  it("returns the message from an Error instance", () => {
    expect(formatErrorMessage(new Error("something broke"))).toBe("something broke");
  });

  it("returns string as-is", () => {
    expect(formatErrorMessage("plain string")).toBe("plain string");
  });

  it('returns "Unknown error" for null', () => {
    expect(formatErrorMessage(null)).toBe("Unknown error");
  });

  it('returns "Unknown error" for undefined', () => {
    expect(formatErrorMessage(undefined)).toBe("Unknown error");
  });

  it("strips Electron IPC remote-method wrapper", () => {
    expect(
      formatErrorMessage(
        new Error("Error invoking remote method 'cloud_describe_resource': Error: boom"),
      ),
    ).toBe("boom");
  });
});
