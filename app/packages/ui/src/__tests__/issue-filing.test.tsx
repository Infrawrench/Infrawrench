import { beforeAll, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

beforeAll(() => {
  // jsdom doesn't implement <dialog> showModal/close — stub them, the way
  // cost-reports-panel.test.tsx does. FileIssueModal renders through Modal.
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
import type { JiraIntegration, LinearIntegration } from "@infrawrench/client-core";
import { FileIssueButton } from "../issue-filing/FileIssueButton.js";
import { IssueFilingProvider, type IssueFilingApi } from "../issue-filing/host.js";

/**
 * The tracker-aware filing affordance has four configuration states — no
 * tracker, Jira only, Linear only, both — and the button's label and modal
 * behaviour are the whole contract: a wrong label advertises a tracker the
 * org doesn't have, and a missing "already filed" badge is how duplicates get
 * filed. These tests pin each state, plus the badge behaviour when one or
 * both trackers hold a link.
 */

const JIRA_INTEGRATION: JiraIntegration = {
  siteUrl: "https://acme.atlassian.net",
  accountEmail: "ops@acme.com",
  tokenHint: "…a7f2",
  defaultProjectKey: "OPS",
  defaultIssueTypeId: "10004",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const LINEAR_INTEGRATION: LinearIntegration = {
  keyHint: "…b9c1",
  defaultTeamId: "team-1",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

interface ApiState {
  jira?: JiraIntegration | null;
  linear?: LinearIntegration | null;
  jiraLinks?: unknown[];
  linearLinks?: unknown[];
}

function makeApi(state: ApiState): IssueFilingApi {
  return {
    async get<T>(path: string): Promise<T> {
      if (path.endsWith("/jira")) return { integration: state.jira ?? null } as T;
      if (path.endsWith("/jira/links")) return (state.jiraLinks ?? []) as T;
      if (path.endsWith("/linear")) return { integration: state.linear ?? null } as T;
      if (path.endsWith("/linear/links")) return (state.linearLinks ?? []) as T;
      throw new Error(`unexpected GET ${path}`);
    },
    async post<T>(): Promise<T> {
      throw new Error("not under test");
    },
  };
}

function renderButton(
  state: ApiState,
  caps: Partial<{ jiraWrite: boolean; linearWrite: boolean }> = {},
) {
  return render(
    <IssueFilingProvider
      orgId="org-1"
      api={makeApi(state)}
      canReadJira
      canFileJira={caps.jiraWrite ?? true}
      canReadLinear
      canFileLinear={caps.linearWrite ?? true}
      openExternal={() => {}}
    >
      <FileIssueButton
        sourceKind="cost_anomaly"
        sourceId="anom-1"
        draft={{ title: "EC2 spend up 240% on 2026-08-06" }}
      />
    </IssueFilingProvider>,
  );
}

function jiraLink(overrides: Record<string, unknown> = {}) {
  return {
    id: "l1",
    sourceKind: "cost_anomaly",
    sourceId: "anom-1",
    issueKey: "OPS-412",
    issueUrl: "https://acme.atlassian.net/browse/OPS-412",
    createdByUserId: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

function linearLink(overrides: Record<string, unknown> = {}) {
  return {
    id: "l2",
    sourceKind: "cost_anomaly",
    sourceId: "anom-1",
    issueIdentifier: "ENG-123",
    issueUrl: "https://linear.app/acme/issue/ENG-123",
    createdByUserId: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("FileIssueButton", () => {
  it("renders nothing outside a provider", () => {
    const { container } = render(
      <FileIssueButton sourceKind="cost_anomaly" sourceId="anom-1" draft={{ title: "t" }} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when no tracker is connected", async () => {
    const { container } = renderButton({});
    // The provider settles async; the button must stay empty throughout.
    await waitFor(() => expect(container.querySelector("button")).toBeNull());
  });

  it('offers "File in Jira" when only Jira is connected', async () => {
    renderButton({ jira: JIRA_INTEGRATION });
    expect(await screen.findByText("File in Jira")).toBeTruthy();
  });

  it('offers "File in Linear" when only Linear is connected', async () => {
    renderButton({ linear: LINEAR_INTEGRATION });
    expect(await screen.findByText("File in Linear")).toBeTruthy();
  });

  it('offers "File an issue" with a tracker choice in the modal when both are connected', async () => {
    renderButton({ jira: JIRA_INTEGRATION, linear: LINEAR_INTEGRATION });
    const button = await screen.findByText("File an issue");
    fireEvent.click(button);

    // The modal opens on the tracker choice, not on either tracker's form.
    expect(await screen.findByRole("radio", { name: "Jira" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Linear" })).toBeTruthy();
  });

  /** Both connected, but the caller can only write one ⇒ single-tracker label. */
  it("falls back to the single-tracker label when only one write permission is held", async () => {
    renderButton({ jira: JIRA_INTEGRATION, linear: LINEAR_INTEGRATION }, { jiraWrite: false });
    expect(await screen.findByText("File in Linear")).toBeTruthy();
  });

  it("renders nothing when trackers are connected but no write permission is held", async () => {
    const { container } = renderButton(
      { jira: JIRA_INTEGRATION, linear: LINEAR_INTEGRATION },
      { jiraWrite: false, linearWrite: false },
    );
    await waitFor(() => expect(container.querySelector("button")).toBeNull());
  });

  it("shows the Jira badge instead of the button once filed to Jira", async () => {
    renderButton({ jira: JIRA_INTEGRATION, jiraLinks: [jiraLink()] });
    expect(await screen.findByText("OPS-412")).toBeTruthy();
    expect(screen.queryByText("File in Jira")).toBeNull();
  });

  it("shows the Linear badge once filed to Linear", async () => {
    renderButton({ linear: LINEAR_INTEGRATION, linearLinks: [linearLink()] });
    expect(await screen.findByText("ENG-123")).toBeTruthy();
    expect(screen.queryByText("File in Linear")).toBeNull();
  });

  it("shows both badges when the finding was filed to both trackers", async () => {
    renderButton({
      jira: JIRA_INTEGRATION,
      linear: LINEAR_INTEGRATION,
      jiraLinks: [jiraLink()],
      linearLinks: [linearLink()],
    });
    expect(await screen.findByText("OPS-412")).toBeTruthy();
    expect(screen.getByText("ENG-123")).toBeTruthy();
    expect(screen.queryByText("File an issue")).toBeNull();
  });

  /**
   * A link in one tracker suppresses the second offer entirely — filing the
   * same finding into the other tracker as well is not a flow the row offers
   * (the badge is the row's whole answer), matching the pre-Linear behaviour.
   */
  it("offers no button while any tracker holds a link", async () => {
    renderButton({
      jira: JIRA_INTEGRATION,
      linear: LINEAR_INTEGRATION,
      jiraLinks: [jiraLink()],
    });
    expect(await screen.findByText("OPS-412")).toBeTruthy();
    expect(screen.queryByText("File an issue")).toBeNull();
  });
});
