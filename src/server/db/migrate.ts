import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDatabase, db } from "./client";

/** Applies ./drizzle migrations. Run by `pnpm db:migrate` and by the container entrypoint. */
async function main() {
  await migrate(db(), { migrationsFolder: "./drizzle" });
  await closeDatabase();
  console.log("migrations applied");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
