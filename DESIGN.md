# Montai

AI-powered video editing tool that extracts storylines from unscripted footage and generates edited vlogs.

## Architecture Overview

Montai is a local TypeScript CLI tool, it operates on a user project directory containing a `montai.yaml` config file.

### Key Design Decisions

- **YAML config**: User create the `montai.yaml` file to describe the project
- **SQLite stored per project**: All intermediate data stored locally, use `pushSQLiteSchema` at runtime to auto-sync schema
- **Dual output**: `export` generates FCPXML, `render`/`studio` use a static Remotion project bundled inside Montai
- **Static Remotion project**: The Remotion project lives inside Montai's source tree (`src/remotion/project/`) as real TSX files, never modified at runtime. All dynamic data flows through CLI flags (`--props`, `--public-dir`)
- **Less structured LLM outputs**: Prompts prefer free-form prose or Markdown over rigid JSON schemas for intermediate text (e.g. storyline narratives). Only outputs that are consumed programmatically (e.g. VideoAnalysis, Timeline) use structured JSON. This gives the LLM more flexibility and produces more natural text. Use examples in prompts to guide the expected content rather than prescribing exact schemas.

### Historical Note

Earlier versions had separate `storyline` and `edit` commands — `storyline` generated a narrative in a single LLM call, and `edit` ran a non-interactive agent loop to produce a timeline from that storyline. These were replaced by the unified interactive `story` command which handles both storyline and timeline in a single conversational session.

## Project Configuration

Users create a `montai.yaml` in their project directory:

```yaml
assets:
  videos:
    - .                           # Current directory: scan for all video files
    - ~/footage/extra-clip.mp4    # Individual file also supported
  music:
    - ./musics/                   # Directory of background music files
  voiceover:
    - ./voiceover/                # Voiceover recordings for narration-driven editing
language: zh                     # Language for LLM-generated text (zh | en)
output:
  resolution: 1080p             # 720p | 1080p | 1440p | 4k
  fps: 50
models:
  analysis: gemini-3-flash-preview       # Per-video analysis
  editing: gemini-3.1-pro-preview         # Story agent loop
  musicGeneration: lyria-002            # Optional: enables AI music generation
effects:
  languages: [zh, en]           # Subtitle / caption languages
featureFlags:                    # Optional overrides (see Feature Flags)
  music: false
```

`language` controls the language used for all internal text: video analyses, project facts, project overview, storyline narratives, and story titles. Supports `zh` (Chinese) or `en` (English), defaults to `en`. This is separate from `effects.languages`, which controls the language(s) of overlay text in the final video. If multiple languages are specified (e.g. `[zh, en]`), each overlay should include bilingual text.

Video entries can be directories (scanned for mp4/mov/avi/mkv files) or individual file paths. Music and voiceover entries can be directories (scanned for mp3/wav/flac/m4a/aac/ogg files) or individual file paths. Paths support `.`, `~` expansion, and absolute paths. A common pattern is placing `montai.yaml` alongside the video files and using `.` to reference the current directory.

For backward compatibility, a top-level `videos` key (without `assets` wrapper) is still accepted and automatically mapped to `assets.videos`.

All generated files (`montai.db`, `.montai/`, `output/`, `fcpxml/`) are located relative to the directory containing `montai.yaml` (the project directory).

## Feature Flags

A `FeatureFlags` object (variable name `features` in code, type `FeatureFlags` in `src/feature-flags.ts`) gates optional capabilities across the LLM prompt and tool surface. Each flag resolves to a boolean at runtime: a computed default based on project context, optionally overridden by the `featureFlags` section in `montai.yaml`. The same resolved `features` object is passed into both the prompt templates (Handlebars `{{#if features.X}}`) and the tool list assembly.

The goal is a single switch per feature that controls both what the LLM is told about (prompt) and what it can call (tools), so that adding a new capability only requires defining a flag, its default, and the guarded prompt/tool sections.

### Defined features

