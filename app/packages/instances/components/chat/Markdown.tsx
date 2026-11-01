"use client";

import Link from "next/link";
import { useLocale } from "gt-react";
import { Fragment, type ReactNode } from "react";
import { localePath } from "@/lib/i18n/locales";

/**
 * The subset of Markdown the chat's answers use: paragraphs, headings, bullet
 * and numbered lists, tables, code blocks, and inline bold, italics, code and
 * links. Never raw HTML. Site links (`/aws/ec2/m7g.large`) stay in the
 * visitor's language and navigate client-side; other links must be https.
 */

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*)/g;

function Inline({ text, locale }: { text: string; locale: string }) {
  const parts = text.split(INLINE);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          return (
            <code key={i} className="rounded bg-surface-2 px-1 py-0.5 text-[0.9em]">
              {part.slice(1, -1)}
            </code>
          );
        }
        const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
        if (link) {
          const [, label, href] = link as unknown as [string, string, string];
          if (href.startsWith("/") && !href.startsWith("//")) {
            return (
              <Link key={i} href={localePath(locale, href)} className="text-accent hover:underline">
                {label}
              </Link>
            );
          }
          if (/^https:\/\//.test(href)) {
            return (
              <a
                key={i}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                {label}
              </a>
            );
          }
          return <Fragment key={i}>{label}</Fragment>;
        }
        if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
          return <em key={i}>{part.slice(1, -1)}</em>;
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

export function Markdown({ text }: { text: string }) {
  const locale = useLocale();
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  const key = () => blocks.length;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      blocks.push(
        <pre key={key()} className="overflow-x-auto rounded-md bg-surface-2 p-3 text-xs">
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <p key={key()} className="font-semibold text-ink">
          <Inline text={heading[2]!} locale={locale} />
        </p>,
      );
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) body.push(cells(lines[i++]!));
      blocks.push(
        <div key={key()} className="overflow-x-auto">
          <table className="text-sm">
            <thead>
              <tr>
                {head.map((h, j) => (
                  <th key={j} className="border-b border-line px-2 py-1 text-left font-semibold">
                    <Inline text={h} locale={locale} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={r}>
                  {row.map((c, j) => (
                    <td key={j} className="border-b border-line px-2 py-1 tabular-nums">
                      <Inline text={c} locale={locale} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const bullet = /^\s*[-*]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const pattern = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && pattern.test(lines[i]!))
        items.push(lines[i++]!.replace(pattern, ""));
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={key()} className={`${ordered ? "list-decimal" : "list-disc"} space-y-1 pl-5`}>
          {items.map((item, j) => (
            <li key={j}>
              <Inline text={item} locale={locale} />
            </li>
          ))}
        </Tag>,
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !lines[i]!.startsWith("```") &&
      !/^#{1,4}\s/.test(lines[i]!) &&
      !bullet.test(lines[i]!) &&
      !numbered.test(lines[i]!)
    ) {
      para.push(lines[i++]!);
    }
    blocks.push(
      <p key={key()}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            <Inline text={p} locale={locale} />
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="space-y-3 leading-relaxed">{blocks}</div>;
}
