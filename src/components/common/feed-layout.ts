/**
 * Feed row layout, shared by server rows and the client group row. The feed
 * container is a CSS container named "feed": below 672 px of feed width the
 * row stacks (source and time, then the title, then the actions).
 */
export const FEED_ROW =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b px-4 py-2 transition-colors hover:bg-foreground/3 @2xl/feed:grid-cols-[120px_minmax(0,1fr)_auto_auto] @2xl/feed:pr-3";

export const FEED_SLOTS = {
  source: "col-start-1 row-start-1",
  main: "col-span-2 row-start-2 min-w-0 @2xl/feed:col-span-1 @2xl/feed:col-start-2 @2xl/feed:row-start-1",
  time: "col-start-2 row-start-1 justify-self-end text-[13px] whitespace-nowrap text-muted-foreground @2xl/feed:col-start-3",
  actions: "col-span-2 row-start-3 flex flex-wrap gap-0.5 -ml-2.5 @2xl/feed:col-span-1 @2xl/feed:col-start-4 @2xl/feed:row-start-1 @2xl/feed:ml-0",
} as const;
