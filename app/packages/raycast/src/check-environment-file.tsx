import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Form,
  Icon,
  List,
  Toast,
  confirmAlert,
  getSelectedFinderItems,
  showToast,
  type Image,
  type LaunchProps,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import path from "node:path";
import {
  checkInfraenvReference,
  infraenvDiagnostics,
  infraenvEntriesFor,
  infraenvReferenceEntries,
  infraenvScopeLabel,
  infraenvValueHasTemplate,
  parseInfraenv,
  worstInfraenvCheckState,
  type InfraenvCheckState,
  type InfraenvDocument,
  type InfraenvReferenceCheck,
} from "@infrawrench/client-core";
import { getClient, type Client } from "./lib/client";
import { loadInfraenvReport, locateInfraenv, planDotenvPull, pullDotenv } from "./lib/infraenv";
import { destinationsFor, openPreferred } from "./lib/open";

interface Arguments {
  path?: string;
}

const STATE_ICONS: Record<InfraenvCheckState, Image.ImageLike> = {
  ok: { source: Icon.CheckCircle, tintColor: Color.Green },
  warning: { source: Icon.Warning, tintColor: Color.Yellow },
  error: { source: Icon.XMarkCircle, tintColor: Color.Red },
  unchecked: { source: Icon.Circle, tintColor: Color.SecondaryText },
};

/**
 * Check Environment File: a local `.infraenv` (the argument, else the Finder
 * selection, else a picked file) checked offline for syntax and against the
 * organization for what every reference points at.
 */
export default function Command(props: LaunchProps<{ arguments: Arguments }>) {
  const [file, setFile] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    void (async () => {
      const typed = props.arguments.path?.trim();
      if (typed) {
        setFile(await locateInfraenv(typed));
        return;
      }
      try {
        const [first] = await getSelectedFinderItems();
        setFile(first ? await locateInfraenv(first.path) : null);
      } catch {
        // Finder is not frontmost (or this platform has none): ask instead.
        setFile(null);
      }
    })();
  }, []);

  if (file === undefined) return <List isLoading />;
  if (file === null) return <PickFile onPick={setFile} />;
  return <Report file={file} />;
}

function PickFile({ onPick }: { onPick: (file: string) => void }) {
  const [error, setError] = useState<string | undefined>();
  return (
    <Form
      navigationTitle="Check Environment File"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Check"
            onSubmit={async (values: { files: string[] }) => {
              const found = values.files[0] ? await locateInfraenv(values.files[0]) : null;
              if (found) onPick(found);
              else setError("No .infraenv there");
            }}
          />
        </ActionPanel>
      }
    >
      <Form.FilePicker
        id="files"
        title=".infraenv"
        info="The file itself, or the folder that holds it."
        allowMultipleSelection={false}
        canChooseDirectories
        showHiddenFiles
        error={error}
        onChange={() => setError(undefined)}
      />
    </Form>
  );
}

function scopesOf(doc: InfraenvDocument): (string | null)[] {
  return [null, ...doc.environments.map((e) => e.name)];
}

interface Row {
  key: string;
  environment: string | null;
  line: number | undefined;
  perScope: boolean;
  check: InfraenvReferenceCheck;
}

