/**
 * What the signed-in person's menu offers: their pages, their settings, and
 * the ways out.
 */
import type { SessionUser } from "@infrawrench/git-contract";
import { Icon } from "../components/icons";
import type { MenuItem } from "../components/Menu";
import { paths } from "../lib/paths";
import { signOut } from "../lib/session";

export const accountName = (user: SessionUser): string =>
  user.displayName ?? user.username ?? user.email;

export function useAccountMenuItems(user: SessionUser, appUrl: string): MenuItem[] {
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
