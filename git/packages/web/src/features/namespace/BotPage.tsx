/** A bot account's page: who it is and what is attributed to it. Nothing of its own to list. */
import type { BotAccount } from "@infrawrench/git-contract";
import { Badge } from "../../components/Badge";
import { Icon } from "../../components/icons";
import { Page } from "../../components/Panel";
import { Avatar } from "../../components/people";

export function BotPage({ bot }: { bot: BotAccount }) {
  return (
    <Page>
      <section aria-label="Profile" className="space-y-3 text-xs">
        <div className="flex items-center gap-3">
          <Avatar name={bot.displayName} src={bot.avatar} size={72} square />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-on-surface">{bot.displayName}</h1>
              <Badge tone="outline">
                <Icon name="bot" size={10} />
                Bot
              </Badge>
            </div>
            <p className="text-on-surface-muted">{bot.username}</p>
          </div>
        </div>
        <p className="text-on-surface-secondary">
          Commits made with {bot.displayName} are attributed to this account.
        </p>
      </section>
    </Page>
  );
}
