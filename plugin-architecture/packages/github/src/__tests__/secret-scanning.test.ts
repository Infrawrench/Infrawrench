import { describe, expect, it } from "vitest";
import {
  alertRef,
  listSecretScanningAlerts,
  parseAlertRef,
  resolveSecretScanningAlert,
} from "../secret-scanning.js";
import { ctxWith, makeHttp } from "./helpers.js";

const alert = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-02T10:00:00Z",
  html_url: `https://github.com/octo-org/app/security/secret-scanning/${n}`,
  state: "open",
  resolution: null,
  secret_type: "github_personal_access_token",
  secret_type_display_name: "GitHub Personal Access Token",
  secret: "ghp_...placeholder",
  validity: "active",
  publicly_leaked: false,
  repository: { full_name: "octo-org/app" },
  first_location_detected: { path: "config/ci.yml", start_line: 12, commit_sha: "abc123" },
  ...extra,
});

describe("secret scanning", () => {
  it("lists org alerts newest-updated first and maps them to findings", async () => {
    const { http, calls } = makeHttp(() => ({ body: [alert(7)] }));
    const page = await listSecretScanningAlerts(ctxWith(http), {
      limit: 50,
      includeResolved: true,
    });
    expect(calls[0]!.url.pathname).toBe("/orgs/octo-org/secret-scanning/alerts");
    expect(calls[0]!.url.searchParams.get("sort")).toBe("updated");
    expect(calls[0]!.url.searchParams.get("state")).toBeNull();
    expect(page.truncated).toBe(false);
    expect(page.findings[0]).toEqual({
      ref: "octo-org/app#7",
      tokenType: "github_personal_access_token",
      tokenTypeLabel: "GitHub Personal Access Token",
      secret: "ghp_...placeholder",
      state: "open",
      location: {
        repository: "octo-org/app",
        path: "config/ci.yml",
        line: 12,
        commitSha: "abc123",
      },
      url: "https://github.com/octo-org/app/security/secret-scanning/7",
      detectedAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-02T10:00:00Z",
      publiclyLeaked: false,
      validity: "active",
    });
  });

  it("asks for open alerts only when resolved ones are not wanted, and pages to the limit", async () => {
    const full = Array.from({ length: 100 }, (_, i) => alert(i + 1));
    const { http, calls } = makeHttp(() => ({ body: full }));
    const page = await listSecretScanningAlerts(ctxWith(http), {
      limit: 100,
      includeResolved: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("state")).toBe("open");
    expect(page.findings).toHaveLength(100);
    expect(page.truncated).toBe(true);
  });

  it("returns nothing for an enterprise account without calling GitHub", async () => {
    const { http, calls } = makeHttp(() => ({ body: [] }));
    const page = await listSecretScanningAlerts(ctxWith(http, "enterprise:big"), {
      limit: 10,
      includeResolved: true,
    });
    expect(page.findings).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("closes an alert with GitHub's resolution word and treats an unchanged resolution as done", async () => {
    const { http, calls } = makeHttp((_url, method) =>
      method === "PATCH" ? { status: 200, body: {} } : { status: 404 },
    );
    await resolveSecretScanningAlert(ctxWith(http), "octo-org/app#7", {
      reason: "revoked",
      comment: "Rotated in Infrawrench.",
    });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url.pathname).toBe("/repos/octo-org/app/secret-scanning/alerts/7");
    expect(calls[0]!.body).toEqual({
      state: "resolved",
      resolution: "revoked",
      resolution_comment: "Rotated in Infrawrench.",
    });

    const unchanged = makeHttp(() => ({ status: 400, body: { message: "unchanged" } }));
    await expect(
      resolveSecretScanningAlert(ctxWith(unchanged.http), "octo-org/app#7", { reason: "wont-fix" }),
    ).resolves.toBeUndefined();
  });

  it("round-trips alert references", () => {
    expect(parseAlertRef(alertRef("octo-org/app", 3))).toEqual({ repo: "octo-org/app", number: 3 });
    expect(() => parseAlertRef("nope")).toThrow();
  });
});
