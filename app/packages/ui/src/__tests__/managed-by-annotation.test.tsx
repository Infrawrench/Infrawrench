import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IacManagedBy } from "@infrawrench/client-core";
import { ManagedByAnnotation } from "../iac/ManagedByAnnotation.js";

const managed = (over: Partial<IacManagedBy> = {}): IacManagedBy => ({
  repository: "acme/infra",
  rootPath: "network/prod",
  workspace: "prod",
  address: "hcloud_server.web",
  url: "https://git.infrawrench.com/acme/infra/terraform/prod",
  ...over,
});

describe("ManagedByAnnotation", () => {
  it("names the repository and root that manage the resource, linking to the workspace", async () => {
    const onOpen = vi.fn();
    render(<ManagedByAnnotation load={async () => [managed()]} onOpen={onOpen} />);

    const link = await screen.findByRole("link", { name: "acme/infra (network/prod)" });
    expect(screen.getByText("Managed by")).toBeTruthy();
    expect(link.getAttribute("href")).toBe("https://git.infrawrench.com/acme/infra/terraform/prod");
    expect(link.getAttribute("title")).toBe("hcloud_server.web in the workspace prod");

    // The host decides how a link opens (a tab on web, the system browser on desktop).
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith("https://git.infrawrench.com/acme/infra/terraform/prod");
  });

  it("says so when the root is the top of the repository, and lists every workspace", async () => {
    render(
      <ManagedByAnnotation
        load={async () => [
          managed({ rootPath: "" }),
          managed({
            repository: "acme/platform",
            rootPath: "dns",
            workspace: "dns",
            url: "https://git.infrawrench.com/acme/platform/terraform/dns",
          }),
        ]}
        onOpen={() => {}}
      />,
    );
    expect(await screen.findByRole("link", { name: "acme/infra (repository root)" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "acme/platform (dns)" })).toBeTruthy();
  });

  it("renders nothing for a resource no workspace manages, or when the read fails", async () => {
    const empty = vi.fn(async () => []);
    const first = render(<ManagedByAnnotation load={empty} onOpen={() => {}} />);
    await waitFor(() => expect(empty).toHaveBeenCalled());
    expect(first.container.innerHTML).toBe("");

    const failing = vi.fn(async () => {
      throw new Error("403");
    });
    const second = render(<ManagedByAnnotation load={failing} onOpen={() => {}} />);
    await waitFor(() => expect(failing).toHaveBeenCalled());
    expect(second.container.innerHTML).toBe("");
  });
});
