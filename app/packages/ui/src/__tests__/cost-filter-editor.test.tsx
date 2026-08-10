import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CostFilterEditor } from "../cost/CostGraphConfigModal.js";
import type { CostFilter } from "../cost/config.js";
import type { CostApi } from "../cost/types.js";

function makeApi(): CostApi {
  return {
    queryCosts: vi.fn(async () => ({ series: [], currencies: [], totals: {} })),
    loadDimensionValues: vi.fn(async () => []),
    loadCostStatus: vi.fn(async () => []),
  } as unknown as CostApi;
}

/**
 * The editor is controlled; the host owns the filters and the "is the query
 * broken" flag it uses to block Save.
 */
function Harness({
  api,
  onErrorChange,
  initial = [],
}: {
  api: CostApi;
  onErrorChange: (error: string | null) => void;
  initial?: CostFilter[];
}) {
  const [filters, setFilters] = useState<CostFilter[]>(initial);
  return (
    <CostFilterEditor
      filters={filters}
      onChange={setFilters}
      api={api}
      onErrorChange={onErrorChange}
    />
  );
}

describe("CostFilterEditor error reporting", () => {
  it("says nothing to the host on mount", async () => {
    const onErrorChange = vi.fn();
    render(<Harness api={makeApi()} onErrorChange={onErrorChange} />);

    expect(await screen.findByText("+ Add filter")).toBeInTheDocument();
    // The rows can't produce a query error, so there is nothing to report yet —
    // and reporting it from an effect would re-render the host for nothing.
    expect(onErrorChange).not.toHaveBeenCalled();
  });

  it("reports a broken query as it is typed and clears it when it parses", async () => {
    const api = makeApi();
    const onErrorChange = vi.fn();
    render(<Harness api={api} onErrorChange={onErrorChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Query" }));
    const textarea = screen.getByLabelText("Cost filter query");
    expect(onErrorChange).toHaveBeenLastCalledWith(null);

    fireEvent.change(textarea, { target: { value: "provider =" } });
    expect(onErrorChange).toHaveBeenLastCalledWith(expect.any(String));
    // Blocked, not lossy: the rows only hold the last query that parsed.
    expect(screen.getByRole("button", { name: "Rows" })).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "provider = 'aws'" } });
    expect(onErrorChange).toHaveBeenLastCalledWith(null);

    const rowsTab = screen.getByRole("button", { name: "Rows" });
    expect(rowsTab).toBeEnabled();
    fireEvent.click(rowsTab);

    await waitFor(() => expect(screen.getByText("+ Add filter")).toBeInTheDocument());
    expect(onErrorChange).toHaveBeenLastCalledWith(null);
  });

  it("keeps a failed switch-to-text error until the filter itself is fixed", async () => {
    const api = makeApi();
    const onErrorChange = vi.fn();
    render(
      <Harness
        api={api}
        onErrorChange={onErrorChange}
        // A tag filter with no key can't be written as a query at all.
        initial={[{ dimension: "tag", op: "in", values: ["prod"] }]}
      />,
    );

    expect(await screen.findByLabelText("Tag key")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Query" }));

    // Still in rows mode, with the error standing so the host keeps Save blocked.
    expect(screen.queryByLabelText("Cost filter query")).not.toBeInTheDocument();
    expect(onErrorChange).toHaveBeenLastCalledWith(expect.stringContaining("tag filter"));

    // Clicking the tab you are already on must not swallow it.
    fireEvent.click(screen.getByRole("button", { name: "Rows" }));
    expect(onErrorChange).toHaveBeenLastCalledWith(expect.stringContaining("tag filter"));
    expect(screen.getByText(/tag filter/)).toBeInTheDocument();
  });
});
