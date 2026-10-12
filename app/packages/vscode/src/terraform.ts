import * as vscode from "vscode";
import {
  findTerraformResourceBlocks,
  lookupTerraformBlock,
  webIacUrl,
  type IacAddressMatch,
  type TerraformResourceBlock,
} from "@infrawrench/client-core";
import { TtlCache } from "./cache";
import { readConfig } from "./config";
import type { IacIndexService } from "./iac-index";
import { commandLink, escapeMarkdown } from "./markdown";
import type { OpenResourceArgs } from "./open";
import {
  RESOURCE_SECTIONS,
  lensSummary,
  loadSections,
  renderResource,
  type SectionCaches,
  type SectionContext,
} from "./sections";
import type { Session } from "./session";

export const TERRAFORM_SELECTOR: vscode.DocumentSelector = [
  { language: "terraform" },
  { scheme: "file", pattern: "**/*.tf" },
];

/** Resources rendered in full in one hover; the rest are listed by name. */
const HOVER_DETAIL_LIMIT = 5;

const blockCache = new WeakMap<
  vscode.TextDocument,
  { version: number; blocks: TerraformResourceBlock[] }
>();

function blocksOf(document: vscode.TextDocument): TerraformResourceBlock[] {
  const hit = blockCache.get(document);
  if (hit && hit.version === document.version) return hit.blocks;
  const blocks = findTerraformResourceBlocks(document.getText());
  blockCache.set(document, { version: document.version, blocks });
  return blocks;
}

function openArgs(m: IacAddressMatch): OpenResourceArgs {
  return {
    accountId: m.resource.accountId,
    pluginId: m.resource.pluginId,
    resourceTypeId: m.resource.resourceTypeId,
    resourceId: m.resource.resourceId,
  };
}

export const ENABLED_HOVER_COMMANDS = [
  "infrawrench.openResource",
  "infrawrench.openService",
  "infrawrench.copyText",
  "infrawrench.signIn",
];

export function createSectionCaches(): SectionCaches {
  return {
    posture: new TtlCache(2 * 60 * 1000),
    perResource: new TtlCache(2 * 60 * 1000),
  };
}

export class TerraformHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly session: Session,
    private readonly iac: IacIndexService,
    private readonly caches: SectionCaches,
  ) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | null> {
    const block = blocksOf(document).find((b) => b.line === position.line);
    if (!block) return null;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ENABLED_HOVER_COMMANDS };
    md.supportHtml = false;
    md.appendMarkdown(`**Infrawrench** · \`${block.address}\`\n\n`);

    const api = this.session.api;
    const orgId = this.session.orgId;
    const loading = this.iac.get();
    if (!api || !orgId || !loading) {
      md.appendMarkdown(
        `${commandLink("Sign in", "infrawrench.signIn", [])} to see the live resource this block manages.`,
      );
      return new vscode.Hover(md);
    }
    let loaded;
    try {
      loaded = await loading;
    } catch (err) {
      md.appendMarkdown(
        `Couldn't load Terraform state from Infrawrench: ${escapeMarkdown(String(err instanceof Error ? err.message : err))}`,
      );
      return new vscode.Hover(md);
    }
    const iacPage = webIacUrl(this.session.cloudUrl, orgId);
    if (loaded.states.length === 0) {
      md.appendMarkdown(
        `No Terraform state is uploaded to this organization, so blocks can't be tied to live resources. [Upload one](${iacPage}).`,
      );
      return new vscode.Hover(md);
    }
    const matches = lookupTerraformBlock(loaded.index, block);
    if (matches.length === 0) {
      md.appendMarkdown(
        `No live resource matched in ${loaded.states.length} uploaded state(s). The block may not be applied yet, or its state is not uploaded. [Open IaC](${iacPage})`,
      );
      return new vscode.Hover(md);
    }

    const detailed = matches.slice(0, HOVER_DETAIL_LIMIT);
    const ctx: SectionContext = { api, orgId, caches: this.caches };
    const sections = await loadSections(
      ctx,
      detailed.map((m) => m.resource),
    );
    md.appendMarkdown(
      matches.length === 1
        ? `Manages 1 live resource (state "${escapeMarkdown(matches[0]!.state.label)}").\n\n`
        : `Manages ${matches.length} live resources.\n\n`,
    );
    for (const m of detailed) {
      const r = m.resource;
      md.appendMarkdown("---\n\n");
      md.appendMarkdown(`**${escapeMarkdown(r.displayName)}** · \`${m.address}\`\n\n`);
      for (const line of renderResource(sections, r)) md.appendMarkdown(`${line}\n\n`);
      const links = [
        commandLink("Open in Infrawrench", "infrawrench.openResource", [openArgs(m)]),
        commandLink("Copy ID", "infrawrench.copyText", [r.resourceId]),
      ];
      if (r.externalId)
        links.push(commandLink("Copy provider ID", "infrawrench.copyText", [r.externalId]));
      md.appendMarkdown(`${links.join(" · ")}\n\n`);
    }
    if (matches.length > detailed.length) {
      md.appendMarkdown("---\n\n");
      for (const m of matches.slice(HOVER_DETAIL_LIMIT)) {
        md.appendMarkdown(
          `- ${commandLink(m.resource.displayName, "infrawrench.openResource", [openArgs(m)])} \`${m.address}\`\n`,
        );
      }
    }
    const failed = [...sections.failures.keys()];
    if (failed.length > 0) {
      md.appendMarkdown(`\n\n_Not shown (no access or unavailable): ${failed.join(", ")}._`);
    }
    return new vscode.Hover(md);
  }
}

