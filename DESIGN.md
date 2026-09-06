# Montai

AI-powered video editing tool that extracts storylines from unscripted footage and generates edited vlogs.

## Architecture Overview

Montai is a local TypeScript CLI tool, it operates on a user project directory containing a `montai.yaml` config file.

### Key Design Decisions

- **YAML config**: User create the `montai.yaml` file to describe the project
- **SQLite stored per project**: All intermediate data stored locally, schema kept current by migrations applied at runtime
- **Dual output**: `export` generates FCPXML, `render`/`studio` use a static Remotion project bundled inside Montai
- **Static Remotion project**: The Remotion project lives in the package's top-level `remotion/` directory as real TSX files, never modified at runtime. All dynamic data flows through CLI flags (`--props`, `--public-dir`)
- **Less structured LLM outputs**: Prompts prefer free-form prose or Markdown over rigid JSON schemas for intermediate text (e.g. storylines). Only outputs that are consumed programmatically (e.g. VideoAnalysis, Timeline) use structured JSON. This gives the LLM more flexibility and produces more natural text. Use examples in prompts to guide the expected content rather than prescribing exact schemas.

### Historical Note

Earlier versions had separate `storyline` and `edit` commands — `storyline` generated a narrative in a single LLM call, and `edit` ran a non-interactive agent loop to produce a timeline from that storyline. These were replaced by the unified interactive `story` command which handles both storyline and timeline in a single conversational session.

## Project Configuration

Users create a `montai.yaml` in their project directory:

```yaml
assets:
  videos: .                       # String or array; directories and files supported
  music: ./musics/                # Optional background music files
  voiceover: ./voiceover/         # Optional narration recordings
language: zh                     # Language for LLM-generated text (zh | en)
output:
  resolution: 1080p             # landscape 720p|1080p|1440p|2160p|4k; vertical 720v|1080v|1440v; square 720s|1080s|1440s
  fps: 50
models:
  analysis: gemini-3.8-flash             # Per-video analysis
  editing: gemini-3.8-flash              # Story agent loop
  musicGeneration: lyria-3-clip-preview      # Optional: enables AI music generation
  voiceoverGeneration: gemini-2.5-flash-preview-tts  # Optional: enables AI (TTS) voiceover — gemini-2.5-flash-preview-tts | system
effects:
  languages: [zh, en]           # Subtitle / caption languages
  voiceLanguage: zh             # Optional: spoken language for generated (TTS) voiceover; defaults to first of `languages`
featureFlags:                    # Optional overrides (see Feature Flags)
  music: false
```

`language` controls the language used for all internal text: video analyses, project overview, storylines, and story titles. Supports `zh` (Chinese) or `en` (English), defaults to `en`. This is separate from `effects.languages`, which controls the language(s) of overlay text in the final video. If multiple languages are specified (e.g. `[zh, en]`), each overlay should include bilingual text. A third language axis, `effects.voiceLanguage`, sets the spoken language for AI-generated (TTS) voiceover narration; it is a single language and defaults to the first `effects.languages` entry (then `language`) when unset.

`assets.videos`, `assets.music`, and `assets.voiceover` accept either a single string path or an array of string paths. Video entries can be directories (scanned for mp4/mov/avi/mkv files) or individual file paths. Music and voiceover entries can be directories (scanned for mp3/wav/flac/m4a/aac/ogg files) or individual file paths. Paths support `.`, `~` expansion, and absolute paths. A common pattern is placing `montai.yaml` alongside the video files and using `.` to reference the current directory.

For backward compatibility, a top-level `videos` key (without `assets` wrapper) is still accepted and automatically mapped to `assets.videos`.

All generated files (`montai.db`, `.montai/`, `output/`, `fcpxml/`) are located relative to the directory containing `montai.yaml` (the project directory).

Secrets and account-level environment variables are not stored in `montai.yaml`. On CLI startup, Montai loads dotenv-compatible variables from `~/.config/montai/env` and only fills keys that are missing from the current runtime environment. Shell-provided environment variables therefore remain the highest-priority source.

## Feature Flags

A `FeatureFlags` object (variable name `features` in code, type `FeatureFlags` in `src/feature-flags.ts`) gates optional capabilities across the LLM prompt and tool surface. Each flag resolves to a boolean at runtime: a computed default based on project context, optionally overridden by the `featureFlags` section in `montai.yaml`. The same resolved `features` object is passed into both the prompt templates (Handlebars `{{#if features.X}}`) and the tool list assembly.

The goal is a single switch per feature that controls both what the LLM is told about (prompt) and what it can call (tools), so that adding a new capability only requires defining a flag, its default, and the guarded prompt/tool sections.

### Defined features

| Feature | Description | Controls | Default |
|---------|-------------|----------|---------|
| `music` | Background music selection from the library and/or generated tracks | `getMusicAnalysis` tool; music item format and editing guidance in `story-system`; music analyses (library + summaries) in `story-context` | Project has music files (`assets.music` non-empty) **or** `models.musicGeneration` is configured |
| `musicGeneration` | AI-generated background music via Lyria 3 | `generateMusic` tool; "Using generateMusic" prompt section; generated-music list in `story-context` | `models.musicGeneration` is configured |
| `voiceover` | Voiceover-driven editing with transcription-aware timeline placement | `getVoiceoverAnalysis` tool (also enabled by `voiceoverGeneration`); recorded-voiceover guidance in `story-system`; voiceover analyses in `story-context` | Project has voiceover files (`assets.voiceover` non-empty) |
| `voiceoverGeneration` | AI-generated (TTS) narration voiceover | `generateVoiceover` tool guarded by the `ai-voiceover` skill; voiceover item format in `story-system`; also enables `getVoiceoverAnalysis` | `models.voiceoverGeneration` is configured (the `system` provider additionally requires macOS, else config resolution errors) |
| `previewTools` | Agent self-preview of the edited timeline (renders a frame or short video and injects it back into the conversation) | `previewFrame` and `previewFinalVideo` tools; tool descriptions in `story-system` | `true` |
| `multiStory` | Agent awareness of and ability to switch between stories | `listStories` and `switchStory` tools and prompt descriptions | `true` |
| `transcodeFps` | FPS the analyze pipeline transcodes source videos at. The analyze step itself still calls Gemini at default 1fps sampling — bumping this only pre-warms the transcode/upload cache so a later `watchSegment(fps=N)` doesn't have to re-transcode or re-upload | `transcodeForUpload` + `uploadFileToGemini` path-keyed cache in `analyze` | `1` (number, not a boolean) |
| `transcodeConcurrency` | Number of ffmpeg transcode processes the analyze pipeline runs in parallel. Transcode is decode-bound, so the default scales with cores | `resolveConcurrency` in `analyzer/pipeline.ts` | `CPU/4`, min `2` |
| `uploadConcurrency` | Parallel Gemini File API uploads in the analyze pipeline | `resolveConcurrency` in `analyzer/pipeline.ts` | `2` |
| `analyzeConcurrency` | Parallel Gemini analysis calls in the analyze pipeline | `resolveConcurrency` in `analyzer/pipeline.ts` | `2` |