| Feature | Description | Controls | Default |
|---------|-------------|----------|---------|
| `music` | Background music selection from the library and/or generated tracks | `getMusicAnalysis` tool; music item format and editing guidance in `story-system`; music analyses (library + summaries) in `story-context` | Project has music files (`assets.music` non-empty) **or** `models.musicGeneration` is configured |
| `musicGeneration` | AI-generated background music via Lyria 2 | `generateMusic` tool; "Using generateMusic" prompt section; generated-music list in `story-context` | `models.musicGeneration` is configured |
| `voiceover` | Voiceover-driven editing with transcription-aware timeline placement | `getVoiceoverAnalysis` tool; voiceover item format and editing guidance in `story-system`; voiceover analyses in `story-context` | Project has voiceover files (`assets.voiceover` non-empty) |

### User overrides

Users may override any default by setting the flag explicitly under `featureFlags`:

```yaml
featureFlags:
  music: false            # disable music even though music files exist
  musicGeneration: true   # force-enable (still requires the model to be configured to actually work)
  voiceover: false
```

An unset override leaves the default in place. Overrides only affect flag resolution — they do not add missing capabilities (e.g. setting `musicGeneration: true` without configuring `models.musicGeneration` will fail at tool-call time).

## Database Design

SQLite database (`montai.db`) in the project directory. Schema managed via Drizzle ORM with `pushSQLiteSchema` (auto-sync at runtime).

### Tables

- **videos** — Discovered video files (whether analyzed is determined by joining video_analyses)
- **video_analyses** — Per-video LLM analysis results, fields flattened as columns (overview, location, timeOfDay, segments, highlights, technicalNotes)
- **music** — Music files: both user-provided library tracks and AI-generated tracks. `type` column distinguishes 'library' (user-provided, analyzed by Gemini) from 'generated' (created via Lyria 2, `generationPrompt` stores the prompt). Shared ID space — `musicId` in timeline items references both types.
- **music_analyses** — Per-music LLM analysis results (overview, segments JSON)
- **project_context** — User-provided facts about the project (markdown bullet list), managed via `montai project --add-fact`. Also stores an AI-generated project overview (`overview`) that synthesizes all video analyses and user facts, viewable via `montai project`. The overview is cached and auto-invalidated (`overview_stale`) when facts or video analyses change.
- **stories** — Interactive story sessions (`montai story`), storing both storyline narrative and raw `TimelineItem[]` JSON. Each has a unique `name`. The `storyline` and `timeline` fields are nullable and filled progressively during the interactive session. The raw items are expanded into `ExpandedTimeline` format (with video paths, fps, resolution) at consumption time by export/render/preview commands.
- **voiceovers** — Voiceover recording files (filename, path, md5, duration, sample rate, channels)
- **voiceover_analyses** — Per-voiceover transcription results (voiceoverId FK, transcription JSON `[{ startTime, endTime, text, skip }]`, overview text)
- **gemini_files** — Cached Gemini File API references for uploaded videos, music, and voiceover files (videoId, musicId, or voiceoverId, all nullable)

## Pipeline

### 1. Analyze (`montai analyze`)

Runs a 3-stage concurrent pipeline for videos, followed by a 2-stage pipeline for music.

**Video pipeline** — each stage processes one video at a time, but different stages run in parallel on different videos:

1. **Transcode** — Transcode video via ffmpeg to reduce upload size (1 FPS, 720p 8-bit, mono audio 64kbps). Cached in `.montai/transcoded/` and reused until the source file changes.
2. **Upload** — Upload transcoded video to LLM File API (or reuse cached ref if still active in `gemini_files` table).
3. **Analyze** — Send video + prompt to get structured VideoAnalysis JSON, store in `video_analyses`. If project facts exist (from `montai project --add-fact`), they are included as context in the analysis prompt.

While video N is being analyzed, video N+1 can be uploading, and video N+2 can be transcoding.

**Music pipeline** — simpler 2-stage pipelined pipeline (no transcoding needed):

1. **Upload** — Upload audio file directly to Gemini File API (cached in `gemini_files` table with `musicId`).
2. **Analyze** — Send audio + music analysis prompt to get structured analysis (overview + segments), store in `music_analyses`.

If project facts exist (from `montai project --add-fact`), they are included as context in the analysis prompt.

**Voiceover pipeline** — same 2-stage structure as music (no transcoding):

