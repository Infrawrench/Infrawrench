import { localePath } from "./i18n/locales";

const ORIGIN = "https://instances.infrawrench.com";

/**
 * schema.org BreadcrumbList for the trail above a page (AWS / EC2 / m5.large),
 * so search engines read the page's place in the site from the page itself.
 * Paths are site paths; each becomes an absolute URL in the locale.
 */
export function breadcrumbJsonLd(locale: string, items: { name: string; path: string }[]): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: `${ORIGIN}${localePath(locale, item.path)}`,
    })),
  }).replace(/</g, "\\u003c");
}
