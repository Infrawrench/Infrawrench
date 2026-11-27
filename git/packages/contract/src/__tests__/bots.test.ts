import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  BOT_ACCOUNTS,
  UserRef,
  botByUsername,
  botForEmail,
  botUserForEmail,
  coAuthorsOf,
  nameProblemMessage,
  namespaceSlugProblem,
} from "../index";

describe("bot accounts", () => {
  it("resolves each tool's commit address, whatever its case", () => {
    for (const email of [
      "noreply@anthropic.com",
      "NoReply@Anthropic.com",
      "NOREPLY@ANTHROPIC.COM",
      " noreply@anthropic.com ",
    ]) {
      expect(botForEmail(email)?.username, email).toBe("claude");
    }
    for (const email of ["cursoragent@cursor.com", "CursorAgent@Cursor.com"]) {
      expect(botForEmail(email)?.username, email).toBe("cursor");
    }
  });

  it("leaves every other address alone", () => {
    for (const email of [
      "",
      "noreply@github.com",
      "someone@anthropic.com",
      "noreply@anthropic.com.example",
      "agent@cursor.com",
      "cursoragent@cursor.com.evil.example",
    ]) {
      expect(botForEmail(email), email).toBeNull();
    }
  });

  it("names the bot the same whatever the commit calls it", () => {
    const message = [
      "Fix the thing",
      "",
      "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>",
      "Co-authored-by: Cursor <cursoragent@cursor.com>",
    ].join("\n");
    const people = coAuthorsOf(message, "mara@acme.example").map((person) =>
      botUserForEmail(person.email),
    );
    expect(people).toEqual([
      {
        id: "bot:claude",
        username: "claude",
        displayName: "Claude",
        avatarUrl: "/assets/bots/claude-icon.svg",
        kind: "bot",
      },
      {
        id: "bot:cursor",
        username: "cursor",
        displayName: "Cursor",
        avatarUrl: "/assets/bots/cursor-avatar.png",
        kind: "bot",
      },
    ]);
    // What the API sends is what the schema reads.
    for (const person of people) expect(Schema.is(UserRef)(person)).toBe(true);
  });

  it("finds a bot by its username and gives it a page and a picture on this site", () => {
    expect(botByUsername("Claude")?.displayName).toBe("Claude");
    expect(botByUsername("CURSOR")?.displayName).toBe("Cursor");
    expect(botByUsername("mara")).toBeNull();
    for (const bot of BOT_ACCOUNTS) {
      expect(bot.kind).toBe("bot");
      expect(bot.profileUrl).toBe(`/${bot.username}`);
      // Never another site's: the page's policy is `img-src 'self' data: blob:`.
      expect(bot.avatar).toMatch(/^\/assets\/bots\/[a-z-]+\.(svg|png)$/);
      expect(bot.emails.every((email) => email === email.toLowerCase())).toBe(true);
    }
  });

  it("keeps the usernames from everyone, under a problem no admin is let past", () => {
    for (const slug of ["claude", "Claude", "CLAUDE", "cursor", "Cursor"]) {
      expect(namespaceSlugProblem(slug), slug).toBe("bot");
    }
    // `reserved` is what a platform admin may waive: a bot's name is not that.
    expect(namespaceSlugProblem("explore")).toBe("reserved");
    expect(namespaceSlugProblem("claudette")).toBeNull();
    expect(nameProblemMessage("bot", 39)).toBe("That name belongs to a bot account");
  });
});
