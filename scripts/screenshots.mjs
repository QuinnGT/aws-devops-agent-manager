// Captures the screenshots in docs/images from a running app that holds the sample data.
//
//   pnpm demo:seed                                   # fill a dam_* database (see docs/development.md)
//   <start the app on that database, signed in as the space owner>
//   pnpm screenshots http://127.0.0.1:3001 [docs/images] [--space <alias>]
//
// Each page is captured at 1440x900 in the light theme, and the three that the
// README shows at the top also in the dark theme (<name>-dark.png). Asset,
// plan, release, audit, finding and revision IDs are read from the app's own
// pages, so the script works on any database the seed filled. It does not
// click anything that writes.
//
// It drives the Google Chrome you have installed (playwright-core downloads no
// browser). Set CHROME_PATH to use a different Chrome or Chromium binary.
// Run it soon after the seed: the sync status line reads "Synced 3 min ago",
// and it turns to a warning once the last sync is older than twice the interval.
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const MAX_BYTES = 400 * 1024;
const VIEWPORT = { width: 1440, height: 900 };

const args = process.argv.slice(2);
const spaceFlag = args.indexOf("--space");
const spaceArg = spaceFlag >= 0 ? args.splice(spaceFlag, 2)[1] : undefined;
const [baseArg, outArg = "docs/images"] = args;
if (!baseArg || baseArg.startsWith("-")) {
  console.error("Usage: node scripts/screenshots.mjs <base URL> [output folder] [--space <alias>]");
  console.error("Example: pnpm screenshots http://127.0.0.1:3001");
  process.exit(2);
}
const base = new URL(baseArg);
if (base.protocol !== "http:" && base.protocol !== "https:") {
  console.error(`The base URL must start with http:// or https://, not ${base.protocol}`);
  process.exit(2);
}
const outDir = path.resolve(outArg);

const unescapeHtml = (s) => s.replaceAll("&amp;", "&");
const textOf = (html) => html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const hrefs = (html, re) => [...new Set([...html.matchAll(re)].map((m) => unescapeHtml(m[1])))];

const browser = await chromium
  .launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
    args: ["--hide-scrollbars"],
  })
  .catch((err) => {
    console.error(`Could not start Chrome: ${err.message.split("\n")[0]}`);
    console.error("Install Google Chrome, or set CHROME_PATH to a Chrome or Chromium binary.");
    process.exit(1);
  });

const context = await browser.newContext({ viewport: VIEWPORT, timezoneId: "UTC", locale: "en-US", reducedMotion: "reduce" });
// The app formats times in the zone its "tz" cookie names; a fixed zone keeps the images the same on every machine.
await context.addCookies([{ name: "tz", value: "UTC", url: base.origin }]);
const page = await context.newPage();

async function html(p) {
  const res = await context.request.get(new URL(p, base).href);
  if (!res.ok()) throw new Error(`GET ${p} answered ${res.status()}`);
  return res.text();
}

