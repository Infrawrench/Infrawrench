/**
 * git.infrawrench.com's bot accounts: the coding tools whose commits and
 * `Co-authored-by:` trailers carry an address of the tool's own, shown as one
 * account each whatever name the commit wrote ("Claude", "Claude Opus 5.5").
 *
 * A bot is no row anywhere: nobody signs in as one, it owns nothing and
 * cannot be a collaborator or be mentioned. Its username is kept from
 * everyone ({@link gitNamespaceSlugProblem} answers `bot`, which no platform
 * admin may waive), and the forge's Worker and UI both read the accounts
 * here. Beside the name rules because those refuse the usernames.
 */

export interface GitBotAccount {
  readonly username: string;
  readonly displayName: string;
  readonly kind: "bot";
  /** The account's picture: a file the forge's UI ships (`web/public/assets/bots/`). */
  readonly avatar: string;
  /** Its page on the forge. */
  readonly profileUrl: string;
  /** The addresses its commits carry, lowercased. */
  readonly emails: readonly string[];
}

export const GIT_BOT_ACCOUNTS: readonly GitBotAccount[] = [
  {
    username: "claude",
    displayName: "Claude",
    kind: "bot",
    avatar: "/assets/bots/claude-icon.svg",
    profileUrl: "/claude",
    emails: ["noreply@anthropic.com"],
  },
  {
    username: "cursor",
    displayName: "Cursor",
    kind: "bot",
    avatar: "/assets/bots/cursor-avatar.png",
    profileUrl: "/cursor",
    emails: ["cursoragent@cursor.com"],
  },
];

/** The bot a commit's address belongs to, whatever its case, or null. */
export const gitBotForEmail = (email: string): GitBotAccount | null => {
  const lower = email.trim().toLowerCase();
  return GIT_BOT_ACCOUNTS.find((bot) => bot.emails.includes(lower)) ?? null;
};

/** The bot with this username, whatever its case, or null. */
export const gitBotByUsername = (username: string): GitBotAccount | null => {
  const lower = username.toLowerCase();
  return GIT_BOT_ACCOUNTS.find((bot) => bot.username === lower) ?? null;
};
