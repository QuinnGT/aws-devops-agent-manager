CREATE TABLE "apply_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"job_run_id" uuid,
	"started_by" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"counts" jsonb,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"commits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"final_commit" text,
	"pushed" boolean DEFAULT false NOT NULL,
	"push_error" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"asset_type" text NOT NULL,
	"asset_id" text,
	"asset_key" text NOT NULL,
	"name" text NOT NULL,
	"origin" text NOT NULL,
	"base_version" integer,
	"base_updated_at" timestamp with time zone,
	"base_commit" text,
	"base_metadata" jsonb,
	"base_content_hash" text,
	"desired" jsonb NOT NULL,
	"validation" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"plan_id" uuid,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"discarded_by" text,
	"discarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"asset_type" text NOT NULL,
	"asset_key" text NOT NULL,
	"name" text NOT NULL,
	"asset_id" text,
	"desired" jsonb,
	"base_version" integer,
	"base_updated_at" timestamp with time zone,
	"remove_metadata_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"draft_id" uuid,
	"change" text,
	"live_version" integer,
	"live_updated_at" timestamp with time zone,
	"conflict" jsonb,
	"metadata_diff" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_diff" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"added_lines" integer DEFAULT 0 NOT NULL,
	"removed_lines" integer DEFAULT 0 NOT NULL,
	"validation" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"validation_status" text,
	"size_meter" jsonb,
	"write_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone,
	"progress" text,
	"progress_message" text,
	"write_started_at" timestamp with time zone,
	"pre_write_version" integer,
	"pre_write_updated_at" timestamp with time zone,
	"write_state" jsonb,
	"written_version" integer,
	"written_updated_at" timestamp with time zone,
	"verification" jsonb,
	"commit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"title" text NOT NULL,
	"origin" jsonb NOT NULL,
	"origin_kind" text NOT NULL,
	"state" text DEFAULT 'checking' NOT NULL,
	"reason" text,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text,
	"check_run_id" uuid,
	"check_requested_by" text,
	"checked_at" timestamp with time zone,
	"check_error" text,
	"summary" jsonb,
	"validation" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_requested_by" text,
	"approval_requested_at" timestamp with time zone,
	"approved_by" text,
	"approved_by_name" text,
	"approved_at" timestamp with time zone,
	"rejected_by" text,
	"rejected_at" timestamp with time zone,
	"reject_note" text,
	"apply_run_id" uuid,
	"apply_started_by" text,
	"apply_started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"result_commit" text,
	"discarded_by" text,
	"discarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tag" text NOT NULL,
	"commit" text NOT NULL,
	"source_commit" text NOT NULL,
	"manifest_path" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"asset_count" integer NOT NULL,
	"note" text,
	"plan_id" text,
	"created_by" text NOT NULL,
	"job_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"source" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"layout" text NOT NULL,
	"package_name" text,
	"status" text NOT NULL,
	"mapping_summary" jsonb,
	"results" jsonb,
	"plan_id" text,
	"imported_by" text NOT NULL,
	"planned_by" text,
	"stored_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"analyzed_at" timestamp with time zone,
	"planned_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"file_deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "apply_runs" ADD CONSTRAINT "apply_runs_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_imports" ADD CONSTRAINT "package_imports_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apply_runs_plan_idx" ON "apply_runs" USING btree ("plan_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "apply_runs_job_uq" ON "apply_runs" USING btree ("job_run_id");--> statement-breakpoint
CREATE INDEX "drafts_space_idx" ON "drafts" USING btree ("space_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "drafts_user_idx" ON "drafts" USING btree ("space_id","created_by","status");--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_open_asset_uq" ON "drafts" USING btree ("space_id","asset_id","created_by") WHERE "drafts"."asset_id" is not null and "drafts"."status" in ('open', 'planned');--> statement-breakpoint
CREATE INDEX "plan_items_plan_idx" ON "plan_items" USING btree ("plan_id","position");--> statement-breakpoint
CREATE INDEX "plans_space_idx" ON "plans" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "plans_state_idx" ON "plans" USING btree ("space_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "releases_space_name_uq" ON "releases" USING btree ("space_id","name");--> statement-breakpoint
CREATE INDEX "releases_space_created_idx" ON "releases" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "package_imports_space_idx" ON "package_imports" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "package_imports_sha_idx" ON "package_imports" USING btree ("space_id","sha256");--> statement-breakpoint
CREATE INDEX "package_imports_expiry_idx" ON "package_imports" USING btree ("expires_at");