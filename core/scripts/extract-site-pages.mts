/**
 * Extracts the site's own public pages that GAIA should know (Terms, Privacy,
 * the Company/Team page) from the site's content modules into
 * canon/site-pages.json, which build-library.mjs chunks next to the GitBook.
 * The site lives in its own repository (Seasons-SEAS/seasons-web); point
 * SEASONS_SITE_DIR at a checkout of it (default: the usual sibling path).
 *   SEASONS_SITE_DIR=../seasons-web npx tsx scripts/extract-site-pages.mts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const site = resolve(
  process.env.SEASONS_SITE_DIR ?? new URL("../../../Seasons OTC/seasons-wtf", import.meta.url).pathname,
);
const load = (file: string) => import(pathToFileURL(resolve(site, file)).href);
const { companyPages } = await load("content/pages/company.ts");
const { privacyDoc } = await load("content/legal/privacy.ts");
const { termsDoc } = await load("content/legal/terms.ts");

type Section = { heading: string; text: string };
type Page = { title: string; url: string; sections: Section[] };

/** Every string in a content tree, in order. */
const strings = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === "object"
        ? Object.entries(value)
            .filter(([key]) => !["photo", "linkedin", "href", "icon", "image", "kind", "type", "alt"].includes(key))
            .flatMap(([, v]) => strings(v))
        : [];

type LegalLike = { title: string; intro?: unknown; sections: { heading: string; blocks: unknown }[] };
const legal = (doc: LegalLike, url: string, updated?: string): Page => ({
  title: doc.title,
  url,
  sections: [
    { heading: updated ? `${doc.title} (last updated ${updated})` : doc.title, text: strings(doc.intro).join("\n") },
    ...doc.sections.map((s) => ({ heading: s.heading, text: strings(s.blocks).join("\n") })),
  ].filter((s) => s.text.trim()),
});

const pages: Page[] = [
  legal(termsDoc as unknown as LegalLike, "https://seasons.wtf/legal/terms", (termsDoc as { lastUpdated?: string }).lastUpdated),
  legal(privacyDoc as unknown as LegalLike, "https://seasons.wtf/legal/privacy", (privacyDoc as { lastUpdated?: string }).lastUpdated),
];

// Company pages: the team page lists first names and roles only.
for (const page of companyPages as unknown as { slug: string; title: string; subtitle?: string; sections: unknown[] }[]) {
  const slug = page.slug;
  const sections: Section[] = [];
  for (const section of page.sections as Record<string, unknown>[]) {
    const members = (section.members ?? section.team) as { name: string; role: string; bio?: string }[] | undefined;
    if (Array.isArray(members) && members.length) {
      sections.push({
        heading: String(section.title ?? "Team"),
        text: `The public team page lists these people by first name and role (no surnames): ${members.map((m) => `${m.name} (${m.role})`).join(", ")}.`,
      });
    } else {
      const text = strings(section).join("\n");
      if (text.trim()) sections.push({ heading: String(section.title ?? page.title), text });
    }
  }
  pages.push({ title: `Company › ${page.title}`, url: `https://seasons.wtf/company/${slug}`, sections: [{ heading: page.title, text: page.subtitle ?? "" }, ...sections].filter((s) => s.text.trim()) });
}

const out = new URL("../canon/site-pages.json", import.meta.url);
writeFileSync(out, JSON.stringify({ extracted: new Date().toISOString().slice(0, 10), pages }, null, 2) + "\n");
console.log(`site pages: ${pages.map((p) => `${p.title} (${p.sections.length})`).join(", ")}`);
