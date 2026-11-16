// The "use with your coding agent" modal: per harness, the MCP connection
// snippet and every skill in `skills/`, written in that harness's
// instruction-file format. Claude Code takes a skill as a folder (SKILL.md
// plus its references); the others read one file per rule, so a skill's
// references are appended to it.
import { claudeCodeInstall, skillAsOneFile, skillFiles, skills, type Skill } from "./skills";

const MCP_URL = "https://app.infrawrench.com/api/mcp";

export interface HarnessSnippet {
  /** Where the snippet goes: a file path, or a "run this" hint. */
  file: string;
  content: string;
}

export interface HarnessSkill {
  skill: Skill;
  /** A command that installs every file at once, where the harness has one. */
  install?: HarnessSnippet;
  files: HarnessSnippet[];
}

export interface HarnessVariant {
  id: string;
  label: string;
  mcp: HarnessSnippet;
  skills: HarnessSkill[];
}

interface Harness {
  id: string;
  label: string;
  mcp: HarnessSnippet;
  skill: (skill: Skill) => Omit<HarnessSkill, "skill">;
}

const HARNESSES: Harness[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    mcp: {
      file: "Run in your terminal",
      content: `claude mcp add --transport http infrawrench ${MCP_URL}\n`,
    },
    skill: (s) => ({
      install: { file: "Install: run in your repository", content: claudeCodeInstall(s) },
      files: skillFiles(s).map((f) => ({
        file: `.claude/skills/${s.id}/${f.path}`,
        content: f.content,
      })),
    }),
  },
  {
    id: "cursor",
    label: "Cursor",
    mcp: {
      file: ".cursor/mcp.json",
      content: `{\n  "mcpServers": {\n    "infrawrench": {\n      "url": "${MCP_URL}"\n    }\n  }\n}\n`,
    },
    skill: (s) => ({
      files: [
        {
          file: `.cursor/rules/${s.id}.mdc`,
          content: `---\ndescription: ${s.description}\nalwaysApply: false\n---\n\n${skillAsOneFile(s)}`,
        },
      ],
    }),
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    mcp: {
      file: ".vscode/mcp.json",
      content: `{\n  "servers": {\n    "infrawrench": {\n      "type": "http",\n      "url": "${MCP_URL}"\n    }\n  }\n}\n`,
    },
    skill: (s) => ({
      files: [
        {
          file: `.github/instructions/${s.id}.instructions.md`,
          content: `---\napplyTo: '**'\ndescription: ${s.description}\n---\n\n${skillAsOneFile(s)}`,
        },
      ],
    }),
  },
  {
    id: "agents-md",
    label: "Codex & AGENTS.md",
    mcp: {
      file: "~/.codex/config.toml",
      content: `[mcp_servers.infrawrench]\nurl = "${MCP_URL}"\n`,
    },
    skill: (s) => ({ files: [{ file: "AGENTS.md (append)", content: skillAsOneFile(s) }] }),
  },
];

export const harnessVariants: HarnessVariant[] = HARNESSES.map((h) => ({
  id: h.id,
  label: h.label,
  mcp: h.mcp,
  skills: skills.map((skill) => ({ skill, ...h.skill(skill) })),
}));

/** One skill across every harness, for a modal that offers only that skill. */
export function harnessVariantsFor(
  id: string,
): { id: string; label: string; skill: HarnessSkill }[] {
  return harnessVariants.flatMap((h) => {
    const skill = h.skills.find((s) => s.skill.id === id);
    return skill ? [{ id: h.id, label: h.label, skill }] : [];
  });
}
