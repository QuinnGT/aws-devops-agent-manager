import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/server/env";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __damPool?: Pool; __damDb?: Db };

/** Shared pool. In dev, kept on globalThis so hot reload doesn't leak connections. */
export function pool(): Pool {
  globalForDb.__damPool ??= new Pool({ connectionString: env().databaseUrl(), max: 10 });
  return globalForDb.__damPool;
}

/** The Drizzle database. Lazy, so importing this module never opens a connection. */
export function db(): Db {
  globalForDb.__damDb ??= drizzle(pool(), { schema });
  return globalForDb.__damDb;
}

/** Tests only: point the app at another database. */
export async function setDatabaseForTests(connectionString: string): Promise<Db> {
  await globalForDb.__damPool?.end().catch(() => {});
  globalForDb.__damPool = new Pool({ connectionString, max: 5 });
  globalForDb.__damDb = drizzle(globalForDb.__damPool, { schema });
  return globalForDb.__damDb;
}

export async function closeDatabase(): Promise<void> {
  await globalForDb.__damPool?.end();
  globalForDb.__damPool = undefined;
  globalForDb.__damDb = undefined;
}

export { schema };
