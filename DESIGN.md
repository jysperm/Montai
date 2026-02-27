# CutFlow

CutFlow is an AI-powered vlog auto-editing CLI tool. It takes raw vlog footage, uses LLM multimodal video understanding to analyze content, generates storylines, and produces edited videos via Remotion and FCPXML.

## Architecture Overview

CutFlow is a local TypeScript CLI tool, it operates on a user project directory containing a `cutflow.yaml` config file.

### Key Design Decisions

- **YAML config**: User create the `cutflow.yaml` file to describe the project
- **SQLite stored per project**: All intermediate data stored locally, use `pushSQLiteSchema` at runtime to auto-sync schema
- **Dual output**: `edit` generates FCPXML, `render`/`studio` use a static Remotion project bundled inside CutFlow
- **Static Remotion project**: The Remotion project lives inside CutFlow's source tree (`src/remotion/project/`) as real TSX files, never modified at runtime. All dynamic data flows through CLI flags (`--props`, `--public-dir`)
- **Less structured LLM outputs**: Prompts prefer free-form prose or Markdown over rigid JSON schemas for intermediate text (e.g. storyline narratives). Only outputs that are consumed programmatically (e.g. VideoSummary, Timeline) use structured JSON. This gives the LLM more flexibility and produces more natural text. Use examples in prompts to guide the expected content rather than prescribing exact schemas.

## Project Configuration

Users create a `cutflow.yaml` in their project directory:

```yaml
videos:
  - .                           # Current directory: scan for all video files
  - ~/footage/extra-clip.mp4    # Individual file also supported
intermediateLanguage: zh        # Language for LLM-generated text (zh | en)
output:
  resolution: 1080p             # 720p | 1080p | 1440p | 4k
  fps: 50
models:
  analyze: gemini-3-flash-preview       # Per-video analysis
  storyline: gemini-3-pro-preview       # Storyline generation
  edit: gemini-3-pro-preview            # Edit spec agent loop
effects:
  languages: [zh, en]           # Subtitle / caption languages
```

`intermediateLanguage` controls the language used by the LLM for all generated text: video analysis descriptions, project facts, storyline narratives, and timeline text content (titles, captions). Supports `zh` (Chinese) or `en` (English), defaults to `en`. This is separate from `effects.languages`, which controls subtitle/caption language variants in the final output.

Video entries can be directories (scanned for mp4/mov/avi/mkv files) or individual file paths. Paths support `.`, `~` expansion, and absolute paths. A common pattern is placing `cutflow.yaml` alongside the video files and using `.` to reference the current directory.

All generated files (`cutflow.db`, `.cutflow/`, `output/`, `fcpxml/`) are located relative to the directory containing `cutflow.yaml` (the project directory).

## Database Design

SQLite database (`cutflow.db`) in the project directory. Schema managed via Drizzle ORM with `pushSQLiteSchema` (auto-sync at runtime).

### Tables

- **videos** — Discovered video files (whether analyzed is determined by joining video_summaries)
- **video_summaries** — Per-video LLM analysis results, fields flattened as columns (overview, location, timeOfDay, segments, highlights, technicalNotes)
- **project_context** — User-provided facts about the project (markdown bullet list), managed via `cutflow analyze --add-fact`. Also stores an AI-generated project overview (`generated_overview`) that synthesizes all video summaries and user facts, viewable via `cutflow analyze --project`. The overview is cached and auto-invalidated (`generated_overview_stale`) when facts or video summaries change.
- **storylines** — Generated narrative structures (JSON), each with a unique `codename` (e.g. `night-market`) for CLI reference
- **timelines** — Concrete editing instructions (JSON), each with a unique `name` per project
- **gemini_files** — Cached Gemini File API references for uploaded videos

## Pipeline

### 1. Analyze (`cutflow analyze`)

Runs a 3-stage concurrent pipeline where each stage processes one video at a time, but different stages run in parallel on different videos:

1. **Transcode** — Transcode video via ffmpeg to reduce upload size (1 FPS, 720p 8-bit, mono audio 64kbps). Cached in `.cutflow/transcoded/` and reused until the source file changes.
2. **Upload** — Upload transcoded video to LLM File API (or reuse cached ref if still active in `gemini_files` table).
3. **Analyze** — Send video + prompt to get structured VideoSummary JSON, store in `video_summaries`. If project facts exist (from `--add-fact`), they are included as context in the analysis prompt.

While video N is being analyzed, video N+1 can be uploading, and video N+2 can be transcoding.

Additionally, `cutflow analyze --add-fact <text>` adds a user-provided fact to the project context. An LLM merges the new fact into the existing facts list, deduplicating and resolving contradictions.

`cutflow analyze --project` shows an AI-generated project overview that synthesizes all video summaries and user facts into a bullet list describing what the project is about, key locations, people, themes, and time span. The overview is cached and automatically regenerated when facts or video summaries change.

Supports resume: skips videos that already have a row in `video_summaries` on re-run. Each stage has its own caching, so interrupted runs resume efficiently — completed transcodes and uploads are reused.

### 2. Storyline (`cutflow storyline`)

