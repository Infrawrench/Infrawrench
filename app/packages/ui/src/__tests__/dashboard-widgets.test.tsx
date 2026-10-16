import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import type { DashboardKpiResult, KpiWidgetConfig } from "@infrawrench/client-core";
import { DashboardGridCard } from "../dashboard-widgets/DashboardGridCard.js";
import { KpiWidgetCard } from "../dashboard-widgets/KpiWidgetCard.js";
import { TextWidgetCard } from "../dashboard-widgets/TextWidgetCard.js";

const config: KpiWidgetConfig = {
  version: 1,
  source: { kind: "cost_report", reportId: "r1", measure: "cost", aggregation: "sum" },
  comparePreviousPeriod: true,
};

function result(patch: Partial<DashboardKpiResult> = {}): DashboardKpiResult {
  return {
    value: 1500,
    unit: "count",
    previous: 1000,
    change: 500,
    changePercent: 50,
    upIsGood: false,
    sourceName: "AWS spend",
    ...patch,
  };
}

describe("KpiWidgetCard", () => {
  it("shows the figure and colours a rise in spend as bad news", async () => {
    const evaluate = vi.fn(() => Promise.resolve(result()));
    render(<KpiWidgetCard title="" config={config} evaluate={evaluate} />);
    expect(await screen.findByText("1,500")).toBeTruthy();
    const badge = screen.getByText(/\+500 \(\+50\.0%\)/);
    expect(badge.className).toContain("text-danger");
    // Colour is not the only signal.
    expect(screen.getByText("a deterioration")).toBeTruthy();
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("colours the same rise as good news when up is good", async () => {
    render(
      <KpiWidgetCard
        title="Savings"
        config={config}
        evaluate={() => Promise.resolve(result({ upIsGood: true }))}
      />,
    );
    const badge = await screen.findByText(/\+500/);
    expect(badge.className).toContain("text-success");
  });

  it("puts an evaluation error in place", async () => {
    render(
      <KpiWidgetCard
        title="Spend"
        config={config}
        evaluate={() => Promise.reject(new Error("This saved report was deleted"))}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/deleted/);
  });

  it("says where KPIs are measured when the host cannot evaluate them", () => {
    render(<KpiWidgetCard title="Spend" config={config} />);
    expect(screen.getByText(/measured in Infrawrench Cloud/)).toBeTruthy();
  });
});

describe("TextWidgetCard", () => {
  it("renders markdown without raw HTML", () => {
    render(
      <TextWidgetCard
        title="Notes"
        config={{
          version: 1,
          markdown: "## Heading\n\n<b>raw</b> and [a link](https://example.com)",
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Heading" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "a link" }).getAttribute("target")).toBe("_blank");
    expect(document.querySelector("b")).toBeNull();
  });
});

describe("DashboardGridCard", () => {
  function renderCard(onResize = vi.fn(), onDuplicate = vi.fn()) {
    render(
      <DndContext>
        <SortableContext items={["dashboard-card:widget:w1"]}>
          <DashboardGridCard
            id="widget:w1"
            size={{ w: 1, h: 1 }}
            columns={4}
            label="Spend"
            onResize={onResize}
            onDuplicate={onDuplicate}
          >
            <div>card body</div>
          </DashboardGridCard>
        </SortableContext>
      </DndContext>,
    );
    return { onResize, onDuplicate };
  }

  it("spans its stored size", () => {
    renderCard();
    const item = screen.getByText("card body").closest("[style]") as HTMLElement;
    expect(item.style.gridColumn).toBe("span 1");
    expect(item.style.gridRow).toBe("span 1");
  });

  it("resizes one track per arrow key from the handle", async () => {
    const { onResize } = renderCard();
    const handle = screen.getByRole("button", { name: /Resize Spend/ });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onResize).toHaveBeenCalledWith({ w: 2, h: 1 });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(onResize).toHaveBeenLastCalledWith({ w: 1, h: 2 });
    // Ours, not dnd-kit's own live region.
    await waitFor(() =>
      expect(
        screen.getAllByRole("status").some((el) => /rows tall/.test(el.textContent ?? "")),
      ).toBe(true),
    );
  });

  it("does not resize past the bounds", () => {
    const { onResize } = renderCard();
    fireEvent.keyDown(screen.getByRole("button", { name: /Resize Spend/ }), { key: "ArrowLeft" });
    expect(onResize).not.toHaveBeenCalled();
  });

  it("duplicates from its own button", () => {
    const { onDuplicate } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Spend" }));
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });
});
