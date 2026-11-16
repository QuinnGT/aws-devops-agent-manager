import { PgBoss } from "pg-boss";
import { env } from "@/server/env";

const g = globalThis as unknown as { __damBoss?: Promise<PgBoss> };

/** The shared pg-boss instance (started lazily). Used by the web app to send and the worker to work. */
export function boss(): Promise<PgBoss> {
  g.__damBoss ??= (async () => {
    const b = new PgBoss({ connectionString: env().databaseUrl(), schema: "pgboss" });
    b.on("error", (err) => console.error("[pg-boss]", err));
    await b.start();
    return b;
  })();
  return g.__damBoss;
}

export async function stopBoss(): Promise<void> {
  if (!g.__damBoss) return;
  const b = await g.__damBoss;
  await b.stop({ graceful: true });
  g.__damBoss = undefined;
}
