import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Repository } from "@infrawrench/git-contract";
import { EmptyRepository } from "../EmptyRepository";

const repository = {
  defaultBranch: "main",
  httpCloneUrl: "https://git.infrawrench.com/astrid/repo-testing.git",
  sshCloneUrl: "git@git.infrawrench.com:astrid/repo-testing.git",
  viewer: { canPush: true },
} as unknown as Repository;

const commands = (container: HTMLElement): string =>
  Array.from(container.querySelectorAll("pre"))
    .map((pre) => pre.textContent ?? "")
    .join("\n");

describe("EmptyRepository", () => {
  it("writes the commands with the address the HTTPS/SSH switch shows", () => {
    const { container } = render(<EmptyRepository repository={repository} />);
    expect(commands(container)).toContain(`git remote add origin ${repository.httpCloneUrl}`);
    expect(commands(container)).not.toContain(repository.sshCloneUrl);

    fireEvent.click(screen.getByRole("button", { name: "SSH" }));
    expect(commands(container)).toContain(`git remote add origin ${repository.sshCloneUrl}`);
    expect(commands(container)).not.toContain(repository.httpCloneUrl);
  });
});
