/**
 * Compile a policy glob to an anchored regular expression. `*` matches any
 * run of characters (including none); every other character is literal, so
 * policy text can never inject regex syntax.
 */
export function compileGlob(pattern: string): RegExp {
  const body = pattern
    .split("*")
    .map((part) => part.replace(/[\\^$.|?+()[\]{}/-]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

const cache = new Map<string, RegExp>();

/** compileGlob with a small per-process cache (patterns come from policy and rarely change). */
export function globMatches(pattern: string, value: string): boolean {
  let re = cache.get(pattern);
  if (!re) {
    re = compileGlob(pattern);
    if (cache.size > 500) cache.clear();
    cache.set(pattern, re);
  }
  return re.test(value);
}