### User overrides

Users may override any default by setting the flag explicitly under `featureFlags`:

```yaml
featureFlags:
  music: false            # disable music even though music files exist
  musicGeneration: true   # force-enable (still requires the model to be configured to actually work)
  voiceover: false
  multiStory: false       # keep the agent focused on the current story
```

An unset override leaves the default in place. Overrides only affect flag resolution — they do not add missing capabilities (e.g. setting `musicGeneration: true` without configuring `models.musicGeneration` will fail at tool-call time).

## Story Agent Skills

Skills hold narrow, situational editing instructions that do not need to occupy the story agent's system prompt on every turn. A skill's name is its `.md` filename without the extension, avoiding a duplicated name in frontmatter. Filenames cannot contain whitespace or path separators, but may use uppercase letters and punctuation such as hyphens, underscores, and dots. Frontmatter contains a trigger-oriented `description`, an optional `gatedBy` list of feature flag names, and an optional `unlockTools` list of story-agent tool names. `gatedBy` is validated only as a string array rather than against a duplicated feature-name registry; names absent from the resolved feature flags naturally evaluate as disabled. The body is loaded only when the agent calls `loadSkill(name)` or the user runs `/skill <name>`.

Skills are merged by filename in increasing precedence:

1. `skills/` in the Montai package (built in)
2. `~/.config/montai/skills/` (user-wide)
3. `<project>/skills/` (project-specific)

A higher layer replaces the same name from lower layers. A winning skill is excluded from the agent's list when any flag in `gatedBy` is false. `montai skills` always shows the built-in, user, and project source groups, including empty groups, with one line per skill showing whether it is active, overridden, or unavailable. An empty user or project group directly shows its skill creation directory. There is intentionally no `skills:` config section and no always-load option; persistent project instructions continue to belong in `AGENTS.md`.

The story system prompt contains only the active `name — description` list. `loadSkill` injects the skill body as a user message through the agent's steering queue, while its tool result returns only a confirmation. The injected message is persisted in session history but hidden by the TUI. A set of loaded names makes loading idempotent, including after session resume. v1 skills are Markdown-only and do not include resource files.

An active skill's `unlockTools` entries make that skill a prerequisite for those tools. The requirement is added to each affected tool's description, and a premature call fails with an instruction to use `loadSkill` first. A tool is unlocked only after the injected skill message is present in the agent's conversation history, not merely queued during the same turn; this ensures the agent has received the skill body before it can use the tool. If multiple active skills name the same tool, all of them are required. Overridden and feature-gated skills impose no requirements.

## Database Design

SQLite database (`montai.db`) in the project directory. Schema defined with Drizzle ORM in `src/db/schema.ts` and applied by the migrations in `drizzle/`.

### Tables

- **videos** — Discovered video files (whether analyzed is determined by joining video_analyses)
- **video_analyses** — Per-video LLM analysis results, fields flattened as columns (overview, location, timeOfDay, segments, highlights, technicalNotes), plus the provenance columns below
- **music** — Music files: both user-provided library tracks and AI-generated tracks. `type` column distinguishes 'library' (user-provided, analyzed by Gemini) from 'generated' (created via Lyria 3, `generationPrompt` stores the prompt). Shared ID space — `musicId` in timeline items references both types.
- **music_analyses** — Per-music LLM analysis results (overview, segments JSON), plus the provenance columns below
- **project_context** — Cached AI-generated project overview (`overview`) synthesizing all video analyses and the project's `AGENTS.md`, viewable via `montai project`. Auto-invalidated (`overview_stale`) when video analyses change, and on hash mismatch (`agents_hash`) when `AGENTS.md` changes.
- **stories** — Interactive story sessions (`montai story`), storing both the storyline and raw `TimelineItem[]` JSON. Each has a unique `name`. The `storyline` and `timeline` fields are nullable and filled progressively during the interactive session. The raw items are expanded into `ResolvedTimeline` format (with video paths, fps, resolution) at consumption time by export/render/preview commands.
- **story_marks** — TUI-local timeline checkpoints created via `/mark` in the story TUI. Each row stores a `TimelineItem[]` JSON snapshot for a specific story (`storyId` FK). `name` is unique within a story. Storyline is intentionally not captured; restore overwrites the current timeline only.
- **voiceovers** — Voiceover audio files: both user-provided recordings and AI-generated (TTS) narration. `type` distinguishes 'recording' (user-provided) from 'generated' (synthesized via `generateVoiceover`, `generationText` stores the script). Shared ID space — `voiceoverId` in timeline items references both types.
- **voiceover_analyses** — Per-voiceover transcription results (voiceoverId FK, transcription JSON `[{ startTime, endTime, text, skip }]`, overview text), plus the provenance columns below
- **sessions** — Agent conversation sessions for `montai story`. Each `montai story` invocation creates a session; `--resume` restores one. Stores `currentStoryId` (nullable FK to stories) which is written immediately on every change. A session can span multiple stories via `/switch`.
- **session_messages** — Individual messages (pi-ai `Message` as JSON) belonging to a session. Appended at `turn_end` via count-based diff against `agent.state.messages`. Order determined by autoincrement `id`.
- **gemini_files** — Cached Gemini File API references keyed by nullable `cacheKey` = the project-relative file path. Same scheme for every upload: source video transcodes (`.montai/transcoded/<id>-<n>fps.mp4`), music / voiceover assets (e.g. `musics/track1.mp3`), and previewFinalVideo renders (`.montai/agent-previews/<sha256>.mp4`). The path encodes everything the cache needs to distinguish — `<id>-<n>fps.mp4` already encodes the videoId+fps, the preview filename encodes the spec hash. Legacy rows with `NULL` cache keys are ignored and naturally replaced on next upload.

### Schema Migrations

Migrations live in `drizzle/` and ship in the npm package; `initDb` applies the pending ones (`src/db/migrate.ts`) on every command, so a database is brought up to date by whichever release opens it rather than by a separate step.

