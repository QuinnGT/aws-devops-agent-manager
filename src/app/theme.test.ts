import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Theme contrast test (design-system MASTER "Verification", item 2).
 *
 * Parses the :root and .dark token blocks in globals.css, converts oklch to
 * sRGB, composites the tints at the percentages MASTER "Tokens" fixes (the
 * browser blends a Tailwind opacity modifier such as bg-src-agent/12 over
 * the surface in gamma-encoded sRGB), and checks WCAG 2 contrast for every
 * listed pair in both themes. Changing a token means running this test.
 */

type Rgba = { r: number; g: number; b: number; a: number };
type Tokens = Record<string, Rgba>;

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

function parseBlock(source: string, selector: ":root" | ".dark"): Record<string, string> {
  const start = source.search(new RegExp(`(^|\\n)${selector.replace(".", "\\.")}\\s*\\{`));
  if (start < 0) throw new Error(`${selector} block not found`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  const body = source.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp = (c: number) => Math.min(1, Math.max(0, c));

/** oklch(L C h [/ a]) to gamma-encoded sRGB in 0..1, clamped to the sRGB gamut. */
function oklchToSrgb(value: string): Rgba {
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/.exec(value);
  if (!m) throw new Error(`not an oklch() value: ${value}`);
  const L = Number(m[1]) / (m[2] ? 100 : 1);
  const C = Number(m[3]);
  const h = (Number(m[4]) * Math.PI) / 180;
  const a = m[5] === undefined ? 1 : Number(m[5]) / (m[6] ? 100 : 1);
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const mm = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s;
  return { r: toGamma(clamp(r)), g: toGamma(clamp(g)), b: toGamma(clamp(bl)), a };
}

/** Source-over compositing of `top` at `alpha` (times its own alpha) onto an opaque `bottom`. */
function over(top: Rgba, bottom: Rgba, alpha = 1): Rgba {
  const a = top.a * alpha;
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
}

const luminance = (c: Rgba) => 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);

function contrast(fg: Rgba, bg: Rgba): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function themeTokens(theme: "light" | "dark", source = css): Tokens {
  const raw = { ...parseBlock(source, ":root"), ...(theme === "dark" ? parseBlock(source, ".dark") : {}) };
  const out: Tokens = {};
  for (const [k, v] of Object.entries(raw)) if (v.startsWith("oklch(")) out[k] = oklchToSrgb(v);
  return out;
}

/** A surface: a token, optionally with a tint of another token at a percentage on top of it. */
type Surface = string | { tint: string; pct: number; on: string };
interface Pair {
  fg: string;
  bg: Surface;
  min: 3 | 4.5;
  what: string;
}

const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 };

function resolve(t: Tokens, s: Surface): Rgba {
  const tok = (name: string) => {
    const c = t[name];
    if (!c) throw new Error(`token --${name} missing`);
    return c;
  };
  if (typeof s === "string") return over(tok(s), WHITE);
  return over(tok(s.tint), resolve(t, s.on), s.pct / 100);
}

const STATUS = ["success", "warning", "info", "destructive"] as const;
const SOURCES = ["src-agent", "src-console", "src-cli", "src-app", "src-unknown"] as const;
const SURFACES = ["background", "card", "muted", "sidebar-accent"] as const;

