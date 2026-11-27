import type { ReactNode } from "react";
import { ButtonLink } from "../../components/Button";
import { Icon } from "../../components/icons";
import { Page } from "../../components/Panel";
import { SettingsFrame, SideNav } from "../../components/SideNav";
import { EmptyState } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { paths } from "../../lib/paths";

/** Repository settings: administrators only, a section per page. */
export function RepoSettingsLayout({ children }: { children: ReactNode }) {
  const repo = useRepoRef();
  const repository = useRepository();
  if (!repository.viewer.canAdminister) {
    return (
      <Page>
        <EmptyState action={<ButtonLink href={paths.repo(repo)}>Code</ButtonLink>}>
          Only administrators can open a repository's settings
        </EmptyState>
      </Page>
    );
  }
  return (
    <SettingsFrame
      nav={
        <SideNav
          label="Repository settings"
          items={[
            {
              label: "General",
              href: paths.repoSettings(repo),
              icon: <Icon name="settings" size={13} />,
              exact: true,
            },
            {
              label: "Collaborators",
              href: paths.repoSettings(repo, "collaborators"),
              icon: <Icon name="user" size={13} />,
            },
            {
              label: "Branches",
              href: paths.repoSettings(repo, "branches"),
              icon: <Icon name="shield" size={13} />,
            },
            {
              label: "Review",
              href: paths.repoSettings(repo, "review"),
              icon: <Icon name="eye" size={13} />,
            },
            // Deploy keys are SSH keys: none while Git over SSH is turned off.
            ...(repository.sshCloneUrl !== null
              ? [
                  {
                    label: "Deploy keys",
                    href: paths.repoSettings(repo, "keys"),
                    icon: <Icon name="key" size={13} />,
                  },
                ]
              : []),
            {
              label: "Labels",
              href: paths.repoSettings(repo, "labels"),
              icon: <Icon name="tag" size={13} />,
            },
            {
              label: "Milestones",
              href: paths.repoSettings(repo, "milestones"),
              icon: <Icon name="milestone" size={13} />,
            },
            {
              label: "CI",
              href: paths.repoSettings(repo, "ci"),
              icon: <Icon name="listChecks" size={13} />,
            },
          ]}
        />
      }
    >
      {children}
    </SettingsFrame>
  );
}
