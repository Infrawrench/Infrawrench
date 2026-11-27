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
export {
  type InstructionRow,
  findingInstructionBody,
  queueFindingInstructions,
} from "@infrawrench/server-core/git-review/findings";
