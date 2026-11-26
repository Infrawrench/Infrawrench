/**
 * What the signed-in person's menu offers, in either shell: their pages,
 * their settings, how pull requests open for them, and the ways out.
 */
import type { SessionUser } from "@infrawrench/git-contract";
import { Icon } from "../components/icons";
import type { MenuItem } from "../components/Menu";
import { MODE_LABEL, useReviewMode, useSetReviewMode } from "../features/review/mode";
import { paths } from "../lib/paths";
import { signOut } from "../lib/session";

export const accountName = (user: SessionUser): string =>
  user.displayName ?? user.username ?? user.email;

export function useAccountMenuItems(user: SessionUser, appUrl: string): MenuItem[] {
  const { mode } = useReviewMode();
  const change = useSetReviewMode();
  const shown = change.isPending && change.variables !== undefined ? change.variables : mode;
  return [
    ...(user.username !== null
      ? [
          {
            label: "Your repositories",
            href: paths.namespace(user.username),
            icon: <Icon name="book" />,
          },
          {
            label: "Your stars",
            href: paths.namespace(user.username, { tab: "stars" }),
            icon: <Icon name="star" />,
          },
        ]
      : []),
    { label: "Settings", href: paths.settings(), icon: <Icon name="settings" /> },
    ...(shown !== undefined
      ? (["agent", "classic"] as const).map((value, index): MenuItem => ({
          label: MODE_LABEL[value],
          checked: shown === value,
          onSelect: () => {
            if (value !== mode) change.mutate(value);
          },
          icon: <Icon name={value === "agent" ? "gitBranch" : "gitPullRequest"} />,
          ...(index === 0 ? { heading: "Open pull requests as", separated: true } : {}),
        }))
      : []),
    {
      label: "Infrawrench app",
      href: appUrl,
      icon: <Icon name="externalLink" />,
      separated: true,
    },
    {
      label: "Sign out",
      onSelect: () => void signOut(),
      icon: <Icon name="logOut" />,
      separated: true,
    },
  ];
}
