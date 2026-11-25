# @infrawrench/git-web

The UI of git.infrawrench.com: Vite, React 19, TanStack Router (file routes), TanStack Query, Tailwind 4 on the app's theme tokens. It talks to the worker's JSON API through a client derived from `@infrawrench/git-contract`, and runs without the worker against an in-browser mock.

```sh
pnpm --filter @infrawrench/git-web dev:mock    # VITE_GIT_MOCK=1 vite, http://localhost:5174
pnpm --filter @infrawrench/git-web typecheck
pnpm --filter @infrawrench/git-web test
pnpm --filter @infrawrench/git-web build
```

## Layout

| Path                   | What                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/api/`             | The typed client (`client.ts`), its React Query form (`queries.ts`), the types derived from the contract.               |
| `src/lib/`             | Pure helpers: `paths.ts` (every URL), `refs.ts`, `lines.ts`, `diff-rows.ts`, `format.ts`, `highlight.ts`, `session.ts`. |
| `src/components/`      | Shared primitives. Nothing in here knows a feature.                                                                     |
| `src/layout/`          | `AppShell` (top bar) and `RepoLayout` (repository header, tab bar, `useRepository()`).                                  |
| `src/features/<name>/` | Pages and their private components, one folder per feature.                                                             |
| `src/routes/`          | Route files only: read the params, render a page from `features/`.                                                      |
| `src/mock/`            | The dev mock: `db.ts` (state), `git.ts` (fixtures and Git operations), `handlers/*.ts` (the endpoints).                 |
| `scripts/`             | `build-fixtures.mjs` and the scripted histories it turns into fixtures.                                                 |

Feature ownership: `home`, `explore`, `new-repository`, `onboarding`, `namespace` and `code` are the shell and code pages. Issues, pull requests, CI, Infrastructure, repository settings and personal settings each get their own folder under `features/` and their own files under `routes/` and `mock/handlers/`; none of them needs to edit a file listed above except `routeTree.gen.ts`, which the router plugin rewrites.

## Rules

- **No blurbs.** A page has a name and its controls. No slogans, no "what this does" paragraphs, no helper text that explains a feature. An empty state is one short neutral line plus the next action (`EmptyState`). A `Field` hint states a constraint, never a pitch.
- **No em dashes** in code, comments or copy.
- **Icons are inline SVG** from `components/icons.tsx` (Lucide paths on the app's 24x24 grid). Add a glyph there. Never an emoji, never an icon font.
- **The app's look**: the tokens of `app/packages/ui/src/theme.css` (`bg-surface`, `bg-surface-raised`, `bg-surface-inset`, `border-border`, `text-on-surface*`, `text-danger|warning|success`, `bg-accent text-on-accent`), `text-xs` body with `text-sm`/`text-base` headings, `rounded` and `rounded-md` corners, 1px borders, no shadows on cards. Never a Tailwind palette colour (`text-red-500`): it is right in one colour scheme only. Dark and light both come from `prefers-color-scheme`; look at both.
- **Accessible**: real `<table>`s with a caption (`Table`), every control labelled (`Field`, or `aria-label`), menus and pickers keyboard-navigable (`Menu`, `Popover`, `moveFocus`), state changes announced (`role="status"`, `role="alert"`).

## Adding a page

1. **The URL** goes in `src/lib/paths.ts`. Every link is `<AppLink href={paths.x(...)}>` (or `ButtonLink`), and navigation from code is `useGo()`. Do not use TanStack's `<Link to>`: refs and file paths contain slashes, and `paths.ts` is where they are encoded once. `paths.issues`, `paths.issue`, `paths.newIssue`, `paths.pulls`, `paths.pull`, `paths.newPull`, `paths.ci`, `paths.infrastructure`, `paths.repoSettings` and `paths.settings` already exist and the tab bar and the code pages link to them. The Infrastructure tab is `/infrastructure`, not `/terraform`, which belongs to the state backend.
2. **The route file** goes in `src/routes/`, flat names with dots: `src/routes/$owner/$repo/issues.index.tsx` is `/:owner/:repo/issues`, `issues.$number.tsx` is `/:owner/:repo/issues/:number`, `pulls.new.tsx` is `/:owner/:repo/pulls/new`. Everything under `$owner/$repo/` renders inside `RepoLayout` (`$owner/$repo/route.tsx`). A route file holds no logic:

   ```tsx
   import { createFileRoute } from "@tanstack/react-router";
   import { IssuesPage } from "../../../features/issues/IssuesPage";

   export const Route = createFileRoute("/$owner/$repo/issues/")({ component: IssuesPage });
   ```

   Search parameters need `validateSearch` on the route; read them with `Route.useSearch()` in a small wrapper component in the route file and pass them to the page as props. The dev server (or `vite build`) regenerates `routeTree.gen.ts`; commit it. If two branches both changed it, regenerate rather than merge by hand.

3. **The page** goes in `src/features/<feature>/`. Inside a repository, `useRepository()` is the `Repository` (already loaded by the layout: its `viewer` block decides which buttons show) and `useRepoRef()` is `{ owner, repo }` for `paths` and for request `params`. A new first path segment that belongs to the Code tab is added to `CODE_SECTIONS` in `RepoLayout.tsx`; the other tabs match their own segment already.
4. **Personal settings** live under `/settings` (`src/routes/settings*.tsx`); the account menu links to `paths.settings()`.

## Talking to the API

```tsx
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { invalidate, queries, usePages } from "../../api/queries";

const issue = useQuery(queries.issues.get({ params: { ...repo, number } }));

const close = useMutation({
  mutationFn: () =>
    api.issues.update({ params: { ...repo, number }, payload: { state: "closed" } }),
  onSuccess: () => invalidate("issues"),
});

const list = usePages(["issues", "list", request], (cursor) =>
  api.issues.list({ ...request, query: { ...request.query, cursor } }),
);
// <LoadMore pages={list} /> under the list; list.pages[0]?.counts for the tabs.
```

- `api.<group>.<endpoint>({ params, query, payload })` resolves with the endpoint's JSON, typed from the contract. Groups and endpoint names are the contract's (`src/api/routes.gen.ts` lists them all).
- `queries` mirrors `api` and answers `{ queryKey, queryFn }`. Keys are `[group, endpoint, request]`: `invalidate("issues")` refetches the group, `invalidate("issues", "get")` one endpoint.
- A failure is an `ApiError` with `status`, the server's sentence as `message`, and `code` (one of the contract's `ERROR_CODES`) to branch on. `QueryView` renders loading, error and data; `InlineError` goes beside a form's button.
- Request numbers are numbers (`limit: 50`), flags are the contract's `"true"`/`"false"` strings.
- After changing the contract's routes: `pnpm --filter @infrawrench/git-web generate:routes` (a test fails until `routes.gen.ts` matches). The client carries no Effect at runtime; import values from the contract only when they are plain functions or constants (`names.ts`, `urls.ts`), and everything else as `import type`.
- If the contract lacks something, do not edit it from here. Note it and work around it.

## The dev mock

`VITE_GIT_MOCK=1` replaces the client's transport with handlers in the browser. Nothing of it is in a production build.

- **Adding endpoints**: create `src/mock/handlers/<feature>.ts`. Every file in that folder is picked up; do not edit another feature's file. Two files answering the same endpoint throw at startup.

  ```ts
  import { defineMockHandlers, notFound, paginate } from "../define";
  import { findRepository, requireUser } from "../db";

  export default defineMockHandlers({
    issues: {
      list: ({ params, query }) => {
        const repo = findRepository(params.owner, params.repo); // 404s as the API does
        return { ...paginate(issuesOf(repo.id), query), counts: { open: 3, closed: 9 } };
      },
    },
  });
  ```

  Handlers are typed by the contract: `params`, `query` and `payload` in, the endpoint's JSON out. Throw `notFound()`, `badRequest()`, `conflict()`, `unprocessable()`, `unauthorized()` or `mockError(status, sentence, code)` for errors. Every file in `handlers/` is read as a handler file, so a feature's state (its issues, its runs) goes one level up, in `src/mock/<feature>-data.ts`.

- **Shared state** is `src/mock/db.ts`: `currentUser()`, `requireUser()`, `users`, `findRepository(owner, repo)` (a `RepositoryRecord`, whose `openIssueCount` and `openPullRequestCount` the header's tabs show), `toRepository`, `toSummary`, `findNamespace`, `isMember`.
- **Git** is `src/mock/git.ts` over real repositories: `gitOf(repo)` then `resolveRef`, `summarize` (a `CommitSummary`), `log`, `mergeBase`, `aheadBehind`, `diffCommits` (a `DiffFile[]` with hunks), `statsOf`, `blobAt`, `listTree`. A pull request's mock should point at real branches: `acme/infra` has `feature/vpc-peering` (3 commits ahead of `main`, 3 behind) and `fix/database-backups` (1 ahead), and `feature/flow-logs` was merged by the commit "Merge pull request #7". The branches endpoint already shows #12 on `feature/vpc-peering` and #7 on `feature/flow-logs`; keep the numbers if you can.
- **Fixtures**: `acme/infra` (private, Terraform, CI) and `acme/edge-router` (public, TypeScript) are generated from the scripted histories in `scripts/fixtures/` by `pnpm --filter @infrawrench/git-web fixtures`, which writes them with real `git` and reads them back into `src/mock/fixtures/*.generated.json`. The other repositories share one of the two histories. `acme/new-service` is empty.
- **Who is signed in**: `?mock=signed-in` (default: `mara`, a member of the `acme` organisation with every `git:*` permission), `?mock=signed-out`, `?mock=new-user` (signed in, no username yet). Kept in `sessionStorage`. `jonas` and `priya` are the other people.
- `VITE_GIT_MOCK_DELAY` is the latency per call in ms (default 40).

## Primitives (`src/components/`)

| File            | Exports                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `AppLink.tsx`   | `AppLink` (every link), `useGo` (navigate from code).                                                                                    |
| `Button.tsx`    | `Button` (`variant`: primary, secondary, ghost, danger; `size`: sm, md; `busy`), `ButtonLink`, `buttonClass`.                            |
| `forms.tsx`     | `Field` (label, hint, error wired by id), `Input`, `Textarea`, `Select`, `SearchInput`, `Checkbox`, `RadioCards`, `inputClass`.          |
| `Badge.tsx`     | `Badge` (`tone`), `VisibilityBadge`, `CommitStatusIcon` (a `StatusState`), `LanguageLabel`.                                              |
| `Panel.tsx`     | `Page` (the centred column; `width="narrow"` for forms), `PageHeader`, `Panel`, `PanelHeader`, `Table`, `Th`, `Tr`, `Td`.                |
| `states.tsx`    | `Loading`, `EmptyState`, `ErrorState`, `InlineError`, `QueryView`, `LoadMore`, `errorMessage`.                                           |
| `people.tsx`    | `RelativeTime`, `Avatar`, `UserLink`, `CommitAuthor`.                                                                                    |
| `Menu.tsx`      | `Menu` (actions), `Popover` (any floating box under a trigger), `moveFocus` (arrow keys in a list).                                      |
| `controls.tsx`  | `CopyButton`, `LinkTabs` (tabs that are pages), `Segmented`, `Breadcrumbs`, `Dialog`, `ConfirmDialog`.                                   |
| `RefPicker.tsx` | `RefPicker`: the branch and tag picker (search, arrow keys). Use it for a pull request's base and head.                                  |
| `Markdown.tsx`  | `Markdown`: GitHub-flavoured, lazy, raw HTML never rendered. `resolveLink` and `resolveImage` place relative URLs.                       |
| `CodeView.tsx`  | `CodeView` (line numbers, anchors, selection, optional gutter), `CodeLine`, `linesOf`.                                                   |
| `DiffView.tsx`  | `DiffView` (unified or split, expandable context), `DiffStat`, `diffFileId`. `renderAfterLine` and `lineAction` are for review comments. |
| `RepoList.tsx`  | `RepoList`, `RepoRow`.                                                                                                                   |
| `icons.tsx`     | `Icon` (`name`), `Spinner`.                                                                                                              |

`lib/format.ts` has `relativeTime`, `formatDate`, `formatBytes`, `shortOid`, `plural`, `compactCount`, `dayKey`, `groupConsecutive`. `lib/session.ts` has `useSession()`, `signInHref()` (a plain `<a href>`: sign-in is a page load) and `signOut()`. `lib/highlight.ts` has `useHighlight(text, language)` and `languageOfPath`; Shiki and its grammars load on demand, so add a language to `GRAMMARS` and `EXTENSIONS` there rather than importing Shiki anywhere else. `lib/raw.ts` has `rawUrl(repo, at, path)` for file bytes (an image in a rendered Markdown file); use it rather than the contract's `rawPath` so the mock can answer.

From the code pages, reusable by a pull request's pages: `features/code/DiffSection.tsx` (`DiffSection`: stats, file list, unified/split switch and a paged `DiffView`; `useDiffLayout`), `features/code/CommitsPage.tsx` (`CommitRow`, `CommitsByDay`), `features/code/ReadmePanel.tsx` (`RenderedMarkdown`, which resolves a file's relative links and images) and `features/code/shared.tsx` (`RefRoute` for a route whose splat is `ref/path`, `CommitStrip`, `CloneUrl`).

## Decisions

- **Refs in URLs keep their slashes** (`/tree/feature/x/src/a.ts`), resolved against the repository's refs the way the worker resolves raw paths: a full commit id first, then the longest prefix that names a branch or tag, then the first segment (`lib/refs.ts`, tested). Compare URLs are `/compare/base...head`; a ref name cannot contain `..`, so the first `...` splits them.
- **The client has no Effect in it.** `routes.gen.ts` is the contract's method and path per endpoint, generated and held in step by a test, and the types come from the contract as `import type`. The contract package is `sideEffects: false`, so importing `names.ts` and `urls.ts` functions pulls in nothing else.
- **`AppLink` over typed routes.** Links take an `href` from `paths.ts`. Typed `to` props would need the splat routes' refs and paths encoded at every call site.
- **Diff context expands in the browser**: the view fetches the new side's blob once and fills the gaps between hunks itself, rather than asking for the diff again with more context.
- **Syntax highlighting is Shiki's core with the JavaScript regex engine**, no WebAssembly, one chunk per grammar. Tokens carry both themes' colours and CSS picks by colour scheme.
