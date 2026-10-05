import { beforeAll, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

beforeAll(() => {
  // jsdom doesn't implement <dialog> showModal/close: stub them, the way
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

import { CostExportsSection } from "../settings/CostExportsSection.js";
import { parseNumericInputValue } from "../form-values.js";
import { SettingsHostProvider, type SettingsHostValue } from "../settings/host.js";

/**
 * The restatement window is a number the user types, and `Number("")` is `0`.
 * Zero is a real setting here ("never re-export a period") so a field
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

const SINKS = {
  sinks: [
    {
      pluginId: "snowflake",
      displayName: "Snowflake",
      label: "Snowflake table",
      description: null,
      accounts: [{ id: "acct-sf", name: "Prod Snowflake" }],
      targetFields: [
        {
          key: "database",
          label: "Database",
          description: null,
          dependsOn: [],
          optional: false,
          allowCustom: false,
          placeholder: null,
          emptyLabel: null,
        },
        {
          key: "table",
          label: "Table",
          description: null,
          dependsOn: ["database"],
          optional: false,
          allowCustom: true,
          placeholder: null,
          emptyLabel: null,
        },
      ],
    },
  ],
};

function renderSection(posted: { path?: string; body?: unknown }, withSinks = false) {
  const host = {
    orgId: "org-1",
    api: {
      async get<T>(path: string): Promise<T> {
        if (withSinks && path.endsWith("/warehouse-sinks")) return SINKS as T;
        return [] as T;
      },
      async post<T>(path: string, body?: unknown): Promise<T> {
        if (path.endsWith("/warehouse-options")) {
          const field = (body as { field: string }).field;
          return {
            options: field === "database" ? [{ id: "ANALYTICS", label: "ANALYTICS" }] : [],
          } as T;
        }
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

describe("CostExportsSection warehouse destination", () => {
  it("picks the account and target from the provider and sends no credential", async () => {
    const posted: { path?: string; body?: unknown } = {};
    renderSection(posted, true);

    fireEvent.click(await screen.findByRole("button", { name: "New export" }));
    fireEvent.click(await screen.findByRole("button", { name: "Snowflake table" }));

    // The only connected account is chosen for the user.
    const database = (await screen.findByLabelText("Database")) as HTMLSelectElement;
    await waitFor(() => expect(database.tagName).toBe("SELECT"));
    await screen.findByRole("option", { name: "ANALYTICS" });
    fireEvent.change(database, { target: { value: "ANALYTICS" } });
    const table = (await screen.findByLabelText("Table")) as HTMLInputElement;
    await waitFor(() => expect(table.disabled).toBe(false));
    fireEvent.change(table, { target: { value: "COSTS" } });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Finance" } });
    fireEvent.click(screen.getByRole("button", { name: "Create export" }));

    await waitFor(() => expect(posted.body).toBeDefined());
    const body = posted.body as Record<string, unknown>;
    expect(body["destination"]).toEqual({
      kind: "warehouse",
      pluginId: "snowflake",
      accountId: "acct-sf",
      target: { database: "ANALYTICS", table: "COSTS" },
    });
    expect(body).not.toHaveProperty("accessKeyId");
    expect(body).not.toHaveProperty("url");
  });
});
