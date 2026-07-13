# Montai User Manual

Montai is a CLI tool for turning unscripted footage into edited vlog-style videos. It analyzes source media with AI, lets you shape the story through an interactive editing session, provides a live preview, and exports FCPXML for rendering or further editing in professional video editors.

## Contents

- [Requirements](#requirements)
- [Getting Started](#getting-started)
  - [Quick Start](#quick-start)
  - [Command Reference](#command-reference)
- [Montai Project](#montai-project)
  - [Project Layout](#project-layout)
  - [Configuration](#configuration)
  - [Models](#models)
  - [Environment Variables](#environment-variables)
  - [Agent Instructions](#agent-instructions)
- [Media Analysis](#media-analysis)
  - [Analyze Media](#analyze-media)
  - [Project Overview](#project-overview)
- [Story Editing](#story-editing)
  - [Editing Capabilities](#editing-capabilities)
  - [Interactive Story Editing](#interactive-story-editing)
  - [Live Preview](#live-preview)
  - [Stories](#stories)
  - [Sessions](#sessions)
  - [Timeline Marks](#timeline-marks)
  - [Background Music](#background-music)
  - [Voiceover-Driven Editing](#voiceover-driven-editing)
  - [AI Voiceover Generation](#ai-voiceover-generation)
- [Render](#render)
  - [Compatibility](#compatibility)
  - [Render with Remotion](#render-with-remotion)
  - [Export FCPXML](#export-fcpxml)
  - [Render with Final Cut Pro](#render-with-final-cut-pro)
  - [Render with DaVinci Resolve](#render-with-davinci-resolve)
- [Archive](#archive)
  - [Archive Source Clips](#archive-source-clips)
  - [Clean Cache](#clean-cache)
- [Troubleshooting](#troubleshooting)
  - [Logs](#logs)

## Requirements

Install Montai:

```bash
npm install -g montai-cli
```

Or install from source:

```bash
git clone https://github.com/jysperm/Montai.git
cd Montai
npm ci && npm link
```

Prerequisites:

- Node.js >= 22
- `ffmpeg` and `ffprobe` on PATH (`brew install ffmpeg`)
- [Gemini](https://ai.google.dev/gemini-api/docs/gemini-3) for video analysis and editing (required) — set `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/api-keys)
- [Lyria 2](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/lyria/lyria-002) for music generation and [Gemini TTS](https://ai.google.dev/gemini-api/docs/speech-generation) for voiceover generation (both are optional) — set `GOOGLE_CLOUD_PROJECT` and `GOOGLE_APPLICATION_CREDENTIALS` from [Google Cloud Console](https://console.cloud.google.com/)

## Getting Started

### Quick Start

1. Create a project directory and put your source videos in a `footage/` subdirectory inside it.

Create `montai.yaml`:

```yaml
assets:
  videos: ./footage
language: en
output:
  resolution: 1080p
  fps: 50
models:
  analysis: gemini-3.5-flash
  editing: gemini-3.5-flash
  musicGeneration: lyria-002 # Optional but recommended
```

2. Write your credentials to `~/.config/montai/env`:

```dotenv
GEMINI_API_KEY=...
GOOGLE_CLOUD_PROJECT=...
GOOGLE_APPLICATION_CREDENTIALS=/path/to/google-cloud-vertex-key.json
```

3. Analyze the source media:

```bash
montai analyze
```

4. Start a new interactive story editing session:

```bash
montai story --new
```

Inside the story session, use `/preview` to start Remotion Studio to preview the edited video or `/export` to export FCPXML for Final Cut Pro:

```text
> /preview
Auto preview: on
Remotion Studio: http://localhost:3000

> /export
Auto export: on
FCPXML exported
```

### Command Reference

| Command | Description | See Also |
|---------|-------------|---------|
| `montai analyze` | Transcode, upload, and analyze videos, music, and voiceovers | [Analyze Media](#analyze-media) |
| `montai analyze --re-run [file]` | Re-analyze media file (omit for all) | [Analyze Media](#analyze-media) |
| `montai analyze --list` | List media analysis status | [Analyze Media](#analyze-media) |
| `montai analyze --show <file>` | Show one stored media analysis | [Analyze Media](#analyze-media) |
| `montai project` | Show project overview and stats | [Project Overview](#project-overview) |
| `montai story` | Open an interactive story editing session (create new or open existing one) | [Interactive Story Editing](#interactive-story-editing) |
| `montai story --list` | List stories | [Stories](#stories) |
| `montai story --sessions` | List saved editing sessions | [Sessions](#sessions) |
| `montai story --resume [id]` | Resume a prior editing session (omit to select interactively) | [Sessions](#sessions) |
| `montai preview [name]` | Open Remotion Studio for preview (omit for all) | [Live Preview](#live-preview) |
| `montai export [name]` | Export FCPXML from a timeline (omit for all) | [Export FCPXML](#export-fcpxml) |
| `montai render [name]` | Render MP4 through Remotion (omit for all) | [Render with Remotion](#render-with-remotion) |
| `montai [preview \| export \| render] --from-archived` | Use archived videos as source | [Work From Archived Clips](#work-from-archived-clips) |
| `montai archive` | Archive original video clips referenced by current timelines | [Archive Source Clips](#archive-source-clips) |
| `montai archive --encode [spec]` | Encode archived clips instead of passthrough copy | [Encoded Archive](#encoded-archive) |
| `montai clean` | Remove regenerable cache files | [Clean Cache](#clean-cache) |

## Montai Project

### Project Layout

A Montai project is a normal directory containing a `montai.yaml` file. Run Montai commands from that directory.

Typical project:

```text
my-vlog-project/
  .montai/              # regenerable caches
  footage/
  musics/
  voiceover/
  generated-music/      # AI-generated music
  generated-voiceover/  # AI-generated voiceover
  archived/             # archived video clips
  fcpxml/               # FCPXML exports
  output/               # Remotion MP4 renders
  montai.db
  montai.yaml
  AGENTS.md             # optional editing instructions
```

`montai.db`, `.montai/`, `generated-music/`, `generated-voiceover/`, `fcpxml/`, `output/`, and `archived/` will be automatically created relative to the project directory.

### Configuration

The example below shows every option with its default and accepted values. Only `assets.videos` is required; all other keys can be omitted.

```yaml
# Each asset accepts a single path string or an array of strings.
# Paths can be relative to the project directory, absolute and `~/...` also accepted.
# Each path can be a directory to scan, or an individual media file.
# Use `.` to keep the media files next to `montai.yaml` in the project directory.
assets:
  # Required: Directories scanned for .mp4, .mov, .avi, .mkv.
  videos: ./footage
  # Directories scanned for .mp3, .wav, .flac, .m4a, .aac, .ogg.
  music: ./musics
  voiceover: ./voiceover
# Use for analysis summaries, storylines, titles, and internal text.
# Default: en. Accepts any ISO 639-1 code.
language: en
output:
  # Landscape: 720p, 1080p, 1440p, 2160p, 4k.
  # Vertical: 720v, 1080v, 1440v.
  # Square: 720s, 1080s, 1440s.
  # Default: 1080p.
  resolution: 1080p
  # Default: 50.
  fps: 50
models:
  # Used by `montai analyze` and `montai project`.
  # Default: gemini-3.5-flash.
  analysis: gemini-3.5-flash
  # Used by `montai story`.
  # Default: gemini-3.5-flash.
  editing: gemini-3.5-flash
  # Optional: specify a model to enable AI music generation.
  # Accepted only: lyria-002.
  musicGeneration: lyria-002
  # Optional: specify a model to enable AI voiceover generation.
  # Accepted: gemini-2.5-flash-tts, system.
  # `system` only supports macOS for now.
  voiceoverGeneration: gemini-2.5-flash-tts
effects:
  # Languages used in text overlays (can be different from `language` which is used for internal text).
  # Specify multiple values for bilingual overlays.
  # Default: [en]. Accepts any ISO 639-1 code.
  languages: [en, zh]
  # Optional; spoken language for AI-generated (TTS) voiceover. A single language.
  # Default: first item of `effects.languages`, then fallback to `language`. Accepts any ISO 639-1 code.
  voiceLanguage: en
# Override internal or experimental feature flags.
# You can also disable features that you will not use to reduce context.
featureFlags:
  # Enable music related features.
  # Default: true.
  music: false
  # Enable music generation.
  # Default: true.
  musicGeneration: false
  # Enable voiceover related features.
  # Default: true.
  voiceover: false
  # Enable AI (TTS) voiceover generation.
  # Default: derived from models.voiceoverGeneration.
  voiceoverGeneration: false
  # Enable agent self-feedback features.
  # Default: true.
  previewTools: false
  # Pre-transcoding FPS at analyze time.
  # Default: 1.
  transcodeFps: 5
  # Concurrency for ffmpeg transcoding at analyze time.
  # Default: CPU/4 (minimum 2).
  transcodeConcurrency: 4
  # Concurrency for Gemini file uploads at analyze time.
  # Default: 2.
  uploadConcurrency: 2
  # Concurrency for Gemini analysis at analyze time.
  # Default: 2.
  analyzeConcurrency: 2
```

If `montai.yaml` is missing, `montai analyze` can create a minimal default config after confirmation.

### Models

`models.analysis` and `models.editing` accept any of the following:

| Model | Notes |
|-------|-------|
| `gemini-3.5-flash` | Default and recommended, the best balance of quality, speed, and cost. |
| `gemini-3-flash-preview` | A cheaper option. |
| `gemini-3.1-pro-preview` | Much more expensive, with only a small gain in quality. |

`models.musicGeneration` and `models.voiceoverGeneration` are covered in [Background Music](#background-music) and [AI Voiceover Generation](#ai-voiceover-generation).

### Environment Variables

Montai reads environment variables first, and also loads dotenv-compatible variables from `~/.config/montai/env` on startup, values from this global file are only used when environment variables are not set.

Montai reads the following environment variables:

```dotenv
# Gemini LLM credentials, used for analysis and story editing.
GEMINI_API_KEY=...
# Google Cloud credentials, used for Music Generation (Lyria) and the Voiceover Generation (Gemini TTS).
GOOGLE_CLOUD_PROJECT=...
GOOGLE_APPLICATION_CREDENTIALS=/path/to/google-cloud-vertex-key.json
# Optional, the Google Cloud region used for music generation. Default: us-central1.
GOOGLE_CLOUD_REGION=us-central1
```

### Agent Instructions

Add an optional `AGENTS.md` file in the project directory for project-specific context.

Examples:

```markdown
# Editing Guidance

- Prefer calm pacing.
- Avoid clips where faces are too close to the camera.
- The trip was in Chiang Mai during the flower festival.
- Use Chinese titles with short English subtitles.
```

Montai passes `AGENTS.md` to:

- video/music/voiceover analysis
- project overview generation
- story editing

## Media Analysis

### Analyze Media

Run:

```bash
montai analyze
```

This command scans and analyzes all files in the project assets directory, writing analysis results to `montai.db` for future editing. This process may take a little bit of time to complete. You can interrupt it at any time, and it will resume from where it left off.

You can access the analysis results with the following commands:

```bash
montai analyze --list

montai analyze --show DJI_0001.MP4
montai analyze --show ./footage/DJI_0001.MP4
montai analyze --show narration.wav
```

Or re-run analysis on a specific file:

```bash
montai analyze --re-run DJI_0001.MP4
```

Omit the filename to re-run analysis on all files:

```bash
montai analyze --re-run
```

### Project Overview

Run:

```bash
montai project
```

Example output:

```text
Overview (cached)
A travel project focused on flower festival footage, night market scenes, and drone establishing shots.

Stories
  chiang-mai-flower-festival  Chiang Mai Flower Festival  [1m18s, 18 clips, 6 overlays]  2 hours ago

Videos
  34 files, 1h 12m, 28.4 GB, 18% highlights
  28× 4K 50p HDR
   6× 1080p 50p

Music
  Library: 5 files, 14m 20s, 42 MB
  Generated: 2 tracks, 1m 0s, 11 MB

Settings
  Output: 1080p 50fps
  Models: analysis=gemini-3.5-flash, editing=gemini-3.5-flash
  Language: en, effects: en
```

## Story Editing

### Editing Capabilities

Montai currently supports:

- **Clip trimming** — select segments from any analyzed video with precise start/end times
- **Playback rate** — speed up or slow down individual clips
- **Volume control** — adjust volume per clip
- **Transitions** — fade, slide, and wipe transitions between clips
- **Crop** — static crop to reframe shots
- **Ken Burns** — animated pan & zoom from one crop to another
- **Rotation** — rotate clips to fix footage shot in the wrong orientation
- **Text overlays** — title, subtitle, and caption styles at 6 positions, with fade, slide, and pop entrance animations
- **Background music** — add library music with volume and fade controls, auto-looping with crossfade
- **AI music generation** — generate instrumental background music
- **AI voiceover generation** — write a script and have the AI narrate it (Google Gemini-TTS, or macOS's built-in voices), then place the narration under the footage
- **Mixed orientations** — can also mix landscape and portrait shots in the same timeline, with automatic rotation adjustments
- **Voiceover-driven editing** — match video clips to narration recordings, selecting visuals that fit each spoken segment

The agent can also check its own work:

- **Inspect a single frame** — view any moment of the current edit as an image to verify how an effect actually looks
- **Watch the edited video** — view a range (or the whole timeline) end-to-end to check pacing, transitions, and overall flow

### Interactive Story Editing

Once you finish the analysis, you can start a new story:

```bash
montai story --new
```

![montai story demo](example/demo.gif)

Inside interactive mode, the agent can update the storyline, inspect source footage, choose or generate music, and edit the timeline, you can describe edits naturally, like:

> Make a short opening with the best drone shot, then build toward the night market. Keep it under 90 seconds and use bilingual title overlays.

Or you can just follow along with the AI's suggestions.

After every timeline change, the interactive mode will print a summary of the timeline in ASCII art.

#### Interactive Shell
It works just like a REPL:

- Enter to send your message
- Shift-Enter to inserts a newline
- Up/Down arrow keys to navigate history
- Ctrl-C or Ctrl-D to exit

#### Slash Commands

Slash commands are typed at an empty prompt by starting with `/`. Press Tab to complete command names.

| Command | Description | See Also |
|---------|-------------|---------|
| `/preview` | Toggle background live preview (Remotion Studio) | [Live Preview](#live-preview) |
| `/export` | Toggle automatic FCPXML export after timeline changes | [Export FCPXML](#export-fcpxml) |
| `/switch <name>` | Switch to an existing story or start a new story with that kebab-case name | [Stories](#stories) |
| `/mark [name]` | Save the current timeline as a checkpoint | [Timeline Marks](#timeline-marks) |
| `/marks` | Open a picker to restore or delete timeline marks | [Timeline Marks](#timeline-marks) |

### Live Preview

You can watch the edit in a browser while you work on it, powered by Remotion Studio.

The usual way is `/preview` during an editing session, which starts the preview in the background and prints its address:

```text
> /preview
Auto preview: on — Remotion Studio starting in background
  Remotion Studio: http://localhost:3000
```

Leave the page open, and it refreshes on its own every time the agent changes the timeline. Type `/preview` again to turn it off.

You can also open the preview on its own, without an editing session:

```bash
montai preview
```

This loads every story that has a timeline, and Remotion Studio shows one composition per story. Pass a story name to load just that one.

### Stories

A story is one edit of your footage: a storyline and the timeline built from it. A project can hold several, and each keeps its own timeline, so you can cut a long version and a short one from the same footage without them interfering.

Story names are kebab-case identifiers used by commands and output filenames. Story titles are human-readable labels shown in summaries.

Open an existing story by name:

```bash
montai story chiang-mai-flower-festival
```

With no name, Montai opens an interactive picker when stories already exist.

List stories, with the duration and contents of each timeline:

```bash
montai story --list
```

```text
chiang-mai-flower-festival  Chiang Mai Flower Festival  [1m24s, 16 clips, 2 overlays, 1 music]  8 minutes ago
morning-market  Morning Market  [empty]  2 days ago
```

Two options for starting a new story: `--hint` gives the agent an initial direction, and `--no-intro` skips the summary of your footage that it opens with.

```bash
montai story --new --hint "Make a 60-second upbeat travel recap." --no-intro
```

### Sessions

A session is the conversation you had with the agent while editing a story: your messages, its replies, and the edits that came out of them. It is separate from the story itself, so `montai story <name>` always picks up the latest timeline, only with an empty conversation. Resume a session when the earlier chat still matters — the direction you set, the things you already ruled out — and start a fresh one when it does not, which also keeps the agent's context small.

List saved sessions:

```bash
montai story --sessions
```

```text
  #12  chiang-mai-flower-festival  Chiang Mai Flower Festival  24 messages, 2 hours ago – 8 minutes ago
  #11  morning-market  Morning Market  6 messages, 2 days ago
```

Resume the session you pick from a list, or one by its number:

```bash
montai story --resume
montai story --resume 12
```

### Timeline Marks

Timeline marks are story-local checkpoints of the timeline, so you can try a bold edit and come back if you do not like it.

Use `/mark` once the timeline reaches a state worth keeping:

```text
/mark clean-opening
```

Names must be kebab-case and unique within the current story. Without a name, `/mark` creates a timestamped one (for example `20260712-143052`).

Use `/marks` to open the picker for the current story, where you can restore a mark or delete the ones you no longer need:

```text
Restore a mark  (Enter: restore, d: delete)
❯ clean-opening  [1m12s, 14 clips, 1 music]  2 hours ago
  20260712-143052  [1m24s, 16 clips, 2 overlays, 1 music]  8 minutes ago
  last-overwritten  [1m30s, 17 clips, 2 overlays, 1 music]  just now
```

Restoring overwrites the current timeline, and the overwritten one is saved as a mark named `last-overwritten`, so an accidental restore can itself be undone.

Notes:

- Marks cover the timeline only — the storyline text and the agent conversation session are not part of them.
- `montai archive` only considers the current timeline of each story, clips kept only by a mark are not archived.

### Background Music

Background music can come from your own library, or be generated by AI. By default the agent picks a track on its own, and generates one when the library has nothing suitable. You can also tell it what you want, either for the choice or for the generation.

To use your own music, add the files to `assets.music`:

```yaml
assets:
  videos: ./footage
  music: ./musics
```

Then run `montai analyze`, and the analyzed tracks become available to the story agent.

To let the AI compose a track instead, enable Lyria:

```yaml
models:
  musicGeneration: lyria-002
```

Generated tracks are saved in `generated-music/`, and the agent works with them just like library tracks.

### Voiceover-Driven Editing

Montai also supports building a video around narration you recorded yourself. The agent takes your voiceover as the backbone of the story, then picks the visuals that fit what you are saying at each moment.

Add narration files:

```yaml
assets:
  videos: ./footage
  voiceover: ./voiceover
```

Run:

```bash
montai analyze
```

Then ask:

> Build the edit around the narration. Use the voiceover timing as the structure and choose visuals that match each spoken segment.

Your narration is transcribed during analysis, so the agent can follow what you said, leave out fumbled takes, and keep only the parts worth using.

### AI Voiceover Generation

Montai can also narrate a video for you when you have no recordings of your own. The agent writes a script from what it saw in your footage, reads it aloud in a synthesized voice, and lays the narration under the cut.

Enable a provider:

```yaml
models:
  voiceoverGeneration: gemini-2.5-flash-tts
effects:
  voiceLanguage: en
```

Supported providers:

| Provider | Notes | Requirements |
|----------|-------|--------------|
| `gemini-2.5-flash-tts` | Recommended, Google Gemini-TTS via the Cloud Text-to-Speech API. | `GOOGLE_CLOUD_PROJECT` + `GOOGLE_APPLICATION_CREDENTIALS`, the same Google Cloud credentials as `musicGeneration`, no extra key. |
| `system` | Free and offline but robotic. Uses macOS's built-in `say`. | macOS only for now. No credentials needed. |

Then ask in `montai story`:

> Write a short narration for the flower market section and read it in a female voice, then trim the clips to cover it.

You can ask for a female or male voice; the exact voice depends on the provider and the spoken language. Generated narration is saved as audio files in `generated-voiceover/`.

## Render

### Compatibility

Montai supports several render mechanisms, however every mechanism has its own limitations. Overall we recommend to use Final Cut Pro for rendering.

| | Final Cut Pro | DaVinci Resolve | Remotion |
|---------|---------------|-----------------|----------|
| Color depth | Passthrough 8/10-bit | Passthrough 8/10-bit | 8-bit only |
| Color space | SDR and HDR | SDR and HDR | SDR only |
| Transitions | Fade, slide, wipe | Fade only | Fade, slide, wipe |
| Text overlays & animations | Full with known issues | Centered only, no animations | Full |
| Ken Burns | Full, not working with rotated | Fallback to static crop | Full |
| Mixed aspect ratios | Yes | Known issues | Yes |
| Audio fades | Yes | No | Yes |
| Render speed | Fast | Fast | Very slow |

### Render with Remotion

Render a story (or omit name to render all):

```bash
montai render my-story
```

Output files are written to `output/<story-name>.mp4`.

### Export FCPXML

`montai export` generates .fcpxml 1.11 files in the `fcpxml/` directory, which can be imported into professional video editors. .fcpxml preserves clips, transitions, and text overlays, and is recommended over Remotion Renderer for HDR projects.

Export FCPXML for a story (or omit name to export all):

```bash
montai export my-story
```

Final Cut Pro mode is the default (you can omit `--fcp`):

```bash
montai export --fcp
```

If you are exporting for DaVinci Resolve:

```bash
montai export --davinci
```

### Render with Final Cut Pro

First import your video files into Final Cut Pro, then use File → Import → XML to import the `.fcpxml` file. FCP will automatically link the media.

If your source footage is HDR, make sure the library uses Wide Gamut HDR color processing (Library Inspector → Modify → Wide Gamut HDR) before importing the .fcpxml.

![Imported to Final Cut Pro](example/fcp-timeline.png)

Known Issues:

- **FCP "The item is not on an edit frame boundary" warning.** Triggered when source footage has embedded timecode and a frame rate different from the sequence (e.g. 59.94fps footage in a 50fps project). Safe to dismiss — titles and audio still land in the correct positions.
- **Corner text can be clipped in vertical or square projects.** Long text in a left or right corner may be cut off at the frame edge. Shorten the text, or move the overlay to a centered position.
- **Ken Burns on a rotated clip falls back to a static crop.** The clip keeps its final framing, but the pan and zoom animation is lost.

### Render with DaVinci Resolve

First import your video files into the Media Pool, then use File → Import → Timeline → Import AAF, EDL, XML, FCPXML to import the `.fcpxml` file. Resolve will automatically match the media to the timeline clips.

If your source footage is HDR (e.g. HLG), enable color management in Project Settings → Color Management, otherwise the output will look washed out. Set Color Science to "DaVinci YRGB Color Managed", enable Automatic Color Management, then choose:

- **Output SDR**: Color Processing Mode "SDR", Output Color Space "Rec.709 Gamma 2.4"
- **Output HDR**: Color Processing Mode "HDR", Output Color Space "HDR HLG"

Known Issues:

- **Portrait clips are cropped in a landscape output.** Resolve ignores the conform settings in the `.fcpxml` and falls back to its own Image Scaling setting, which crops the clip to fill the frame instead of fitting it inside with black bars.
- **Only Cross Dissolve is imported reliably.** Slide and wipe transitions fall back to a dissolve.
- **Overlay animations and audio fades are ignored.** Text overlays still land in place, but without their entrance animation, and audio fade in/out is dropped.
- **Ken Burns falls back to a static crop.** The clip keeps its final framing, but the pan and zoom animation is lost.

## Archive

### Archive Source Clips

After creating stories, archive only the source ranges referenced by current timelines:

```bash
montai archive
```

Montai writes video clips to the `archived` folder under the project root, preserving the source filename and adding the extracted time range as a suffix (such as `DJI_0001-8.2s-27.5s.mp4`).

By default, `montai archive` adds 2 seconds of handles before and after each source range. You can adjust this with:

```bash
montai archive --handles 5
```

Notes:

- This command only archives video files, not music or voiceover.
- This command currently ignores timeline marks.
- Overlapping ranges from the same source video are merged into one file.
- Passthrough mode can only clip from keyframes, so the extracted range may be slightly longer.

#### Encoded Archive

By default, `montai archive` uses passthrough extraction, which preserves quality and is fast. You can enable encoded archive by passing the `--encode` option.

Use the output settings from your project (`montai.yaml`):

```bash
montai archive --encode
```

Or use custom settings:

```bash
montai archive --encode 720p,crf=20,fps=30,8bit
```

Supported encode options: any output resolution preset, `crf=<number>`, `fps=<number>`, `8bit`, `10bit`.

#### Work From Archived Clips

After archiving, you can delete your source files, and you can still render, preview, or export from archived clips:

```bash
montai preview --from-archived
montai render --from-archived
montai export --from-archived
```

### Clean Cache

```bash
montai clean
```

This command only removes regenerable cache files. All your source files, archived clips, outputs, FCPXML, and generated music are preserved.

## Troubleshooting

### Logs

Print short LLM call logs:

```bash
DEBUG=montai:*,-montai:*:verbose montai story
```

Print full message contents:

```bash
DEBUG=montai:* montai story
```

When the provider returns an error during `montai story`, Montai may write a debug dump under `.montai/logs`.
