import type { Repository } from "@infrawrench/git-contract";
import { CopyButton } from "../../components/controls";
import { Panel, PanelHeader } from "../../components/Panel";
import { CloneUrl } from "./shared";

function Commands({ label, lines }: { label: string; lines: ReadonlyArray<string> }) {
  const text = lines.join("\n");
  return (
    <section aria-label={label} className="space-y-1.5">
      <h3 className="text-xs font-medium text-on-surface">{label}</h3>
      <div className="relative rounded border border-border bg-surface-inset">
        <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-5 text-on-surface">
          {text}
        </pre>
        <CopyButton
          text={text}
          label={`Copy commands: ${label}`}
          className="absolute right-1 top-1"
        />
      </div>
    </section>
  );
}

/** A repository nothing has been pushed to: its clone URLs and the commands that fill it. */
export function EmptyRepository({ repository }: { repository: Repository }) {
  const branch = repository.defaultBranch;
  const remote = repository.sshCloneUrl;
  return (
    <Panel>
      <PanelHeader>
        <span className="font-medium text-on-surface">Nothing pushed yet</span>
      </PanelHeader>
      <div className="space-y-4 p-3">
        <CloneUrl repository={repository} />
        {repository.viewer.canPush ? (
          <>
            <Commands
              label="Create a repository and push it"
              lines={[
                "git init -b " + branch,
                "git add .",
                'git commit -m "Initial commit"',
                "git remote add origin " + remote,
                "git push -u origin " + branch,
              ]}
            />
            <Commands
              label="Push an existing repository"
              lines={[
                "git remote add origin " + remote,
                "git branch -M " + branch,
                "git push -u origin " + branch,
              ]}
            />
          </>
        ) : null}
      </div>
    </Panel>
  );
}
