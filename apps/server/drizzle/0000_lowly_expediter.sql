CREATE TABLE `accounts` (
	`network` text PRIMARY KEY NOT NULL,
	`handle` text,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`secrets_enc` blob,
	`meta` text DEFAULT '{}' NOT NULL,
	`browser_profile_dir` text,
	`proxy` text,
	`last_self_test` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`outcome` text NOT NULL,
	`error_code` text,
	`error_msg` text,
	`debug` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`target_id`) REFERENCES `post_targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attempts_target_idx` ON `attempts` (`target_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`entity` text,
	`details` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE TABLE `drafts_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`delivered_via` text NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `codes_draft_idx` ON `drafts_codes` (`draft_id`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`sha256` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`duration_ms` integer,
	`original_path` text NOT NULL,
	`source_path` text,
	`variants` text DEFAULT '{}' NOT NULL,
	`blossom_urls` text DEFAULT '[]' NOT NULL,
	`alt_text` text,
	`purged_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `media_sha_idx` ON `media` (`sha256`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`route` text NOT NULL,
	`payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`delivered_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_due_idx` ON `notifications` (`delivered_at`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`network` text NOT NULL,
	`code_verifier` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `post_media` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`media_id` text NOT NULL,
	`position` integer NOT NULL,
	`network` text,
	`alt_text` text,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `post_media_post_idx` ON `post_media` (`post_id`);--> statement-breakpoint
CREATE TABLE `post_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`network` text NOT NULL,
	`text_override` text,
	`scheduled_at_utc` integer NOT NULL,
	`tz` text NOT NULL,
	`local_input` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_until` integer,
	`next_attempt_at` integer,
	`published_url` text,
	`remote_ids` text DEFAULT '[]' NOT NULL,
	`rendered_parts` text DEFAULT '[]' NOT NULL,
	`last_error_code` text,
	`last_error_msg` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `targets_post_idx` ON `post_targets` (`post_id`);--> statement-breakpoint
CREATE INDEX `targets_due_idx` ON `post_targets` (`status`,`scheduled_at_utc`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `targets_network_sched_idx` ON `post_targets` (`network`,`scheduled_at_utc`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`base_text` text NOT NULL,
	`thread_mode` text DEFAULT 'auto' NOT NULL,
	`networks` text NOT NULL,
	`overrides` text DEFAULT '{}' NOT NULL,
	`schedule_overrides` text DEFAULT '{}' NOT NULL,
	`scheduled_at_utc` integer NOT NULL,
	`tz` text NOT NULL,
	`local_input` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`confirmed_at` integer,
	`updated_at` integer NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `posts_status_sched_idx` ON `posts` (`status`,`scheduled_at_utc`);--> statement-breakpoint
CREATE INDEX `posts_created_idx` ON `posts` (`created_at`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`key` text PRIMARY KEY NOT NULL,
	`value_enc` blob NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`scope` text DEFAULT 'write' NOT NULL,
	`token_hash` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `ui_sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`user_agent` text
);
