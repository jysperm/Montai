# Montai

AI-powered tool that extracts storylines from unscripted footage and generates edited vlogs.

## Architecture Overview

Montai is a local TypeScript CLI tool, it operates on a user project directory containing a `montai.yaml` config file.

### Key Design Decisions

- **YAML config**: User create the `montai.yaml` file to describe the project
- **SQLite stored per project**: All intermediate data stored locally, use `pushSQLiteSchema` at runtime to auto-sync schema
- **Dual output**: `export` generates FCPXML, `render`/`studio` use a static Remotion project bundled inside Montai
- **Static Remotion project**: The Remotion project lives inside Montai's source tree (`src/remotion/project/`) as real TSX files, never modified at runtime. All dynamic data flows through CLI flags (`--props`, `--public-dir`)
- **Less structured LLM outputs**: Prompts prefer free-form prose or Markdown over rigid JSON schemas for intermediate text (e.g. storyline narratives). Only outputs that are consumed programmatically (e.g. VideoSummary, Timeline) use structured JSON. This gives the LLM more flexibility and produces more natural text. Use examples in prompts to guide the expected content rather than prescribing exact schemas.

### Historical Note

Earlier versions had separate `storyline` and `edit` commands — `storyline` generated a narrative in a single LLM call, and `edit` ran a non-interactive agent loop to produce a timeline from that storyline. These were replaced by the unified interactive `story` command which handles both storyline and timeline in a single conversational session.

## Project Configuration

Users create a `montai.yaml` in their project directory:

```yaml
videos:
  - .                           # Current directory: scan for all video files
  - ~/footage/extra-clip.mp4    # Individual file also supported
language: zh                     # Language for LLM-generated text (zh | en)
output:
  resolution: 1080p             # 720p | 1080p | 1440p | 4k
  fps: 50
models:
  analysis: gemini-3-flash-preview       # Per-video analysis
  editing: gemini-3-pro-preview         # Story agent loop
effects:
  languages: [zh, en]           # Subtitle / caption languages
```

`language` controls the language used for all internal text: video analysis summaries, project facts, project overview, storyline narratives, and story titles. Supports `zh` (Chinese) or `en` (English), defaults to `en`. This is separate from `effects.languages`, which controls the language(s) of overlay text in the final video. If multiple languages are specified (e.g. `[zh, en]`), each overlay should include bilingual text.

Video entries can be directories (scanned for mp4/mov/avi/mkv files) or individual file paths. Paths support `.`, `~` expansion, and absolute paths. A common pattern is placing `montai.yaml` alongside the video files and using `.` to reference the current directory.

All generated files (`montai.db`, `.montai/`, `output/`, `fcpxml/`) are located relative to the directory containing `montai.yaml` (the project directory).

## Database Design

SQLite database (`montai.db`) in the project directory. Schema managed via Drizzle ORM with `pushSQLiteSchema` (auto-sync at runtime).

### Tables

- **videos** — Discovered video files (whether analyzed is determined by joining video_summaries)
- **video_summaries** — Per-video LLM analysis results, fields flattened as columns (overview, location, timeOfDay, segments, highlights, technicalNotes)
- **project_context** — User-provided facts about the project (markdown bullet list), managed via `montai analyze --add-fact`. Also stores an AI-generated project overview (`generated_overview`) that synthesizes all video summaries and user facts, viewable via `montai analyze --project`. The overview is cached and auto-invalidated (`generated_overview_stale`) when facts or video summaries change.
- **stories** — Interactive story sessions (`montai story`), storing both storyline narrative and raw `TimelineItem[]` JSON. Each has a unique `name`. The `storyline` and `timeline` fields are nullable and filled progressively during the interactive session. The raw items are expanded into `ExpandedTimeline` format (with video paths, fps, resolution) at consumption time by export/render/preview commands.
- **gemini_files** — Cached Gemini File API references for uploaded videos

## Pipeline

### 1. Analyze (`montai analyze`)

