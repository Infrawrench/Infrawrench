import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import type { PeerPaneResource, PeerPaneResourceGroup } from "@infrawrench/plugin-base";
import { PeerPaneView } from "../components/detail/PeerPaneView.js";
import type { PeerPaneData } from "../components/detail/detail-types.js";

function ns(name: string, subtitle: string, system = false): PeerPaneResource {
  return {
    id: `acct:k8s-namespace:${name}`,
    pluginId: "kubernetes",
    resourceTypeId: "k8s-namespace",
    displayName: name,
    subtitle,
    status: "healthy",
    fields: { name, phase: "Active", system: system ? "true" : "false" },
    namespace: name,
  };
}

function pod(name: string, namespace: string): PeerPaneResource {
  return {
    id: `acct:k8s-pod:${namespace}/${name}`,
    pluginId: "kubernetes",
    resourceTypeId: "k8s-pod",
    displayName: name,
    subtitle: `${namespace} · nginx:1.27`,
    status: "healthy",
    fields: { name, namespace },
    namespace,
  };
}

/**
 * A cluster with two workload-bearing namespaces and one control-plane
 * namespace. The workload listers hide `kube-system`, so no pod here reports
 * it, which is exactly why the pane must not offer or count it.
 */
function paneData(groups?: PeerPaneResourceGroup[]): PeerPaneData {
  return {
    tabLabel: "Kubernetes",
    pluginLogoSvg: "<svg />",
    credentials: {},
    schema: {
      resourceGroups: groups ?? [
        {
          title: "Namespaces (3) · by cost",
          resourceTypeId: "k8s-namespace",
          pluginId: "kubernetes",
          role: "namespace",
          items: [
            ns("payments", "Active · ~$4.20/day · 18% CPU"),
            ns("web", "Active · ~$1.10/day · 62% mem"),
            ns("kube-system", "Active · ~$0.90/day", true),
          ],
        },
        {
          title: "Pods (2)",
          resourceTypeId: "k8s-pod",
          pluginId: "kubernetes",
          items: [pod("api-0", "payments"), pod("frontend-0", "web")],
        },
      ],
    },
  };
}

function renderPane(data: PeerPaneData = paneData()) {
  return render(
    <DndContext>
      <PeerPaneView
        pane={data}
        accountId="acct"
        parentResourceId="acct:k8s-cluster:default"
        onOpenPill={vi.fn()}
      />
    </DndContext>,
  );
}

describe("PeerPaneView namespace grid", () => {
  it("renders each namespace's subtitle — the cost and efficiency figures", () => {
    renderPane();
    expect(screen.getByText("Active · ~$4.20/day · 18% CPU")).toBeInTheDocument();
    expect(screen.getByText("Active · ~$1.10/day · 62% mem")).toBeInTheDocument();
  });

  it("keeps the subtitle inside the namespace's own pill", () => {
    renderPane();
    const pill = screen.getByRole("button", { name: /^payments/ });
    expect(pill).toHaveTextContent("payments");
    expect(pill).toHaveTextContent("Active · ~$4.20/day · 18% CPU");
  });

  it("does not double-count a title whose count precedes an ordering suffix", () => {
    renderPane();
    expect(screen.queryByText(/by cost \(\d+\)/)).toBeNull();
    expect(screen.getByRole("heading", { name: /Namespaces/ })).toHaveTextContent(
      "Namespaces (2) · by cost",
    );
  });

  it("counts only the namespaces it draws — kube-system is neither shown nor counted", () => {
    renderPane();
    expect(screen.queryByRole("button", { name: /kube-system/ })).toBeNull();
    // Two namespace pills drawn, and the header says two.
    expect(screen.getByRole("heading", { name: /Namespaces/ })).toHaveTextContent("(2)");
    expect(screen.getByRole("button", { name: /^payments/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^web/ })).toBeInTheDocument();
  });

  it("offers a port forward only on a group that declares the service role", () => {
    const service = {
      ...pod("api", "payments"),
      fields: { namespace: "payments", hasSelector: "true" },
    };
    const groups = (role?: "service") => [
      {
        title: "Services (1)",
        resourceTypeId: "any-type",
        pluginId: "any-plugin",
        ...(role ? { role } : {}),
        items: [service],
      },
    ];
    const portForward = {
      entries: [],
      starting: null,
      error: null,
      onStart: vi.fn(),
      onStop: vi.fn(),
    };
    const renderGroups = (data: PeerPaneData) =>
      render(
        <DndContext>
          <PeerPaneView
            pane={data}
            accountId="acct"
            parentResourceId="acct:k8s-cluster:default"
            onOpenPill={vi.fn()}
            portForward={portForward}
          />
        </DndContext>,
      );

    const plain = renderGroups(paneData(groups()));
    expect(screen.queryByRole("button", { name: "Port forward" })).toBeNull();
    plain.unmount();

    renderGroups(paneData(groups("service")));
    expect(screen.getByRole("button", { name: "Port forward" })).toBeInTheDocument();
  });

  it("appends a count to a group title that carries none", () => {
    const data = paneData([
      {
        title: "Tables",
        resourceTypeId: "pg-table",
        pluginId: "postgres",
        items: [pod("users", "public")],
      },
    ]);
    renderPane(data);
    expect(screen.getByRole("heading", { name: /Tables/ })).toHaveTextContent("Tables (1)");
  });
});
