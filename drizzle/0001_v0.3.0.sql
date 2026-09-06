CREATE TABLE `session_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`content` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);

--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`current_story_id` integer,
	FOREIGN KEY (`current_story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade
);

--> statement-breakpoint
CREATE TABLE `story_marks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`name` text NOT NULL,
	`timeline` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade
);

--> statement-breakpoint
CREATE UNIQUE INDEX `story_marks_story_id_name_unique` ON `story_marks` (`story_id`,`name`);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_gemini_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cache_key` text,
	`file_uri` text NOT NULL,
	`uploaded_at` text NOT NULL,
	`state` text NOT NULL
);

--> statement-breakpoint
INSERT INTO `__new_gemini_files`("id", "file_uri", "uploaded_at", "state") SELECT "id", "file_uri", "uploaded_at", "state" FROM `gemini_files`;
--> statement-breakpoint
DROP TABLE `gemini_files`;
--> statement-breakpoint
ALTER TABLE `__new_gemini_files` RENAME TO `gemini_files`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE UNIQUE INDEX `gemini_files_cache_key_unique` ON `gemini_files` (`cache_key`);
--> statement-breakpoint
ALTER TABLE `project_context` ADD `agents_hash` text;
--> statement-breakpoint
ALTER TABLE `project_context` DROP COLUMN `facts`;
