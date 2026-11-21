import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { normalizeServiceRule, type Service, type ServiceMember } from "@infrawrench/client-core";
import { ServiceEditorModal } from "../services/ServiceEditorModal.js";
import type { ServiceResourceOption, ServicesClient } from "../services/types.js";

beforeAll(() => {
  // jsdom doesn't implement <dialog> showModal/close.
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

const service: Service = {
  id: "svc-1",
  name: "Checkout",
  slug: "checkout",
  description: null,
  tier: 1,
  ownerTeam: null,
  ownerUserIds: [],
  links: [],
  onCallScheduleId: null,
  sloIds: [],
  runbookIds: [],
  rules: [normalizeServiceRule({ kind: "name", nameMatch: "prefix", value: "checkout-" })],
  monthlyBudget: null,
  budgetCurrency: null,
  owners: [],
  onCallScheduleName: null,
  memberCount: 2,
  scores: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

function member(id: string, name: string, source: "manual" | "rule"): ServiceMember {
  return {
    resourceId: id,
    accountId: "a1",
    accountName: "AWS Production",
    pluginId: "aws",
    resourceTypeId: "s3-bucket",
    resourceName: name,
    externalId: null,
    source,
    ruleIndex: source === "rule" ? 0 : null,
    owner: null,
    missing: false,
  };
}

function hit(id: string, name: string, pluginId = "aws"): ServiceResourceOption {
  return {
    id,
    displayName: name,
    pluginId,
    pluginDisplayName: pluginId === "aws" ? "Amazon Web Services" : "Cloudflare",
    resourceTypeId: "s3-bucket",
    resourceTypeLabel: "S3 Bucket",
    accountId: "a1",
    accountName: "AWS Production",
  };
}

function makeClient(overrides: Partial<ServicesClient> = {}): ServicesClient {
  const fail = () => Promise.reject(new Error("unused"));
  return {
    listServices: fail,
    getService: vi.fn(async () => ({
      service,
      members: [member("m1", "checkout-assets", "manual"), member("m2", "checkout-db", "rule")],
      excluded: [member("x1", "checkout-old", "rule")],
    })),
    getServiceSummary: fail,
    getServiceScorecards: fail,
    listScorecards: fail,
    getScorecardOverview: fail,
    getOrgScorecard: fail,
    listOwnerCandidates: async () => [],
    listOnCallSchedules: async () => [],
    listSlos: async () => [],
    listRunbooks: async () => [],
    listTagKeys: async () => ({
      keys: [],
      settings: { hidden: [], preferred: [] },
      lookbackDays: 30,
      truncated: false,
    }),
    listVirtualTags: async () => [],
    listAccounts: async () => [],
    searchResources: vi.fn(async (q: string) =>
      [
        hit("m1", "checkout-assets"),
        hit("m2", "checkout-db"),
        hit("x1", "checkout-old"),
        hit("r3", "checkout-edge", "cloudflare"),
      ].filter((r) => r.displayName.includes(q)),
    ),
    createService: vi.fn(async () => ({ ...service, id: "svc-new" })),
    updateService: vi.fn(async () => service),
    addMembers: vi.fn(async () => null),
    removeMember: vi.fn(async () => null),
    restoreMember: vi.fn(async () => null),
    ...overrides,
  } as unknown as ServicesClient;
}

const row = async (name: string) =>
  (await screen.findByText(name)).closest("label") as HTMLLabelElement;
const checkbox = async (name: string) =>
  within(await row(name)).getByRole("checkbox") as HTMLInputElement;

describe("ServiceEditorModal", () => {
  it("ticks members from the search and applies the changes on Save", async () => {
    const client = makeClient();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      <ServiceEditorModal client={client} existing={service} onSaved={onSaved} onClose={onClose} />,
    );

    // Members load checked; rule members carry their rule, exclusions are unchecked.
    await waitFor(async () => expect((await checkbox("checkout-assets")).checked).toBe(true));
    expect(within(await row("checkout-db")).getByText("Rule 1")).toBeTruthy();
    expect((await checkbox("checkout-old")).checked).toBe(false);

    fireEvent.click(await checkbox("checkout-edge")); // add
    fireEvent.click(await checkbox("checkout-assets")); // remove a hand-added member
    fireEvent.click(await checkbox("checkout-db")); // exclude a rule member
    fireEvent.click(await checkbox("checkout-old")); // restore an exclusion

    expect(screen.getByText("2 to add · 2 to remove")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(client.updateService).toHaveBeenCalledWith("svc-1", expect.any(Object));
    expect(client.addMembers).toHaveBeenCalledWith("svc-1", ["r3"]);
    expect(client.removeMember).toHaveBeenCalledWith("svc-1", "m1");
    expect(client.removeMember).toHaveBeenCalledWith("svc-1", "m2");
    expect(client.restoreMember).toHaveBeenCalledWith("svc-1", "x1");
    expect(onSaved).toHaveBeenCalledWith(service);
  });

  it("adds the picked resources to a service it creates", async () => {
    const client = makeClient();
    const onClose = vi.fn();
    render(
      <ServiceEditorModal client={client} existing={null} onSaved={vi.fn()} onClose={onClose} />,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Checkout" } });
    fireEvent.click(await checkbox("checkout-edge"));
    fireEvent.click(screen.getByRole("button", { name: "Create service" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(client.getService).not.toHaveBeenCalled();
    expect(client.addMembers).toHaveBeenCalledWith("svc-new", ["r3"]);
  });

  it("keeps the dialog open with what failed, and updates rather than re-creates on retry", async () => {
    const addMembers = vi
      .fn()
      .mockRejectedValueOnce(new Error("Resource limit reached"))
      .mockResolvedValue(null);
    const client = makeClient({
      addMembers,
      updateService: vi.fn(async () => ({ ...service, id: "svc-new" })),
    });
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      <ServiceEditorModal client={client} existing={null} onSaved={onSaved} onClose={onClose} />,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Checkout" } });
    fireEvent.click(await checkbox("checkout-edge"));
    fireEvent.click(screen.getByRole("button", { name: "Create service" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Resource limit reached");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect((await checkbox("checkout-edge")).checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(client.createService).toHaveBeenCalledTimes(1);
    expect(client.updateService).toHaveBeenCalledWith("svc-new", expect.any(Object));
    expect(addMembers).toHaveBeenLastCalledWith("svc-new", ["r3"]);
  });
});