1. **Upload** — Upload audio file to Gemini File API (cached in `gemini_files` with `voiceoverId`).
2. **Analyze** — Transcription-focused analysis: produces per-sentence timestamps with skip markers for unusable content (hesitations, repeats, etc.), plus an overview summary.

Supports resume: skips videos that already have a row in `video_analyses` on re-run. Each stage has its own caching, so interrupted runs resume efficiently — completed transcodes and uploads are reused.

### 2. Story (`montai story [name]`)

Interactive session that merges storyline generation and timeline editing into a single conversational flow. The user can iteratively refine both the storyline and timeline with the LLM.

Uses an agent loop with tools:
- `updateStoryline(name, title, narrative)` — Save/update the storyline
- `updateTimeline(index, deleteCount, items)` — Update timeline using splice semantics
- `watchSegment(videoId, startSeconds, endSeconds)` — Watch a video segment
- `getVideoAnalysis(videoId)` — Retrieve stored analysis
- `getVoiceoverAnalysis(voiceoverId)` — Retrieve stored transcription
- `generateMusic(prompt)` — Generate instrumental background music via Lyria 2 (~30s WAV), returns musicId for use in music items

The timeline uses a unified items array with clip-anchored positioning (startClip/endClip) instead of absolute times for overlays. Items are expanded into `ExpandedTimeline` format for downstream consumption.

Sessions can be resumed: `montai story <name>` restores the current storyline and timeline state. Running `montai story` with no name shows an interactive arrow-key picker listing existing stories (plus a "new story" option); `--new` forces a fresh story. Use `--no-intro` to skip the initial LLM summary and go straight to input.

After each agent response, a TUI timeline visualization is printed showing clips as `[ vN ]` blocks (proportional to duration), transitions as `~`, and overlays as `‹arrow style arrow›` on lanes above the clip track. Overlays that overlap in time are placed on separate lanes, with lanes ordered bottom-up (closest to clips first). Arrow characters indicate overlay position (e.g. `↙` for bottom-left, `─` for center).

The TUI provides slash commands: `/switch <name>` switches stories, `/render` triggers a render, and `/export` and `/preview` are toggles for auto mode. When `/export` is on, FCPXML is regenerated after each LLM turn that modifies the timeline. When `/preview` is on, Remotion Studio runs in the background and `timelines.json` is updated after each timeline change (full `preparePublicDir` only runs when new media files appear). A single status line is printed after the auto operations (e.g. "Remotion and FCPXML updated with 2 corrections").

### 3. Render (`montai render [name]`)

Loads Timeline(s) from the database (by name, or all if omitted), prepares a public directory with hard links to video files, then runs `npx remotion render` for each timeline against Montai's built-in static Remotion project with `--props` and `--public-dir` flags. Output goes to `output/<name>.mp4`.

### 4. Preview (`montai preview [name]`)

Loads Timeline(s) from the database (by name, or all if omitted), prepares a public directory with hard links to video files and a `timelines.json` index, then runs `npx remotion studio` against Montai's built-in static Remotion project with `--public-dir`. Root.tsx dynamically registers one Composition per timeline, so all stories appear in the Studio sidebar. Root.tsx uses `watchStaticFile` to monitor `timelines.json` for changes and automatically re-fetches it, enabling live updates when the story TUI's auto-preview mode rewrites the file.

### 5. Export (`montai export [name]`)

Generates FCPXML 1.11 format from a Timeline. If name is given, exports that single timeline; if omitted, exports all timelines. Output goes to `fcpxml/<name>.fcpxml`. Supports `--fcp` (default) and `--davinci` flags to optimize output for the target editor.

### 6. Archive (`montai archive`)

Archives all video segments referenced by any timeline, for safekeeping before deleting original source files. The output directory (`archived/`) contains only video files — no database or config. Each clip's time range (plus 2 seconds padding) is extracted from the source video. Overlapping segments from the same video (across all stories and clips) are merged into a single file.

By default uses passthrough (ffmpeg `-c copy`) to preserve original quality without re-encoding. The actual start time is aligned to the nearest prior keyframe via ffprobe, so the archived file may include a few extra frames before the requested range. Supports `--encode [spec]` for encoding: `--encode output` uses project output settings (resolution + fps from `montai.yaml`), or a custom spec like `--encode 720p,crf=20,fps=30,8bit`. 10-bit encoding (`10bit`) auto-detects the best available HEVC encoder (libx265, or hevc_videotoolbox on macOS); 8-bit (default) uses libx264.