/** Every pair MASTER "Verification" item 2 lists, at the "Tokens" tint percentages. */
function pairs(): Pair[] {
  const p: Pair[] = [];
  for (const bg of SURFACES) {
    p.push({ fg: "foreground", bg, min: 4.5, what: `text on ${bg}` });
    p.push({ fg: "muted-foreground", bg, min: 4.5, what: `muted text on ${bg}` });
  }
  p.push({ fg: "sidebar-foreground", bg: "sidebar", min: 4.5, what: "sidebar text" });
  p.push({ fg: "muted-foreground", bg: "sidebar", min: 4.5, what: "sidebar group label" });
  p.push({ fg: "sidebar-accent-foreground", bg: "sidebar-accent", min: 4.5, what: "active nav item" });
  p.push({ fg: "primary-foreground", bg: "primary", min: 4.5, what: "primary button" });
  for (const s of STATUS) {
    const fg = `${s}-fg`;
    // Callouts sit on the page background, badges usually on a card: check both surfaces.
    for (const on of ["card", "background"]) {
      p.push({ fg, bg: { tint: s, pct: 7, on }, min: 4.5, what: `${fg} on its callout (7% on ${on})` });
      p.push({ fg: "foreground", bg: { tint: s, pct: 7, on }, min: 4.5, what: `callout text on ${s} (7% on ${on})` });
      p.push({ fg, bg: { tint: s, pct: 12, on }, min: 4.5, what: `${fg} on its badge (12% on ${on})` });
      p.push({ fg, bg: on, min: 4.5, what: `${fg} on ${on}` });
    }
  }
  for (const s of SOURCES) {
    p.push({ fg: s, bg: { tint: s, pct: 12, on: "card" }, min: 4.5, what: `${s} chip on card (12%)` });
    p.push({ fg: s, bg: { tint: s, pct: 12, on: "background" }, min: 4.5, what: `${s} chip on background (12%)` });
    // ChangeChip uses --src-agent as plain text (Set Inactive, Metadata only)
    p.push({ fg: s, bg: "card", min: 4.5, what: `${s} text on card` });
  }
  p.push({ fg: "muted-foreground", bg: "background", min: 3, what: "checkbox border on background" });
  p.push({ fg: "muted-foreground", bg: "card", min: 3, what: "checkbox border on card" });
  const lines = [
    { tint: "success", pct: 14, sign: "success-fg", name: "added line" },
    { tint: "destructive", pct: 10, sign: "destructive-fg", name: "deleted line" },
    { tint: "info", pct: 8, sign: "info-fg", name: "hunk header" },
  ];
  for (const l of lines) {
    const bg = { tint: l.tint, pct: l.pct, on: "card" };
    p.push({ fg: "foreground", bg, min: 4.5, what: `diff text on ${l.name} (${l.pct}%)` });
    p.push({ fg: "muted-foreground", bg, min: 4.5, what: `line number on ${l.name} (${l.pct}%)` });
    p.push({ fg: l.sign, bg, min: 4.5, what: `${l.sign} on ${l.name} (${l.pct}%)` });
  }
  p.push({ fg: "ring", bg: "background", min: 3, what: "focus ring on background" });
  p.push({ fg: "ring", bg: "card", min: 3, what: "focus ring on card" });
  p.push({ fg: "ring", bg: "sidebar", min: 3, what: "focus ring on sidebar" });
  return p;
}

function failures(source: string): string[] {
  const out: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    const t = themeTokens(theme, source);
    for (const pair of pairs()) {
      const ratio = contrast(over(t[pair.fg] ?? WHITE, resolve(t, pair.bg)), resolve(t, pair.bg));
      if (!t[pair.fg]) out.push(`${theme}: token --${pair.fg} missing`);
      else if (ratio < pair.min) out.push(`${theme}: ${pair.what} is ${ratio.toFixed(2)}:1, needs ${pair.min}:1`);
    }
  }
  return out;
}

describe("theme tokens", () => {
  it("converts oklch like a browser", () => {
    const white = oklchToSrgb("oklch(1 0 0)");
    expect(white.r).toBeCloseTo(1, 3);
    const black = oklchToSrgb("oklch(0 0 0)");
    expect(black.g).toBeCloseTo(0, 3);
    // oklch(0.205 0 0) is #171717 in the shadcn neutral theme
    expect(Math.round(oklchToSrgb("oklch(0.205 0 0)").r * 255)).toBe(23);
    expect(oklchToSrgb("oklch(1 0 0 / 10%)").a).toBeCloseTo(0.1, 5);
    expect(contrast(white, black)).toBeCloseTo(21, 1);
  });

  it("defines every token MASTER lists, in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const t = themeTokens(theme);
      for (const name of [...STATUS.map((s) => `${s}-fg`), ...STATUS, ...SOURCES]) expect(t[name], `${theme} --${name}`).toBeDefined();
    }
  });

  it("meets WCAG contrast for every listed pair in light and dark", () => {
    expect(failures(css)).toEqual([]);
  });

  it("fails when a token drops below its threshold", () => {
    const lowered = css.replace("--muted-foreground: oklch(0.5 0 0);", "--muted-foreground: oklch(0.6 0 0);");
    expect(lowered).not.toBe(css);
    expect(failures(lowered).some((f) => f.startsWith("light: muted text on muted"))).toBe(true);
  });
});
