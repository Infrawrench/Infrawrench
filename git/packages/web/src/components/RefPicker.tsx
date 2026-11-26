/**
 * The branch and tag picker: a button showing the current ref, opening a
 * filter box over two lists. Arrow keys move through the list from the filter
 * box, Enter picks, Escape closes.
 */
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { queries } from "../api/queries";
import type { RepoRef } from "../lib/paths";
import { shortOid } from "../lib/format";
import { buttonClass } from "./Button";
import { Icon } from "./icons";
import { Popover } from "./Menu";
import { Loading } from "./states";

export type RefKind = "branch" | "tag" | "commit";

export interface RefPickerProps {
  readonly repo: RepoRef;
  /** The current ref's short name, or a commit id. */
  readonly value: string;
  readonly kind?: RefKind;
  readonly onSelect: (name: string, kind: "branch" | "tag") => void;
  /** What is being picked, for the button's accessible name: "base", "head". Default "branch or tag". */
  readonly label?: string;
  /** Leave tags out: a pull request's base is a branch. */
  readonly branchesOnly?: boolean;
  readonly align?: "start" | "end";
}

const FULL_OID = /^[0-9a-f]{40}$/;

export function RefPicker({
  repo,
  value,
  kind,
  onSelect,
  label = "branch or tag",
  branchesOnly = false,
  align = "start",
}: RefPickerProps) {
  const [open, setOpen] = useState(false);
  const shown = FULL_OID.test(value) ? shortOid(value) : value;
  const icon = kind === "tag" ? "tag" : kind === "commit" ? "gitCommit" : "gitBranch";
  return (
    <Popover
      align={align}
      className="w-72"
      onOpenChange={setOpen}
      trigger={({ props }) => (
        <button
          {...props}
          type="button"
          aria-haspopup="dialog"
          aria-label={`Switch ${label}: ${shown}`}
          className={buttonClass("secondary", "md", "max-w-56")}
        >
          <Icon name={icon} />
          <span className="truncate">{shown}</span>
          <Icon name="chevronDown" size={12} className="text-on-surface-muted" />
        </button>
      )}
    >
      {({ close }) =>
        open ? (
          <RefList
            repo={repo}
            value={value}
            branchesOnly={branchesOnly}
            onSelect={(name, picked) => {
              close();
              onSelect(name, picked);
            }}
          />
        ) : null
      }
    </Popover>
  );
}

function RefList({
  repo,
  value,
  branchesOnly,
  onSelect,
}: {
  repo: RepoRef;
  value: string;
  branchesOnly: boolean;
  onSelect: (name: string, kind: "branch" | "tag") => void;
}) {
  const listId = useId();
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<"branch" | "tag">("branch");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  // The whole list once, filtered here: typing should not wait on the network.
  const refs = useQuery(queries.contents.listRefs({ params: repo, query: { limit: 100 } }));

  const words = filter.trim().toLowerCase();
  const all = tab === "branch" ? (refs.data?.branches ?? []) : (refs.data?.tags ?? []);
  const items = all.filter((ref) => ref.name.toLowerCase().includes(words));
  const truncated =
    tab === "branch" ? refs.data?.branchesTruncated === true : refs.data?.tagsTruncated === true;
  const index = Math.min(active, Math.max(0, items.length - 1));

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length === 0) return;
      const next =
        event.key === "ArrowDown"
          ? (index + 1) % items.length
          : (index - 1 + items.length) % items.length;
      setActive(next);
      list.current?.children[next]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const picked = items[index];
      if (picked) onSelect(picked.name, tab);
    }
  };

  return (
    <div role="dialog" aria-label="Switch branch or tag">
      <div className="border-b border-border p-2">
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={items[index] ? `${listId}-${index}` : undefined}
          aria-label={tab === "branch" ? "Filter branches" : "Filter tags"}
          placeholder={tab === "branch" ? "Find a branch" : "Find a tag"}
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="w-full rounded border border-border bg-surface px-2 py-1 text-xs text-on-surface placeholder:text-on-surface-faint focus:border-border-strong focus:outline-none"
        />
      </div>
      {branchesOnly ? null : (
        <div role="group" aria-label="Kind of ref" className="flex border-b border-border px-2">
          {(["branch", "tag"] as const).map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={tab === name}
              onClick={() => {
                setTab(name);
                setActive(0);
              }}
              className={`-mb-px border-b-2 px-2 py-1.5 text-xs font-medium ${
                tab === name
                  ? "border-accent text-on-surface"
                  : "border-transparent text-on-surface-muted hover:text-on-surface"
              }`}
            >
              {name === "branch" ? "Branches" : "Tags"}
            </button>
          ))}
        </div>
      )}
      {refs.data === undefined ? (
        <Loading shape="inline" />
      ) : (
        <ul
          ref={list}
          id={listId}
          role="listbox"
          aria-label={tab === "branch" ? "Branches" : "Tags"}
          className="max-h-64 overflow-y-auto py-1"
        >
          {items.map((ref, position) => {
            const current = ref.name === value;
            return (
              <li
                key={ref.name}
                id={`${listId}-${position}`}
                role="option"
                aria-selected={current}
                onClick={() => onSelect(ref.name, tab)}
                onMouseEnter={() => setActive(position)}
                className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-on-surface ${
                  position === index ? "bg-surface-sunken" : ""
                }`}
              >
                <Icon name="check" size={12} className={current ? "" : "invisible"} />
                <span className="min-w-0 flex-1 truncate">{ref.name}</span>
                {tab === "branch" && ref.name === refs.data.defaultBranch ? (
                  <span className="rounded border border-border px-1 text-[10px] text-on-surface-muted">
                    default
                  </span>
                ) : null}
              </li>
            );
          })}
          {items.length === 0 ? (
            <li className="px-3 py-3 text-xs text-on-surface-muted">
              {tab === "branch" ? "No branches match" : "No tags match"}
            </li>
          ) : null}
          {truncated ? (
            <li className="px-3 py-1.5 text-xs text-on-surface-faint">
              More exist than are listed
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
