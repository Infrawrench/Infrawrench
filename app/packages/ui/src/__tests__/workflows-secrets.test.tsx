import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { overlaySecretTypings, WorkflowsPanel } from "../workflows/WorkflowsPanel.js";
import type { WorkflowClient, WorkflowSecretSummary, WorkflowSummary } from "../workflows/types.js";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
}));

vi.mock("@monaco-editor/react", () => ({
  default: () => <div data-testid="workflow-editor" />,
}));

const workflow: WorkflowSummary = {
  id: "w1",
  name: "Deploy",
  source: "infra.log('ok')",
  trigger: { kind: "manual" },
  metricDefs: [],
  assignedSecretIds: [],
  enabled: true,
};

function makeClient() {
  let secrets: WorkflowSecretSummary[] = [{ id: "s1", name: "API_TOKEN", hasValue: true }];
  return {
    list: vi.fn(async () => [workflow]),
    create: vi.fn(),
    update: vi.fn(async (_id, body) => ({ ...workflow, ...body })),
    remove: vi.fn(),
    getTypings: vi.fn(async () => "interface InfraApi {}"),
    run: vi.fn(),
    listRuns: vi.fn(async () => []),
    listMetrics: vi.fn(async () => []),
    getAssignedSecrets: vi.fn(async () => ({ assignedSecretIds: [], secrets: [] })),
    listSecrets: vi.fn(async () => secrets),
    upsertSecret: vi.fn(async ({ id, name }) => {
      const saved = { id: id ?? "s2", name, hasValue: true };
      secrets = [...secrets.filter((secret) => secret.id !== saved.id), saved];
      return saved;
    }),
    deleteSecret: vi.fn(async (id) => {
      secrets = secrets.filter((secret) => secret.id !== id);
    }),
  } satisfies WorkflowClient;
}

describe("WorkflowsPanel secrets", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("assigns reusable secrets and saves their ids", async () => {
    const client = makeClient();
    render(<WorkflowsPanel client={client} />);

    fireEvent.click(await screen.findByText("Deploy"));
    const assignment = await screen.findByRole("checkbox", { name: /API_TOKEN/ });
    fireEvent.click(assignment);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(client.update).toHaveBeenCalledWith(
        "w1",
        expect.objectContaining({ assignedSecretIds: ["s1"] }),
      ),
    );
  });

  it("overlays only assigned names as readonly Monaco typings", () => {
    const dts = overlaySecretTypings("interface InfraApi {}", [
      { id: "s1", name: "API_TOKEN", hasValue: true },
      { id: "s2", name: "stripe.apiKey", hasValue: true },
    ]);
    expect(dts).toContain("readonly API_TOKEN: string;");
    expect(dts).toContain("readonly stripe: {");
    expect(dts).toContain("readonly apiKey: string;");
    expect(dts).toContain("readonly secrets: InfraSecrets;");
  });

  it("fails closed when legacy secret paths collide", () => {
    const dts = overlaySecretTypings("interface InfraApi {}", [
      { id: "s1", name: "stripe", hasValue: true },
      { id: "s2", name: "stripe.apiKey", hasValue: true },
    ]);
    expect(dts).toContain("readonly stripe: never;");
    expect(dts).not.toContain("readonly stripe: {");
  });

  it("creates with a labelled password field and clears the write-only value", async () => {
    const client = makeClient();
    render(<WorkflowsPanel client={client} />);

    fireEvent.click(await screen.findByText("Deploy"));
    const name = await screen.findByLabelText("Name");
    const value = screen.getByLabelText("Initial value");
    fireEvent.change(name, { target: { value: "NEW_TOKEN" } });
    fireEvent.change(value, { target: { value: "write-only" } });
    fireEvent.click(screen.getByRole("button", { name: "Add and assign" }));

    await waitFor(() =>
      expect(client.upsertSecret).toHaveBeenCalledWith({
        name: "NEW_TOKEN",
        value: "write-only",
      }),
    );
    expect(value).toHaveValue("");
    expect(await screen.findByText("NEW_TOKEN")).toBeInTheDocument();
  });
});
