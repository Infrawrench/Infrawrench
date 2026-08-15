import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DeploymentsPanel } from "../deployments/DeploymentsPanel.js";
import type { DeployRunResult, DeploySession, DeploymentClient } from "../deployments/types.js";

const result: DeployRunResult = {
  // What a stopped run really settles as: the abort surfaces as a failure with
  // the stage it reached, not a status of its own.
  status: "failure",
  env: "prod",
  notes: [],
  logs: [],
  durationMs: 12,
};

/**
 * A transport shaped like the real ones: `deploy()` awaits a token before it
 * has anything to send over, which is precisely why the panel cannot read a
 * stop handle back off the session.
 */
function makeClient() {
  const sent: string[] = [];
  let settle: (() => void) | null = null;

  const client = {
    listRepos: vi.fn(async () => [{ fullName: "acme/api", defaultBranch: "main" }]),
    listEnvs: vi.fn(async () => ({
      envs: ["prod"],
      sha: "abc1234",
      repo: "acme/api",
      branch: "main",
    })),
    plan: vi.fn(async () => ({ runId: "r1", result })),
    deploy: vi.fn(async (_opts: unknown, session: DeploySession) => {
      // The await that made the old contract impossible to satisfy.
      await Promise.resolve();
      await new Promise<void>((resolve) => {
        // Socket "opens" only when the test says so.
        settle = () => {
          session.stopper.finish();
          resolve();
        };
      });
      return { runId: "r1", result };
    }),
    listRuns: vi.fn(async () => []),
    rollback: vi.fn(async () => ({ runId: "r1", result })),
    listTriggers: vi.fn(async () => []),
    createTrigger: vi.fn(),
    updateTrigger: vi.fn(),
    deleteTrigger: vi.fn(async () => {}),
  } as unknown as DeploymentClient;

  return {
    client,
    /** Stand-in for `ws.onopen`, which is where the transports arm. */
    openSocket(session: DeploySession) {
      session.stopper.arm(() => sent.push("deploy:stop"));
    },
    finishRun: () => settle?.(),
    sent,
  };
}

function sessionOf(client: DeploymentClient): DeploySession {
  const call = (client.deploy as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
  return call![1] as DeploySession;
}

describe("DeploymentsPanel stop button", () => {
  it("offers Stop for a running deploy and reaches the transport", async () => {
    const h = makeClient();
    render(<DeploymentsPanel client={h.client} initialRepo="acme/api" />);

    await waitFor(() => expect(screen.getByText("Deploy", { selector: "button" })).toBeEnabled());
    fireEvent.click(screen.getByText("Deploy", { selector: "button" }));

    // Visible straight away — the transport has not even resolved its token.
    const stop = await screen.findByText("Stop", { selector: "button" });
    await waitFor(() => expect(h.client.deploy).toHaveBeenCalled());

    fireEvent.click(stop);
    // Queued while the socket was still connecting…
    expect(h.sent).toEqual([]);
    h.openSocket(sessionOf(h.client));
    // …and delivered the moment it opened.
    expect(h.sent).toEqual(["deploy:stop"]);

    await waitFor(() => expect(screen.getByText("Stopping…")).toBeDisabled());
  });

  it("clears the stop control when the run ends, and a late click is inert", async () => {
    const h = makeClient();
    render(<DeploymentsPanel client={h.client} initialRepo="acme/api" />);

    await waitFor(() => expect(screen.getByText("Deploy", { selector: "button" })).toBeEnabled());
    fireEvent.click(screen.getByText("Deploy", { selector: "button" }));
    await screen.findByText("Stop", { selector: "button" });
    await waitFor(() => expect(h.client.deploy).toHaveBeenCalled());

    const session = sessionOf(h.client);
    h.openSocket(session);
    h.finishRun();

    await waitFor(() => expect(screen.queryByText("Stop", { selector: "button" })).toBeNull());
    session.stopper.stop();
    expect(h.sent).toEqual([]);
  });
});
