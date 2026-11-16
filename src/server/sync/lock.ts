import { pool } from "@/server/db/client";

/**
 * One sync or reconcile per space at a time, across worker processes: a
 * Postgres session advisory lock held on a dedicated connection. The lock is
 * released when the function returns or when the connection drops.
 *
 * pg-boss singletonKey only deduplicates in queues with a singleton-style
 * policy, and the foundation creates standard queues, so this lock is what
 * enforces the rule.
 */
export async function withSpaceLock<T>(
  spaceId: string,
  waitSeconds: number,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const key = `dam:sync:${spaceId}`;
  const client = await pool().connect();
  try {
    const deadline = Date.now() + waitSeconds * 1000;
    let ok = false;
    for (;;) {
      const r = await client.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtextextended($1, 0)) as ok", [key]);
      ok = r.rows[0]?.ok === true;
      if (ok || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, Math.max(50, deadline - Date.now()))));
    }
    if (!ok) return { acquired: false };
    try {
      return { acquired: true, value: await fn() };
    } finally {
      await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
