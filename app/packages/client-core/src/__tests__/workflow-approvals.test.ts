import { describe, expect, it } from "vitest";

import { CloudApiError, type CloudFetch } from "../fetch";
import {
  decideWorkflowApproval,
  fetchWorkflowApprovals,
  formatApprovalExpiry,
  isApprovalConflict,
  isApprovalExpired,
  type WorkflowApproval,
} from "../workflow-approvals";

interface Call {
  orgId: string;
  path: string;
  init?: RequestInit | undefined;
}

/** A CloudFetch that records org-scoped calls and replies with `reply`. */
function fakeApi(reply: unknown): { api: CloudFetch; calls: Call[] } {
  const calls: Call[] = [];
  const api: CloudFetch = {
    baseUrl: "https://example.test",
    org: <T>(orgId: string, path: string, init?: RequestInit) => {
      calls.push({ orgId, path, init });
      return Promise.resolve(reply as T);
    },
    api: <T>() => Promise.resolve(null as T),
    raw: () => Promise.resolve(new Response(null)),
  };
  return { api, calls };
}

const APPROVAL: WorkflowApproval = {
  id: "a1",
  workflowId: "w1",
  workflowName: "Nightly deploy",
  runId: "r1",
  title: "Ship to production",
  message: "Deploy build 412?",
  status: "pending",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  decidedAt: null,
  decidedByName: null,
  createdAt: new Date().toISOString(),
};

describe("fetchWorkflowApprovals", () => {
  it("filters by status when one is given", async () => {
    const { api, calls } = fakeApi([APPROVAL]);
    const rows = await fetchWorkflowApprovals(api, "org1", "pending");
    expect(rows).toEqual([APPROVAL]);
    expect(calls[0]).toMatchObject({ orgId: "org1", path: "/workflow-approvals?status=pending" });
  });

  it("omits the query when no status is given, and 204 reads as empty", async () => {
    const { api, calls } = fakeApi(null);
    expect(await fetchWorkflowApprovals(api, "org1")).toEqual([]);
    expect(calls[0]?.path).toBe("/workflow-approvals");
  });
});

describe("decideWorkflowApproval", () => {
  it("POSTs to the decision endpoint with an encoded id", async () => {
    const { api, calls } = fakeApi(APPROVAL);
    await decideWorkflowApproval(api, "org1", "a/1", "approve");
    expect(calls[0]?.path).toBe("/workflow-approvals/a%2F1/approve");
    expect(calls[0]?.init?.method).toBe("POST");
  });
});

describe("isApprovalConflict", () => {
  it("is true only for a 409 from the cloud API", () => {
    expect(isApprovalConflict(new CloudApiError("already decided", 409, ""))).toBe(true);
    expect(isApprovalConflict(new CloudApiError("forbidden", 403, ""))).toBe(false);
    expect(isApprovalConflict(new Error("network"))).toBe(false);
    expect(isApprovalConflict(null)).toBe(false);
  });
});

describe("formatApprovalExpiry", () => {
  const now = Date.parse("2026-07-31T12:00:00Z");
  const at = (ms: number) => new Date(now + ms).toISOString();

  it("counts down in the largest sensible unit", () => {
    expect(formatApprovalExpiry(at(20_000), now)).toBe("expires in less than a minute");
    expect(formatApprovalExpiry(at(4 * 60_000), now)).toBe("expires in 4m");
    expect(formatApprovalExpiry(at(2 * 3_600_000), now)).toBe("expires in 2h");
    expect(formatApprovalExpiry(at(3 * 86_400_000), now)).toBe("expires in 3d");
  });

  it("reads as past tense once the window has closed", () => {
    expect(formatApprovalExpiry(at(-3 * 60_000), now)).toBe("expired 3m ago");
  });

  it("returns an empty string for an unparseable timestamp", () => {
    expect(formatApprovalExpiry("not-a-date", now)).toBe("");
  });
});

describe("isApprovalExpired", () => {
  const now = Date.parse("2026-07-31T12:00:00Z");

  it("is true at and after the deadline", () => {
    expect(isApprovalExpired({ ...APPROVAL, expiresAt: new Date(now).toISOString() }, now)).toBe(
      true,
    );
    expect(
      isApprovalExpired({ ...APPROVAL, expiresAt: new Date(now - 1).toISOString() }, now),
    ).toBe(true);
    expect(
      isApprovalExpired({ ...APPROVAL, expiresAt: new Date(now + 1000).toISOString() }, now),
    ).toBe(false);
  });

  it("treats an unparseable deadline as not expired rather than hiding the request", () => {
    expect(isApprovalExpired({ ...APPROVAL, expiresAt: "nope" }, now)).toBe(false);
  });
});
