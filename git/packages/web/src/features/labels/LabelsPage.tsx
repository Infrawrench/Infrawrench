import { ButtonLink } from "../../components/Button";
import { Page, PageHeader } from "../../components/Panel";
import { useRepoRef } from "../../layout/RepoLayout";
import { paths } from "../../lib/paths";
import { LabelsManager } from "./LabelsManager";

export function LabelsPage() {
  const repo = useRepoRef();
  return (
    <Page>
      <PageHeader
        title="Labels"
        actions={
          <>
            <ButtonLink href={paths.issues(repo)}>Issues</ButtonLink>
            <ButtonLink href={paths.milestones(repo)}>Milestones</ButtonLink>
          </>
        }
      />
      <LabelsManager />
    </Page>
  );
}
