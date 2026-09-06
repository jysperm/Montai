CREATE TABLE `gemini_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_id` integer,
	`music_id` integer,
	`voiceover_id` integer,
	`file_uri` text NOT NULL,
	`uploaded_at` text NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`music_id`) REFERENCES `music`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voiceover_id`) REFERENCES `voiceovers`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE TABLE `music` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`filename` text NOT NULL,
	`path` text NOT NULL,
	`md5` text NOT NULL,
	`type` text DEFAULT 'library',
	`generation_prompt` text,
	`duration_seconds` integer,
	`sample_rate` integer,
	`channels` integer
);

--> statement-breakpoint
CREATE UNIQUE INDEX `music_path_unique` ON `music` (`path`);
--> statement-breakpoint
CREATE TABLE `music_analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`music_id` integer NOT NULL,
	`overview` text NOT NULL,
	`segments` text NOT NULL,
	FOREIGN KEY (`music_id`) REFERENCES `music`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE TABLE `project_context` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`facts` text NOT NULL,
	`overview` text,
	`overview_stale` integer,
	`updated_at` text NOT NULL
);

--> statement-breakpoint
CREATE TABLE `stories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`title` text NOT NULL,
	`storyline` text,
	`timeline` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

--> statement-breakpoint
CREATE UNIQUE INDEX `stories_name_unique` ON `stories` (`name`);
--> statement-breakpoint
CREATE TABLE `video_analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_id` integer NOT NULL,
	`overview` text NOT NULL,
	`location` text,
	`time_of_day` text,
	`segments` text NOT NULL,
	`highlights` text NOT NULL,
	`technical_notes` text,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE TABLE `videos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`filename` text NOT NULL,
	`path` text NOT NULL,
	`md5` text NOT NULL,
	`duration_seconds` integer,
	`width` integer,
	`height` integer,
	`fps_num` integer,
	`fps_den` integer,
	`fps` text,
	`bit_depth` integer,
	`color_primaries` text,
	`color_transfer` text,
	`total_frames` integer,
	`audio_channels` integer,
	`audio_sample_rate` integer,
	`start_timecode` text
);

--> statement-breakpoint
CREATE UNIQUE INDEX `videos_path_unique` ON `videos` (`path`);
--> statement-breakpoint
CREATE TABLE `voiceover_analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`voiceover_id` integer NOT NULL,
	`transcription` text NOT NULL,
	`overview` text NOT NULL,
	FOREIGN KEY (`voiceover_id`) REFERENCES `voiceovers`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE TABLE `voiceovers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`filename` text NOT NULL,
	`path` text NOT NULL,
	`md5` text NOT NULL,
	`duration_seconds` integer,
	`sample_rate` integer,
	`channels` integer
);

--> statement-breakpoint
CREATE UNIQUE INDEX `voiceovers_path_unique` ON `voiceovers` (`path`);
