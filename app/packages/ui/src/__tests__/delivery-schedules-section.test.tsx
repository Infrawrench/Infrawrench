import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { DeliverySchedulesSection } from "../delivery/DeliverySchedulesSection.js";
import { DashboardExportActions } from "../delivery/DashboardExportActions.js";
import { ReportDeliverySection } from "../cost-reports/ReportDeliverySection.js";
import type {
  DashboardExportClient,
  DeliverySchedule,
  DeliverySchedulesClient,
} from "../delivery/types.js";
import type { CostReportsClient } from "../cost-reports/types.js";

beforeAll(() => {
  // jsdom doesn't implement <dialog> showModal/close; the editor renders
  // through Modal.
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

afterEach(() => {
  vi.restoreAllMocks();
});

function schedule(overrides: Partial<DeliverySchedule> = {}): DeliverySchedule {
  return {
    id: "n1",
    cadence: "weekly",
    sendDay: 1,
    sendDayOfMonth: 1,
    hour: 8,
    timezone: "UTC",
    slackChannelIds: ["s1"],
    teamsWebhookIds: [],
    emailRecipients: ["a@example.com"],
    enabled: true,
    nextSendAt: null,
    lastSentAt: null,
    lastStatus: null,
    lastError: null,
    createdByUserId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

const COPY = { description: "Describes a send.", editorDescription: "Describes the editor." };
const TARGETS = {
  slackChannels: [{ id: "s1", label: "#finance" }],
  teamsWebhooks: [],
  emailAvailable: true,
};

function manageClient(rows: DeliverySchedule[]): Required<DeliverySchedulesClient> {
  return {
    list: vi.fn(async () => rows),
    targets: vi.fn(async () => TARGETS),
    create: vi.fn(async () => rows[0] ?? schedule()),
    update: vi.fn(async () => rows[0] ?? schedule()),
    remove: vi.fn(async () => {}),
    sendNow: vi.fn(async () => ({ attempted: 1, succeeded: 1, failures: [] })),
  } as unknown as Required<DeliverySchedulesClient>;
}

describe("DeliverySchedulesSection", () => {
  it("renders read-only without the manage half", async () => {
    const list = vi.fn(async () => [schedule()]);
    render(<DeliverySchedulesSection client={{ list }} copy={COPY} />);
    expect(await screen.findByText(/To /)).toBeTruthy();
    expect(screen.queryByText("New schedule")).toBeNull();
    expect(screen.queryByText("Send now")).toBeNull();
  });

  it("shows the PDF hint on rows only where PDFs are supported", async () => {
    const client = { list: vi.fn(async () => [schedule({ attachPdf: true })]) };
    const { unmount } = render(<DeliverySchedulesSection client={client} copy={COPY} />);
    await screen.findByText(/To /);
    expect(screen.queryByText(/PDF attached/)).toBeNull();
    unmount();
    render(<DeliverySchedulesSection client={client} copy={COPY} supportsPdf />);
    expect(await screen.findByText(/PDF attached/)).toBeTruthy();
  });

  it("creates a schedule with attachPdf defaulting on when PDFs are supported", async () => {
    const client = manageClient([]);
    render(<DeliverySchedulesSection client={client} copy={COPY} supportsPdf />);
    fireEvent.click(await screen.findByText("New schedule"));
    const attach = (await screen.findByLabelText("Attach PDF")) as HTMLInputElement;
    expect(attach.checked).toBe(true);
    fireEvent.click(attach);
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() => expect(client.create).toHaveBeenCalled());
    expect(vi.mocked(client.create).mock.calls[0]?.[0]).toMatchObject({ attachPdf: false });
  });

  it("never sends attachPdf for a host without PDF support", async () => {
    const client = manageClient([]);
    render(<DeliverySchedulesSection client={client} copy={COPY} />);
    fireEvent.click(await screen.findByText("New schedule"));
    expect(screen.queryByLabelText("Attach PDF")).toBeNull();
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() => expect(client.create).toHaveBeenCalled());
    expect(vi.mocked(client.create).mock.calls[0]?.[0]).not.toHaveProperty("attachPdf");
  });

  it("says when the PDF missed a Slack channel after Send now", async () => {
    const client = manageClient([schedule({ attachPdf: true })]);
    vi.mocked(client.sendNow).mockResolvedValue({
      attempted: 2,
      succeeded: 2,
      failures: [],
      pdfAttached: true,
      slackFilesUploaded: 0,
    } as never);
    render(<DeliverySchedulesSection client={client} copy={COPY} supportsPdf />);
    fireEvent.click(await screen.findByText("Send now"));
    expect(await screen.findByText(/reconnect Slack/)).toBeTruthy();
  });
});

describe("ReportDeliverySection", () => {
  it("renders nothing when the host has no schedules client", () => {
    const { container } = render(
      <ReportDeliverySection reportId="r1" client={{} as unknown as CostReportsClient} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("binds every call to the report id", async () => {
    const listReportNotifications = vi.fn(async () => []);
    render(
      <ReportDeliverySection
        reportId="r1"
        client={{ listReportNotifications } as unknown as CostReportsClient}
      />,
    );
    await waitFor(() => expect(listReportNotifications).toHaveBeenCalledWith("r1"));
    expect(screen.getByText("Delivery")).toBeTruthy();
  });
});

describe("DashboardExportActions", () => {
  it("renders nothing for a host without the endpoints", () => {
    const { container } = render(
      <DashboardExportActions dashboardId="d1" dashboardName="Prod" client={{}} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("downloads through the host and opens the schedule dialog", async () => {
    const client: DashboardExportClient = {
      downloadPdf: vi.fn(async () => {}),
      listNotifications: vi.fn(async () => []),
    };
    render(<DashboardExportActions dashboardId="d1" dashboardName="Prod" client={client} />);
    fireEvent.click(screen.getByText("Download PDF"));
    await waitFor(() => expect(client.downloadPdf).toHaveBeenCalledWith("d1", "Prod"));
    fireEvent.click(screen.getByText("Schedule delivery"));
    await waitFor(() => expect(client.listNotifications).toHaveBeenCalledWith("d1"));
    expect(screen.getByText("Scheduled delivery")).toBeTruthy();
    // Read-only: no create without the manage half.
    expect(screen.queryByText("New schedule")).toBeNull();
  });
});
