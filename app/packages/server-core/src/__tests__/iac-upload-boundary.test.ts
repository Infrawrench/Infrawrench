import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Parsing is the trust boundary for an uploaded state document: before it, a
 * file a stranger sent us; after it, our own data. So the translation of parse
 * failures has to be **total**, not an allow-list of error classes — that is
 * what let a `RangeError` from a deeply nested attribute escape as an HTTP 500.
 *
 * A 500 is not merely the wrong status here. It tells a user holding an
 * unacceptable file that *we* broke, which invites them to retry it unchanged.
 */

import { fakePostgres } from "./helpers/fake-postgres";

const mockParse = vi.fn();
vi.mock("@infrawrench/client-core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    parseTerraformStateDocument: (...a: unknown[]) => mockParse(...a),
  };
});

// Real Drizzle over a recording driver. Every path exercised here fails before
// persistence, so no statement should ever be issued.
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

const { saveIacState, IacInputError } = await import("../iac/store");
const { TerraformStateParseError } = await import("@infrawrench/client-core");

const args = { organizationId: "org-1", label: "prod", document: "{}" };

/** Run `saveIacState` and return whatever it rejected with. */
async function rejection(): Promise<unknown> {
  try {
    await saveIacState(args);
    return null;
  } catch (e) {
    return e;
  }
}

describe("saveIacState parse-failure translation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pg.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("passes a classified parser rejection through with its own message", async () => {
    mockParse.mockImplementation(() => {
      throw new TerraformStateParseError("unsupported-version", "State file format version 3 …");
    });
    const err = await rejection();
    expect(err).toBeInstanceOf(IacInputError);
    expect((err as InstanceType<typeof IacInputError>).status).toBe(400);
    expect((err as Error).message).toContain("format version 3");
  });

  // The regression: this used to be rethrown, reaching the route's catch-all
  // and answering 500.
  it("translates a RangeError from the parse stage into a 400", async () => {
    mockParse.mockImplementation(() => {
      throw new RangeError("Maximum call stack size exceeded");
    });
    const err = await rejection();
    expect(err).toBeInstanceOf(IacInputError);
    expect((err as InstanceType<typeof IacInputError>).status).toBe(400);
    expect(err).not.toBeInstanceOf(RangeError);
  });

  // Total, not allow-listed: the point is that the *next* unbounded primitive
  // nobody has thought of yet also cannot become a 500.
  it.each([
    ["a TypeError", () => new TypeError("Cannot read properties of undefined")],
    ["a bare Error", () => new Error("something unforeseen")],
    ["a thrown string", () => "not even an error"],
  ])("translates %s from the parse stage into a 400", async (_label, make) => {
    mockParse.mockImplementation(() => {
      throw make();
    });
    const err = await rejection();
    expect(err).toBeInstanceOf(IacInputError);
    expect((err as InstanceType<typeof IacInputError>).status).toBe(400);
    // Still tells the user what an acceptable document looks like.
    expect((err as Error).message).toContain("terraform show -json");
  });

  it("logs an unclassified failure, since the parser should have caught it", async () => {
    mockParse.mockImplementation(() => {
      throw new RangeError("Maximum call stack size exceeded");
    });
    await rejection();
    expect(console.error).toHaveBeenCalled();
  });

  it("rejects a bad label before parsing anything at all", async () => {
    mockParse.mockImplementation(() => {
      throw new Error("should never be reached");
    });
    const err = await (async () => {
      try {
        await saveIacState({ ...args, label: "   " });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(IacInputError);
    expect(mockParse).not.toHaveBeenCalled();
  });
});
