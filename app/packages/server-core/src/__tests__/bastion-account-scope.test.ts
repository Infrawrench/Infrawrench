import { describe, expect, it } from "vitest";
import { fetch, MockAgent } from "undici";
import { scopeDispatcherToAccount } from "../bastion/account-scope";

/**
 * Real undici over a MockAgent, which answers from memory with the network turned off:
 * what matters here is how a refusal reaches a caller of `fetch`, redirects included.
 */
function agentAnswering() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get("https://own.acme.example")
    .intercept({ path: "/ok" })
    .reply(200, "from own host")
    .persist();
  agent
    .get("https://own.acme.example")
    .intercept({ path: "/redirect" })
    .reply(302, "", { headers: { location: "https://other.acme.example/secret" } })
    .persist();
  agent
    .get("https://other.acme.example")
    .intercept({ path: "/secret" })
    .reply(200, "from another account's host")
    .persist();
  return agent;
}

function refusalOf(error: unknown): string {
  return error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
}

describe("scopeDispatcherToAccount", () => {
  const scoped = () =>
    scopeDispatcherToAccount(agentAnswering(), "b1", ["own.acme.example", "*.example.test"]);

  it("passes a call to the account's own host through", async () => {
    const response = await fetch("https://own.acme.example/ok", { dispatcher: scoped() });
    expect(await response.text()).toBe("from own host");
  });

  it("refuses a host that is on the bastion's allowlist for another account", async () => {
    const error = await fetch("https://other.acme.example/secret", {
      dispatcher: scoped(),
    }).catch((err: unknown) => err);
    expect(refusalOf(error)).toMatch(/other\.acme\.example.*not allowed for this account/);
  });

  it("refuses a redirect from the account's own host to another account's", async () => {
    const error = await fetch("https://own.acme.example/redirect", {
      dispatcher: scoped(),
    }).catch((err: unknown) => err);
    expect(refusalOf(error)).toMatch(/other\.acme\.example.*not allowed for this account/);
  });
});
