import { Linking, Text, View } from "react-native";
import { formatGitForgeBytes, type GitForgeRepository } from "@infrawrench/client-core";
import {
  Card,
  EmptyView,
  ErrorView,
  LoadingView,
  Row,
  Screen,
  SectionTitle,
} from "@/components/ui";
import { colors } from "@/lib/theme";
import { useGitForge } from "./useGitForge";

/** `private · CI passed · 2 open branches · pushed 12 Nov`: what fits under a repository's name. */
function repositorySubtitle(repository: GitForgeRepository): string {
  const parts: string[] = [repository.visibility];
  if (repository.archived) parts.push("archived");
  if (repository.ci) parts.push(`CI ${repository.ci.status.replace(/_/g, " ")}`);
  const { openBranches } = repository;
  if (openBranches > 0) {
    parts.push(`${openBranches} open branch${openBranches === 1 ? "" : "es"}`);
  }
  parts.push(
    repository.pushedAt
      ? `pushed ${new Date(repository.pushedAt).toLocaleDateString()}`
      : "nothing pushed",
  );
  return parts.join(" · ");
}

function ciColor(status: string | undefined): string {
  if (status === "passed") return colors.success;
  if (status === "failed" || status === "error") return colors.danger;
  return colors.textFaint;
}

/**
 * Git: the organisation's namespace on git.infrawrench.com and its
 * repositories, read-only. The forge is its own site, so every row opens it
 * in the browser; claiming or renaming the namespace and the default
 * visibility stay in Settings > Git on web and desktop (KNOWLEDGE.md lists
 * the omission).
 */
export function GitScreen() {
  const git = useGitForge();

  if (git.isLoading && !git.data) return <LoadingView />;
  if (git.isError && !git.data) {
    return (
      <ErrorView
        message={git.error instanceof Error ? git.error.message : "Couldn't load Git."}
        onRetry={() => void git.refetch()}
      />
    );
  }
  const data = git.data;
  if (!data) return <LoadingView />;
  const { overview, repositories } = data;
  const { namespace, usage, limits } = overview;
  if (!namespace) {
    return (
      <EmptyView message="No namespace claimed. Someone with git:admin can claim one under Settings > Git on the web or desktop app." />
    );
  }

  return (
    <Screen onRefresh={() => void git.refetch()} refreshing={git.isRefetching}>
      <SectionTitle>Namespace</SectionTitle>
      <Card list>
        <Row
          title={namespace.slug}
          subtitle={namespace.url.replace(/^https?:\/\//, "")}
          onPress={() => void Linking.openURL(namespace.url)}
        />
        <Row
          title="Private repositories"
          right={
            <Text style={{ color: colors.textMuted }}>
              {limits.privateRepositories === null
                ? usage.privateRepositories
                : `${usage.privateRepositories} of ${limits.privateRepositories}`}
            </Text>
          }
        />
        <Row
          title="Private storage"
          right={
            <Text style={{ color: colors.textMuted }}>
              {formatGitForgeBytes(usage.privateStorageBytes)} of{" "}
              {formatGitForgeBytes(limits.privateStorageBytes)}
            </Text>
          }
        />
      </Card>

      <SectionTitle>Repositories</SectionTitle>
      {repositories.length === 0 ? (
        <EmptyView message="No repositories yet." />
      ) : (
        <Card list>
          {repositories.map((repository) => (
            <Row
              key={repository.id}
              title={repository.name}
              subtitle={repositorySubtitle(repository)}
              right={
                repository.ci ? (
                  <View
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: ciColor(repository.ci.status),
                    }}
                  />
                ) : undefined
              }
              onPress={() => void Linking.openURL(repository.url)}
            />
          ))}
        </Card>
      )}
    </Screen>
  );
}
