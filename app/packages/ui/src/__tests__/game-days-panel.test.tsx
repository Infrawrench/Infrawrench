import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

beforeAll(() => {
  // jsdom doesn't implement <dialog> showModal/close: stub them, as the other
  // panel tests do. The editor and the arm dialog render through Modal.
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
  }
});
import {
  EMPTY_GAME_DAY_SIGNALS,
  computeGameDayReport,
  type GameDay,
} from "@infrawrench/client-core";
import { GameDaysPanel } from "../game-days/GameDaysPanel.js";
import type { GameDaysClient } from "../game-days/types.js";

const base: GameDay = {
  id: "gd-1",
  name: "Checkout without its cache",
  description: null,
  serviceId: null,
  serviceName: null,
  status: "running",
  endReason: null,
  startsAt: "2026-11-18T10:00:00.000Z",
  durationMinutes: 15,
  recoveryTimeoutMinutes: 30,
  freezeDuringRun: false,
  freezeId: null,
  watchedProbes: [{ id: "p1", name: "checkout", status: "down" }],
  watchedSloIds: [],
  armedAt: "2026-11-18T09:00:00.000Z",
  armedByUserId: "u1",
  armedByEmail: "a@example.com",
  injectedAt: "2026-11-18T10:00:00.000Z",
  endsAt: "2026-11-18T10:15:00.000Z",
  endRequestedAt: null,
  undoneAt: null,
  recoveredAt: null,
  completedAt: null,
  lastError: null,
  signals: { ...EMPTY_GAME_DAY_SIGNALS, probeFailedAt: "2026-11-18T10:01:00.000Z" },
  targets: [
    {
      id: "t1",
      resourceId: "res-1",
      accountId: "acct-1",
      pluginId: "kubernetes",
      resourceTypeId: "k8s-deployment",
      displayName: "checkout-cache",
      actionId: "scale-to-zero",
      actionLabel: "Scale to zero replicas",
      undoLabel: "Scale back to the previous replica count",
      state: "injected",
      stateBefore: "3 replicas",
      injectedAt: "2026-11-18T10:00:01.000Z",
      revertedAt: null,
      attempts: 0,
      lastError: null,
    },
  ],
  createdAt: "2026-11-17T09:00:00.000Z",
  updatedAt: "2026-11-18T10:00:00.000Z",
};

function client(gameDay: GameDay, overrides: Partial<GameDaysClient> = {}): GameDaysClient {
  return {
    listGameDays: vi.fn(async () => [gameDay]),
    getGameDay: vi.fn(async () => ({
      gameDay,
      alerts: [],
      report: computeGameDayReport(gameDay, Date.parse("2026-11-18T10:05:00.000Z")),
    })),
    listCandidates: vi.fn(async () => ({ resources: [], services: [], probes: [], slos: [] })),
    abortGameDay: vi.fn(async () => gameDay),
    ...overrides,
  };
}

describe("GameDaysPanel", () => {
  it("lists game days with how fast they were detected", async () => {
    const onChange = vi.fn();
    render(<GameDaysPanel client={client(base)} onGameDayChange={onChange} />);
    expect(await screen.findByText("Checkout without its cache")).toBeTruthy();
    expect(screen.getByText("Detected in 1 min")).toBeTruthy();
    fireEvent.click(screen.getByText("Checkout without its cache"));
    expect(onChange).toHaveBeenCalledWith("gd-1");
  });

  it("offers abort on a running game day even to a read-only client", async () => {
    const c = client(base);
    render(<GameDaysPanel client={c} gameDayId="gd-1" onGameDayChange={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Abort" }));
    await waitFor(() => expect(c.abortGameDay).toHaveBeenCalledWith("gd-1"));
    // No `game-days:run` methods: nothing else to press.
    expect(screen.queryByRole("button", { name: "End now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Arm" })).toBeNull();
  });

  it("shows the report with the detectors that did not fire", async () => {
    const done: GameDay = {
      ...base,
      status: "completed",
      endReason: "time_limit",
      undoneAt: "2026-11-18T10:15:00.000Z",
      recoveredAt: "2026-11-18T10:17:00.000Z",
      completedAt: "2026-11-18T10:17:00.000Z",
    };
    render(<GameDaysPanel client={client(done)} gameDayId="gd-1" onGameDayChange={() => {}} />);
    expect(await screen.findByText("Time to detect")).toBeTruthy();
    expect(screen.getByText("2 min")).toBeTruthy();
    expect(screen.getAllByText("Did not fire").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Abort" })).toBeNull();
  });

  it("arms only once the name is typed", async () => {
    const planned: GameDay = { ...base, status: "planned", injectedAt: null, endsAt: null };
    const armGameDay = vi.fn(async () => ({ ...planned, status: "armed" as const }));
    const c = client(planned, {
      armGameDay,
      planGameDay: vi.fn(async () => ({ steps: [], blockingFreeze: null, unmeasured: [] })),
    });
    render(<GameDaysPanel client={c} gameDayId="gd-1" onGameDayChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Arm" }));
    const confirm = await screen.findByRole("button", { name: "Arm game day" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: planned.name } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(armGameDay).toHaveBeenCalledWith("gd-1", planned.name));
  });
});
