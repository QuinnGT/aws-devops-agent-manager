import { sql } from "drizzle-orm";
import { db } from "@/server/db/client";

/** Truncate every app table (not pg-boss). For integration tests on a disposable database. */
export async function truncateAll(): Promise<void> {
  const rows = await db().execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename not like '__drizzle%'`,
  );
  const names = rows.rows.map((r) => `"public"."${r.tablename}"`);
  if (names.length) await db().execute(sql.raw(`truncate ${names.join(", ")} restart identity cascade`));
}
