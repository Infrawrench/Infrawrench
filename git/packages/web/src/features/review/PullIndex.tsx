/**
 * What a pull request's address shows, by the reader's mode: the branch page
 * or the conversation, and for `/files` the diff the branch page already has.
 */
import { useEffect } from "react";
import { useGo } from "../../components/AppLink";
import { Loading } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import { paths } from "../../lib/paths";
import { ConversationTab } from "../pulls/ConversationTab";
import { FilesTab } from "../pulls/FilesTab";
import { usePull, usePullMode } from "../pulls/PullLayout";
import type { DiffMode } from "./branch";
import { BranchPage } from "./BranchPage";

export function PullIndex({ v, diff }: { v: number | undefined; diff: DiffMode | undefined }) {
  return usePullMode() === "agent" ? <BranchPage v={v} diff={diff} /> : <ConversationTab />;
}

/** The files tab. On the branch page the diff is the page: a link here lands on it, anchor kept. */
export function PullFiles() {
  const repo = useRepoRef();
  const pull = usePull();
  const go = useGo();
  const agent = usePullMode() === "agent";
  useEffect(() => {
    if (agent) go(`${paths.pull(repo, pull.number)}${window.location.hash}`, { replace: true });
  }, [agent, go, repo, pull.number]);
  return agent ? <Loading shape="code" /> : <FilesTab />;
}