Runs a 3-stage concurrent pipeline where each stage processes one video at a time, but different stages run in parallel on different videos:

1. **Transcode** — Transcode video via ffmpeg to reduce upload size (1 FPS, 720p 8-bit, mono audio 64kbps). Cached in `.montai/transcoded/` and reused until the source file changes.
2. **Upload** — Upload transcoded video to LLM File API (or reuse cached ref if still active in `gemini_files` table).
3. **Analyze** — Send video + prompt to get structured VideoSummary JSON, store in `video_summaries`. If project facts exist (from `--add-fact`), they are included as context in the analysis prompt.

While video N is being analyzed, video N+1 can be uploading, and video N+2 can be transcoding.

Additionally, `montai analyze --add-fact <text>` adds a user-provided fact to the project context. An LLM merges the new fact into the existing facts list, deduplicating and resolving contradictions.

`montai analyze --project` shows an AI-generated project overview that synthesizes all video summaries and user facts into a bullet list describing what the project is about, key locations, people, themes, and time span. The overview is cached and automatically regenerated when facts or video summaries change.

Supports resume: skips videos that already have a row in `video_summaries` on re-run. Each stage has its own caching, so interrupted runs resume efficiently — completed transcodes and uploads are reused.

### 2. Story (`montai story [name]`)

Interactive session that merges storyline generation and timeline editing into a single conversational flow. The user can iteratively refine both the storyline and timeline with the LLM.

Uses an agent loop with tools:
- `update_storyline(name, title, narrative)` — Save/update the storyline
- `update_timeline(index, deleteCount, items)` — Update timeline using splice semantics
- `watch_segment(videoId, startSeconds, endSeconds)` — Re-watch a video segment
- `get_video_summary(videoId)` — Retrieve stored summary

The timeline uses a unified items array with clip-anchored positioning (startClip/endClip) instead of absolute times for overlays. Items are expanded into `ExpandedTimeline` format for downstream consumption.

Sessions can be resumed: `montai story <name>` restores the current storyline and timeline state.

### 3. Render (`montai render [name]`)

Loads Timeline(s) from the database (by name, or all if omitted), prepares a public directory with hard links to video files, then runs `npx remotion render` for each timeline against Montai's built-in static Remotion project with `--props` and `--public-dir` flags. Output goes to `output/<name>.mp4`.

### 4. Preview (`montai preview [name]`)

Loads Timeline(s) from the database (by name, or all if omitted), prepares a public directory with hard links to video files and a `timelines.json` index, then runs `npx remotion studio` against Montai's built-in static Remotion project with `--public-dir`. Root.tsx dynamically registers one Composition per timeline, so all stories appear in the Studio sidebar.

### 5. Export (`montai export [name]`)

Generates FCPXML 1.11 format from a Timeline. If name is given, exports that single timeline; if omitted, exports all timelines. Output goes to `fcpxml/<name>.fcpxml`. Supports `--fcp` (default) and `--davinci` flags to optimize output for the target editor.

## Timeline Data Model

The timeline has two layers: raw `TimelineItem` (stored in DB, edited by LLM) and `ExpandedTimeline` (consumed by Remotion/FCPXML).

A project can produce multiple timelines (multiple output videos). Each has a unique `name` used as an identifier and output filename.

### Timeline Items

The LLM works with a unified items array containing three item types:

```typescript
ClipItem {
  type: 'clip'
  videoId: number
  startTimeSeconds: number
  endTimeSeconds: number
  playbackRate: number         // default 1
  volume: number               // default 1
  transition?: Transition      // optional; defines the transition FROM the previous clip INTO this clip
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
}

AudioItem {
  type: 'audio'
  startClip: number
  startOffset: number
  endClip?: number
  endOffset: number
  sourceFile?: string
  description?: string
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
}

ExpandedOverlay {
  text: string
  startTimeSeconds: number
  endTimeSeconds: number
  position: 'top-left' | 'top-right' | 'center' | 'bottom-left' | 'bottom-center' | 'bottom-right'
  style: 'title' | 'subtitle' | 'caption'
}
```

