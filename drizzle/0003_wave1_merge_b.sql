ALTER TABLE "analyzer_runs" ADD COLUMN "job_run_id" uuid;--> statement-breakpoint
ALTER TABLE "analyzer_runs" ADD COLUMN "record_count" integer;--> statement-breakpoint
ALTER TABLE "analyzer_runs" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "analyzer_runs_input_uq" ON "analyzer_runs" USING btree ("space_id","task_id","analyzer","analyzer_version","input_digest");