function Report({ file }: { file: string }) {
  const { data, isLoading, revalidate, error } = usePromise(
    (f: string) => loadInfraenvReport(f, getClient),
    [file],
  );
  const name = path.basename(file);
  const client = useMemo(() => {
    try {
      return getClient();
    } catch {
      return null;
    }
  }, []);

  if (error) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.Warning}
          title={`Couldn't read ${name}`}
          description={error.message}
          actions={<FileActions file={file} source={null} doc={null} onRefresh={revalidate} />}
        />
      </List>
    );
  }

  const source = data?.source ?? null;
  const doc = source === null ? null : parseInfraenv(source).document;
  const describe = data?.describe ?? null;
  const diagnostics = source === null ? [] : infraenvDiagnostics(source, describe);
  const rows: Row[] = doc
    ? infraenvReferenceEntries(doc).flatMap((at) => {
        const checks = checkInfraenvReference(doc, at, describe);
        const perScope = checks.length > 1 || infraenvValueHasTemplate(at.entry.value);
        return checks.map((check) => ({
          key: at.entry.key,
          environment: at.environment,
          line: at.entry.line,
          perScope,
          check,
        }));
      })
    : [];
  const actions = (extra?: ReactElement) => (
    <FileActions file={file} source={source} doc={doc} onRefresh={revalidate} extra={extra} />
  );

  return (
    <List isLoading={isLoading} navigationTitle={name} searchBarPlaceholder={`Filter ${name}`}>
      {data?.failure ? (
        <List.Section title="References">
          <List.Item
            icon={STATE_ICONS.unchecked}
            title="References not checked"
            subtitle={data.failure}
            actions={actions()}
          />
        </List.Section>
      ) : null}
      {doc ? (
        <List.Section title="Environments">
          {scopesOf(doc).map((scope) => {
            const keys = new Set(infraenvEntriesFor(doc, scope).map((e) => e.key));
            const states = rows
              .filter((r) => r.check.environments.includes(scope))
              .map((r) => r.check.state);
            const errors = diagnostics.filter((d) => d.severity === "error").length;
            return (
              <List.Item
                key={`env:${scope ?? ""}`}
                icon={STATE_ICONS[errors > 0 ? "error" : worstInfraenvCheckState(states)]}
                title={scope ?? "Shared"}
                subtitle={scope ? `[env] + [env.${scope}]` : "[env]"}
                accessories={[{ text: `${keys.size} variable${keys.size === 1 ? "" : "s"}` }]}
                actions={actions(
                  <PullAction file={file} source={source} environment={scope} primary />,
                )}
              />
            );
          })}
        </List.Section>
      ) : null}
      {rows.length > 0 ? (
        <List.Section title="References">
          {rows.map((r, i) => (
            <ReferenceItem key={`ref:${i}`} row={r} client={client} actions={actions} />
          ))}
        </List.Section>
      ) : null}
      {diagnostics.length > 0 ? (
        <List.Section title="Problems">
          {diagnostics.map((d, i) => (
            <List.Item
              key={`problem:${i}`}
              icon={STATE_ICONS[d.severity]}
              title={d.message}
              subtitle={d.line > 0 ? `Line ${d.line}` : undefined}
              accessories={d.key ? [{ tag: d.key }] : []}
              actions={actions(
                <Action.CopyToClipboard
                  title="Copy Problem"
                  content={`${file}${d.line > 0 ? `:${d.line}` : ""} ${d.message}`}
                />,
              )}
            />
          ))}
        </List.Section>
      ) : null}
      {!isLoading && doc && rows.length === 0 && diagnostics.length === 0 ? (
        <List.EmptyView icon={Icon.CheckCircle} title={`${name} has no references`} />
      ) : null}
    </List>
  );
}

function ReferenceItem({
  row,
  client,
  actions,
}: {
  row: Row;
  client: Client | null;
  actions: (extra?: ReactElement) => ReactElement;
}) {
  const { check } = row;
  const scopes = row.perScope
    ? check.environments.map((s) => infraenvScopeLabel(s)).join(", ")
    : row.environment
      ? `[env.${row.environment}]`
      : null;
  const resource = check.resource;
  const accessories: List.Item.Accessory[] = [];
  if (scopes) accessories.push({ tag: scopes });
  if (resource?.found && resource.sensitive)
    accessories.push({ icon: Icon.Lock, tooltip: "Sensitive" });
  accessories.push({
    text: check.secret ? "Organization secret" : (resource?.accountName ?? ""),
    ...(check.message ? { tooltip: check.message } : {}),
  });
  const extra =
    resource?.found &&
    resource.resourceId &&
    resource.accountId &&
    resource.pluginId &&
    resource.resourceTypeId &&
    client ? (
      <>
        <Action
          title="Open Resource"
          icon={Icon.ArrowRight}
          onAction={() =>
            void openPreferred(
              client,
              destinationsFor(client, {
                kind: "resource",
                orgId: client.orgId,
                accountId: resource.accountId!,
                pluginId: resource.pluginId!,
                resourceTypeId: resource.resourceTypeId!,
                resourceId: resource.resourceId!,
              }),
            )
          }
        />
        <Action.CopyToClipboard title="Copy Resource ID" content={resource.resourceId} />
      </>
    ) : undefined;
  return (
    <List.Item
      icon={STATE_ICONS[check.state]}
      title={row.key}
      subtitle={check.message ?? `${check.title}${check.detail ? ` · ${check.detail}` : ""}`}
      keywords={[check.title, check.detail]}
      accessories={accessories}
      actions={actions(extra)}
    />
  );
}

