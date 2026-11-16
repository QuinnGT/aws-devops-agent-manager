CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"idp_groups" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alias" text NOT NULL,
	"display_name" text,
	"region" text NOT NULL,
	"account_id" text NOT NULL,
	"agent_space_id" text NOT NULL,
	"read_role_arn" text,
	"write_role_arn" text,
	"external_id" text,
	"aws_profile" text,
	"history_repo_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"connection_status" text DEFAULT 'unknown' NOT NULL,
	"connection_checked_at" timestamp with time zone,
	"connection_detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_spaces_alias_unique" UNIQUE("alias")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_email" text NOT NULL,
	"actor_name" text,
	"action" text NOT NULL,
	"space_id" uuid,
	"target_type" text,
	"target_id" text,
	"result" text DEFAULT 'ok' NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "history_repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"remote_url" text,
	"deploy_key_file" text,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"push_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "history_repos_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue" text NOT NULL,
	"boss_job_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"message" text,
	"actor_email" text NOT NULL,
	"space_id" uuid,
	"input" jsonb,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"history_repo_id" uuid,
	"commit" text,
	"digest" text NOT NULL,
	"content" jsonb NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid,
	"subject_type" text NOT NULL,
	"subject" text NOT NULL,
	"role" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_changes" (
	"space_id" uuid NOT NULL,
	"asset_id" text NOT NULL,
	"service_version" integer NOT NULL,
	"service_updated_at" timestamp with time zone NOT NULL,
	"change_kind" text NOT NULL,
	"commit" text NOT NULL,
	"change_source" text DEFAULT 'unknown' NOT NULL,
	"change_source_label" text,
	"principal" text,
	"cloudtrail_event_id" text,
	"plan_id" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_changes_space_id_asset_id_service_version_service_updated_at_pk" PRIMARY KEY("space_id","asset_id","service_version","service_updated_at")
);
--> statement-breakpoint
CREATE TABLE "asset_index" (
	"space_id" uuid NOT NULL,
	"asset_id" text NOT NULL,
	"asset_type" text NOT NULL,
	"name" text NOT NULL,
	"parent_asset_id" text,
	"live_version" integer,
	"live_updated_at" timestamp with time zone,
	"last_synced_version" integer,
	"last_synced_updated_at" timestamp with time zone,
	"git_path" text,
	"last_commit" text,
	"metadata" jsonb,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	CONSTRAINT "asset_index_space_id_asset_id_pk" PRIMARY KEY("space_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"space_id" uuid PRIMARY KEY NOT NULL,
	"updated_after" timestamp with time zone,
	"last_sync_started_at" timestamp with time zone,
	"last_sync_completed_at" timestamp with time zone,
	"last_reconcile_at" timestamp with time zone,
	"baseline_completed_at" timestamp with time zone,
	"status" text DEFAULT 'never' NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "export_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"export_job_id" uuid NOT NULL,
	"path" text NOT NULL,
	"file_name" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"selection" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"job_run_id" uuid,
	"task_count" integer,
	"record_count" integer,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "journal_executions" (
	"space_id" uuid NOT NULL,
	"execution_id" text NOT NULL,
	"task_id" text NOT NULL,
	"parent_execution_id" text,
	"agent_type" text,
	"agent_sub_task" text,
	"status" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"raw" jsonb,
	CONSTRAINT "journal_executions_space_id_execution_id_pk" PRIMARY KEY("space_id","execution_id")
);
--> statement-breakpoint
CREATE TABLE "journal_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"sha256" text NOT NULL,
	"format" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"parse_report" jsonb,
	"imported_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_records" (
	"space_id" uuid NOT NULL,
	"record_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"task_id" text NOT NULL,
	"seq" integer NOT NULL,
	"record_type" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"content" jsonb,
	"raw" jsonb,
	"size_bytes" bigint,
	CONSTRAINT "journal_records_space_id_record_id_pk" PRIMARY KEY("space_id","record_id")
);
--> statement-breakpoint
CREATE TABLE "journal_tasks" (
	"space_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"incident_id" text,
	"title" text,
	"task_type" text,
	"status" text,
	"priority" text,
	"reference" jsonb,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"source" text NOT NULL,
	"import_id" uuid,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_tasks_space_id_task_id_pk" PRIMARY KEY("space_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "analyzer_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"analyzer" text NOT NULL,
	"analyzer_version" text NOT NULL,
	"input_digest" text NOT NULL,
	"output" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_spaces" ADD CONSTRAINT "agent_spaces_history_repo_id_history_repos_id_fk" FOREIGN KEY ("history_repo_id") REFERENCES "public"."history_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_history_repo_id_history_repos_id_fk" FOREIGN KEY ("history_repo_id") REFERENCES "public"."history_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_changes" ADD CONSTRAINT "asset_changes_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_index" ADD CONSTRAINT "asset_index_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_files" ADD CONSTRAINT "export_files_export_job_id_export_jobs_id_fk" FOREIGN KEY ("export_job_id") REFERENCES "public"."export_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_executions" ADD CONSTRAINT "journal_executions_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_imports" ADD CONSTRAINT "journal_imports_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_records" ADD CONSTRAINT "journal_records_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_tasks" ADD CONSTRAINT "journal_tasks_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_tasks" ADD CONSTRAINT "journal_tasks_import_id_journal_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."journal_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyzer_runs" ADD CONSTRAINT "analyzer_runs_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_spaces_space_uq" ON "agent_spaces" USING btree ("region","agent_space_id");--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_events_space_idx" ON "audit_events" USING btree ("space_id","at");--> statement-breakpoint
CREATE INDEX "job_runs_space_idx" ON "job_runs" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "job_runs_queue_idx" ON "job_runs" USING btree ("queue","status");--> statement-breakpoint
CREATE UNIQUE INDEX "role_bindings_uq" ON "role_bindings" USING btree ("space_id","subject_type","subject");--> statement-breakpoint
CREATE INDEX "asset_changes_time_idx" ON "asset_changes" USING btree ("space_id","service_updated_at");--> statement-breakpoint
CREATE INDEX "asset_index_type_idx" ON "asset_index" USING btree ("space_id","asset_type");--> statement-breakpoint
CREATE INDEX "journal_exec_task_idx" ON "journal_executions" USING btree ("space_id","task_id");--> statement-breakpoint
CREATE INDEX "journal_records_exec_idx" ON "journal_records" USING btree ("space_id","execution_id","seq");--> statement-breakpoint
CREATE INDEX "journal_records_task_idx" ON "journal_records" USING btree ("space_id","task_id");--> statement-breakpoint
CREATE INDEX "journal_tasks_incident_idx" ON "journal_tasks" USING btree ("space_id","incident_id");--> statement-breakpoint
CREATE INDEX "analyzer_runs_task_idx" ON "analyzer_runs" USING btree ("space_id","task_id","analyzer");