Each release ships exactly one migration, named after it (`0002_v0.6.0.sql`). Its snapshot in `drizzle/meta/` therefore describes what a database of that release looks like, which is how a database predating migrations is placed: it is matched against the snapshots, falling back to `pushSQLiteSchema` when it matches none. That fallback is the only remaining runtime use of drizzle-kit, and the only path that can still prompt for a rename.

Workflow:

1. After changing `src/db/schema.ts`, run `npm run db:generate`. Each change becomes its own migration named `head`, so the databases being tested against upgrade normally.
2. Before a release, bump the version in `package.json` and run `npm run db:squash`: it collapses everything unreleased into the single migration the release ships, named after that version.
3. Commit, then run `contrib/release.sh`, which reruns the squash and aborts if it changed anything.

### Analysis Provenance

The three `*_analyses` tables each carry `analyzed_at` (ISO 8601), `montai_version`, `model` and `prompt_hash`, written by `runAnalysisPipeline` and by `transcribeGeneratedVoiceover` via `provenanceFor()` (`src/analyzer/provenance.ts`). Source files are otherwise only invalidated by their md5 changing, so a project accumulates rows produced by different models and prompts; these columns are what makes an existing row attributable, and what `montai analyze --refresh` compares against.

`model` and `prompt_hash` together form the **analysis signature** (`analysisSignature()`): a stored row is stale when either differs from the current one. `prompt_hash` is `sha256` (first 12 hex chars) of the *rendered* prompt, so it moves when the template, the project's `AGENTS.md`, or `language` changes. Since the Zod schema is never sent to the API — `completeWithSchemaRetry` only validates locally — the prompt is also where the model's output contract lives, so a schema change is covered as long as the prompt describes it.

Two things are deliberately outside the signature. `montai_version` is recorded but never triggers staleness: most releases don't touch analysis, and in a development checkout the version changes on every commit, which would mark the whole library stale continuously. `featureFlags.transcodeFps` is not recorded at all: analyze uploads the transcoded file but passes no `videoMetadata`, so Gemini samples it at its default 1fps and the transcode rate cannot change the result.

All four columns are nullable — rows written before the columns existed cannot be attributed retroactively (and read as stale, which is the right default), and a migration can only add nullable columns to a populated table.

`montaiVersion()` (`src/utils/version.ts`) reports `0.6.0` for an installed release and `0.6.0+5.g3871658.dirty` for a development checkout: the `package.json` version, plus SemVer build metadata carrying `git describe`'s commit distance, short SHA and dirty marker. A development checkout is identified by `.git` existing at the package root — npm never ships it, and testing for the directory rather than for git succeeding avoids an installed copy under a user's `node_modules` reporting that user's tags. The distance segment is absent when no `v*` tag is reachable (shallow clones).

## Pipeline

### 1. Analyze (`montai analyze`)

All media types (video, music, voiceover) are discovered and registered per type (`syncVideos`/`syncMusic`/`syncVoiceovers` in `src/analyzer/`), then fed into one shared 3-stage pipeline (`runAnalysisPipeline` in `src/analyzer/pipeline.ts`). The pipeline has three stage queues — **transcode → upload → analyze** — each with its own concurrency (`resolveConcurrency`: transcode defaults to CPU/4 min 2, upload/analyze to 2; all overridable via `featureFlags`). Stages overlap: while some assets are being analyzed, others can be uploading or transcoding, and the analyze queue stays saturated regardless of media type.

Per-type behavior is encapsulated in a handler table (mime type, prompt name, schema, and DB persistence):

1. **Transcode** — Video only. Transcode via ffmpeg to reduce upload size (1 FPS, 720p 8-bit, mono audio 64kbps). Uses `-hwaccel auto` for platform-agnostic hardware-accelerated decode, falling back to a software re-run if that fails; the log annotates the hardware decoder actually used (parsed from ffmpeg stderr). Cached in `.montai/transcoded/` and reused until the source file changes. Audio (music/voiceover) skips this stage and is enqueued straight to upload.
2. **Upload** — Upload the (transcoded video or raw audio) file to the LLM File API, or reuse a cached ref if still active in `gemini_files`.
3. **Analyze** — Send file + prompt to get structured JSON, stored in `video_analyses` / `music_analyses` / `voiceover_analyses`. Voiceover analysis is transcription-focused (per-sentence timestamps with skip markers for unusable content). If `AGENTS.md` exists in the project directory, its contents are injected into every analysis prompt as user-provided context.

Supports resume: skips assets that already have an analysis row on a repeat run. Each stage has its own caching, so interrupted runs resume efficiently — completed transcodes and uploads are reused.

