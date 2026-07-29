// The "use with your coding agent" modal: one shared skill body
// (agent-skill-body.md) wrapped per harness in that harness's
// instruction-file format, plus the MCP connection snippet for each.
import body from "./agent-skill-body.md?raw";

const MCP_URL = "https://app.infrawrench.com/api/mcp";

const description =
  "Use the infrawrench CLI to inspect accounts, resources, metrics, costs, and deploys from the terminal. Trigger when asked to list or check infrastructure from the shell, script against Infrawrench data (--json), page on-call, push cost rows, or run a deploy.";

const trimmedBody = body.trim();

export interface HarnessSnippet {
  /** Where the snippet goes — a file path, or a "run this" hint. */
  file: string;
  content: string;
}

export interface HarnessVariant {
  id: string;
  label: string;
  skill: HarnessSnippet;
  mcp: HarnessSnippet;
}

export const harnessVariants: HarnessVariant[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    skill: {
      file: ".claude/skills/infrawrench-cli/SKILL.md",
      content: `---
name: infrawrench-cli
description: ${description}
---

${trimmedBody}
`,
    },
    mcp: {
      file: "Run in your terminal",
      content: `claude mcp add --transport http infrawrench ${MCP_URL}
`,
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    skill: {
      file: ".cursor/rules/infrawrench-cli.mdc",
      content: `---
description: ${description}
alwaysApply: false
---

${trimmedBody}
`,
    },
    mcp: {
      file: ".cursor/mcp.json",
      content: `{
  "mcpServers": {
    "infrawrench": {
      "url": "${MCP_URL}"
    }
  }
}
`,
    },
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    skill: {
      file: ".github/instructions/infrawrench-cli.instructions.md",
      content: `---
applyTo: '**'
description: ${description}
---

${trimmedBody}
`,
    },
    mcp: {
      file: ".vscode/mcp.json",
      content: `{
  "servers": {
    "infrawrench": {
      "type": "http",
      "url": "${MCP_URL}"
    }
  }
}
`,
    },
  },
  {
    id: "agents-md",
    label: "Codex & AGENTS.md",
    skill: {
      file: "AGENTS.md (append)",
      content: `${trimmedBody}
`,
    },
    mcp: {
      file: "~/.codex/config.toml",
      content: `[mcp_servers.infrawrench]
url = "${MCP_URL}"
`,
    },
  },
];