/** Finds what to capture by reading the app's own pages. */
async function discover() {
  const alias = spaceArg ?? hrefs(await html("/spaces"), /href="\/spaces\/([^"/?#]+)"/g).find((a) => a !== "new");
  if (!alias) throw new Error("No space found. Seed the database first (pnpm demo:seed).");
  const space = `/spaces/${alias}`;
  const links = (body, re) => hrefs(body, new RegExp(`href="(${space.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${re})"`, "g"));

  // Asset: the one with the most recorded versions, on the comparison of its two newest.
  const assetLinks = links(await html(`${space}/assets`), "/assets/[^\"/?#]+").slice(0, 60);
  let asset = null;
  for (const link of assetLinks) {
    const body = await html(`${link}?tab=versions`);
    const versions = Number(body.match(/tab=versions">Versions<span[^>]*>(\d+)</)?.[1] ?? 0);
    if (asset && versions <= asset.versions) continue;
    const compare = hrefs(body, /href="([^"]*tab=versions&amp;from=\d+&amp;to=\d+)"/g)[0];
    asset = { link: compare ?? `${link}?tab=versions`, versions };
  }
  if (!asset) throw new Error("No asset found");

  // Plan: the first open plan, else the first plan of any state.
  const plan =
    links(await html(`${space}/plans`), "/plans/[0-9a-f-]{36}")[0] ?? links(await html(`${space}/plans?status=all`), "/plans/[0-9a-f-]{36}")[0];
  if (!plan) throw new Error("No plan found");

  // Release: the newest one, on its Verification tab.
  const release = links(await html(`${space}/releases`), "/releases/[^\"/?#]+")[0];
  if (!release) throw new Error("No release found");

  // Audit flow: the audit with the most investigations, on its page with the flow strip.
  // Review files: an audit whose reviews come back as review files (it offers "Download all review files").
  let audit = null;
  let reviewFiles = null;
  for (const link of links(await html(`${space}/audits`), "/audits/[0-9a-f-]{36}")) {
    const body = await html(link);
    const items = [...body.matchAll(/<a [^>]*href="([^"]+\/items\/[0-9a-f-]{36})"[^>]*>([^<]*)</g)].filter((m) => /^INCIDENT-\d+$/.test(m[2].trim()));
    if (items.length && (!audit || items.length > audit.count)) audit = { link, count: items.length };
    if (!reviewFiles && textOf(body).includes("Download all review files")) reviewFiles = link;
  }
  if (!audit) throw new Error("No audit with investigations found");
  if (!reviewFiles) throw new Error("No audit reviewed with review files found");

  // Audit record: the report tab of an audit whose record is saved.
  const saved = links(await html(`${space}/audits?state=finalized`), "/audits/[0-9a-f-]{36}")[0];
  if (!saved) throw new Error("No audit with a saved record found");

  // Revision editor: the revision with the most findings to address, then the most saves, whose build passed, on a file it edited.
  let revision = null;
  for (const link of links(await html(`${space}/revisions`), "/revisions/[^\"/?#]+")) {
    const body = await html(link);
    const text = textOf(body);
    const saves = Number(text.match(/(\d+) saves?/)?.[1] ?? 0);
    const toAddress = Number(body.match(/rev-to-address-h[\s\S]*?tabular-nums">(\d+)</)?.[1] ?? 0);
    const score = toAddress * 1000 + saves;
    if (!text.includes(" Ready ") || (revision && score <= revision.score)) continue;
    const edited = body
      .split("<a ")
      .filter((s) => s.startsWith('href="?file='))
      .map((s) => ({ href: unescapeHtml(s.match(/^href="([^"]+)"/)[1]), edited: textOf(s.slice(0, s.indexOf("</a>"))).includes("Edited") }))
      .filter((f) => f.edited && !f.href.endsWith(".zip"));
    const file = edited.find((f) => !f.href.includes("README")) ?? edited[0];
    // A finding the revision lists (to address, or linked by a save), for the Findings tab.
    const finding = hrefs(body, new RegExp(`href="(${space.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/audits/[0-9a-f-]{36}/findings\\?finding=[0-9a-f-]{36})"`, "g"))[0];
    revision = { link: file ? `${link}${file.href}` : link, score, finding };
  }
  if (!revision) throw new Error("No revision with a passing build found");

  return {
    "space-home": { url: space, dark: true },
    "plan-review": { url: plan, dark: true },
    "audit-flow": { url: audit.link, dark: true },
    // Scrolled so the list and the selected finding fill the frame under the tabs and filters.
    findings: { url: revision.finding ?? `${audit.link}/findings`, scrollTo: { selector: '[aria-label="Findings list"]', top: 185 } },
    "revision-editor": { url: revision.link },
    "review-files": { url: reviewFiles },
    "audit-record": { url: `${saved}/report` },
    "release-verification": { url: `${release}/verification` },
    "asset-history": { url: asset.link },
  };
}

async function capture(name, { url, scrollTo }, scheme) {
  await page.emulateMedia({ colorScheme: scheme });
  const res = await page.goto(new URL(url, base).href, { waitUntil: "networkidle" });
  if (!res || !res.ok()) throw new Error(`${url} answered ${res?.status()}`);
  // Route loading states are skeletons; wait until the page has its data.
  await page.waitForFunction(() => !document.querySelector('[data-slot="skeleton"]'), null, { timeout: 15000 });
  if (!(await page.locator("h1").count())) throw new Error(`${url} has no heading`);
  if (scrollTo) {
    // Scroll the page so the element's top is `top` pixels from the top of the viewport.
    const found = await page.evaluate(({ selector, top }) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - top);
      return true;
    }, scrollTo);
    if (!found) throw new Error(`${url} has no ${scrollTo.selector}`);
  }
  const body = await page.locator("body").innerText();
  if (/Application error|This page couldn.t load|Internal Server Error/i.test(body)) throw new Error(`${url} shows an error page`);
  const file = path.join(outDir, scheme === "dark" ? `${name}-dark.png` : `${name}.png`);
  await page.screenshot({ path: file });
  const { size } = await stat(file);
  console.log(`${path.relative(process.cwd(), file)}  ${Math.round(size / 1024)} KB${size > MAX_BYTES ? "  (over 400 KB)" : ""}`);
  return size <= MAX_BYTES;
}

let ok = true;
try {
  await mkdir(outDir, { recursive: true });
  const shots = await discover();
  for (const [name, shot] of Object.entries(shots)) {
    for (const scheme of shot.dark ? ["light", "dark"] : ["light"]) ok = (await capture(name, shot, scheme)) && ok;
  }
} catch (err) {
  console.error(err.message);
  ok = false;
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
