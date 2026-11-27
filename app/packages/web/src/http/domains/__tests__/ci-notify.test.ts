import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

/**
 * A CI runner's notice that a run changed. What matters here is the door:
 * the bearer token reaches `acceptRunNotice` (which checks it, pinned in
 * server-core `ci/__tests__/notify.test.ts`), and each refusal comes back
 * with the status the runner retries on or gives up on.
 */

class CiNoticeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
const mockAccept = vi.fn();
vi.mock("@infrawrench/server-core/ci/runs", () => ({
  CiNoticeError,
  acceptRunNotice: (...a: unknown[]) => mockAccept(...a),
}));

const { ciNotifyDomain } = await import("@/http/domains/ci-notify/index");
const app = buildTestApi(ciNotifyDomain);

const RUN = "4a0e3c52-6c1f-4f5e-9d0c-2b8f6f1d7a10";
const TOKEN = "0".repeat(64);

function notice(path = `/api/ci-notify/runs/${RUN}`, token: string | null = TOKEN) {
  return app.request(path, {
    method: "POST",
    body: JSON.stringify({ run: "abc", state: "finished" }),
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/ci-notify/runs/:runId", () => {
  it("follows the run with the notice's token and answers 204", async () => {
    mockAccept.mockResolvedValue("ended");
    const res = await notice();
    expect(res.status).toBe(204);
    expect(mockAccept).toHaveBeenCalledWith(RUN, TOKEN);
  });

  it("passes no token on when there is none, for the check to refuse", async () => {
    mockAccept.mockRejectedValue(new CiNoticeError("no", 401));
    const res = await notice(undefined, null);
    expect(res.status).toBe(401);
    expect(mockAccept).toHaveBeenCalledWith(RUN, "");
  });

  it("answers each refusal with its status", async () => {
    for (const status of [401, 404, 409, 503]) {
      mockAccept.mockRejectedValueOnce(new CiNoticeError("refused", status));
      const res = await notice();
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: "refused" });
    }
  });
});
