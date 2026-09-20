CREATE TYPE "public"."bounty_status" AS ENUM('open', 'closed', 'awarded', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."challenge_status" AS ENUM('open', 'accepted', 'completed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."component_kind" AS ENUM('harness', 'instructions', 'skill', 'hook', 'mcp', 'subagent', 'prompt', 'settings', 'memory', 'benchmark');--> statement-breakpoint
CREATE TYPE "public"."experiment_kind" AS ENUM('regression', 'ablation', 'comparison');--> statement-breakpoint
CREATE TYPE "public"."experiment_status" AS ENUM('planned', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."lineage_evidence" AS ENUM('github_fork', 'manifest', 'declared');--> statement-breakpoint
CREATE TYPE "public"."lineage_relation" AS ENUM('forked_from', 'derived_from', 'based_on', 'previous_version', 'component_source');--> statement-breakpoint
CREATE TYPE "public"."tournament_format" AS ENUM('single_elimination');--> statement-breakpoint
CREATE TYPE "public"."tournament_status" AS ENUM('draft', 'open', 'running', 'completed', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."rating_category" ADD VALUE 'testing' BEFORE 'long_horizon';--> statement-breakpoint
ALTER TYPE "public"."rating_category" ADD VALUE 'security' BEFORE 'long_horizon';--> statement-breakpoint
ALTER TYPE "public"."rating_category" ADD VALUE 'repo_navigation' BEFORE 'long_horizon';--> statement-breakpoint
ALTER TYPE "public"."rating_category" ADD VALUE 'performance' BEFORE 'speed';--> statement-breakpoint
ALTER TYPE "public"."rating_category" ADD VALUE 'documentation' BEFORE 'speed';--> statement-breakpoint
ALTER TYPE "public"."rating_category" ADD VALUE 'dependencies' BEFORE 'speed';--> statement-breakpoint
CREATE TABLE "battle_links" (
	"battle_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"treatment_side" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "battle_links_battle_id_kind_pk" PRIMARY KEY("battle_id","kind")
);
--> statement-breakpoint
CREATE TABLE "benchmark_tasks" (
	"version_id" text NOT NULL,
	"task_id" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"tags" jsonb NOT NULL,
	"repository_source" text NOT NULL,
	"repository_commit" text,
	"trials" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "benchmark_tasks_version_id_task_id_pk" PRIMARY KEY("version_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "benchmark_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"benchmark_id" text NOT NULL,
	"version" text NOT NULL,
	"pack" jsonb NOT NULL,
	"task_count" integer NOT NULL,
	"battles_per_run" integer NOT NULL,
	"categories" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "benchmark_versions_label_uq" UNIQUE("benchmark_id","version")
);
--> statement-breakpoint
CREATE TABLE "benchmarks" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"author" text,
	"owner_user_id" text,
	"visibility" "visibility" DEFAULT 'public' NOT NULL,
	"latest_version_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "benchmarks_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "bounties" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "bounty_status" DEFAULT 'open' NOT NULL,
	"created_by_user_id" text,
	"baseline" jsonb NOT NULL,
	"baseline_harness_id" text,
	"agent" jsonb NOT NULL,
	"target" jsonb NOT NULL,
	"benchmark_version_id" text,
	"condition" jsonb NOT NULL,
	"reward_kind" text NOT NULL,
	"reward_description" text NOT NULL,
	"eligibility" text,
	"deadline" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bounty_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"bounty_id" text NOT NULL,
	"submitted_by_user_id" text,
	"harness" jsonb NOT NULL,
	"harness_id" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "challenge_status" DEFAULT 'open' NOT NULL,
	"created_by_user_id" text,
	"accepted_by_user_id" text,
	"side_a" jsonb NOT NULL,
	"side_b" jsonb NOT NULL,
	"harness_a_id" text,
	"harness_b_id" text,
	"agent" jsonb NOT NULL,
	"target" jsonb NOT NULL,
	"benchmark_version_id" text,
	"privacy" jsonb NOT NULL,
	"visibility" "visibility" DEFAULT 'public' NOT NULL,
	"rating_eligible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "components" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "component_kind" NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source" text,
	"owner_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "components_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"kind" "experiment_kind" NOT NULL,
	"status" "experiment_status" DEFAULT 'planned' NOT NULL,
	"created_by_user_id" text,
	"control" jsonb NOT NULL,
	"treatment" jsonb NOT NULL,
	"harness_id" text,
	"control_version_id" text,
	"treatment_version_id" text,
	"changed_component" jsonb,
	"component_id" text,
	"agent" jsonb NOT NULL,
	"target" jsonb NOT NULL,
	"benchmark_version_id" text,
	"trials" integer DEFAULT 1 NOT NULL,
	"visibility" "visibility" DEFAULT 'public' NOT NULL,
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_components" (
	"harness_version_id" text NOT NULL,
	"component_id" text NOT NULL,
	"path" text,
	CONSTRAINT "harness_components_harness_version_id_component_id_pk" PRIMARY KEY("harness_version_id","component_id")
);
--> statement-breakpoint
CREATE TABLE "harness_lineage" (
	"id" text PRIMARY KEY NOT NULL,
	"harness_id" text NOT NULL,
	"relation" "lineage_relation" NOT NULL,
	"parent_harness_id" text,
	"parent_source" text NOT NULL,
	"evidence" "lineage_evidence" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "harness_lineage_uq" UNIQUE("harness_id","relation","parent_source")
);
--> statement-breakpoint
CREATE TABLE "tournament_matches" (
	"id" text PRIMARY KEY NOT NULL,
	"tournament_id" text NOT NULL,
	"round" integer NOT NULL,
	"position" integer NOT NULL,
	"entrant_a" integer,
	"entrant_b" integer,
	"bye" boolean DEFAULT false NOT NULL,
	"winner" integer,
	"settled_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournament_matches_slot_uq" UNIQUE("tournament_id","round","position")
);
--> statement-breakpoint
CREATE TABLE "tournaments" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"format" "tournament_format" DEFAULT 'single_elimination' NOT NULL,
	"status" "tournament_status" DEFAULT 'draft' NOT NULL,
	"created_by_user_id" text,
	"agent" jsonb NOT NULL,
	"target" jsonb NOT NULL,
	"benchmark_version_id" text,
	"entrants" jsonb NOT NULL,
	"winner" integer,
	"visibility" "visibility" DEFAULT 'public' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournaments_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "battles" ADD COLUMN "benchmark_version_id" text;--> statement-breakpoint
ALTER TABLE "battles" ADD COLUMN "benchmark_task_id" text;--> statement-breakpoint
ALTER TABLE "battles" ADD COLUMN "benchmark_trial" integer;--> statement-breakpoint
ALTER TABLE "battles" ADD COLUMN "integrity" jsonb;--> statement-breakpoint
ALTER TABLE "battles" ADD COLUMN "rating_eligible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "battles" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TABLE "rating_events" ADD COLUMN "deviation_before" real DEFAULT 350 NOT NULL;--> statement-breakpoint
ALTER TABLE "rating_events" ADD COLUMN "deviation_after" real DEFAULT 350 NOT NULL;--> statement-breakpoint
ALTER TABLE "rating_events" ADD COLUMN "harness_version_id" text;--> statement-breakpoint
ALTER TABLE "rating_events" ADD COLUMN "opponent_harness_id" text;--> statement-breakpoint
ALTER TABLE "rating_events" ADD COLUMN "opponent_rating" real DEFAULT 1500 NOT NULL;--> statement-breakpoint
ALTER TABLE "rating_events" ADD COLUMN "outcome" text DEFAULT 'tie' NOT NULL;--> statement-breakpoint
ALTER TABLE "ratings" ADD COLUMN "peak_rating" real DEFAULT 1500 NOT NULL;--> statement-breakpoint
ALTER TABLE "ratings" ADD COLUMN "form" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "ratings" ADD COLUMN "last_battle_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "battle_links" ADD CONSTRAINT "battle_links_battle_id_battles_id_fk" FOREIGN KEY ("battle_id") REFERENCES "public"."battles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_tasks" ADD CONSTRAINT "benchmark_tasks_version_id_benchmark_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."benchmark_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_versions" ADD CONSTRAINT "benchmark_versions_benchmark_id_benchmarks_id_fk" FOREIGN KEY ("benchmark_id") REFERENCES "public"."benchmarks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmarks" ADD CONSTRAINT "benchmarks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_baseline_harness_id_harnesses_id_fk" FOREIGN KEY ("baseline_harness_id") REFERENCES "public"."harnesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_benchmark_version_id_benchmark_versions_id_fk" FOREIGN KEY ("benchmark_version_id") REFERENCES "public"."benchmark_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_submissions" ADD CONSTRAINT "bounty_submissions_bounty_id_bounties_id_fk" FOREIGN KEY ("bounty_id") REFERENCES "public"."bounties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_submissions" ADD CONSTRAINT "bounty_submissions_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_submissions" ADD CONSTRAINT "bounty_submissions_harness_id_harnesses_id_fk" FOREIGN KEY ("harness_id") REFERENCES "public"."harnesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_harness_a_id_harnesses_id_fk" FOREIGN KEY ("harness_a_id") REFERENCES "public"."harnesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_harness_b_id_harnesses_id_fk" FOREIGN KEY ("harness_b_id") REFERENCES "public"."harnesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_benchmark_version_id_benchmark_versions_id_fk" FOREIGN KEY ("benchmark_version_id") REFERENCES "public"."benchmark_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_harness_id_harnesses_id_fk" FOREIGN KEY ("harness_id") REFERENCES "public"."harnesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_control_version_id_harness_versions_id_fk" FOREIGN KEY ("control_version_id") REFERENCES "public"."harness_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_treatment_version_id_harness_versions_id_fk" FOREIGN KEY ("treatment_version_id") REFERENCES "public"."harness_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_benchmark_version_id_benchmark_versions_id_fk" FOREIGN KEY ("benchmark_version_id") REFERENCES "public"."benchmark_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_components" ADD CONSTRAINT "harness_components_harness_version_id_harness_versions_id_fk" FOREIGN KEY ("harness_version_id") REFERENCES "public"."harness_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_components" ADD CONSTRAINT "harness_components_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_lineage" ADD CONSTRAINT "harness_lineage_harness_id_harnesses_id_fk" FOREIGN KEY ("harness_id") REFERENCES "public"."harnesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_lineage" ADD CONSTRAINT "harness_lineage_parent_harness_id_harnesses_id_fk" FOREIGN KEY ("parent_harness_id") REFERENCES "public"."harnesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_benchmark_version_id_benchmark_versions_id_fk" FOREIGN KEY ("benchmark_version_id") REFERENCES "public"."benchmark_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "battle_links_target_idx" ON "battle_links" USING btree ("kind","target_id");--> statement-breakpoint
CREATE INDEX "benchmark_tasks_category_idx" ON "benchmark_tasks" USING btree ("category");--> statement-breakpoint
CREATE INDEX "benchmark_versions_benchmark_idx" ON "benchmark_versions" USING btree ("benchmark_id");--> statement-breakpoint
CREATE INDEX "benchmarks_owner_idx" ON "benchmarks" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "bounties_status_created_idx" ON "bounties" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "bounty_submissions_bounty_idx" ON "bounty_submissions" USING btree ("bounty_id");--> statement-breakpoint
CREATE INDEX "challenges_status_created_idx" ON "challenges" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "challenges_harness_a_idx" ON "challenges" USING btree ("harness_a_id");--> statement-breakpoint
CREATE INDEX "challenges_harness_b_idx" ON "challenges" USING btree ("harness_b_id");--> statement-breakpoint
CREATE INDEX "components_kind_idx" ON "components" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "experiments_harness_idx" ON "experiments" USING btree ("harness_id");--> statement-breakpoint
CREATE INDEX "experiments_status_created_idx" ON "experiments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "experiments_component_idx" ON "experiments" USING btree ("component_id");--> statement-breakpoint
CREATE INDEX "harness_lineage_parent_idx" ON "harness_lineage" USING btree ("parent_harness_id");--> statement-breakpoint
CREATE INDEX "tournament_matches_tournament_idx" ON "tournament_matches" USING btree ("tournament_id");--> statement-breakpoint
CREATE INDEX "tournaments_status_created_idx" ON "tournaments" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_harness_version_id_harness_versions_id_fk" FOREIGN KEY ("harness_version_id") REFERENCES "public"."harness_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_opponent_harness_id_harnesses_id_fk" FOREIGN KEY ("opponent_harness_id") REFERENCES "public"."harnesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "battles_benchmark_idx" ON "battles" USING btree ("benchmark_version_id","benchmark_task_id");--> statement-breakpoint
CREATE INDEX "battles_fingerprint_idx" ON "battles" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "rating_events_history_idx" ON "rating_events" USING btree ("harness_id","agent_id","category","pool","created_at");