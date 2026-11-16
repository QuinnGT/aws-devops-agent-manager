CREATE TABLE "audit_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"incident_id" text,
	"cohort" text,
	"journal_sha256" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"state_reason" text,
	"current_review_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"profile_id" text NOT NULL,
	"profile_snapshot" jsonb NOT NULL,
	"policy_digest" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"note" text,
	"run_id" uuid,
	"report" jsonb,
	"report_updated_by" text,
	"report_updated_at" timestamp with time zone,
	"finalized_commit" text,
	"finalized_by" text,
	"finalized_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"incident_id" text NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"body" text NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"uploaded_by" text NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_id" uuid NOT NULL,
	"audit_item_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"incident_id" text,
	"kind" text NOT NULL,
	"ordinal" integer NOT NULL,
	"title" text NOT NULL,
	"proposed" jsonb NOT NULL,
	"current" jsonb NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"review_note" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"audit_id" uuid,
	"review_id" uuid,
	"purpose" text NOT NULL,
	"runner" text NOT NULL,
	"model_id" text NOT NULL,
	"region" text NOT NULL,
	"steps" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer NOT NULL,
	"error" text,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_id" uuid NOT NULL,
	"audit_item_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"runner" text NOT NULL,
	"model_id" text NOT NULL,
	"prompt_digest" text NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"output" jsonb,
	"schema_valid" boolean,
	"schema_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"citation_check" jsonb,
	"error" text,
	"steps" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer,
	"job_run_id" uuid,
	"started_by" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_items" ADD CONSTRAINT "audit_items_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_docs" ADD CONSTRAINT "evidence_docs_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_audit_item_id_audit_items_id_fk" FOREIGN KEY ("audit_item_id") REFERENCES "public"."audit_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_audit_item_id_audit_items_id_fk" FOREIGN KEY ("audit_item_id") REFERENCES "public"."audit_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_items_task_uq" ON "audit_items" USING btree ("audit_id","task_id");--> statement-breakpoint
CREATE INDEX "audit_items_state_idx" ON "audit_items" USING btree ("audit_id","state");--> statement-breakpoint
CREATE INDEX "audits_space_idx" ON "audits" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "audits_state_idx" ON "audits" USING btree ("space_id","state");--> statement-breakpoint
CREATE INDEX "evidence_docs_incident_idx" ON "evidence_docs" USING btree ("space_id","incident_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_docs_current_uq" ON "evidence_docs" USING btree ("space_id","incident_id","kind") WHERE "evidence_docs"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "findings_review_uq" ON "findings" USING btree ("review_id","kind","ordinal");--> statement-breakpoint
CREATE INDEX "findings_audit_idx" ON "findings" USING btree ("audit_id","kind","state");--> statement-breakpoint
CREATE INDEX "findings_space_state_idx" ON "findings" USING btree ("space_id","state");--> statement-breakpoint
CREATE INDEX "model_calls_space_idx" ON "model_calls" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "model_calls_audit_idx" ON "model_calls" USING btree ("audit_id");--> statement-breakpoint
CREATE INDEX "reviews_item_idx" ON "reviews" USING btree ("audit_item_id","started_at");--> statement-breakpoint
CREATE INDEX "reviews_audit_idx" ON "reviews" USING btree ("audit_id");