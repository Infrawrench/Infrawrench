import { beforeAll, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

beforeAll(() => {
  // jsdom doesn't implement <dialog> showModal/close — stub them, the way
  // issue-filing.test.tsx does. The export editor renders through Modal.
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

import { CostExportsSection, parseNumericInputValue } from "../settings/CostExportsSection.js";
import { SettingsHostProvider, type SettingsHostValue } from "../settings/host.js";

/**
 * The restatement window is a number the user types, and `Number("")` is `0`.
 * Zero is a real setting here — "never re-export a period" — so a field
 * cleared mid-edit coercing to it would quietly turn restatement off in the
 * request body without anybody asking for that. These tests pin the guard on
 * both sides: the parse helper, and the wiring that decides what gets saved.
 */

describe("parseNumericInputValue", () => {
  it("rejects the values a cleared or half-typed field produces", () => {
    expect(parseNumericInputValue("")).toBeNull();
    expect(parseNumericInputValue("   ")).toBeNull();
    expect(parseNumericInputValue("-")).toBeNull();
    expect(parseNumericInputValue("abc")).toBeNull();
    expect(parseNumericInputValue("1e")).toBeNull();
  });

  it("accepts real numbers, zero included", () => {
    expect(parseNumericInputValue("0")).toBe(0);
    expect(parseNumericInputValue("7")).toBe(7);
    expect(parseNumericInputValue("90")).toBe(90);
    expect(parseNumericInputValue(" 14 ")).toBe(14);
  });
});

function renderSection(posted: { path?: string; body?: unknown }) {
  const host = {
    orgId: "org-1",
    api: {
      async get<T>(): Promise<T> {
        return [] as T;
      },
      async post<T>(path: string, body?: unknown): Promise<T> {
        posted.path = path;
        posted.body = body;
        return {} as T;
      },
      async put<T>(): Promise<T> {
        return {} as T;
      },
      async patch<T>(): Promise<T> {
        return {} as T;
      },
      async delete<T>(): Promise<T> {
        return {} as T;
      },
    },
    has: () => true,
    hasAny: () => true,
    permissionsLoading: false,
    async refreshPermissions() {},
    async fetchText() {
      return "";
    },
    openWorkspace() {},
    openSection() {},
    openExternal() {},
    onAccountDeleted() {},
    approvals: {},
  } as unknown as SettingsHostValue;

  return render(
    <SettingsHostProvider value={host}>
      <CostExportsSection />
    </SettingsHostProvider>,
  );
}

describe("CostExportsSection restatement window", () => {
  it("keeps the previous window when the field is cleared, and never saves 0 by accident", async () => {
    const posted: { path?: string; body?: unknown } = {};
    renderSection(posted);

    fireEvent.click(await screen.findByRole("button", { name: "New export" }));

    const days = (await screen.findByLabelText("Days")) as HTMLInputElement;
    expect(days.value).toBe("7");

    // Clearing the field to retype it must not be read as "0 days".
    fireEvent.change(days, { target: { value: "" } });
    expect(days.value).toBe("7");

    // Nor may a half-typed value land as NaN.
    fireEvent.change(days, { target: { value: "-" } });
    expect(days.value).toBe("7");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Finance" } });
    fireEvent.click(screen.getByRole("button", { name: "Create export" }));

    await waitFor(() => expect(posted.body).toBeDefined());
    expect((posted.body as { restatementDays: number }).restatementDays).toBe(7);
  });

  it("still accepts a deliberate 0", async () => {
    const posted: { path?: string; body?: unknown } = {};
    renderSection(posted);

    fireEvent.click(await screen.findByRole("button", { name: "New export" }));
    const days = (await screen.findByLabelText("Days")) as HTMLInputElement;

    fireEvent.change(days, { target: { value: "0" } });
    expect(days.value).toBe("0");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Finance" } });
    fireEvent.click(screen.getByRole("button", { name: "Create export" }));

    await waitFor(() => expect(posted.body).toBeDefined());
    expect((posted.body as { restatementDays: number }).restatementDays).toBe(0);
  });
});
