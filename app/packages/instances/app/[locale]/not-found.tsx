"use client";

import Link from "next/link";
import { useGT, useLocale } from "gt-react";
import { localePath } from "@/lib/i18n/locales";

export default function NotFound() {
  const gt = useGT();
  const example = localePath(useLocale(), "/aws/ec2/m5.large");
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-[1280px] px-4 py-16 sm:px-7">
      <h1 className="text-2xl font-bold">{gt("Not found")}</h1>
      <p className="mt-2 text-ink-2">
        {gt("There is no such instance type. Pages live at {pattern}, for example", {
          pattern: "/aws/<platform>/<instance>",
        })}{" "}
        <Link className="text-accent hover:text-accent-hover underline" href={example}>
          {example}
        </Link>
      </p>
    </main>
  );
}