Output filenames encode the source video name and precise time range: `<videoBase>-<start>s-<end>s.<ext>` (e.g., `DJI_0001-8.2s-27.5s.mp4`).

### `--from-archived` flag (render, preview, export)

The `--from-archived` flag on `render`, `preview`, and `export` commands remaps timeline clip references to use files from `archived/`, enabling playback and export after deleting original source files. The remapping is filename-based: archived filenames encode the original video name and source time range, which is used to compute the time offset within the archived file. For `export`, the archived files are additionally probed via ffprobe to obtain accurate format metadata (resolution, fps, color space, etc.).

## Timeline Data Model

The timeline has two layers: raw `TimelineItem` (stored in DB, edited by LLM) and `ExpandedTimeline` (consumed by Remotion/FCPXML).

A project can produce multiple timelines (multiple output videos). Each has a unique `name` used as an identifier and output filename.

### Timeline Items

The LLM works with a unified items array containing four item types:

```typescript
ClipItem {
  type: 'clip'
  videoId: number
  startTimeSeconds: number
  endTimeSeconds: number
  playbackRate: number         // default 1
  volume: number               // default 1
  transition?: Transition      // optional; defines the transition FROM the previous clip INTO this clip
  rotation?: number            // degrees clockwise; applied before crop. Any angle accepted, but 90/180/270 are the typical cases (camera orientation fixes)
  crop?: Crop                  // static crop (left/top/right/bottom as % of frame height)
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
  audioStartSeconds: number     // offset within music file (default 0)
  volume: number
  fadeInSeconds: number          // linear fade in (default 0)
  fadeOutSeconds: number         // linear fade out (default 0)
}

VoiceoverItem {
  type: 'voiceover'
  voiceoverId: number           // references voiceovers table
  startClip: number
  startOffset: number
  audioStartSeconds: number     // start position in voiceover recording
  audioEndSeconds: number       // end position in voiceover recording (required)
  volume: number
}
```

