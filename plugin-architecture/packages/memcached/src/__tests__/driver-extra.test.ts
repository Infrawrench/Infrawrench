import { describe, it, expect, vi, beforeEach } from "vitest";

type StatsCallback = (
  err: Error | null,
  server: string | null,
  stats: Record<string, string> | null,
) => void;

// vi.mock is hoisted above all module code, so the mock fns it references must
// be created via vi.hoisted (which is hoisted too) rather than plain consts.
const { create, mockStats, mockQuit } = vi.hoisted(() => {
  const mockStats = vi.fn();
  const mockQuit = vi.fn();
  const create = vi.fn(() => ({ stats: mockStats, quit: mockQuit }));
  return { create, mockStats, mockQuit };
});

vi.mock("memjs", () => ({
  default: {
    Client: { create },
  },
}));

import { driver } from "../driver.js";

describe("memcached driver extra branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("strips memcacheds:// scheme when resolving servers", async () => {
    mockStats.mockImplementation((cb: StatsCallback) => {
      cb(null, "s1:11211", { version: "1.6" });
      cb(null, null, null);
    });
    await driver.command("memcacheds://secure.example.com:11211", "VERSION", []);
    expect(create).toHaveBeenCalledWith(
      "secure.example.com:11211",
      expect.objectContaining({ timeout: 5, retries: 0 }),
    );
  });

  it("VERSION falls back to ? when version stat missing", async () => {
    mockStats.mockImplementation((cb: StatsCallback) => {
      cb(null, "s1:11211", {});
      cb(null, null, null);
    });
    const res = await driver.command("memcached://localhost:11211", "VERSION", []);
    expect(res).toBe("s1:11211: ?");
  });

  it("STATS tolerates null stats object", async () => {
    mockStats.mockImplementation((cb: StatsCallback) => {
      cb(null, "s1:11211", null);
      cb(null, null, null);
    });
    const res = await driver.command("memcached://localhost:11211", "STATS", []);
    expect(res).toContain("# s1:11211");
  });
});
