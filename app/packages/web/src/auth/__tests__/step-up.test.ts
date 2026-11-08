import { describe, it, expect, vi, beforeEach } from "vitest";

const mockListSessions = vi.fn();
vi.mock("../workos", () => ({
  workos: { userManagement: { listSessions: (...a: unknown[]) => mockListSessions(...a) } },
  clientId: "client-1",
}));

const {
  requireRecentAuthentication,
  ReauthenticationRequiredError,
  STEP_UP_MAX_AGE_MS,
  REAUTHENTICATION_REQUIRED,
} = await import("../step-up");

/** The session as the auth middleware hands it over. */
function ctx(session: { userId: string; email: string; sessionId?: string }) {
  return session;
}

const SESSION = { userId: "u1", email: "u@e.com", sessionId: "sess_1" };

/**
 * The refusal the helper throws, as the route answers it: a 403 whose body is
 * `{ error, code }` (the profile domain's `ReauthenticationRequired`).
 */
async function denialOf(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await promise;
    throw new Error("expected requireRecentAuthentication to throw");
  } catch (e) {
    if (!(e instanceof ReauthenticationRequiredError)) throw e;
    return { status: 403, body: { error: e.message, code: e.code } };
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
