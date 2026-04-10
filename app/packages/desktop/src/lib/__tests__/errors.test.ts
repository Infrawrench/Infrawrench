import { describe, it, expect } from "vitest";
import { formatErrorMessage } from "../errors";

describe("formatErrorMessage", () => {
  it("extracts message from Error instance", () => {
    expect(formatErrorMessage(new Error("something broke"))).toBe("something broke");
  });

  it("handles string input", () => {
    expect(formatErrorMessage("plain string error")).toBe("plain string error");
  });

  it("handles null/undefined input", () => {
    expect(formatErrorMessage(null)).toBe("Unknown error");
    expect(formatErrorMessage(undefined)).toBe("Unknown error");
  });

  it("strips leading 'Error: ' prefix", () => {
    expect(formatErrorMessage(new Error("Error: double prefix"))).toBe("double prefix");
  });

  it("parses JSON error with nested message", () => {
    const json = JSON.stringify({ error: { message: "nested error msg" } });
    expect(formatErrorMessage(new Error(json))).toBe("nested error msg");
  });

  it("parses JSON error with top-level message", () => {
    const json = JSON.stringify({ message: "top level msg" });
    expect(formatErrorMessage(new Error(json))).toBe("top level msg");
  });

  it("detects connection refused errors", () => {
    expect(formatErrorMessage(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe(
      "Connection refused. Check the host, port, and that the service is reachable.",
    );
  });

  it("detects host not found errors", () => {
    expect(formatErrorMessage(new Error("getaddrinfo ENOTFOUND example.invalid"))).toBe(
      "Host not found. Check the hostname or DNS settings.",
    );
  });

  it("detects timeout errors", () => {
    expect(formatErrorMessage(new Error("connect ETIMEDOUT 10.0.0.1:443"))).toBe(
      "Connection timed out. Check network access, firewall rules, and the remote service.",
    );
  });

  it("detects authentication errors", () => {
    const result = formatErrorMessage(new Error("authentication failed for user admin"));
    expect(result).toMatch(/^Authentication or permission error\./);
  });

  it("detects permission denied", () => {
    const result = formatErrorMessage(new Error("permission denied"));
    expect(result).toMatch(/^Authentication or permission error\./);
  });

  it("handles Google API SERVICE_DISABLED error", () => {
    const json = JSON.stringify({
      error: {
        message: "Some API has not been used",
        details: [
          {
            reason: "SERVICE_DISABLED",
            metadata: {
              serviceTitle: "Compute Engine API",
              consumer: "projects/my-proj",
            },
          },
        ],
      },
    });
    const result = formatErrorMessage(new Error(json));
    expect(result).toContain("Compute Engine API");
    expect(result).toContain("not enabled");
    expect(result).toContain("my-proj");
  });

  it("handles Google API PERMISSION_DENIED error", () => {
    const json = JSON.stringify({
      error: {
        status: "PERMISSION_DENIED",
        message: "Caller does not have permission",
        details: [{ reason: "ACCESS_DENIED" }],
      },
    });
    const result = formatErrorMessage(new Error(json));
    expect(result).toContain("Permission denied");
  });

  it("normalizes whitespace in raw error messages", () => {
    expect(formatErrorMessage(new Error("too   many   spaces"))).toBe("too many spaces");
  });

  it("handles non-Error objects", () => {
    expect(formatErrorMessage(42)).toBe("42");
  });

  it("returns full JSON when no structured message is found", () => {
    const json = JSON.stringify({ code: 500 });
    const result = formatErrorMessage(new Error(json));
    expect(result).toContain("500");
  });
});