## Remotion Output

Montai includes a static Remotion project at `src/remotion/project/` (inside Montai's own source tree). This project is **never modified at runtime** — all dynamic data is passed via CLI flags:

- **Dynamic Compositions**: Root.tsx fetches `timelines.json` from the public dir and registers one Composition per timeline (using the story name as id)
- **Render mode**: Timeline passed via `--props=<path>`, composition targeted by story name, video files served via `--public-dir=<path>`
- **Studio mode**: All stories appear in the Studio sidebar for switching, video files served via `--public-dir=<path>`
- **Public dir**: `render`/`studio` commands create `.montai/public/` with hard links to source video files and a `timelines.json` index
- **Dependencies**: Remotion, React, and transition packages are Montai's own dependencies — no separate install needed

## FCPXML Output

Generates FCPXML 1.11 format XML. Maps clips to `<asset-clip>`, transitions to `<transition>`, text overlays to `<title>` (Essential Title template). Times expressed as rational numbers (e.g., `1001/30000s`). Each Timeline outputs to `fcpxml/<name>.fcpxml`.

Transition types map to FCP FxPlug effects: fade → Cross Dissolve, slide → Slide, wipe → Wipe. DaVinci Resolve only reliably imports Cross Dissolve; Slide and Wipe fall back to dissolve.

Text overlays use the Essential Title Motion template, which is the most compatible across FCP and DaVinci. Font sizes and text shadow match Remotion's rendering. The `caption` style's background box cannot be replicated since Essential Title has no background element.

Title positioning uses Essential Title's Motion template params. The template has a fixed 3840×2160 canvas with paragraph margins (left=-1600, right=1600, top=562, bottom=-700). Positioning is achieved by shifting the title object's Position param (`key="9999/10085/10086/1/100/101"`); horizontal alignment uses the standard `<text-style alignment>` attribute, vertical positioning is computed from font size. This works in FCP; DaVinci ignores Motion template params so titles render at center there.

The `--fcp`/`--davinci` flag controls target-specific adaptations:

| Aspect | `--fcp` (default) | `--davinci` |
|--------|-------------------|-------------|
| Font sizes / shadow | 2× scaled (template canvas 3840×2160) | 1× (DaVinci reads text-style directly) |
| Title positioning | Position param on Essential Title | Skipped (DaVinci ignores Motion params) |
| Transitions | fade, slide, wipe | All mapped to Cross Dissolve |

## Gemini Integration

Uses Gemini 3 preview models (gemini-3-flash-preview, gemini-3-pro-preview) via `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` (with patch-package for FileContent support).

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

The `watch_segment` tool returns `FileContent` with `videoMetadata` (startOffset/endOffset), which is injected directly into the agent's conversation context so the model sees the actual video pixels when making editing decisions.

### Supported Models

Configurable per-stage via `models` in `montai.yaml`.

| Stage | Video Input | Default | Supported Models |
|-------|------------|---------|-----------------|
| analysis | Yes | gemini-3-flash-preview | gemini-3-flash-preview, gemini-3-pro-preview |
| editing | Yes | gemini-3-pro-preview | gemini-3-flash-preview, gemini-3-pro-preview |

Gemini file references are cached in the database with 48-hour expiry tracking.

## User Project Directory Structure

```
my-vlog-project/
  montai.yaml                  # User-authored
  AGENTS.md                    # Optional: instructions/knowledge for the LLM (used in analyze + story)
  STYLE.md                     # Optional: writing style reference from previous scripts (used in story only)
  montai.db                    # SQLite (auto-created)
  .montai/                     # Cache directory (in project directory)
    transcoded/                 # Preprocessed video files
    public/                     # Hard links to source video files + timelines index
      timelines.json            # All timelines for Remotion Studio
      video1.mp4                # Hard link to source video
  output/
    <name>.mp4                  # Generated by `montai render`
  fcpxml/
    <name>.fcpxml               # Generated by `montai export`
```
