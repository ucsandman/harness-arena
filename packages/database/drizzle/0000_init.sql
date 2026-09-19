CREATE TYPE "public"."artifact_kind" AS ENUM('diff', 'final_response', 'report_html');--> statement-breakpoint
CREATE TYPE "public"."battle_status" AS ENUM('pending', 'preparing', 'running', 'evaluating', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."battle_winner" AS ENUM('a', 'b', 'tie', 'inconclusive');--> statement-breakpoint
CREATE TYPE "public"."device_code_status" AS ENUM('pending', 'approved', 'denied', 'expired');--> statement-breakpoint
CREATE TYPE "public"."event_confidence" AS ENUM('observed', 'derived', 'estimated');--> statement-breakpoint
CREATE TYPE "public"."execution_mode" AS ENUM('local', 'local-byok', 'cloud');--> statement-breakpoint
CREATE TYPE "public"."harness_framework" AS ENUM('claude-code', 'codex', 'gemini-cli', 'opencode', 'multi', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."harness_source_kind" AS ENUM('vanilla', 'github', 'git', 'local');--> statement-breakpoint
CREATE TYPE "public"."metric_status" AS ENUM('observed', 'calculated', 'estimated', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."rating_category" AS ENUM('overall', 'debugging', 'refactoring', 'greenfield', 'frontend', 'backend', 'long_horizon', 'speed', 'token_efficiency', 'cost_efficiency');--> statement-breakpoint
CREATE TYPE "public"."rating_pool" AS ENUM('community', 'verified');--> statement-breakpoint
CREATE TYPE "public"."repository_kind" AS ENUM('github', 'git', 'local', 'empty');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('pending', 'preparing', 'running', 'completed', 'failed', 'timed_out', 'cancelled', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."battle_side" AS ENUM('a', 'b');--> statement-breakpoint
CREATE TYPE "public"."task_kind" AS ENUM('prompt', 'issue', 'demo');--> statement-breakpoint
CREATE TYPE "public"."user_plan" AS ENUM('free', 'pro', 'team');--> statement-breakpoint
CREATE TYPE "public"."verification_kind" AS ENUM('local', 'cloud');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('private', 'unlisted', 'public');--> statement-breakpoint
CREATE TABLE "device_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"device_name" text NOT NULL,
	"status" "device_code_status" DEFAULT 'pending' NOT NULL,
	"user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	CONSTRAINT "device_codes_device_code_hash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "device_codes_user_code_unique" UNIQUE("user_code")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{"battles:write"}' NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"github_id" bigint NOT NULL,
	"login" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"email" text,
	"plan" "user_plan" DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"vendor" text NOT NULL,
	"homepage" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"harness_id" text NOT NULL,
	"commit" text,
	"manifest" jsonb,
	"inspection" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "harness_versions_commit_uq" UNIQUE NULLS NOT DISTINCT("harness_id","commit")
);
--> statement-breakpoint
CREATE TABLE "harnesses" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"source_kind" "harness_source_kind" NOT NULL,
	"source_url" text,
	"owner_user_id" text,
	"description" text,
	"framework" "harness_framework" DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "harnesses_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"kind" "repository_kind" NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_source_unique" UNIQUE("source")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "task_kind" NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"source" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"battle_id" text NOT NULL,
	"side" "battle_side",
	"kind" "artifact_kind" NOT NULL,
	"content" text NOT NULL,
	"content_type" text DEFAULT 'text/plain' NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_battle_side_kind_uq" UNIQUE NULLS NOT DISTINCT("battle_id","side","kind")
);
--> statement-breakpoint
CREATE TABLE "battle_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"battle_id" text NOT NULL,
	"side" "battle_side" NOT NULL,
	"label" text NOT NULL,
	"agent_id" text NOT NULL,
	"harness_id" text,
	"harness_version_id" text,
	"status" "run_status" NOT NULL,
	"model" text,
	"duration_ms" integer,
	"exit_code" integer,
	"metrics" jsonb NOT NULL,
	"invocation" jsonb,
	"error" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "battle_runs_side_uq" UNIQUE("battle_id","side")
);
--> statement-breakpoint
CREATE TABLE "battles" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text,
	"device_id" text,
	"title" text NOT NULL,
	"status" "battle_status" NOT NULL,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"mode" "execution_mode" NOT NULL,
	"verification_kind" "verification_kind" NOT NULL,
	"verification_eligible" boolean DEFAULT false NOT NULL,
	"demo" boolean DEFAULT false NOT NULL,
	"task_id" text NOT NULL,
	"repository_id" text,
	"repository_commit" text,
	"spec" jsonb NOT NULL,
	"record" jsonb NOT NULL,
	"winner" "battle_winner",
	"confidence" real,
	"category" text,
	"event_count" integer DEFAULT 0 NOT NULL,
	"events_capped" boolean DEFAULT false NOT NULL,
	"arena_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"battle_id" text NOT NULL,
	"report" jsonb,
	"verdict" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"battle_id" text NOT NULL,
	"seq" integer NOT NULL,
	"id" text NOT NULL,
	"run_id" text,
	"side" "battle_side",
	"type" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"t_offset_ms" integer NOT NULL,
	"source" jsonb NOT NULL,
	"confidence" "event_confidence" NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_battle_id_seq_pk" PRIMARY KEY("battle_id","seq")
);
--> statement-breakpoint
CREATE TABLE "metrics" (
	"battle_id" text NOT NULL,
	"side" "battle_side" NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"status" "metric_status" NOT NULL,
	CONSTRAINT "metrics_battle_id_side_key_pk" PRIMARY KEY("battle_id","side","key")
);
--> statement-breakpoint
CREATE TABLE "rating_events" (
	"id" text PRIMARY KEY NOT NULL,
	"battle_id" text NOT NULL,
	"harness_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"category" "rating_category" NOT NULL,
	"pool" "rating_pool" NOT NULL,
	"rating_before" real NOT NULL,
	"rating_after" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rating_events_unique" UNIQUE("battle_id","harness_id","agent_id","category","pool")
);
--> statement-breakpoint
CREATE TABLE "ratings" (
	"harness_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"category" "rating_category" NOT NULL,
	"pool" "rating_pool" NOT NULL,
	"rating" real NOT NULL,
	"deviation" real NOT NULL,
	"battles" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"ties" integer DEFAULT 0 NOT NULL,
	"provisional" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ratings_harness_id_agent_id_category_pool_pk" PRIMARY KEY("harness_id","agent_id","category","pool")
);
--> statement-breakpoint
ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_versions" ADD CONSTRAINT "harness_versions_harness_id_harnesses_id_fk" FOREIGN KEY ("harness_id") REFERENCES "public"."harnesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harnesses" ADD CONSTRAINT "harnesses_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_battle_id_battles_id_fk" FOREIGN KEY ("battle_id") REFERENCES "public"."battles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battle_runs" ADD CONSTRAINT "battle_runs_battle_id_battles_id_fk" FOREIGN KEY ("battle_id") REFERENCES "public"."battles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battle_runs" ADD CONSTRAINT "battle_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battle_runs" ADD CONSTRAINT "battle_runs_harness_id_harnesses_id_fk" FOREIGN KEY ("harness_id") REFERENCES "public"."harnesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battle_runs" ADD CONSTRAINT "battle_runs_harness_version_id_harness_versions_id_fk" FOREIGN KEY ("harness_version_id") REFERENCES "public"."harness_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battles" ADD CONSTRAINT "battles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battles" ADD CONSTRAINT "battles_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battles" ADD CONSTRAINT "battles_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battles" ADD CONSTRAINT "battles_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_battle_id_battles_id_fk" FOREIGN KEY ("battle_id") REFERENCES "public"."battles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_battle_id_battles_id_fk" FOREIGN KEY ("battle_id") REFERENCES "public"."battles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_battle_id_battles_id_fk" FOREIGN KEY ("battle_id") REFERENCES "public"."battles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_battle_id_battles_id_fk" FOREIGN KEY ("battle_id") REFERENCES "public"."battles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_harness_id_harnesses_id_fk" FOREIGN KEY ("harness_id") REFERENCES "public"."harnesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_harness_id_harnesses_id_fk" FOREIGN KEY ("harness_id") REFERENCES "public"."harnesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_codes_status_idx" ON "device_codes" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "devices_user_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_login_idx" ON "users" USING btree ("login");--> statement-breakpoint
CREATE INDEX "harnesses_owner_idx" ON "harnesses" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "battle_runs_battle_idx" ON "battle_runs" USING btree ("battle_id");--> statement-breakpoint
CREATE INDEX "battles_owner_created_idx" ON "battles" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "battles_visibility_created_idx" ON "battles" USING btree ("visibility","created_at");--> statement-breakpoint
CREATE INDEX "battles_status_idx" ON "battles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "evaluations_battle_idx" ON "evaluations" USING btree ("battle_id");--> statement-breakpoint
CREATE INDEX "events_battle_type_idx" ON "events" USING btree ("battle_id","type");--> statement-breakpoint
CREATE INDEX "rating_events_battle_idx" ON "rating_events" USING btree ("battle_id");--> statement-breakpoint
CREATE INDEX "ratings_board_idx" ON "ratings" USING btree ("category","pool","rating");