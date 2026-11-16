/**
 * Small pagination helper for List* operations that use `nextToken`.
 * Generated SDK paginators (paginateListAssets, ...) also exist; use either.
 */
export async function* pages<Req extends { nextToken?: string }, Res extends { nextToken?: string }>(
  call: (req: Req) => Promise<Res>,
  request: Req,
  opts: { maxPages?: number } = {},
): AsyncGenerator<Res> {
  let nextToken: string | undefined = request.nextToken;
  let n = 0;
  do {
    const res = await call({ ...request, nextToken });
    yield res;
    nextToken = res.nextToken;
    n++;
  } while (nextToken && (opts.maxPages === undefined || n < opts.maxPages));
}

/** Run `fn` over `items` with at most `limit` in flight. Results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}
