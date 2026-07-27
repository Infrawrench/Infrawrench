import { describe, expect, it } from "vitest";
import { describeDisabledApi, gcpApiError } from "../api-error.js";
import { formatGcpError } from "../utils.js";

/**
 * Verbatim body returned by sqladmin.googleapis.com for a project that has
 * never enabled the API — the shape the rewrite keys off. Trimmed only of the
 * fields we don't read.
 */
const SERVICE_DISABLED_BODY = JSON.stringify({
  error: {
    code: 403,
    message:
      "Cloud SQL Admin API has not been used in project 205336108475 before or it is disabled. " +
      "Enable it by visiting https://console.developers.google.com/apis/api/sqladmin.googleapis.com/overview?project=205336108475 " +
      "then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.",
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "SERVICE_DISABLED",
        domain: "googleapis.com",
        metadata: { service: "sqladmin.googleapis.com", consumer: "projects/205336108475" },
      },
    ],
  },
});

describe("describeDisabledApi", () => {
  it("names the API, the project and how to switch it on", () => {
    const msg = describeDisabledApi(403, SERVICE_DISABLED_BODY, "my-project");
    expect(msg).toBe(
      "The Cloud SQL Admin API (sqladmin.googleapis.com) is not enabled for project my-project. " +
        "Enable it at https://console.cloud.google.com/apis/library/sqladmin.googleapis.com?project=my-project " +
        "— it can take a few minutes to take effect.",
    );
  });

  it("falls back to the project number when the caller has no project id", () => {
    const msg = describeDisabledApi(403, SERVICE_DISABLED_BODY);
    expect(msg).toContain("for project 205336108475");
    expect(msg).toContain("?project=205336108475");
  });

  it("leaves other 403s alone", () => {
    const denied = JSON.stringify({
      error: { code: 403, message: "Permission denied", status: "PERMISSION_DENIED" },
    });
    expect(describeDisabledApi(403, denied, "my-project")).toBeNull();
  });

  it("ignores non-403 responses and non-JSON bodies", () => {
    expect(describeDisabledApi(500, SERVICE_DISABLED_BODY, "my-project")).toBeNull();
    expect(describeDisabledApi(403, "<html>gateway error</html>", "my-project")).toBeNull();
  });
});

describe("gcpApiError", () => {
  it("throws the clarified message for a disabled API", () => {
    const err = gcpApiError(
      403,
      "https://sqladmin.googleapis.com/v1/x",
      SERVICE_DISABLED_BODY,
      "p",
    );
    expect(err.message).toContain("is not enabled for project p");
    // The raw JSON must not survive into the user-facing string.
    expect(err.message).not.toContain("{");
  });

  it("keeps the raw body for anything else", () => {
    const err = gcpApiError(404, "https://compute.googleapis.com/x", "not found", "p");
    expect(err.message).toBe("GCP API 404 for https://compute.googleapis.com/x: not found");
  });
});

describe("formatGcpError", () => {
  it("rewrites a disabled-API response for create/action surfaces too", async () => {
    const res = new Response(SERVICE_DISABLED_BODY, { status: 403 });
    expect(await formatGcpError("Create instance", res, "my-project")).toContain(
      "The Cloud SQL Admin API (sqladmin.googleapis.com) is not enabled for project my-project",
    );
  });

  it("still relays ordinary errors with the operation prefix", async () => {
    const res = new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), {
      status: 429,
    });
    expect(await formatGcpError("Create instance", res)).toBe(
      "Create instance failed (429): Quota exceeded",
    );
  });
});
