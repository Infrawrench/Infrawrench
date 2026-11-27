/**
 * Sending a finding back to the agent that wrote the branch
 * (`git_instructions`, source `finding`).
 *
 * This is the one place a finding becomes an instruction, shared by the
 * review runner (must-fix findings on an agent's branch go back on their
 * own), `findings.report` (the same, for a reviewer outside the forge) and
 * `instructions.send` when a person sends one by hand. It only writes the
 * row, `queued`: delivery to the agent is the instruction handlers' business.
 */
import { and, eq, inArray } from "drizzle-orm";
import { gitInstructions } from "@infrawrench/server-core/db/schema";
import { db, newId } from "./client";
import type { FindingRow } from "./findings";

export type InstructionRow = typeof gitInstructions.$inferSelect;

const lineRange = (finding: Pick<FindingRow, "startLine" | "endLine">): string => {
  if (finding.startLine === null) return "";
  return finding.endLine !== null && finding.endLine !== finding.startLine
    ? `:${finding.startLine}-${finding.endLine}`
    : `:${finding.startLine}`;
};

/**
 * What the agent is told about a finding: its severity and title, where it
 * is, what the reviewer wrote and how it knows. Markdown. `note` is what a
 * person added when they sent it.
 */
export const findingInstructionBody = (
  finding: Pick<
    FindingRow,
    | "severity"
    | "title"
    | "body"
    | "path"
    | "startLine"
    | "endLine"
    | "evidence"
    | "reviewerKind"
    | "lastSeenVersionNumber"
  >,
  note?: string | undefined,
): string => {
  const severity = { must_fix: "Must fix", should_fix: "Should fix", note: "Note" }[
    finding.severity
  ];
  const parts = [`**${severity}: ${finding.title}**`];
  if (finding.path !== null) {
    parts.push(
      `\`${finding.path}${lineRange(finding)}\` (version ${finding.lastSeenVersionNumber})`,
    );
  }
  if (finding.body.trim() !== "") parts.push(finding.body.trim());
  for (const evidence of finding.evidence) {
    const fence = evidence.text.includes("```") ? "````" : "```";
    parts.push(
      `Evidence (${evidence.kind})${evidence.url ? `, ${evidence.url}` : ""}:\n${fence}\n${evidence.text}\n${fence}`,
    );
  }
  parts.push(`Found by the ${finding.reviewerKind} reviewer.`);
  if (note !== undefined && note.trim() !== "") parts.push(note.trim());
  return parts.join("\n\n");
};

/**
 * Queue an instruction for each of these findings that is open and not
 * already with the agent or on its way (queued or delivered).
 * `createdByUserId` is null when the forge sends it on its own. Answers the
 * rows written.
 *
 * Safe to repeat: a second call for the same findings writes nothing.
 */
export const queueFindingInstructions = async (input: {
  readonly repositoryId: string;
  readonly pullRequestId: string;
  readonly findings: readonly FindingRow[];
  readonly createdByUserId: string | null;
  readonly note?: string | undefined;
}): Promise<InstructionRow[]> => {
  const findings = input.findings.filter((finding) => finding.status === "open");
  if (findings.length === 0) return [];
  const out = await db
    .select({ findingId: gitInstructions.findingId })
    .from(gitInstructions)
    .where(
      and(
        eq(gitInstructions.pullRequestId, input.pullRequestId),
        inArray(
          gitInstructions.findingId,
          findings.map((finding) => finding.id),
        ),
        inArray(gitInstructions.status, ["queued", "delivered"]),
      ),
    );
  const withAgent = new Set(out.map((row) => row.findingId));
  const rows = findings
    .filter((finding) => !withAgent.has(finding.id))
    .map((finding) => ({
      id: newId(),
      repositoryId: input.repositoryId,
      pullRequestId: input.pullRequestId,
      source: "finding" as const,
      findingId: finding.id,
      body: findingInstructionBody(finding, input.note),
      createdByUserId: input.createdByUserId,
      status: "queued" as const,
    }));
  if (rows.length === 0) return [];
  return db.insert(gitInstructions).values(rows).returning();
};
