import { describe, it, expect, vi, beforeEach } from "vitest";

const mockListSessions = vi.fn();
vi.mock("../workos", () => ({
  workos: { userManagement: { listSessions: (...a: unknown[]) => mockListSessions(...a) } },
  clientId: "client-1",
}));

const { requireRecentAuthentication, STEP_UP_MAX_AGE_MS, REAUTHENTICATION_REQUIRED } =
  await import("../step-up");

/** Minimal Hono context stand-in carrying just the session variable. */
function ctx(session: { userId: string; email?: string; sessionId?: string }) {
  return { get: (k: string) => (k === "session" ? session : undefined) } as never;
}

const SESSION = { userId: "u1", email: "u@e.com", sessionId: "sess_1" };

/** Reads the JSON body off the HTTPException the helper throws. */
async function denialOf(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await promise;
    throw new Error("expected requireRecentAuthentication to throw");
  } catch (e) {
    const res = (e as { getResponse?: () => Response }).getResponse?.();
    if (!res) throw e;
    return { status: res.status, body: await res.json() };
  }
}

describe("requireRecentAuthentication", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows a session established within the window", async () => {
    mockListSessions.mockResolvedValue({
      data: [{ id: "sess_1", createdAt: new Date(Date.now() - 60_000).toISOString() }],
    });
    await expect(requireRecentAuthentication(ctx(SESSION))).resolves.toBeUndefined();
  });

  it("denies a session older than the window", async () => {
    mockListSessions.mockResolvedValue({
      data: [
        {
          id: "sess_1",
          createdAt: new Date(Date.now() - STEP_UP_MAX_AGE_MS - 1000).toISOString(),
        },
      ],
    });
    const { status, body } = await denialOf(requireRecentAuthentication(ctx(SESSION)));
    expect(status).toBe(403);
    expect(body).toMatchObject({ code: REAUTHENTICATION_REQUIRED });
  });

  it("denies a bearer principal that has no interactive session", async () => {
    const { status, body } = await denialOf(
      requireRecentAuthentication(ctx({ userId: "u1", email: "u@e.com" })),
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ code: REAUTHENTICATION_REQUIRED });
    expect(mockListSessions).not.toHaveBeenCalled();
  });

  it("denies when WorkOS no longer lists the session", async () => {
    mockListSessions.mockResolvedValue({ data: [{ id: "some_other_session" }] });
    const { status } = await denialOf(requireRecentAuthentication(ctx(SESSION)));
    expect(status).toBe(403);
  });

  it("fails closed when WorkOS is unreachable", async () => {
    mockListSessions.mockRejectedValue(new Error("network down"));
    const { status } = await denialOf(requireRecentAuthentication(ctx(SESSION)));
    expect(status).toBe(403);
  });

  it("denies an unparseable createdAt rather than treating it as recent", async () => {
    mockListSessions.mockResolvedValue({ data: [{ id: "sess_1", createdAt: "not-a-date" }] });
    const { status } = await denialOf(requireRecentAuthentication(ctx(SESSION)));
    expect(status).toBe(403);
  });
});
