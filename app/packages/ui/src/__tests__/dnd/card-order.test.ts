import { describe, expect, it } from "vitest";
import {
  cardOrderIndex,
  dashboardCardId,
  moveDashboardCard,
  orderDashboardCards,
  parseDashboardCardId,
  type OrderableDashboardCard,
} from "../../dnd/card-order.js";

const card = (kind: OrderableDashboardCard["kind"], id: string, gridX: number) => ({
  kind,
  id,
  gridX,
});

describe("dashboardCardId", () => {
  it("round-trips through parse", () => {
    expect(parseDashboardCardId(dashboardCardId("widget", "w-1"))).toEqual({
      kind: "widget",
      id: "w-1",
    });
  });

  it("keeps colons in the id, which uuids and slugs may carry", () => {
    expect(parseDashboardCardId("resource:do:droplet:123")).toEqual({
      kind: "resource",
      id: "do:droplet:123",
    });
  });

  it("rejects ids that aren't cards", () => {
    expect(parseDashboardCardId("sidebar-dashboard:d1")).toBeNull();
    expect(parseDashboardCardId("resource")).toBeNull();
    expect(parseDashboardCardId("resource:")).toBeNull();
  });
});

describe("orderDashboardCards", () => {
  it("uses gridX once a dashboard has been reordered into one sequence", () => {
    const ordered = orderDashboardCards([
      card("widget", "w1", 0),
      card("resource", "r1", 2),
      card("workflow", "f1", 1),
    ]);
    expect(ordered.map((c) => c.id)).toEqual(["w1", "f1", "r1"]);
  });

  it("keeps the historical grouping while per-kind sequences still collide", () => {
    // Legacy shape: each table numbered from 0 independently. Sorting by gridX
    // alone would interleave cards the user never moved.
    const ordered = orderDashboardCards([
      card("widget", "w1", 0),
      card("widget", "w2", 1),
      card("resource", "r1", 0),
      card("resource", "r2", 1),
      card("workflow", "f1", 0),
    ]);
    expect(ordered.map((c) => c.id)).toEqual(["r1", "r2", "f1", "w1", "w2"]);
  });

  it("is stable for cards that tie completely", () => {
    const ordered = orderDashboardCards([
      card("resource", "b", 0),
      card("resource", "a", 0),
      card("widget", "c", 0),
    ]);
    expect(ordered.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate its input", () => {
    const input = [card("resource", "r1", 5), card("widget", "w1", 1)];
    orderDashboardCards(input);
    expect(input.map((c) => c.id)).toEqual(["r1", "w1"]);
  });
});

describe("moveDashboardCard", () => {
  const cards = [card("resource", "r1", 0), card("widget", "w1", 1), card("workflow", "f1", 2)];

  it("moves a widget between resource cards", () => {
    const next = moveDashboardCard(cards, "widget:w1", "resource:r1");
    expect(next.map((c) => c.id)).toEqual(["w1", "r1", "f1"]);
  });

  it("moves a card to the end", () => {
    const next = moveDashboardCard(cards, "resource:r1", "workflow:f1");
    expect(next.map((c) => c.id)).toEqual(["w1", "f1", "r1"]);
  });

  it("returns the same reference when nothing moves", () => {
    expect(moveDashboardCard(cards, "widget:w1", "widget:w1")).toBe(cards);
    expect(moveDashboardCard(cards, "widget:gone", "resource:r1")).toBe(cards);
  });
});

describe("cardOrderIndex", () => {
  it("maps each card id to its new position", () => {
    const index = cardOrderIndex([card("widget", "w1", 9), card("resource", "r1", 4)]);
    expect(index.get("widget:w1")).toBe(0);
    expect(index.get("resource:r1")).toBe(1);
  });
});
