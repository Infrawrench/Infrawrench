import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

const mockSelect = vi.fn();
vi.mock("@/db/client", () => ({ db: { select: (...a: unknown[]) => mockSelect(...a) } }));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const mockRunFanout = vi.fn();
class FanoutInputError extends Error {}
vi.mock("@/services/ssh-fanout", () => ({
  FanoutInputError,
  listFanoutTargets: vi.fn(),
  runFanout: (...a: unknown[]) => mockRunFanout(...a),
}));

const mockEvaluateChangeFreeze = vi.fn();
vi.mock("@/services/change-freezes", () => ({
  CHANGE_FREEZE_OVERRIDE_HEADER: "x-change-freeze-override",
  evaluateChangeFreeze: (...a: unknown[]) => mockEvaluateChangeFreeze(...a),
}));

const { sshFanoutDomain } = await import("@/http/domains/ssh-fanout/index");
const buildApp = () => buildTestApi(sshFanoutDomain, { basePath: "/api/org/org-1/ssh-fanout" });
const post = (path: string, body: unknown) =>
  buildApp().request(path, { method: "POST", body: JSON.stringify(body) });

const run = { command: "uptime", targets: [{ kind: "account", id: "a1" }] };

describe("SSH fan-out routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvaluateChangeFreeze.mockResolvedValue(null);
  });

  describe("POST /run", () => {
    it("runs the command and audit-logs the failures it counted", async () => {
      mockRunFanout.mockResolvedValue([
        { status: "done", exitCode: 0 },
        { status: "done", exitCode: 2 },
      ]);
      const res = await post("/run", run);
      expect(res.status).toBe(200);
      expect((await res.json()).results).toHaveLength(2);
      expect(mockRunFanout).toHaveBeenCalledWith(
        "org-1",
        "user-1",
        expect.objectContaining({ command: "uptime", targets: run.targets }),
      );
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "ssh.fanout.run",
          metadata: expect.objectContaining({ failedCount: 1 }),
        }),
      );
    });

    it("refuses an empty command with zod's sentence", async () => {
      const res = await post("/run", { ...run, command: "" });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "String must contain at least 1 character(s)" });
      expect(mockRunFanout).not.toHaveBeenCalled();
    });

    it("refuses an unknown field on a target (strict at every level)", async () => {
      const res = await post("/run", { ...run, targets: [{ kind: "account", id: "a1", x: 1 }] });
      expect(res.status).toBe(400);
      expect(mockRunFanout).not.toHaveBeenCalled();
    });

    it("answers the service's input refusal as a 400", async () => {
      mockRunFanout.mockRejectedValue(new FanoutInputError("Too many targets (max 100)"));
      const res = await post("/run", run);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Too many targets (max 100)" });
    });

    it("is blocked with 423 during a change freeze", async () => {
      mockEvaluateChangeFreeze.mockResolvedValue({
        error: "Change freeze in effect",
        code: "change_freeze_active",
        freeze: {
          id: "f1",
          name: "Close",
          reason: null,
          startsAt: "2026-11-01T00:00:00Z",
          endsAt: null,
        },
      });
      const res = await post("/run", run);
      expect(res.status).toBe(423);
      expect(mockRunFanout).not.toHaveBeenCalled();
    });
  });

  describe("POST /snippets", () => {
    it("409s on a duplicate name", async () => {
      const limit = vi.fn().mockResolvedValue([{ id: "s1" }]);
      const where = vi.fn().mockReturnValue({ limit });
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });
      const res = await post("/snippets", { name: "disk", command: "df -h" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "A snippet with this name already exists" });
    });
  });
});
