CREATE TABLE "revision_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"commit" text NOT NULL,
	"parent_commit" text NOT NULL,
	"changed_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"build_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message" text NOT NULL,
	"finding_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unlinked_reason" text,
	"build_status" text NOT NULL,
	"author" text NOT NULL,
	"author_name" text,
	"job_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"branch" text NOT NULL,
	"package_dir" text NOT NULL,
	"package_name" text NOT NULL,
	"layout" text NOT NULL,
	"base_kind" text NOT NULL,
	"base_ref" text NOT NULL,
	"base" jsonb NOT NULL,
	"base_commit" text,
	"created_commit" text,
	"head_commit" text,
	"state" text DEFAULT 'creating' NOT NULL,
	"state_reason" text,
	"note" text,
	"latest_build" jsonb,
	"create_run_id" uuid,
	"last_save_run_id" uuid,
	"plan_id" uuid,
	"planned_commit" text,
	"plan_claimed_at" timestamp with time zone,
	"release_id" uuid,
	"release_name" text,
	"release_run_id" uuid,
	"release_error" text,
	"created_by" text NOT NULL,
	"abandoned_by" text,
	"abandoned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"trigger" text NOT NULL,
	"requested_by" text NOT NULL,
	"result" jsonb,
	"blocked_reason" text,
	"message" text,
	"investigations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"investigation_count" integer DEFAULT 0 NOT NULL,
	"job_run_id" uuid,
	"triggered_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_items" ADD COLUMN "analyzed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audit_items" ADD COLUMN "analyzer_errors" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_items" ADD COLUMN "review_job_run_id" uuid;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "carried_from_id" uuid;--> statement-breakpoint
ALTER TABLE "revision_changes" ADD CONSTRAINT "revision_changes_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "revision_changes_commit_uq" ON "revision_changes" USING btree ("revision_id","commit");--> statement-breakpoint
CREATE INDEX "revision_changes_revision_idx" ON "revision_changes" USING btree ("revision_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "revisions_space_name_uq" ON "revisions" USING btree ("space_id","name_key");--> statement-breakpoint
CREATE INDEX "revisions_space_idx" ON "revisions" USING btree ("space_id","state","updated_at");--> statement-breakpoint
CREATE INDEX "revisions_plan_idx" ON "revisions" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "verification_runs_release_idx" ON "verification_runs" USING btree ("space_id","release_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "verification_runs_space_idx" ON "verification_runs" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "findings_item_idx" ON "findings" USING btree ("audit_item_id","review_id");