Text-only LLM call. Sends all video summaries (and project facts if available) to receive structured Storyline JSON defining the narrative arc and clip selection.

### 3. Edit (`cutflow edit`)

Runs as an **agent loop** where the model iteratively builds the Timeline:

1. Start with storyline + video summaries
2. Draft an initial Timeline
3. Model can request to re-watch specific video segments (via LLM File API with `videoMetadata` start/end offsets)
4. Model updates Timeline based on what it sees
5. Loop terminates when model returns final Timeline or max iterations reached

Uses LLM function calling with tools:
- `watch_segment(videoId, startSeconds, endSeconds)` — Re-watch a video segment
- `get_video_summary(videoId)` — Retrieve stored summary

Outputs Timeline to `.cutflow/specs/<name>.json` and FCPXML file.

### 4. Render (`cutflow render [name]`)

Loads the Timeline from the database (by name, or latest if omitted), prepares a public directory with hard links to video files, then runs `npx remotion render` against CutFlow's built-in static Remotion project with `--props` and `--public-dir` flags. Output goes to `output/<name>.mp4`.

### 5. Studio (`cutflow studio [name]`)

Loads the Timeline from the database (by name, or latest if omitted), prepares a public directory (including `timeline.json` for studio fallback), then runs `npx remotion studio` against CutFlow's built-in static Remotion project with `--public-dir`.

## Timeline Data Model

The Timeline is the shared intermediate representation consumed by both Remotion and FCPXML generators.

A project can produce multiple Timelines (multiple output videos). Each Timeline has a unique `name` used as an identifier and output filename. Each render/studio invocation operates on a single Timeline, passed to the static Remotion project via `--props`.

```typescript
Timeline {
  name: string            // Unique identifier, used as output filename
  fps: number
  width: number
  height: number
  clips: TimelineClip[]
  textOverlays: TextOverlay[]
}

TimelineClip {
  clipId: string
  videoId: number
  sourceFile: string
  startTimeSeconds: number
  endTimeSeconds: number
  playbackRate: number
  volume: number
  transition: {               // Transition from previous clip into this clip
    type: 'none' | 'fade' | 'slide' | 'wipe'
    direction?: 'from-left' | 'from-right' | 'from-top' | 'from-bottom'  // For slide/wipe
    durationSeconds: number
  }
}

TextOverlay {
  text: string
  startTimeSeconds: number
  endTimeSeconds: number
  position: 'top' | 'center' | 'bottom'
  style: 'title' | 'subtitle' | 'caption'
}
```

## Remotion Output

CutFlow includes a static Remotion project at `src/remotion/project/` (inside CutFlow's own source tree). This project is **never modified at runtime** — all dynamic data is passed via CLI flags:

- **Single Composition** (`CutFlow`): Uses `calculateMetadata` to compute duration/dimensions from the Timeline
- **Render mode**: Timeline passed via `--props=<path>`, video files served via `--public-dir=<path>`
- **Studio mode**: Timeline fetched from `staticFile('timeline.json')` when props are empty, video files served via `--public-dir=<path>`
- **Public dir**: `render`/`studio` commands create `.cutflow/public/` with hard links to source video files and an `timeline.json` copy
- **Dependencies**: Remotion, React, and transition packages are CutFlow's own dependencies — no separate install needed

## FCPXML Output

Generates FCPXML 1.11 format XML. Maps clips to `<asset-clip>`, transitions to `<transition>`, text to `<title>`. Times expressed as rational numbers (e.g., `1001/30000s`). Each Timeline outputs to `fcpxml/<name>.fcpxml`.

## Gemini Integration

Uses Gemini 3 preview models (gemini-3-flash-preview, gemini-3-pro-preview) via `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` (with patch-package for FileContent support).

- **pi-ai**: Unified LLM abstraction, patched to support `FileContent` type for Gemini File API references (`fileData` + `videoMetadata`)
- **pi-agent-core**: Agent loop orchestration for the `edit` command, with tool execution and automatic conversation management
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

Configurable per-stage via `models` in `cutflow.yaml`.

| Stage | Video Input | Default | Supported Models |
|-------|------------|---------|-----------------|
| analyze | Yes | gemini-3-flash-preview | gemini-3-flash-preview, gemini-3-pro-preview |
| storyline | No | gemini-3-pro-preview | gemini-3-flash-preview, gemini-3-pro-preview |
| edit | Yes | gemini-3-pro-preview | gemini-3-flash-preview, gemini-3-pro-preview |

Gemini file references are cached in the database with 48-hour expiry tracking.

## User Project Directory Structure

```
my-vlog-project/
  cutflow.yaml                  # User-authored
  cutflow.db                    # SQLite (auto-created)
  .cutflow/                     # Cache directory (in project directory)
    transcoded/                 # Preprocessed video files
    specs/
      <name>.json               # Timeline JSON (written by `cutflow edit`)
    public/                     # Hard links to source video files + timeline.json
      timeline.json             # Copy of timeline for Remotion Studio fallback
      video1.mp4                # Hard link to source video
  output/
    <name>.mp4                  # Generated by `cutflow render`
  fcpxml/
    <name>.fcpxml               # Generated by `cutflow edit` (per Timeline)
```