What gets analyzed is chosen by `SyncOptions` (`src/analyzer/provenance.ts`), which the three sync functions share: bare `montai analyze` takes only assets with no analysis row; `--refresh` adds those whose stored signature no longer matches (see [Analysis Provenance](#analysis-provenance)) and reports how many were stale; `--refresh --all` takes everything after a confirmation (`-f` skips it); `--refresh <file>` takes that one file unconditionally, since naming a file is already an explicit request. Staleness is evaluated in JS (`isStale()`) rather than as a where-clause so the comparison is written once for all three media types, and because the stale-count message needs the never-analyzed and outdated rows partitioned anyway.

### 2. Story (`montai story [name]`)

Interactive session that merges storyline generation and timeline editing into a single conversational flow. The user can iteratively refine both the storyline and timeline with the LLM.

Uses an agent loop with tools:
- `loadSkill(name)` — Load one available situational editing skill into the conversation as a hidden user message
- `updateStoryline(name?, title?, brief)` — Save/update the storyline. `brief` contains the storyline content: user requirements, creative direction, and current edit structure. `name` and `title` are required when creating a story, but omitted on existing stories to preserve the current identifier/title.
- `updateTimeline(index, deleteCount, items)` — Update timeline using splice semantics
- `watchSegment(videoId, startTime, endTime, fps?)` — Watch a source video segment. `startTime`/`endTime` are source timestamps in `MM:SS` or `MM:SS.s`. `fps` (default 1) controls Gemini's `videoMetadata.fps` AND drives the transcode fps (a cached `<videoId>-<fps>fps.mp4` at fps>=request is reused; otherwise a fresh transcode is produced)
- `previewFrame(clipIndex, timeOffset)` — Render one frame of the CURRENT edited timeline (Remotion, with crop/rotation/overlays/etc applied) and inject it as an image. For verifying a specific moment of the edit
- `previewFinalVideo(startSeconds?, endSeconds?, fps?)` — Render a range of the CURRENT edited timeline as a video, upload to Gemini File API, and inject as a video. Provides an end-to-end preview of the final composition. Defaults to the whole timeline at `fps=1`
- `getVideoAnalysis(videoId)` — Retrieve stored analysis
- `getVoiceoverAnalysis(voiceoverId)` — Retrieve stored transcription
- `generateMusic(prompt)` — Generate instrumental background music via Lyria 3 (~30s), returns musicId for use in music items
- `generateVoiceover(text, gender?)` — Synthesize narration audio via TTS, transcribe it in place, and return a voiceoverId for use in voiceover items (see AI Voiceover Generation)
- `listStories()` / `switchStory(name, new?)` — List and switch the active story when `multiStory` is enabled

`watchSegment`, `previewFrame`, and `previewFinalVideo` share a single 10-per-turn media budget (Gemini's per-request file-ref limit). `turn_start` fires before every LLM request rather than once per user message, so the counter resets for each new assistant message and the budget is a batch size: the agent can watch 10 segments, summarize them, and watch 10 more. `limitVideoFilesInContext` keeps only the 10 newest file refs across the whole conversation, replacing older ones with a placeholder — since a batch is evicted only after the agent has already seen it, the two limits line up and nothing is dropped unseen.

#### Preview implementation (previewFrame / previewFinalVideo)

Both tools use the `@remotion/renderer` programmatic API instead of the CLI:
- **Bundle reuse and media isolation**: `bundle()` is called once per process (lazy on first preview tool call) and the result cached as a module-level promise. The output dir `.montai/agent-bundle/` is reused across processes via webpack's caching layer. After bundle, `<bundleDir>/public` is replaced with a symlink to the Agent-only `.montai/agent-public/`, so newly hard-linked media is reachable without rebundling. Remotion Studio and formal renders keep using `.montai/preview-public/`; this separation prevents `previewFinalVideo` proxy links from changing media in a concurrently running Studio.
- **Direct fps output (previewFinalVideo)**: instead of rendering at composition fps and dropping frames via ffmpeg, the spec's `fps` is overridden to the requested preview fps before passing to `selectComposition` / `renderMedia`. MontaiVideo derives all per-frame quantities from `seconds * fps`, so total frames and transition overlaps adjust automatically. Lower preview fps means fewer frames actually rendered (no waste) at the cost of animation sample density — `previewFrame` is preferred when only a single moment matters; `previewFinalVideo` at higher fps is the right choice when checking transitions / Ken Burns / overlay animations. Preview output is rendered at `scale=0.5` of the spec's native resolution to keep file size small without an extra ffmpeg pass.
- **Browser-friendly preview media (previewFinalVideo)**: before rendering, the public media mapping reuses the smallest fresh `.montai/transcoded/<videoId>[-Nfps].mp4` whose fps is at least the requested preview fps. These full-duration 720p H.264 files preserve source timestamps and avoid expensive browser/`OffthreadVideo` decoding of camera originals. The public filename remains the original basename, so the resolved timeline is unchanged. Clips without an adequate fresh transcode fall back to their original source. This optimization is limited to the Agent's sampled final-video preview; Remotion Studio, formal `render`, and `previewFrame` continue to use original media.
- **Quiet routine logs**: Agent previews suppress Remotion's browser-download progress and recoverable media-fallback warnings while the story TUI spinner is active. Renderer and browser errors still print, and failed renders are returned as tool errors.
- **Cross-session caching**: PNG stills are stored at `.montai/agent-stills/<sha256(spec, frame)>.png`. Preview videos are stored at `.montai/agent-previews/<sha256(spec, range, fps)>.mp4` AND tracked in `gemini_files.cacheKey` (= the same relative path) so the corresponding Gemini File API URI is reused (subject to 48h expiry). Any change to the timeline shape changes the hash, so the cache invalidates naturally — and the same path-as-cacheKey mechanism is what gives source-video uploads their cross-session cache too.

Gated by the `previewTools` feature flag (default `true`).

The timeline uses a unified items array with clip-anchored positioning (startClip/endClip) instead of absolute times for overlays. Items are expanded into `ResolvedTimeline` format for downstream consumption.

Stories can be resumed: `montai story <name>` restores the current storyline and timeline state. Running `montai story` with no name shows an interactive arrow-key picker listing existing stories (plus a "new story" option); `--new` forces a fresh story. A new story's intro summarizes the footage and offers one provisional, high-level direction for discussion without committing to detailed editing decisions. The intro deliberately does not load skills: active skill names and descriptions remain visible in the system prompt, but all tool calls are suppressed, so no skill body enters the conversation. After the user confirms a direction, the agent loads relevant skills before making concrete editing decisions. Use `--no-intro` to skip the introduction and go straight to input.

Agent conversation sessions are persisted to the database. Each `montai story` invocation creates a new session; messages are appended at each `turn_end`. Use `--resume` to restore a previous session with full conversation history (interactive picker, or `--resume <id>` for a specific session). Use `--sessions` to list historical sessions. On resume, the system prompt is re-rendered from current config; context/hint injection is skipped since the history already contains them. Expired Gemini File API references (>48h) are automatically replaced with text placeholders before sending to the LLM.

After each agent response, a TUI timeline visualization is printed showing clips as `[ vN ]` blocks (proportional to duration), transitions as `~`, and overlays as `‹arrow style arrow›` on lanes above the clip track. Music lanes show library track basenames or a generated music prompt preview truncated at a word boundary. When clip blocks are narrow, internal label padding is compressed before the clip label is truncated. Overlays that overlap in time are placed on separate lanes, with lanes ordered bottom-up (closest to clips first). Arrow characters indicate overlay position (e.g. `↙` for bottom-left, `─` for center).

The TUI input supports multi-line prompts: Enter submits, while Shift-Enter inserts a newline when the terminal reports modified Enter keys. It keeps a readline-like editing subset for common cursor, word, deletion, history, and escape-key behavior. It also provides slash commands: `/skill <name>` manually loads an available skill, `/switch <name>` switches stories, `/mark [name]` snapshots the current timeline as a checkpoint (auto-named with a timestamp if no name given), `/marks` opens an interactive picker to restore or delete marks for the current story, and `/export [fcp|davinci]` and `/preview` are toggles for auto mode. When `/export` is on, FCPXML is regenerated after each LLM turn that modifies the timeline. `/export` takes an optional editor target (default `fcp`) matching the `montai export` flags; passing one switches the target and always turns auto-export on, so changing editors mid-session doesn't toggle it off. When `/preview` is on, Remotion Studio runs in the background and `timelines.json` is updated after each timeline change (full `preparePublicDir` only runs when new media files appear). A single status line is printed after the auto operations (e.g. "Remotion and FCPXML updated with 2 corrections").

### 3. Render (`montai render [name]`)

Loads Timeline(s) from the database (by name, or all if omitted), prepares a public directory with hard links to video files, then runs `npx remotion render` for each timeline against Montai's built-in static Remotion project with `--props` and `--public-dir` flags. Output goes to `output/<name>.mp4`.

### 4. Preview (`montai preview [name]`)

Loads Timeline(s) from the database (by name, or all if omitted), prepares a public directory with hard links to video files and a `timelines.json` index, then runs `npx remotion studio` against Montai's built-in static Remotion project with `--public-dir`. Root.tsx dynamically registers one Composition per timeline, so all stories appear in the Studio sidebar. Root.tsx uses `watchStaticFile` to monitor `timelines.json` for changes and automatically re-fetches it, enabling live updates when the story TUI's auto-preview mode rewrites the file.

### 5. Export (`montai export [name]`)

Generates FCPXML 1.11 format from a Timeline. If name is given, exports that single timeline; if omitted, exports all timelines. Output goes to `fcpxml/<name>.fcpxml`. Supports `--fcp` (default) and `--davinci` flags to optimize output for the target editor.

### 6. Archive (`montai archive`)

Archives all video segments referenced by any current story timeline, for safekeeping before deleting original source files. Timeline checkpoints in `story_marks` are intentionally ignored unless restored into a story's current timeline first. The output directory (`archived/`) contains only video files — no database or config. Each clip's time range (plus 2 seconds padding) is extracted from the source video. Overlapping segments from the same video (across all stories and clips) are merged into a single file.

By default uses passthrough (ffmpeg `-c copy`) to preserve original quality without re-encoding. The actual start time is aligned to the nearest prior keyframe via ffprobe, so the archived file may include a few extra frames before the requested range. Supports `--encode [spec]` for encoding: `--encode output` uses project output settings (resolution + fps from `montai.yaml`), or a custom spec like `--encode 720p,crf=20,fps=30,8bit`. 10-bit encoding (`10bit`) auto-detects the best available HEVC encoder (libx265, or hevc_videotoolbox on macOS); 8-bit (default) uses libx264.

Output filenames encode the source video name and precise time range: `<videoBase>-<start>s-<end>s.<ext>` (e.g., `DJI_0001-8.2s-27.5s.mp4`).

### 7. Clean (`montai clean`)

Removes regenerable cache files from the project directory — currently just the `.montai/` directory (transcoded videos, public dir, logs, preview/still/bundle caches). Since the cache is always safe to regenerate, it deletes without confirmation and prints the freed size on completion. User data (`montai.db`) and outputs (`output/`, `fcpxml/`, `archived/`, `generated-music/`, `generated-voiceover/`) are intentionally left untouched. The cache locations are kept in a list (`CACHE_DIRS`) so more can be added later.

### `--from-archived` flag (render, preview, export)

The `--from-archived` flag on `render`, `preview`, and `export` commands remaps timeline clip references to use files from `archived/`, enabling playback and export after deleting original source files. The remapping is filename-based: archived filenames encode the original video name and source time range, which is used to compute the time offset within the archived file. For `export`, the archived files are additionally probed via ffprobe to obtain accurate format metadata (resolution, fps, color space, etc.).

## Timeline Data Model

The timeline has two layers: raw `TimelineItem` (stored in DB, edited by LLM) and `ResolvedTimeline` (consumed by Remotion/FCPXML).

A project can produce multiple timelines (multiple output videos). Each has a unique `name` used as an identifier and output filename.

### Timeline Items

The LLM works with a unified items array containing four item types:

```typescript
ClipItem {
  type: 'clip'
  videoId: number
  startTime: string             // source video start time, MM:SS or MM:SS.s
  endTime: string               // source video end time, MM:SS or MM:SS.s
  playbackRate: number         // default 1
  volume: number               // default 1
  transition?: Transition      // optional; defines the transition FROM the previous clip INTO this clip
  rotation?: number            // degrees clockwise; applied before crop. Any angle accepted, but 90/180/270 are the typical cases (camera orientation fixes)
  crop?: Crop                  // static crop, % of post-rotation source content per edge
  cropEnd?: Crop               // if set, Ken Burns animation from crop → cropEnd
}

OverlayItem {
  type: 'overlay'
  text: string
  startClip: number            // 0-based clip index
  startOffset: number          // seconds from clip start (negative = from end)
  endClip?: number             // defaults to startClip
  endOffset: number            // seconds from clip end (0 = clip end, positive = from start)
  position: 'top-left' | 'top-right' | 'center' | 'bottom-left' | 'bottom-center' | 'bottom-right'
  style: 'title' | 'subtitle' | 'caption'
  animation: 'none' | 'fade' | 'slide' | 'pop'  // default 'none'
}

MusicItem {
  type: 'music'
  startClip: number
  startOffset: number
  endClip?: number
  endOffset: number
  musicId: number               // references music table (library or generated)
  startTime: string            // offset within music file, MM:SS or MM:SS.s (default "00:00")
  volume: number
  fadeInSeconds: number          // linear fade in (default 0)
  fadeOutSeconds: number         // linear fade out (default 0)
}

VoiceoverItem {
  type: 'voiceover'
  voiceoverId: number           // references voiceovers table
  startClip: number
  startOffset: number
  startTime: string            // start position in voiceover recording, MM:SS or MM:SS.s
  endTime: string              // end position in voiceover recording, MM:SS or MM:SS.s
  volume: number
}
```

Raw timeline items use `MM:SS` timestamps for source file times (`startTime`/`endTime`). Agent-facing source media descriptions also show media durations as `MM:SS`. Timeline-relative positions, offsets, and durations remain numeric seconds (`startOffset`, `endOffset`, `durationSeconds`, preview ranges, and ResolvedTimeline `timelineStartSeconds`/`timelineEndSeconds` fields). Older stored timelines with `startTimeSeconds`/`endTimeSeconds` on clip items, `audioStartSeconds` on music items, or `audioStartSeconds`/`audioEndSeconds` on voiceover items are accepted on read and normalized to the new source file time fields when saved.

During timeline sanitization, a music item's `startTime` is wrapped modulo the source music duration when it exceeds the playable range. The correction is reported explicitly so the agent/user can see that an invalid source offset was changed.

The agent-facing computed timeline summary starts each row with a time range and parenthesized duration measured on the final timeline. Source media ranges are labeled separately as `source`, and clip rows keep a bracketed clip-only index for `startClip`/`endClip` references. This gives the agent enough information to call `watchSegment` for existing clips and to split one music track into multiple consecutive items while keeping playback continuous.

When expanding overlays, if `endOffset` is at its default (0), the overlay end time is automatically pulled back to when the outgoing transition starts (i.e. the next clip's incoming transition), so the old subtitle disappears and the new one appears at the transition boundary. Explicit non-zero `endOffset` bypasses this adjustment.

These are expanded via `resolveTimeline()` into `ResolvedTimeline` format at consumption time:

```typescript
ResolvedTimeline {
  name: string
  fps: number
  width: number
  height: number
  clips: TimelineClip[]
  textOverlays: TextOverlay[]
  audioTracks: ResolvedAudio[]
  voiceoverTracks: ResolvedVoiceover[]
}

ResolvedClip {
  clipId: string
  videoId: number
  sourceFile: string
  sourceWidth?: number
  sourceHeight?: number
  startTimeSeconds: number
  endTimeSeconds: number
  playbackRate: number
  volume: number
  fit: 'contain' | 'cover'     // spatial conform, derived from sequence shape
  transition?: {
    type: 'fade' | 'slide' | 'wipe'
    direction?: 'from-left' | 'from-right' | 'from-top' | 'from-bottom'
    durationSeconds: number
  }
  rotation?: number            // passed through from ClipItem
  crop?: Crop                  // passed through from ClipItem
  cropEnd?: Crop               // passed through from ClipItem
}

ResolvedOverlay {
  text: string
  timelineStartSeconds: number
  timelineEndSeconds: number
  position: 'top-left' | 'top-right' | 'center' | 'bottom-left' | 'bottom-center' | 'bottom-right'
  style: 'title' | 'subtitle' | 'caption'
  animation?: {                  // expanded from OverlayItem's enum, with default duration filled in
    type: 'fade' | 'slide' | 'pop'
    durationSeconds: number      // default 0.3
  }
}

ResolvedAudio {
  sourceFile: string
  timelineStartSeconds: number
  timelineEndSeconds: number
  audioStartSeconds: number
  volume: number
  fadeInSeconds: number
  fadeOutSeconds: number
}

ResolvedVoiceover {
  sourceFile: string
  timelineStartSeconds: number
  timelineEndSeconds: number
  audioStartSeconds: number
  volume: number
}
```

VoiceoverItem differs from MusicItem: no endClip/endOffset (end position determined by endTime - startTime), no auto-loop, references voiceoverId instead of musicId. `resolveTimeline` validates that voiceover audio doesn't extend beyond the timeline end, rejecting the update with an error if it does.

## Remotion Output

Montai includes a static Remotion project at `remotion/`. This project is **never modified at runtime** — all dynamic data is passed via CLI flags:

- **Dynamic Compositions**: Root.tsx fetches `timelines.json` from the public dir and registers one Composition per timeline (using the story name as id)
- **Render mode**: Timeline passed via `--props=<path>`, composition targeted by story name, video files served via `--public-dir=<path>`
- **Studio mode**: All stories appear in the Studio sidebar for switching, video files served via `--public-dir=<path>`
- **Public dir**: `render`/`studio` commands create `.montai/preview-public/` with hard links to source video files and a `timelines.json` index; Agent preview tools use an isolated `.montai/agent-public/`
- **Dependencies**: Remotion, React, and transition packages are Montai's own dependencies — no separate install needed
- **Spatial conform**: Each clip is wrapped in layers — outer sequence box (black, hides overflow), middle conformed rectangle (size derived from post-rotation source dims + fit mode), crop layer in rotated-frame coordinates, and the original source box rotated around its center. Fit defaults from sequence shape: landscape → `contain` (pillarbox a cross-oriented source), vertical/square → `cover` (zoom-fill a cross-oriented source). Rotation is a source-orientation fix and is applied before fit; crop is expressed in post-rotation source-space percentages.

## FCPXML Output

Generates FCPXML 1.11 format XML. Maps clips to `<asset-clip>`, transitions to `<transition>`, text overlays to `<title>` (Essential Title template). Times expressed as rational numbers (e.g., `1001/30000s`). Each Timeline outputs to `fcpxml/<name>.fcpxml`.

Transition types map to FCP FxPlug effects: fade → Cross Dissolve, slide → Slide, wipe → Wipe. DaVinci Resolve only reliably imports Cross Dissolve; Slide and Wipe fall back to dissolve.

Text overlays use three Essential Titles Motion templates based on animation type: Essential Title (no animation / slide), Essential Fade (fade animation), and Essential Scale (pop animation). Font sizes and text shadow match Remotion's rendering. The `caption` style's background box cannot be replicated since Essential Title has no background element.

Overlay animations: fade and pop use FCP's built-in Essential Fade / Essential Scale templates, which handle the animation internally. Slide is implemented manually via Position param `keyframeAnimation` (the Essential Titles family has no slide template). The slide distance is computed dynamically to ensure text fully exits the frame.

Title positioning uses `<adjust-transform position>` on each `<title>`; the value is in percent of sequence height for both axes (origin at frame center, Y-up: `position = screenPx × 100 / seqH`). Text is anchored by its **outer visual edge** — the aligned edge (left/right for corners, center otherwise) sits a fixed gap from the frame margin — so different styles (title/subtitle/caption) and multi-line blocks all line up on the same top/bottom row, matching Remotion's `top:margin` / `bottom:margin` box model. The per-orientation edge gaps live in `TITLE_ANCHOR` and are calibrated against FCP imports (FCP's text box behaves differently per aspect and render path); a small per-orientation caption correction (`captionFixCoeff`, proportional to the subtitle−caption font-size gap) realigns the smaller caption onto the subtitle's bottom edge. DaVinci ignores the transform, so titles render at center there.

Font sizing has two regimes. In landscape, size is set directly via `text-style fontSize`; FCP renders a title's fontSize at `value × seqH/2160`, so the exporter pre-multiplies by `fontScale = 2 × shortEdge / seqH` to match Remotion's short-edge scaling (this reduces to 2× for 1080p landscape). In **narrow (vertical/square)** frames the Essential Titles' 1920×1080 internal canvas is conformed into the sequence, and under that conform FCP **ignores** the generated `text-style fontSize` and position entirely, rendering every title at the template's **default** size and position (verified by importing/round-tripping hand-authored Essential Titles: landscape preserves the authored size & position, vertical/square discards both and falls back to defaults). Size must therefore be driven by `<adjust-transform scale>`, which scales the rendered raster and is unaffected by the conform. Essential Title and Essential Fade render at different default sizes under conform (a side-effect of their differing animation-rig rest states), so they use different scale bases: Essential Title renders at a fixed base fontSize and shrinks by a measured aspect scale (`TITLE_SCALE_VERTICAL`/`SQUARE`) × the style ratio, while Essential Fade renders at the title fontSize and shrinks by the pure style ratio. DaVinci ignores the template and reads `text-style fontSize` directly at 1×. Other FCP-specific features (title positioning, overlay animations, slide/wipe transitions) are always included — DaVinci silently ignores them. Audio clips with volume and positioning import correctly into DaVinci, but fadeIn/fadeOut are ignored.

Known limitation: in narrow frames the shrink-to-fit font path renders text oversized before down-scaling, so FCP clips long left/right-aligned (corner) text against the frame edge during its internal render. Tracked, with diagnosis and candidate fixes, in `drafts/fcp-overlay-narrow-frame-clipping.md`.

Spatial conform is emitted as `<adjust-conform type="fill">` per clip when the project's default fit is cover (vertical/square sequences); omitted (default `fit` = contain) for landscape. DaVinci ignores `<adjust-conform>` — users must set project Image Scaling manually to match.

Crop/Ken Burns uses different strategies per target. Crop values are interpreted as % of the post-rotation source frame per edge (top:10 hides the top 10% of the visually upright frame). Visually, crop/zoom happens inside the conformed content box, so contain-mode clips are cropped within their pillarboxed/letterboxed content area rather than against the full sequence frame.
- **FCP**: `adjust-crop mode="crop"` for static crop, `mode="pan"` with two `pan-rect` elements for Ken Burns. Native support with full UI.
- **DaVinci**: Both static crop and Ken Burns use `adjust-transform` (scale + position). DaVinci's `adjust-crop mode="crop"` shows black bars instead of scaling to fill, and `mode="pan"` (Ken Burns) is completely ignored. For Ken Burns, the end state (`cropEnd`) is applied as a static transform — no animation, but preserves the intended final composition.

Rotation is expressed on `adjust-transform` (the `rotation` attribute, in degrees). Rotation is counter-clockwise in FCP's convention but clockwise in CSS/Remotion, so the FCPXML output negates the value to match the render. FCP imports `<adjust-conform>` before `<adjust-transform>`, but Montai's semantics are rotation before fit; for rotated clips, the exporter computes a uniform compensating transform scale so FCP's conform-then-rotate pipeline matches the rotate-then-fit result. This scale can be smaller or larger than 1 depending on source/output orientation, and is separate from the old black-corner cover scale. Static crop with 90°-multiple rotation uses FCP's native `adjust-crop`, with crop edges remapped from the rotated visual frame back to the source axes before rotation; arbitrary-angle rotation with crop falls back to a static `adjust-transform` approximation. Ken Burns (`cropEnd`) together with rotation falls back to the static `cropEnd` state.

Audio auto-loop crossfade in FCPXML uses different strategies per target:
- **FCP**: Loop segments are grouped into a secondary storyline (`<spine>`) with Cross Dissolve transitions between clips. Each clip is shrunk by half the crossfade duration to provide "handles" (extra source media for the transition to borrow). The last clip is extended to compensate for handle shrinkage.
- **DaVinci**: Loop segments are placed on alternating lanes (-N, -N-1) with individual fadeIn/fadeOut, since DaVinci doesn't support transitions in secondary storylines.

Audio lane assignment in FCPXML reuses lanes for non-overlapping music groups and only allocates additional lanes when group time ranges overlap. DaVinci loop segments still reserve two lanes within the group so crossfaded loop pieces can alternate without conflicting.

## Gemini Integration

Uses Gemini 3 models (default `gemini-3.8-flash`) via `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` (both patched via patch-package).

- **pi-ai**: Unified LLM abstraction, patched for the `FileContent` type carrying Gemini File API references (`fileData` + `videoMetadata`), for reporting Gemini's raw `finishReason` on errors, and for three things its `streamSimple` layer otherwise gets wrong for Montai: dropping `toolChoice`, forcing a thinking level, and clamping output tokens to 32000
- **pi-agent-core**: Agent loop orchestration for the `story` command, with tool execution and automatic conversation management
- **@google/genai**: Used directly for File API upload/polling only

pi-ai's bundled model registry trails Google's releases by months, so `src/gemini/models.ts` holds Montai's own descriptors for the models it accepts and `getGeminiModel()` resolves them, keeping new Gemini releases out of the patch.

Both LLM entry points go through pi-ai's normalized layer — `completeSimple()` for `analyze`, `streamSimple()` (as the agent's `streamFn`) for `story` — so a future provider is a pi-ai provider rather than a branch in Montai. Two of that layer's defaults are patched out:

- **Thinking level**: with no level requested it asked for the lowest level a model accepts — `MINIMAL` for a Gemini 3 Flash, which `gemini-3.8-flash` rejects with a 400. The patch sends no `thinkingConfig` at all instead, leaving each model at its own default. Setting `Agent.state.thinkingLevel` still selects a level through pi-ai's normal mapping.
- **Output cap**: it clamped `maxOutputTokens` to 32000. The patch uses the model's documented limit (65536 for every model in the table).

### Video Processing

Videos are transcoded during the preprocessing step of `analyze` (see Pipeline above). The transcoding parameters are chosen to match the LLM's processing capabilities:
- **1 FPS** — matches the LLM's default sampling rate, no information loss
- **720p, 8-bit color** — sufficient for visual analysis (70-280 tokens/frame)
- **Mono audio at 64kbps** — enough for speech recognition

This typically reduces a 100MB+ raw video to a few MB.

The LLM further processes uploaded video at 1Kbps mono audio and default media resolution.

The `watchSegment` tool returns `FileContent` with `videoMetadata` (startOffset/endOffset), which is injected directly into the agent's conversation context so the model sees the actual video pixels when making editing decisions.

### Supported Models

Configurable per-stage via `models` in `montai.yaml`.

| Stage | Video Input | Default | Supported Models |
|-------|------------|---------|-----------------|
| analysis | Yes | gemini-3.8-flash | gemini-3.8-flash, gemini-3.5-flash, gemini-3-flash-preview, gemini-3.1-pro-preview |
| editing | Yes | gemini-3.8-flash | gemini-3.8-flash, gemini-3.5-flash, gemini-3-flash-preview, gemini-3.1-pro-preview |
| musicGeneration | No | N/A | lyria-3-clip-preview |
| voiceoverGeneration | No | N/A | gemini-2.5-flash-preview-tts, system |

Gemini file references are cached in the database with 48-hour expiry tracking.

## Music Generation (Lyria 3)

The `generateMusic` tool in the story agent generates instrumental background music via Google Lyria 3 on the Gemini Developer API. Generated tracks are stored in the unified `music` table (type='generated') and can be referenced by `musicId` like any library track.

- **API**: Gemini Interactions API (`client.interactions.create`, model `lyria-3-clip-preview`), authenticated by `GEMINI_API_KEY`. Lyria 3 generates vocals by default, so `callLyria` appends an "Instrumental only, no vocals." directive to keep tracks usable as background music.
- **Environment variables**: `GEMINI_API_KEY` (same as analysis and editing)
- **Output**: ~30s instrumental MP3 at 44.1kHz stereo
- **Caching**: Generated files stored in `generated-music/` using SHA-256 hash of prompt. Same prompt reuses existing file + DB row.
- **Reuse**: Previously generated music appears in the story context under "Generated Music" so the LLM can reference it without regenerating. The LLM is prompted to prefer existing tracks (library or generated) before generating new ones.
- **Auto-loop**: When a music track (library or generated) is shorter than the music item's timeline span, `resolveTimeline()` automatically splits it into multiple `ResolvedAudio` entries that loop the track with a 1-second crossfade at loop boundaries. The `updateTimeline` tool reports this to the LLM as a correction.
- **Analysis**: Only library music is analyzed by Gemini during `montai analyze`. Generated music uses its generation prompt as the description.

## AI Voiceover Generation (TTS)

The `generateVoiceover` tool in the story agent synthesizes narration audio from a script. TTS is not a new timeline type — it is a generation entry point for the existing voiceover capability, mirroring how `generateMusic` writes into the `music` table. Generated audio reuses the existing `voiceovers` table (`type='generated'`), `VoiceoverItem`, resolve, FCPXML, and Remotion paths unchanged. The difference from recorded voiceover is the editing direction: recorded voiceover is narration-driven (the recording drives the cut), while TTS voiceover is editing-driven (write the script, synthesize, then place it under the footage).

- **Providers** (`models.voiceoverGeneration`): `gemini-2.5-flash-preview-tts` (default, high quality) calls Google Gemini-TTS via the Gemini Developer API (`models.generateContent` with `responseModalities: ['AUDIO']`), authenticated by `GEMINI_API_KEY`; the API returns raw 24kHz mono PCM which `callGeminiTts` wraps into a WAV. `system` (free, offline, robotic) shells out to macOS `say -o out.aiff` then converts to WAV with ffmpeg (macOS only, enforced at config resolution).
- **Voice**: the tool exposes a `gender` argument (`female` default / `male`) rather than a raw voice id. Each provider maps gender to a concrete voice: Gemini-TTS uses the prebuilt `Aoede` (female) / `Puck` (male), picked by ear for a conversational delivery — the voices Google labels "Firm" read as flat newsreader narration; `system` maps to macOS `say -v` voices per language, falling back to the female voice when a language has no reliable default male voice (e.g. Mandarin).
- **Style prompt**: Gemini-TTS has no explicit pacing/pitch controls, so delivery is only steerable by prefixing a natural-language style instruction to the script. A fixed prompt (natural, conversational, slightly faster) counteracts the model's slow, flat default. Not exposed to the agent today.
- **Language**: narration is spoken in `effects.voiceLanguage` (falling back to the first `effects.languages`, then `language`), which drives both the script-writing instruction in the prompt and the TTS voice/language selection.
- **Implementation**: `src/generate/tts.ts` mirrors `src/generate/music.ts` — it dispatches to a provider (the Gemini-TTS client lives in `src/gemini/tts.ts`, `say` is local to the file), then handles caching, persistence, and in-place transcription.
- **Caching**: Generated files stored in `generated-voiceover/` keyed by `SHA-256(text + synthesisSignature)`, where the signature covers everything besides the script that shapes the audio (provider, model, language code, concrete voice, style prompt) — so changing the voice or the prompt invalidates cached tracks instead of silently reusing them. An existing file or DB row (matched by md5 = hash) with a transcription is reused.
- **In-place transcription**: Every generated voiceover is re-transcribed through the same `analyze-voiceover` prompt (writing `voiceover_analyses`) rather than trusting TTS-native timestamps. This keeps timestamp provenance uniform with recordings and works for `system` (which returns none).
- **Context update**: The tool pushes the new voiceover and its analysis into the agent context (`allVoiceovers` / `allVoiceoverAnalyses`) so a `VoiceoverItem` can reference it in the same turn.
- **Ordering constraint**: Duration is unknown until synthesis, and `resolveTimeline` rejects clips that don't cover a voiceover span. So the order must be: write script → `generateVoiceover` (get duration) → size/trim clips. Generating per narrative beat (not one long take) makes clip alignment easier.
- **Clean**: `generated-voiceover/` is treated like `generated-music/` — never removed by `montai clean`.

## User Project Directory Structure

```
my-vlog-project/
  montai.yaml                  # User-authored
  AGENTS.md                    # Optional: instructions/knowledge for the LLM (used in analyze + story)
  montai.db                    # SQLite (auto-created)
  musics/                       # Background music files (optional)
    track1.mp3
  .montai/                     # Cache directory (in project directory)
    transcoded/                 # Preprocessed video files
    preview-public/             # Studio/render hard links to source media + timelines index
      timelines.json            # All timelines for Remotion Studio
      video1.mp4                # Hard link to source video
      track1.mp3                # Hard link to source audio
    agent-public/               # Isolated Agent preview media (may use proxies)
    agent-bundle/               # Reusable programmatic renderer bundle
    agent-previews/             # previewFinalVideo MP4 cache
    agent-stills/               # previewFrame PNG cache
    specs/                      # Temporary props for montai render
    logs/                       # Gemini API request/response dumps written on error
  generated-music/               # AI-generated music files (WAV, keyed by prompt hash)
  generated-voiceover/           # AI-generated (TTS) narration files (WAV, keyed by text+voice+provider hash)
  output/
    <name>.mp4                  # Generated by `montai render`
  fcpxml/
    <name>.fcpxml               # Generated by `montai export`
  archived/                      # Archived video clips only (generated by `montai archive`)
    DJI_0001-8.2s-27.5s.mp4    # Filename encodes source video name and time range
```
