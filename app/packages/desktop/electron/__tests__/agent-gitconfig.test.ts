import { describe, expect, it } from "vitest";
import { sanitizeGitConfigForAgentVm } from "../agent-gitconfig";

describe("sanitizeGitConfigForAgentVm", () => {
  it("keeps identity and aliases", () => {
    const input = [
      "[user]",
      "\tname = Astrid Gealer",
      "\temail = astrid@example.com",
      "[alias]",
      "\tco = checkout",
    ].join("\n");
    const out = sanitizeGitConfigForAgentVm(input);
    expect(out).toContain("name = Astrid Gealer");
    expect(out).toContain("email = astrid@example.com");
    expect(out).toContain("co = checkout");
    expect(out).toContain("# Synced from the local ~/.gitconfig by Infrawrench.");
  });

  // These rewrites used to be kept deliberately — they are user config, and
  // keeping them looked harmless. They are not: a developer who rewrites
  // https://github.com/ to SSH locally does so because their own machine has
  // a key registered with GitHub. The VM has none, so every HTTPS clone
  // silently becomes an SSH one and dies with "Permission denied (publickey)"
  // — even for public repositories, which need no authentication at all, and
  // blaming a URL the user never typed.
  it("drops URL rewrites that point at SSH, in both spellings git accepts", () => {
    const input = [
      "[user]",
      "\tname = A",
      '[url "ssh://git@github.com/"]',
      "\tinsteadOf = https://github.com/",
      '[url "git@gitlab.com:"]',
      "\tinsteadOf = https://gitlab.com/",
      "\tpushInsteadOf = https://gitlab.com/",
      "[alias]",
      "\tco = checkout",
    ].join("\n");
    const out = sanitizeGitConfigForAgentVm(input);
    expect(out).toContain("name = A");
    expect(out).toContain("co = checkout");
    expect(out).not.toContain("insteadOf");
    expect(out).not.toContain("pushInsteadOf");
    expect(out).not.toContain("ssh://git@github.com/");
    expect(out).not.toContain("git@gitlab.com:");
  });

  // A rewrite to another HTTPS endpoint (an internal mirror) may well still
  // resolve from the VM and depends on no local key material, so it stays.
  it("keeps URL rewrites that do not point at SSH", () => {
    const input = [
      '[url "https://mirror.internal/github/"]',
      "\tinsteadOf = https://github.com/",
    ].join("\n");
    const out = sanitizeGitConfigForAgentVm(input);
    expect(out).toContain("https://mirror.internal/github/");
    expect(out).toContain("insteadOf = https://github.com/");
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
