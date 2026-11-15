import { useEffect, useId, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  checkCiInputs,
  type CiInput,
  type CiInputProblem,
  type CiInputValue,
  type CiManualPipeline,
  type CiManualPipelines,
  type CiRepoManual,
  type CiRun,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { CloseIcon } from "../components/icons/ChromeIcons.js";
import { INPUT, LABEL, PRIMARY_BUTTON, SECONDARY_BUTTON } from "../settings/styles.js";
import type { CiClient } from "./types.js";

type Gt = ReturnType<typeof useGT>;

/** An input's problem in the form's words. */
function problemText(problem: CiInputProblem, gt: Gt): string {
  switch (problem.kind) {
    case "required":
      return gt("Required");
    case "unknown":
      return gt("The pipeline declares no such input");
    case "boolean":
      return gt("True or false");
    case "number":
      return gt("A number");
    case "choice":
      return gt("One of {options}", { options: problem.options.join(", ") });
    case "too-long":
      return gt("At most {size} KiB", { size: String(problem.maxBytes / 1024) });
    case "nul":
      return gt("Contains a NUL character");
  }
}

/** What an input reads when the form leaves it alone. */
function unset(input: CiInput): string {
  return input.default ?? (input.type === "boolean" ? "false" : "");
}

/**
 * The form for one pipeline's inputs, generated from its `on.manual`
 * declaration on the default branch. Only values that differ from an
 * input's default are sent, so a branch whose own file has other defaults
 * keeps them.
 */
function ManualRunDialog({
  client,
  repo,
  pipeline,
  onClose,
  onStarted,
}: {
  client: CiClient;
  repo: CiRepoManual;
  pipeline: CiManualPipeline;
  onClose: () => void;
  onStarted: (run: CiRun) => void;
}) {
  const gt = useGT();
  const id = useId();
  const [branch, setBranch] = useState(repo.defaultBranch);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(pipeline.inputs.map((i) => [i.name, unset(i)])),
  );
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const given = useMemo(() => {
    const out: Record<string, CiInputValue> = {};
    for (const input of pipeline.inputs) {
      const value = values[input.name] ?? "";
      if (value === unset(input)) continue;
      out[input.name] = input.type === "boolean" ? value === "true" : value;
    }
    return out;
  }, [pipeline.inputs, values]);
  const { problems } = useMemo(() => checkCiInputs(pipeline.inputs, given), [pipeline, given]);
  const blocked = Object.keys(problems).length > 0 || branch.trim() === "";

  const start = async () => {
    setTried(true);
    if (blocked) return;
    setBusy(true);
    setError(null);
    try {
      const run = await client.startRun({
        installationId: repo.installationId,
        repoFullName: repo.repoFullName,
        pipelineFile: pipeline.file,
        branch: branch.trim(),
        inputs: given,
      });
      onStarted(run);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not start the run"));
      setBusy(false);
    }
  };

  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));

  return (
    <Modal
      // While it starts, the dialog stays: its answer opens the run.
      onClose={() => {
        if (!busy) onClose();
      }}
      ariaLabel={gt("Run {pipeline}", { pipeline: pipeline.name })}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
        className="flex max-h-[88vh] w-[560px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-border-strong bg-surface-raised shadow-2xl"
      >
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-on-surface">
              {gt("Run {pipeline}", { pipeline: pipeline.name })}
            </h2>
            <p className="truncate font-mono text-[11px] text-on-surface-faint">
              {repo.repoFullName} · {pipeline.file}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={gt("Close")}
            className="rounded-md p-1 text-on-surface-muted hover:bg-surface-overlay hover:text-on-surface"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <label htmlFor={`${id}-branch`} className={LABEL}>
              {gt("Branch")}
            </label>
            <input
              id={`${id}-branch`}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className={`${INPUT} font-mono`}
              autoComplete="off"
              spellCheck={false}
              required
            />
            {branch.trim() !== "" && branch.trim() !== repo.defaultBranch ? (
              <p className="mt-1 text-xs text-on-surface-faint">
                {gt(
                  "The inputs below are {default}'s. The run checks them against {branch}'s own pipeline file.",
                  { default: repo.defaultBranch, branch: branch.trim() },
                )}
              </p>
            ) : null}
          </div>

          {pipeline.inputs.map((input) => {
            const field = `${id}-${input.name}`;
            const problem = tried ? problems[input.name] : undefined;
            const value = values[input.name] ?? "";
            const describedBy =
              [input.description ? `${field}-help` : null, problem ? `${field}-problem` : null]
                .filter(Boolean)
                .join(" ") || undefined;
            return (
              <div key={input.name}>
                {input.type === "boolean" ? (
                  <label className="flex items-center gap-2 text-sm text-on-surface">
                    <input
                      id={field}
                      type="checkbox"
                      checked={value === "true"}
                      onChange={(e) => set(input.name, e.target.checked ? "true" : "false")}
                      aria-describedby={describedBy}
                    />
                    <span className="font-mono">{input.name}</span>
                  </label>
                ) : (
                  <>
                    <label htmlFor={field} className={LABEL}>
                      <span className="font-mono">{input.name}</span>
                      {input.required ? (
                        <span className="ml-1 text-on-surface-faint">{gt("(required)")}</span>
                      ) : null}
                    </label>
                    {input.type === "choice" ? (
                      <select
                        id={field}
                        value={value}
                        onChange={(e) => set(input.name, e.target.value)}
                        className={INPUT}
                        aria-describedby={describedBy}
                        aria-invalid={problem ? true : undefined}
                      >
                        {input.default === undefined ? (
                          <option value="">{gt("None")}</option>
                        ) : null}
                        {(input.options ?? []).map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : input.type === "number" ? (
                      <input
                        id={field}
                        type="text"
                        inputMode="decimal"
                        value={value}
                        onChange={(e) => set(input.name, e.target.value)}
                        className={INPUT}
                        aria-describedby={describedBy}
                        aria-invalid={problem ? true : undefined}
                        autoComplete="off"
                      />
                    ) : (
                      <textarea
                        id={field}
                        rows={2}
                        value={value}
                        onChange={(e) => set(input.name, e.target.value)}
                        className={`${INPUT} font-mono`}
                        aria-describedby={describedBy}
                        aria-invalid={problem ? true : undefined}
                        spellCheck={false}
                      />
                    )}
                  </>
                )}
                {input.description ? (
                  <p id={`${field}-help`} className="mt-1 text-xs text-on-surface-faint">
                    {input.description}
                  </p>
                ) : null}
                {problem ? (
                  <p id={`${field}-problem`} role="alert" className="mt-1 text-xs text-danger">
                    {problemText(problem, gt)}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
          <p className="mr-auto min-w-0 text-xs">
            {error ? (
              <span role="alert" className="text-danger">
                {error}
              </span>
            ) : null}
          </p>
          <button type="button" onClick={onClose} disabled={busy} className={SECONDARY_BUTTON}>
            {gt("Cancel")}
          </button>
          <button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
            {busy ? gt("Starting…") : gt("Start run")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Each repository's pipelines with `on.manual`, as last read from its
 * default branch, each with a Run button that opens a form for its inputs.
 * Starting one takes `ci:approve`, as a retry does.
 */
export function CiManualCard({
  client,
  canStart,
  onStarted,
}: {
  client: CiClient;
  canStart: boolean;
  onStarted: (run: CiRun) => void;
}) {
  const gt = useGT();
  // A string, not `gt`, in the effect's deps (see CiCachesCard).
  const loadFailed = gt("Failed to load the manual pipelines");
  const [manual, setManual] = useState<CiManualPipelines | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ repo: CiRepoManual; pipeline: CiManualPipeline } | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .listManual()
      .then((m) => {
        if (cancelled) return;
        setManual(m);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : loadFailed));
    return () => {
      cancelled = true;
    };
  }, [client, loadFailed]);

  return (
    <section
      className="space-y-3 rounded border border-border bg-surface-raised p-4"
      aria-labelledby="ci-manual"
    >
      <h3 id="ci-manual" className="text-sm font-semibold text-on-surface">
        {gt("Manual runs")}
      </h3>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : manual === null ? (
        <p role="status" className="text-xs text-on-surface-faint">
          {gt("Loading…")}
        </p>
      ) : manual.repositories.length === 0 ? (
        <p className="text-xs text-on-surface-muted">
          {gt("No pipeline on a default branch can be started by hand.")}
        </p>
      ) : (
        <div className="space-y-3">
          {manual.repositories.map((repo) => (
            <table key={`${repo.installationId}/${repo.repoFullName}`} className="w-full text-xs">
              <caption className="mb-1 text-left text-xs font-medium text-on-surface-secondary">
                {repo.repoFullName}
              </caption>
              <thead className="sr-only">
                <tr>
                  <th scope="col">{gt("Pipeline")}</th>
                  <th scope="col">{gt("Inputs")}</th>
                  <th scope="col">{gt("Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {repo.pipelines.map((p) => (
                  <tr key={p.file} className="border-t border-border align-middle">
                    <td className="py-1.5 text-on-surface">
                      {p.name}
                      <span className="block font-mono text-[10px] text-on-surface-faint">
                        {p.file}
                      </span>
                    </td>
                    <td className="py-1.5 font-mono text-on-surface-muted">
                      {p.inputs.map((i) => i.name).join(", ")}
                    </td>
                    <td className="py-1.5 text-right">
                      <button
                        type="button"
                        disabled={!canStart}
                        onClick={() => setOpen({ repo, pipeline: p })}
                        title={
                          canStart
                            ? gt("Start {pipeline} on a branch", { pipeline: p.name })
                            : gt("Starting a run takes permission to approve CI runs.")
                        }
                        className="rounded border border-border px-2 py-0.5 text-xs text-on-surface hover:bg-surface-sunken disabled:opacity-50"
                      >
                        {gt("Run")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
      )}
      {open ? (
        <ManualRunDialog
          client={client}
          repo={open.repo}
          pipeline={open.pipeline}
          onClose={() => setOpen(null)}
          onStarted={(run) => {
            setOpen(null);
            onStarted(run);
          }}
        />
      ) : null}
    </section>
  );
}
