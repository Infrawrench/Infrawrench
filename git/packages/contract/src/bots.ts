/**
 * The forge's bot accounts (client-core `git-bots.ts`, beside the name rules
 * that keep their usernames from everyone) and the `UserRef` one is named by.
 * The Worker's commit decorator and the UI's mock both resolve an address
 * here before they look for a person.
 */
import { gitBotForEmail, type GitBotAccount } from "@infrawrench/client-core";
import type { UserRef } from "./schemas/people";

export {
  GIT_BOT_ACCOUNTS as BOT_ACCOUNTS,
  gitBotByUsername as botByUsername,
  gitBotForEmail as botForEmail,
  type GitBotAccount as BotAccount,
} from "@infrawrench/client-core";

/** A bot where a person is named: `id` is `bot:<username>`, never a user's id. */
export const botUserRef = (bot: GitBotAccount): UserRef => ({
  id: `bot:${bot.username}`,
  username: bot.username,
  displayName: bot.displayName,
  avatarUrl: bot.avatar,
  kind: "bot",
});

/** The bot a commit's address belongs to, as a `UserRef`, or null. */
export const botUserForEmail = (email: string): UserRef | null => {
  const bot = gitBotForEmail(email);
  return bot === null ? null : botUserRef(bot);
};
