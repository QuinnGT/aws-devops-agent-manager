ALTER TABLE "export_files" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD COLUMN "summary" jsonb;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "journal_executions" ADD COLUMN "records_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_executions" ADD COLUMN "record_count" integer;--> statement-breakpoint
ALTER TABLE "journal_executions" ADD COLUMN "records_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "journal_imports" ADD COLUMN "stored_path" text;--> statement-breakpoint
ALTER TABLE "journal_imports" ADD COLUMN "size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "journal_imports" ADD COLUMN "job_run_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_imports" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "journal_tasks" ADD COLUMN "import_path" text;--> statement-breakpoint
CREATE INDEX "export_jobs_space_idx" ON "export_jobs" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "journal_imports_sha_idx" ON "journal_imports" USING btree ("space_id","sha256");--> statement-breakpoint
CREATE INDEX "journal_imports_space_idx" ON "journal_imports" USING btree ("space_id","created_at");