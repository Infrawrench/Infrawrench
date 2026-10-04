import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  ProviderOptionsField,
  type CredentialFieldOption,
} from "../../components/ProviderOptionsField.js";

function Harness({
  load,
  initial = "",
}: {
  load: (() => Promise<CredentialFieldOption[]>) | undefined;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ProviderOptionsField
        fieldId="f"
        label="Usage Account"
        value={value}
        onChange={setValue}
        load={load}
        reloadKey="k"
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

describe("ProviderOptionsField", () => {
  it("is a text input until its dependencies are filled", () => {
    render(<Harness load={undefined} />);
    expect(screen.getByRole("textbox", { name: "Usage Account" })).toBeInTheDocument();
    expect(screen.getByText("Fill in the fields above to choose from a list.")).toBeInTheDocument();
  });

  it("offers the loaded options and stores the picked id", async () => {
    const load = vi.fn().mockResolvedValue([
      { id: "42", label: "Parent", description: "42" },
      { id: "7", label: "Child", description: "7" },
    ]);
    render(<Harness load={load} />);
    const select = await screen.findByRole("combobox", { name: "Usage Account" });
    await waitFor(() => expect(screen.getByText("Parent (42)")).toBeInTheDocument());
    fireEvent.change(select, { target: { value: "7" } });
    expect(screen.getByTestId("value").textContent).toBe("7");
  });

  it("picks a lone option outright", async () => {
    render(<Harness load={() => Promise.resolve([{ id: "42", label: "Parent" }])} />);
    await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("42"));
  });

  it("falls back to typing with the provider's error when loading fails", async () => {
    render(<Harness load={() => Promise.reject(new Error("New Relic rejected the key"))} />);
    expect(await screen.findByText("New Relic rejected the key")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Usage Account" }), {
      target: { value: "123" },
    });
    expect(screen.getByTestId("value").textContent).toBe("123");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
