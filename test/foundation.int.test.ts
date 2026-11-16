import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { beforeAll, describe, expect, it } from "vitest";
import { recordAuditEvent } from "@/server/audit-log";
import { db } from "@/server/db/client";
import { auditEvents, historyRepos } from "@/server/db/schema";
import { truncateAll } from "./helpers/db";

describe("foundation (database)", () => {
  beforeAll(async () => {
    await migrate(db(), { migrationsFolder: "./drizzle" });
  });

  it("applies migrations and writes the audit log", async () => {
    await truncateAll().catch(() => {});
    await recordAuditEvent({ actor: { email: "t@example.com" }, action: "test.write", details: { ok: true } });
    const rows = await db().select().from(auditEvents).where(eq(auditEvents.action, "test.write"));
    expect(rows).toHaveLength(1);
  });

  it("rejects updates and deletes on audit_events", async () => {
    await expect(db().execute(sql`update audit_events set action = 'x'`)).rejects.toThrow();
    await expect(db().execute(sql`delete from audit_events`)).rejects.toThrow();
  });

  it("creates core rows", async () => {
    const [r] = await db().insert(historyRepos).values({ name: `t-${Date.now()}` }).returning();
    expect(r?.defaultBranch).toBe("main");
  });
});