interface BlockLens extends vscode.CodeLens {
  block: TerraformResourceBlock;
  matches: IacAddressMatch[];
}

export class TerraformCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(
    private readonly session: Session,
    private readonly iac: IacIndexService,
    private readonly caches: SectionCaches,
  ) {
    iac.onDidChange(() => this.changed.fire());
    session.onDidChange(() => this.changed.fire());
  }

  refresh(): void {
    this.changed.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!readConfig().codeLensEnabled) return [];
    const loading = this.iac.get();
    if (!loading) return [];
    let loaded;
    try {
      loaded = await loading;
    } catch {
      return [];
    }
    if (loaded.states.length === 0) return [];
    const lenses: vscode.CodeLens[] = [];
    for (const block of blocksOf(document)) {
      const range = new vscode.Range(block.line, block.startColumn, block.line, block.endColumn);
      const matches = lookupTerraformBlock(loaded.index, block);
      if (matches.length === 0) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "Infrawrench: no live resource",
            tooltip: "No uploaded Terraform state records this block.",
            command: "",
          }),
        );
        continue;
      }
      const head = new vscode.CodeLens(range, {
        title:
          matches.length === 1
            ? `Infrawrench: ${matches[0]!.resource.displayName}`
            : `Infrawrench: ${matches.length} live resources`,
        command: "infrawrench.openBlock",
        arguments: [matches.map(openArgsWithName)],
      });
      lenses.push(head);
      // Resolved lazily (only for visible lenses): cost, service, findings.
      lenses.push(Object.assign(new vscode.CodeLens(range), { block, matches }) as BlockLens);
    }
    return lenses;
  }

  async resolveCodeLens(lens: vscode.CodeLens): Promise<vscode.CodeLens> {
    const { matches } = lens as Partial<BlockLens>;
    const api = this.session.api;
    const orgId = this.session.orgId;
    if (!matches || !api || !orgId) {
      lens.command = { title: "", command: "" };
      return lens;
    }
    const sections = RESOURCE_SECTIONS.filter((s) => s.lens);
    const resources = matches.slice(0, HOVER_DETAIL_LIMIT).map((m) => m.resource);
    const loaded = await loadSections({ api, orgId, caches: this.caches }, resources, sections);
    const parts =
      resources.length === 1
        ? lensSummary(loaded, resources[0]!, sections)
        : resources.flatMap((r) => lensSummary(loaded, r, sections).slice(0, 1));
    lens.command = {
      title: parts.length > 0 ? parts.join(" · ") : "no cost data or findings",
      command: "",
    };
    return lens;
  }
}

export interface NamedOpenArgs extends OpenResourceArgs {
  displayName: string;
  address: string;
}

function openArgsWithName(m: IacAddressMatch): NamedOpenArgs {
  return { ...openArgs(m), displayName: m.resource.displayName, address: m.address };
}
