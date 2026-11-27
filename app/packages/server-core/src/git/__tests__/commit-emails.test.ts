import { describe, expect, it, vi } from "vitest";

// The module imports the database client at load; what is under test is pure.
vi.mock("../../db/client.js", () => ({ db: {} }));

const { gitCommitEmailMessage, newGitCommitEmailCode } = await import("../commit-emails");

describe("a commit email's code", () => {
  it("is eight letters and digits nobody confuses, shown in two halves", () => {
    const codes = Array.from({ length: 200 }, () => newGitCommitEmailCode());
    for (const code of codes) expect(code).toMatch(/^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/);
    // Random: two hundred of them are two hundred different ones.
    expect(new Set(codes).size).toBe(200);
  });

  it("travels in a message that says who asked, where it counts and what to do with it", () => {
    const message = gitCommitEmailMessage({
      to: "mara@old.example",
      code: "ABCD-2345",
      organization: "Acme",
      requester: "Mara Lindqvist",
      requesterEmail: "mara@acme.example",
      forgeUrl: "https://git.infrawrench.com",
    });
    expect(message.to).toBe("mara@old.example");
    expect(message.subject).toBe("Confirm mara@old.example for commits in Acme");
    expect(message.text).toContain(
      "Mara Lindqvist (mara@acme.example) asked for commits made with mara@old.example to be shown as theirs in Acme's repositories on git.infrawrench.com.",
    );
    expect(message.text).toContain("The code is ABCD-2345");
    expect(message.text).toContain("https://git.infrawrench.com/settings/organisations");
    expect(message.text).toContain("If you did not ask for this, ignore this message.");
    // The code is in the body only: a subject is shown in notifications and lists.
    expect(message.subject).not.toContain("ABCD");
    expect(message.html).toBeUndefined();
  });

  it("says a person's own repositories, and points at their profile, when there is no organisation", () => {
    const message = gitCommitEmailMessage({
      to: "mara@old.example",
      code: "ABCD-2345",
      organization: null,
      requester: "Mara Lindqvist",
      requesterEmail: "mara@acme.example",
      forgeUrl: "https://git.infrawrench.com",
    });
    expect(message.subject).toBe("Confirm mara@old.example for commits in your own repositories");
    expect(message.text).toContain(
      "Mara Lindqvist (mara@acme.example) asked for commits made with mara@old.example to be shown as theirs in their own repositories on git.infrawrench.com.",
    );
    expect(message.text).toContain(
      "Enter it under Settings > Profile: https://git.infrawrench.com/settings\n",
    );
    expect(message.text).not.toContain("organisations");
    expect(message.subject).not.toContain("ABCD");
  });
});
