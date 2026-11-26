import type { ReactNode } from "react";
import { buttonClass } from "../../components/Button";
import { Icon } from "../../components/icons";
import { Page } from "../../components/Panel";
import { SettingsFrame, SideNav } from "../../components/SideNav";
import { EmptyState, Loading } from "../../components/states";
import { paths } from "../../lib/paths";
import { signInHref, useSession } from "../../lib/session";

/** Personal settings: the signed-in person's profile and their credentials for Git. */
export function SettingsLayout({ children }: { children: ReactNode }) {
  const session = useSession();
  if (session.data === undefined) return <Loading shape="page" />;
  if (session.data.user === null) {
    return (
      <Page>
        <EmptyState
          action={
            <a href={signInHref()} className={buttonClass("primary")}>
              Sign in
            </a>
          }
        >
          Sign in to open your settings
        </EmptyState>
      </Page>
    );
  }
  return (
    <SettingsFrame
      nav={
        <>
          <h1 className="mb-2 px-2.5 text-sm font-semibold text-on-surface">Settings</h1>
          <SideNav
            label="Settings"
            items={[
              {
                label: "Profile",
                href: paths.settings(),
                icon: <Icon name="user" size={13} />,
                exact: true,
              },
              {
                label: "Review",
                href: paths.settings("review"),
                icon: <Icon name="eye" size={13} />,
              },
              {
                label: "SSH keys",
                href: paths.settings("keys"),
                icon: <Icon name="key" size={13} />,
              },
              {
                label: "Access tokens",
                href: paths.settings("tokens"),
                icon: <Icon name="lock" size={13} />,
              },
              {
                label: "T3 Code",
                href: paths.settings("t3"),
                icon: <Icon name="code" size={13} />,
              },
            ]}
          />
          <a
            href={session.data.appUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-3 flex items-center gap-2 border-t border-border px-2.5 pt-3 text-xs text-on-surface-secondary hover:underline"
          >
            Infrawrench account
            <Icon name="externalLink" size={11} />
          </a>
        </>
      }
    >
      {children}
    </SettingsFrame>
  );
}
