/** Create a repository: where, its name, who can see it, and whether it starts with a README. */
import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  REPOSITORY_NAME_MAX_LENGTH,
  nameProblemMessage,
  repositoryNameProblem,
  type Session,
  type Visibility,
} from "@infrawrench/git-contract";
import { ApiError, api } from "../../api/client";
import { invalidate } from "../../api/queries";
import { useGo } from "../../components/AppLink";
import { Button, ButtonLink, buttonClass } from "../../components/Button";
import { Checkbox, Field, Input, RadioCards, Select, Textarea } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Page, PageHeader } from "../../components/Panel";
import { EmptyState, InlineError, Loading } from "../../components/states";
import { paths } from "../../lib/paths";
import { signInHref, useSession } from "../../lib/session";

interface Owner {
  readonly slug: string;
  readonly label: string;
  /** Whether the owner's plan allows private repositories. */
  readonly privateRepositories: boolean;
}

/** The namespaces the person can create in: their own, and their organisations' with `git:write`. */
function ownersOf(session: Session): Owner[] {
  const owners: Owner[] = [];
  if (session.user?.username != null) {
    owners.push({
      slug: session.user.username,
      label: session.user.username,
      privateRepositories: true,
    });
  }
  for (const organization of session.organizations) {
    if (organization.namespace === null) continue;
    if (!organization.permissions.includes("git:write")) continue;
    owners.push({
      slug: organization.namespace,
      label: `${organization.namespace} (${organization.name})`,
      privateRepositories: organization.privateRepositories,
    });
  }
  return owners;
}

export function NewRepositoryPage({ owner: initialOwner }: { owner?: string | undefined }) {
  const session = useSession();
  if (session.data === undefined) return <Loading />;
  if (session.data.user === null) {
    return (
      <Page width="narrow">
        <EmptyState
          action={
            <a href={signInHref()} className={buttonClass("primary")}>
              Sign in
            </a>
          }
        >
          Sign in to create a repository
        </EmptyState>
      </Page>
    );
  }
  const owners = ownersOf(session.data);
  if (owners.length === 0) return <Loading />;
  return <NewRepositoryForm owners={owners} initialOwner={initialOwner} />;
}

function NewRepositoryForm({
  owners,
  initialOwner,
}: {
  owners: ReadonlyArray<Owner>;
  initialOwner: string | undefined;
}) {
  const go = useGo();
  const [ownerSlug, setOwnerSlug] = useState(
    owners.find((o) => o.slug === initialOwner)?.slug ?? owners[0]!.slug,
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [readme, setReadme] = useState(true);
  const [touched, setTouched] = useState(false);

  const owner = owners.find((o) => o.slug === ownerSlug) ?? owners[0]!;
  const effectiveVisibility: Visibility = owner.privateRepositories ? visibility : "public";
  const problem = repositoryNameProblem(name);
  const create = useMutation({
    mutationFn: () =>
      api.repositoryLists.create({
        payload: {
          owner: owner.slug,
          name,
          visibility: effectiveVisibility,
          ...(description.trim() === "" ? {} : { description: description.trim() }),
          ...(readme ? { initialize: { readme: true } } : {}),
        },
      }),
    onSuccess: (repository) => {
      void invalidate("repositoryLists");
      go(paths.repo({ owner: repository.owner.slug, repo: repository.name }));
    },
  });

  const nameTaken = create.error instanceof ApiError && create.error.code === "name_taken";
  const nameError =
    touched && problem !== null
      ? nameProblemMessage(problem, REPOSITORY_NAME_MAX_LENGTH)
      : nameTaken
        ? (create.error?.message ?? null)
        : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem === null) create.mutate();
  };

  return (
    <Page width="narrow">
      <PageHeader title="New repository" />
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
          <Field label="Owner">
            {(control) => (
              <Select
                {...control}
                value={owner.slug}
                onChange={(event) => setOwnerSlug(event.target.value)}
              >
                {owners.map((option) => (
                  <option key={option.slug} value={option.slug}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Name"
            error={nameError}
            hint="Letters, digits, dots, dashes and underscores"
          >
            {(control) => (
              <Input
                {...control}
                required
                autoFocus
                autoComplete="off"
                spellCheck={false}
                maxLength={REPOSITORY_NAME_MAX_LENGTH}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (create.error) create.reset();
                }}
                onBlur={() => setTouched(name !== "")}
              />
            )}
          </Field>
        </div>

        <Field label="Description" optional>
          {(control) => (
            <Textarea
              {...control}
              rows={2}
              maxLength={350}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          )}
        </Field>

        <RadioCards
          legend="Visibility"
          name="visibility"
          value={effectiveVisibility}
          onChange={setVisibility}
          options={[
            {
              value: "private",
              label: "Private",
              detail: owner.privateRepositories
                ? "Only people with access can read it"
                : "Not included in this organisation's plan",
              icon: <Icon name="lock" size={12} />,
              disabled: !owner.privateRepositories,
            },
            {
              value: "public",
              label: "Public",
              detail: "Anyone can read and clone it",
              icon: <Icon name="globe" size={12} />,
            },
          ]}
        />

        <Checkbox
          label="Initialise with a README"
          checked={readme}
          onChange={(event) => setReadme(event.target.checked)}
        />

        {nameTaken ? null : <InlineError error={create.error} />}

        <div className="flex items-center gap-2 border-t border-border pt-4">
          <Button type="submit" variant="primary" busy={create.isPending}>
            Create repository
          </Button>
          <ButtonLink variant="ghost" href={paths.home()}>
            Cancel
          </ButtonLink>
        </div>
      </form>
    </Page>
  );
}
