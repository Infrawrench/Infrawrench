import { describe, expect, it, vi } from "vitest";

// `infrawrench offboard`: the list, a person's checklist, the unsaved preview
// and `--start`, against fixtures shaped like client-core's wire types.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getVersion: () => "9.9.9" },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("../cloud-tokens", () => ({
  getAccessToken: vi.fn(async () => "tok"),
  forceRefreshAccessToken: vi.fn(async () => null),
  fetchCloudOrgs: vi.fn(async () => [{ id: "org-1", displayName: "Acme", role: "admin" }]),
  getAuthStatus: vi.fn(async () => ({ authenticated: true })),
  setTokenStoreReadOnly: vi.fn(),
}));

import type {
  Offboarding,
  OffboardingListResponse,
  OffboardingPreview,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { run, serveRoutes, useCliCapture } from "./cli-harness";

const out = useCliCapture();

const summary = {
  id: "off-1",
  email: "jane@example.com",
  name: "Jane Doe",
  userId: "user-9",
  aliases: ["jdoe"],
  status: "open",
  source: "manual",
  sourceDetail: null,
  startedByName: "Ada",
  note: null,
  createdAt: "2026-11-08T10:00:00.000Z",
  updatedAt: "2026-11-08T10:00:00.000Z",
  completedAt: null,
  lastScannedAt: "2026-11-08T10:00:00.000Z",
  scanTruncated: false,
  progress: { total: 2, resolved: 1, open: 0, failed: 1, unconfirmed: 0 },
} satisfies OffboardingListResponse["offboardings"][number];

const item = {
  id: "i1",
  kind: "seat",
  title: "Copilot Business",
  detail: "business",
  pluginId: "github",
  providerName: "GitHub",
  accountId: "a1",
  accountName: "acme-org",
  resourceId: null,
  resourceTypeId: null,
  confidence: "exact",
  matchReason: "Their email in the seat's email",
  matchState: "matched",
  actions: ["remove-seat"],
  status: "failed",
  resolution: null,
  lastError: "GitHub refused",
  note: null,
  resolvedByName: null,
  resolvedAt: null,
  firstSeenAt: "2026-11-08T10:00:00.000Z",
  lastSeenAt: "2026-11-08T10:00:00.000Z",
} satisfies Offboarding["items"][number];

const checklist: Offboarding = {
  ...summary,
  items: [
    item,
    {
      ...item,
      id: "i2",
      kind: "member",
      title: "Jane Doe",
      providerName: null,
      accountName: null,
      status: "done",
      lastError: null,
    },
    // A newer server's kind still renders.
    {
      ...item,
      id: "i3",
      kind: "future-thing" as never,
      title: "Mystery",
      status: "open",
      lastError: null,
    },
  ],
};

const preview: OffboardingPreview = {
  email: "sam@example.com",
  aliases: [],
  scanTruncated: false,
  candidates: [
    {
      key: "resource:r1",
      kind: "principal",
      title: "sam",
      detail: "Group Member",
      pluginId: "gitlab",
      providerName: "GitLab",
      accountId: "a2",
      accountName: "gitlab.com",
      resourceId: "r1",
      resourceTypeId: "group-member",
      confidence: "possible",
      matchReason: '"sam" in the name matches the start of their email',
      actions: ["remove"],
    },
  ],
};

describe("infrawrench offboard", () => {
  it("refuses local mode", async () => {
    expect(await run("offboard", "--local")).toBe(1);
  });

  it("lists checklists with progress", async () => {
    serveRoutes(out, { "GET /offboardings": { offboardings: [summary] } });
    expect(await run("offboard")).toBe(0);
    expect(out.stdout).toContain("Jane Doe");
    expect(out.stdout).toContain("1/2");
    expect(out.stdout).toContain("1 failed");
  });

  it("prints a person's checklist, unknown kinds included", async () => {
    serveRoutes(out, {
      "GET /offboardings": { offboardings: [summary] },
      "GET /offboardings/off-1": checklist,
    });
    expect(await run("offboard", "Jane@Example.com")).toBe(0);
    expect(out.stdout).toContain("Copilot Business");
    expect(out.stdout).toContain("GitHub refused");
    expect(out.stdout).toContain("future-thing");
  });

  it("prints the checklist as the server sent it with --json", async () => {
    serveRoutes(out, {
      "GET /offboardings": { offboardings: [summary] },
      "GET /offboardings/off-1": checklist,
    });
    expect(await run("offboard", "jane@example.com", "--json")).toBe(0);
    const printed = JSON.parse(out.stdout);
    expect(printed.org).toBe("org-1");
    expect(printed.items).toHaveLength(3);
  });

  it("previews without saving when nobody is being offboarded", async () => {
    serveRoutes(out, {
      "GET /offboardings": { offboardings: [summary] },
      "POST /offboardings/preview": preview,
    });
    expect(await run("offboard", "sam@example.com")).toBe(0);
    expect(out.requests).toEqual(["GET /offboardings", "POST /offboardings/preview"]);
    expect(out.stdout).toContain("not saved");
    expect(out.stdout).toContain("possible");
    expect(out.stdout).toContain("infrawrench offboard sam@example.com --start");
  });

  it("starts a checklist with --start", async () => {
    serveRoutes(out, { "POST /offboardings": { offboarding: checklist, created: true } });
    expect(await run("offboard", "jane@example.com", "--start", "--alias", "jdoe")).toBe(0);
    expect(out.requests).toEqual(["POST /offboardings"]);
    expect(out.stdout).toContain("Copilot Business");
  });
});
