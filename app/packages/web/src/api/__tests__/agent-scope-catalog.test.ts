/**
 * The agent link pickers, against the server that enforces them.
 *
 * `AGENT_DENIED_SCOPES` (browser-safe, in `@infrawrench/ui`) is what the
 * approval page and Settings → Agents leave out; `AGENT_DENIED_PERMISSIONS`
 * (server-core) is what `resolveAgentPrincipal` strips. If they drift, a
 * picker offers a box the server silently ignores, or hides one it would honour.
 */
import { describe, it, expect, vi } from "vitest";

// `trials/principal` reaches db/client, which reads DATABASE_URL at import.
process.env["DATABASE_URL"] ??= "postgres://test:test@localhost:5432/test";
vi.mock("@infrawrench/server-core/db/client", () => ({ db: {} }));

const { AGENT_DENIED_PERMISSIONS } = await import("@infrawrench/server-core/trials/principal");
const { AGENT_DENIED_SCOPES, AGENT_SCOPES, agentScopeGroups } =
  await import("@infrawrench/ui/settings/api-key-scopes");

describe("agent scope pickers", () => {
  it("deny exactly what the server denies", () => {
    expect([...AGENT_DENIED_SCOPES].sort()).toEqual([...AGENT_DENIED_PERMISSIONS].sort());
  });

  it("never offer a denied scope", () => {
    for (const denied of AGENT_DENIED_PERMISSIONS) expect(AGENT_SCOPES).not.toContain(denied);
  });

  it("narrow groups to a ceiling and drop the empty ones", () => {
    const groups = agentScopeGroups(["resources:read"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.scopes.map((s) => s.value)).toEqual(["resources:read"]);
  });
});
