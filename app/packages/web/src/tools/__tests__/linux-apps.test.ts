import { describe, it, expect, vi, beforeEach } from "vitest";

const getHeadlessSession = vi.fn();
const endHeadlessSession = vi.fn();

class AppsHostError extends Error {
  constructor(
    message: string,
    readonly needsKey = false,
  ) {
    super(message);
    this.name = "AppsHostError";
  }
}

vi.mock("../../services/apps-headless", () => ({
  getHeadlessSession: (...a: unknown[]) => getHeadlessSession(...a),
  endHeadlessSession: (...a: unknown[]) => endHeadlessSession(...a),
  AppsHostError,
}));
vi.mock("../../services/audit", () => ({ logAudit: vi.fn() }));

const { linuxAppTools } = await import("../linux-apps");

const auth = { userId: "u1", organizationId: "org1", source: "mcp" as const };
const tools = linuxAppTools();
const tool = (name: string) => {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

beforeEach(() => {
  getHeadlessSession.mockReset();
  endHeadlessSession.mockReset();
});

describe("linux app tools", () => {
  it("all carry resources:execute", () => {
    expect(tools.every((t) => t.permission === "resources:execute")).toBe(true);
  });

  it("screenshot returns the png on the image side channel, caption as text", async () => {
    getHeadlessSession.mockResolvedValue({
      screenshot: vi.fn().mockResolvedValue({
        png: Buffer.from([1, 2, 3]),
        width: 640,
        height: 480,
      }),
    });
    const result = await tool("screenshot_app_window").handler(
      { resourceId: "r1", windowId: 4 },
      auth,
    );
    expect(result.content[0]?.text).toContain("640×480");
    expect(result.images?.[0]).toEqual({
      data: Buffer.from([1, 2, 3]).toString("base64"),
      mimeType: "image/png",
    });
  });

  it("flattens the accessibility tree and adds a click center to bounded nodes", async () => {
    getHeadlessSession.mockResolvedValue({
      a11yTree: vi.fn().mockResolvedValue({
        tree: {
          role: "frame",
          name: "Calc",
          states: [],
          children: [
            {
              role: "push button",
              name: "=",
              bounds: { x: 10, y: 20, width: 30, height: 40 },
              actions: ["click"],
            },
          ],
        },
      }),
    });
    const result = await tool("read_app_accessibility_tree").handler(
      { resourceId: "r1", windowId: 4 },
      auth,
    );
    const payload = JSON.parse(result.content[0]!.text) as {
      tree: { children: Array<{ center: { x: number; y: number }; role: string }> };
    };
    expect(payload.tree.children[0]).toMatchObject({
      role: "push button",
      center: { x: 25, y: 40 },
    });
  });

  it("surfaces a host error as a tool error, not a throw", async () => {
    getHeadlessSession.mockRejectedValue(new AppsHostError("This host needs an SSH key", true));
    const result = await tool("launch_app").handler({ resourceId: "r1", appId: "a" }, auth);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("SSH key");
  });

  it("launch requires appId or exec", async () => {
    const result = await tool("launch_app").handler({ resourceId: "r1" }, auth);
    expect(result.isError).toBe(true);
    expect(getHeadlessSession).not.toHaveBeenCalled();
  });

  it("close with endSession tears the session down without connecting", async () => {
    endHeadlessSession.mockReturnValue(true);
    const result = await tool("close_app_window").handler(
      { resourceId: "r1", endSession: true },
      auth,
    );
    expect(endHeadlessSession).toHaveBeenCalledWith("org1", "r1");
    expect(result.content[0]?.text).toContain("Ended");
    expect(getHeadlessSession).not.toHaveBeenCalled();
  });

  it("passes click coordinates and button through to the session", async () => {
    const click = vi.fn();
    getHeadlessSession.mockResolvedValue({ click });
    await tool("click_app_window").handler(
      { resourceId: "r1", windowId: 2, x: 100, y: 200, button: "right" },
      auth,
    );
    expect(click).toHaveBeenCalledWith(2, 100, 200, { button: "right" });
  });
});