When expanding overlays, if `endOffset` is at its default (0), the overlay end time is automatically pulled back to when the outgoing transition starts (i.e. the next clip's incoming transition), so the old subtitle disappears and the new one appears at the transition boundary. Explicit non-zero `endOffset` bypasses this adjustment.

These are expanded via `expandTimeline()` into `ExpandedTimeline` format at consumption time:

```typescript
ExpandedTimeline {
  name: string
  fps: number
  width: number
  height: number
  clips: TimelineClip[]
  textOverlays: TextOverlay[]
  audioTracks: ExpandedAudio[]
  voiceoverTracks: ExpandedVoiceover[]
}

ExpandedClip {
  clipId: string
  videoId: number
  sourceFile: string
  startTimeSeconds: number
  endTimeSeconds: number
  playbackRate: number
  volume: number
  transition?: {
    type: 'fade' | 'slide' | 'wipe'
    direction?: 'from-left' | 'from-right' | 'from-top' | 'from-bottom'
    durationSeconds: number
  }
  rotation?: number            // passed through from ClipItem
  crop?: Crop                  // passed through from ClipItem
  cropEnd?: Crop               // passed through from ClipItem
}

ExpandedOverlay {
  text: string
  startTimeSeconds: number
  endTimeSeconds: number
  position: 'top-left' | 'top-right' | 'center' | 'bottom-left' | 'bottom-center' | 'bottom-right'
  style: 'title' | 'subtitle' | 'caption'
  animation?: {                  // expanded from OverlayItem's enum, with default duration filled in
    type: 'fade' | 'slide' | 'pop'
    durationSeconds: number      // default 0.3
  }
}

ExpandedAudio {
  sourceFile: string
  startTimeSeconds: number
  endTimeSeconds: number
  audioStartSeconds: number
  volume: number
  fadeInSeconds: number
  fadeOutSeconds: number
}

ExpandedVoiceover {
  sourceFile: string
  startTimeSeconds: number
  endTimeSeconds: number
  audioStartSeconds: number
  volume: number
}
```

VoiceoverItem differs from MusicItem: no endClip/endOffset (end position determined by audio duration), no auto-loop, references voiceoverId instead of musicId. `expandTimeline` validates that voiceover audio doesn't extend beyond the timeline end, rejecting the update with an error if it does.

## Remotion Output

Montai includes a static Remotion project at `src/remotion/project/` (inside Montai's own source tree). This project is **never modified at runtime** — all dynamic data is passed via CLI flags:

- **Dynamic Compositions**: Root.tsx fetches `timelines.json` from the public dir and registers one Composition per timeline (using the story name as id)
- **Render mode**: Timeline passed via `--props=<path>`, composition targeted by story name, video files served via `--public-dir=<path>`
- **Studio mode**: All stories appear in the Studio sidebar for switching, video files served via `--public-dir=<path>`
- **Public dir**: `render`/`studio` commands create `.montai/public/` with hard links to source video files and a `timelines.json` index
- **Dependencies**: Remotion, React, and transition packages are Montai's own dependencies — no separate install needed
- **Aspect mismatch**: Video elements use `object-fit: contain` so clips whose aspect differs from the sequence are pillarboxed/letterboxed (preserving source aspect) rather than non-uniformly stretched. This matches FCP/Resolve's default spatial conform behavior for mismatched `format` assets.

## FCPXML Output

Generates FCPXML 1.11 format XML. Maps clips to `<asset-clip>`, transitions to `<transition>`, text overlays to `<title>` (Essential Title template). Times expressed as rational numbers (e.g., `1001/30000s`). Each Timeline outputs to `fcpxml/<name>.fcpxml`.

Transition types map to FCP FxPlug effects: fade → Cross Dissolve, slide → Slide, wipe → Wipe. DaVinci Resolve only reliably imports Cross Dissolve; Slide and Wipe fall back to dissolve.

Text overlays use three Essential Titles Motion templates based on animation type: Essential Title (no animation / slide), Essential Fade (fade animation), and Essential Scale (pop animation). Font sizes and text shadow match Remotion's rendering. The `caption` style's background box cannot be replicated since Essential Title has no background element.

Overlay animations: fade and pop use FCP's built-in Essential Fade / Essential Scale templates, which handle the animation internally. Slide is implemented manually via Position param `keyframeAnimation` (the Essential Titles family has no slide template). The slide distance is computed dynamically to ensure text fully exits the frame.

Title positioning uses Essential Title's Motion template params. The template has a fixed 3840×2160 canvas with paragraph margins (left=-1600, right=1600, top=562, bottom=-700). Positioning is achieved by shifting the title object's Position param (`key="9999/10085/10086/1/100/101"`); horizontal alignment uses the standard `<text-style alignment>` attribute, vertical positioning is computed from font size. This works in FCP; DaVinci ignores Motion template params so titles render at center there.

The `--fcp`/`--davinci` flag currently controls font size scaling: FCP uses 2× scale (Essential Title template canvas is 3840×2160), DaVinci uses 1× (reads text-style fontSize directly). Other FCP-specific features (title positioning via Motion template params, overlay animations, slide/wipe transitions) are always included in the output — DaVinci silently ignores them without errors. Audio clips with volume and positioning import correctly into DaVinci, but fadeIn/fadeOut are ignored.

Crop/Ken Burns uses different strategies per target:
- **FCP**: `adjust-crop mode="crop"` for static crop, `mode="pan"` with two `pan-rect` elements for Ken Burns. Native support with full UI.
- **DaVinci**: Both static crop and Ken Burns use `adjust-transform` (scale + position). DaVinci's `adjust-crop mode="crop"` shows black bars instead of scaling to fill, and `mode="pan"` (Ken Burns) is completely ignored. For Ken Burns, the end state (`cropEnd`) is applied as a static transform — no animation, but preserves the intended final composition.

Rotation is expressed on `adjust-transform` (the `rotation` attribute, in degrees). Rotation is counter-clockwise in FCP's convention but clockwise in CSS/Remotion, so the FCPXML output negates the value to match the render. A cover scale is multiplied in to eliminate the black corners that appear when a rotated frame is smaller than its axis-aligned container. When a clip has both rotation and crop, the combined transform uses `scale = cropScale × coverScale` and crop's `position`, which is mathematically equivalent to rotate-then-crop. Rotation forces the `adjust-transform` path even on FCP (so native `adjust-crop` is not used); Ken Burns (`cropEnd`) together with rotation falls back to the static `cropEnd` state.

Audio auto-loop crossfade in FCPXML uses different strategies per target:
- **FCP**: Loop segments are grouped into a secondary storyline (`<spine>`) with Cross Dissolve transitions between clips. Each clip is shrunk by half the crossfade duration to provide "handles" (extra source media for the transition to borrow). The last clip is extended to compensate for handle shrinkage.
- **DaVinci**: Loop segments are placed on alternating lanes (-N, -N-1) with individual fadeIn/fadeOut, since DaVinci doesn't support transitions in secondary storylines.

## Gemini Integration

Uses Gemini 3 preview models (gemini-3-flash-preview, gemini-3.1-pro-preview) via `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` (with patch-package for FileContent support).

- **pi-ai**: Unified LLM abstraction, patched to support `FileContent` type for Gemini File API references (`fileData` + `videoMetadata`)
- **pi-agent-core**: Agent loop orchestration for the `story` command, with tool execution and automatic conversation management
- **@google/genai**: Used directly for File API upload/polling only

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
| analysis | Yes | gemini-3-flash-preview | gemini-3-flash-preview, gemini-3.1-pro-preview |
| editing | Yes | gemini-3.1-pro-preview | gemini-3-flash-preview, gemini-3.1-pro-preview |
| musicGeneration | No | N/A | lyria-002 |

Gemini file references are cached in the database with 48-hour expiry tracking.

## Music Generation (Lyria 2)

The `generateMusic` tool in the story agent generates instrumental background music via Google Lyria 2 on Vertex AI. Generated tracks are stored in the unified `music` table (type='generated') and can be referenced by `musicId` like any library track.

- **API**: Vertex AI `lyria-002:predict` endpoint, authenticated via Application Default Credentials (`google-auth-library`)
- **Environment variables**: `GOOGLE_CLOUD_PROJECT` (required), `GOOGLE_CLOUD_REGION` (optional, defaults to `us-central1`)
- **Output**: ~30s instrumental WAV at 48kHz stereo, $0.06/clip
- **Caching**: Generated files stored in `generated-music/` using SHA-256 hash of prompt. Same prompt reuses existing file + DB row.
- **Reuse**: Previously generated music appears in the story context under "Generated Music" so the LLM can reference it without regenerating. The LLM is prompted to prefer existing tracks (library or generated) before generating new ones.
- **Auto-loop**: When a music track (library or generated) is shorter than the music item's timeline span, `expandTimeline()` automatically splits it into multiple `ExpandedAudio` entries that loop the track with a 1-second crossfade at loop boundaries. The `updateTimeline` tool reports this to the LLM as a correction.
- **Analysis**: Only library music is analyzed by Gemini during `montai analyze`. Generated music uses its generation prompt as the description.

## User Project Directory Structure

```
my-vlog-project/
  montai.yaml                  # User-authored
  AGENTS.md                    # Optional: instructions/knowledge for the LLM (used in analyze + story)
  STYLE.md                     # Optional: writing style reference from previous scripts (used in story only)
  montai.db                    # SQLite (auto-created)
  musics/                       # Background music files (optional)
    track1.mp3
  .montai/                     # Cache directory (in project directory)
    transcoded/                 # Preprocessed video files
    public/                     # Hard links to source video + audio files + timelines index
      timelines.json            # All timelines for Remotion Studio
      video1.mp4                # Hard link to source video
      track1.mp3                # Hard link to source audio
    logs/                       # Gemini API request/response dumps written on error
  generated-music/               # AI-generated music files (WAV, keyed by prompt hash)
  output/
    <name>.mp4                  # Generated by `montai render`
  fcpxml/
    <name>.fcpxml               # Generated by `montai export`
  archived/                      # Archived video clips only (generated by `montai archive`)
    DJI_0001-8.2s-27.5s.mp4    # Filename encodes source video name and time range
```
