import { describe, expect, it } from "vitest";
import { sanitizeGitConfigForAgentVm } from "../agent-gitconfig";

describe("sanitizeGitConfigForAgentVm", () => {
  it("keeps identity, aliases, and URL rewrites", () => {
    const input = [
      "[user]",
      "\tname = Astrid Gealer",
      "\temail = astrid@example.com",
      '[url "ssh://git@github.com/"]',
      "\tinsteadOf = https://github.com/",
      "[alias]",
      "\tco = checkout",
    ].join("\n");
    const out = sanitizeGitConfigForAgentVm(input);
    expect(out).toContain("name = Astrid Gealer");
    expect(out).toContain("email = astrid@example.com");
    expect(out).toContain("insteadOf = https://github.com/");
    expect(out).toContain("co = checkout");
    expect(out).toContain("# Synced from the local ~/.gitconfig by Infrawrench.");
  });

  it("drops gpg and credential sections including subsections", () => {
    const input = [
      "[user]",
      "\tname = A",
      "[gpg]",
      "\tformat = ssh",
      '[gpg "ssh"]',
      "\tallowedSignersFile = ~/.ssh/allowed_signers",
      "[credential]",
      "\thelper = osxkeychain",
      '[credential "https://github.com"]',
      "\thelper = gh auth git-credential",
      "[core]",
      "\teditor = vim",
    ].join("\n");
    const out = sanitizeGitConfigForAgentVm(input);
    expect(out).toContain("name = A");
    expect(out).toContain("editor = vim");
    expect(out).not.toContain("osxkeychain");
    expect(out).not.toContain("format = ssh");
    expect(out).not.toContain("allowedSignersFile");
    expect(out).not.toContain("gh auth git-credential");
  });

  it("drops signing keys wherever they appear", () => {
    const input = [
      "[user]",
      "\tname = A",
      "\tsigningkey = ABCDEF123",
      "[commit]",
      "\tgpgsign = true",
      "[tag]",
      "\ttagsign = true",
    ].join("\n");
    const out = sanitizeGitConfigForAgentVm(input);
    expect(out).toContain("name = A");
    expect(out).not.toContain("signingkey");
    expect(out).not.toContain("gpgsign");
    expect(out).not.toContain("tagsign");
    // Empty section headers left behind are harmless to git.
    expect(out).toContain("[commit]");
  });
});
