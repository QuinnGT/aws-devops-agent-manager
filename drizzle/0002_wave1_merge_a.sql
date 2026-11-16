CREATE TABLE "asset_reasons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"asset_id" text NOT NULL,
	"commit" text NOT NULL,
	"reason" text NOT NULL,
	"link" text,
	"notes_ref" text NOT NULL,
	"added_by" text NOT NULL,
	"job_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_changes" ADD COLUMN "attribution_matched_by" text;--> statement-breakpoint
ALTER TABLE "asset_changes" ADD COLUMN "attribution_provisional" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_changes" ADD COLUMN "git_path" text;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "last_enqueued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "last_result" jsonb;--> statement-breakpoint
ALTER TABLE "asset_reasons" ADD CONSTRAINT "asset_reasons_space_id_agent_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."agent_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_reasons_asset_idx" ON "asset_reasons" USING btree ("space_id","asset_id");--> statement-breakpoint
CREATE INDEX "asset_reasons_commit_idx" ON "asset_reasons" USING btree ("space_id","commit");--> statement-breakpoint
CREATE INDEX "asset_reasons_search_idx" ON "asset_reasons" USING gin (to_tsvector('simple', "reason"));