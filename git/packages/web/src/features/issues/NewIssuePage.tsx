import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../api/client";
import { invalidate } from "../../api/queries";
import { useGo } from "../../components/AppLink";
import { Button, ButtonLink, buttonClass } from "../../components/Button";
import { Field, Input } from "../../components/forms";
import { MarkdownEditor } from "../../components/MarkdownEditor";
import { Page } from "../../components/Panel";
import { EmptyState, InlineError } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { paths } from "../../lib/paths";
import { signInHref, useSession } from "../../lib/session";
import { TriageFields, type ThreadTriage } from "./ThreadSidebar";

export function NewIssuePage() {
  const repo = useRepoRef();
  const repository = useRepository();
  const session = useSession();
  const go = useGo();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [triage, setTriage] = useState<ThreadTriage>({
    labels: [],
    assignees: [],
    milestone: null,
  });

  const create = useMutation({
    mutationFn: () =>
      api.issues.create({
        params: repo,
        payload: {
          title: title.trim(),
          body,
          labels: [...triage.labels],
          assignees: [...triage.assignees],
          milestone: triage.milestone,
        },
      }),
    onSuccess: (issue) => {
      void invalidate("issues");
      void invalidate("repositories", "get");
      go(paths.issue(repo, issue.number));
    },
  });

  if (session.data !== undefined && session.data.user === null) {
    return (
      <Page>
        <EmptyState
          action={
            <a href={signInHref()} className={buttonClass("primary")}>
              Sign in
            </a>
          }
        >
          Sign in to open an issue
        </EmptyState>
      </Page>
    );
  }
  if (repository.archived) {
    return (
      <Page>
        <EmptyState action={<ButtonLink href={paths.issues(repo)}>Issues</ButtonLink>}>
          This repository is archived
        </EmptyState>
      </Page>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim() !== "") create.mutate();
  };

  return (
    <Page>
      <h1 className="mb-4 text-base font-semibold text-on-surface">New issue</h1>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <form onSubmit={submit} className="min-w-0 space-y-3">
          <Field label="Title">
            {(control) => (
              <Input
                {...control}
                value={title}
                autoFocus
                required
                maxLength={256}
                onChange={(event) => setTitle(event.target.value)}
              />
            )}
          </Field>
          <MarkdownEditor
            label="Description"
            value={body}
            onChange={setBody}
            rows={12}
            onSubmit={() => title.trim() !== "" && create.mutate()}
            actions={
              <>
                <InlineError error={create.error} />
                <ButtonLink href={paths.issues(repo)}>Cancel</ButtonLink>
                <Button
                  type="submit"
                  variant="primary"
                  busy={create.isPending}
                  disabled={title.trim() === ""}
                >
                  Create issue
                </Button>
              </>
            }
          />
        </form>
        <aside aria-label="Details">
          <TriageFields
            kind="issues"
            value={triage}
            onChange={setTriage}
            canTriage={repository.viewer.canTriage}
          />
        </aside>
      </div>
    </Page>
  );
}