function FileActions({
  file,
  source,
  doc,
  onRefresh,
  extra,
}: {
  file: string;
  source: string | null;
  doc: InfraenvDocument | null;
  onRefresh: () => void;
  extra?: ReactElement | undefined;
}) {
  return (
    <ActionPanel>
      {extra}
      <Action.Open title="Open File" target={file} />
      <Action.ShowInFinder path={file} />
      <Action.CopyToClipboard
        title="Copy File Path"
        content={file}
        shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
      />
      {source !== null && doc ? (
        <ActionPanel.Submenu
          title="Pull .env"
          icon={Icon.Download}
          shortcut={{ modifiers: ["cmd"], key: "p" }}
        >
          {scopesOf(doc).map((scope) => (
            <PullAction key={scope ?? ""} file={file} source={source} environment={scope} />
          ))}
        </ActionPanel.Submenu>
      ) : null}
      <Action
        title="Check Again"
        icon={Icon.ArrowClockwise}
        shortcut={{ modifiers: ["cmd"], key: "r" }}
        onAction={onRefresh}
      />
    </ActionPanel>
  );
}

function PullAction({
  file,
  source,
  environment,
  primary,
}: {
  file: string;
  source: string | null;
  environment: string | null;
  primary?: boolean;
}) {
  if (source === null) return null;
  return (
    <Action
      title={primary ? `Pull .env (${environment ?? "Shared"})` : (environment ?? "Shared")}
      icon={Icon.Download}
      onAction={() => void runPull(file, source, environment)}
    />
  );
}

async function runPull(file: string, source: string, environment: string | null): Promise<void> {
  const toast = await showToast({ style: Toast.Style.Animated, title: "Pulling .env" });
  try {
    const client = getClient();
    const plan = await planDotenvPull(file, source);
    const shown = path.basename(plan.target);
    if (plan.needsConfirmation) {
      await toast.hide();
      const replace = await confirmAlert({
        title: `Replace ${shown}?`,
        message:
          "It exists and was not generated by Infrawrench. Its current contents will be lost.",
        icon: Icon.Warning,
        primaryAction: { title: "Replace", style: Alert.ActionStyle.Destructive },
      });
      if (!replace) return;
      toast.style = Toast.Style.Animated;
      toast.title = "Pulling .env";
      await toast.show();
    }
    const result = await pullDotenv(client, file, source, environment, plan);
    const wrote = `Wrote ${result.count} variable${result.count === 1 ? "" : "s"} to ${shown}`;
    if (result.problems.length === 0) {
      toast.style = Toast.Style.Success;
      toast.title = wrote;
      toast.message = environment ?? undefined;
    } else {
      const n = result.problems.length;
      toast.style = Toast.Style.Failure;
      toast.title = wrote;
      toast.message = `${n} did not resolve: ${result.problems.map((p) => p.key ?? `line ${p.line}`).join(", ")}`;
    }
  } catch (err) {
    toast.style = Toast.Style.Failure;
    toast.title = "Couldn't pull .env";
    toast.message = err instanceof Error ? err.message : String(err);
  }
}
