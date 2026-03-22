# Montai

AI-powered tool that extracts storylines from unscripted footage and generates edited vlogs.

## Install

```bash
git clone https://github.com/jysperm/Montai.git
cd Montai
npm ci && npm link
```

Prerequisites:

- `ffmpeg` and `ffprobe` on PATH (`brew install ffmpeg`)
- [Gemini API key](https://aistudio.google.com/apikeys) — set `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` environment variable

## Quick Start

1. Create a project directory with your video files and a `montai.yaml`:

```yaml
videos:
  - .
# Language for intermediate text (e.g. storyline, summaries)
language: en
output:
  resolution: 1080p
  fps: 50
models:
  analysis: gemini-3-flash-preview
  editing: gemini-3-pro-preview
effects:
  # Languages for text overlays, specify multiple for bilingual subtitles
  languages: [zh, en]
```

2. Analyze all videos (uploads to Gemini, generates per-video summaries):

```bash
montai analyze
```

3. Interactive story session — generates storyline and timeline conversationally:

```bash
montai story
```

4. Preview, render, or export:

```bash
# Open Remotion Studio to preview the edit
montai preview

# Render the final video via Remotion
montai render

# Export FCPXML for professional video editors
montai export --fcp        # for Final Cut Pro (default)
montai export --davinci    # for DaVinci Resolve
```

All commands load all stories by default, or pass a name to specify one (e.g. `montai render my-edit`).

## Interactive Story Editing

The `montai story` command opens an interactive session where you chat with AI to craft your storyline and timeline. You can use any language to iteratively refine the edit — adjust pacing, reorder scenes, add or remove clips, and tweak transitions — all through natural conversation.

## Export .fcpxml

`montai export` generates FCPXML 1.11 files in the `fcpxml/` directory, which can be imported into professional video editors. FCPXML preserves clips, transitions, and text overlays, and is recommended over `render` for HDR projects.

### Final Cut Pro (recommended)

First import your video files into Final Cut Pro, then use File → Import → XML to import the `.fcpxml` file. FCP will automatically link the media.

If your source footage is HDR, make sure the library uses Wide Gamut HDR color processing (Library Inspector → Modify → Wide Gamut HDR) before importing the FCPXML.

### DaVinci Resolve

First import your video files into the Media Pool, then use File → Import → Timeline → Import AAF, EDL, XML, FCPXML to import the `.fcpxml` file. Resolve will automatically match the media to the timeline clips.

If your source footage is HDR (e.g. HLG), enable color management in Project Settings → Color Management, otherwise the output will look washed out. Set Color Science to "DaVinci YRGB Color Managed", enable Automatic Color Management, then choose:

- **Output SDR**: Color Processing Mode "SDR", Output Color Space "Rec.709 Gamma 2.4"
- **Output HDR**: Color Processing Mode "HDR", Output Color Space "HDR HLG"

## Commands

| Command | Description |
|---------|-------------|
| `analyze` | Upload videos to Gemini, generate per-video summaries |
| `analyze --add-fact <text>` | Add a project fact (AI merges into existing facts) |
| `analyze --project` | Show AI-generated project overview (regenerates if stale) |
| `analyze --list` | List all videos and their analysis status |
| `analyze --show <filename>` | Show the stored summary for a video |
| `story [name]` | Interactive storyline + timeline editing session |
| `story --new` | Force create a new story |
| `story --list` | List all stories |
| `export` | Export FCPXML from a timeline |
| `export --fcp` | Optimize for Final Cut Pro (default) |
| `export --davinci` | Optimize for DaVinci Resolve |
| `render [name]` | Render video via Remotion |
| `preview` | Open Remotion Studio for preview |

Debug logging for LLM calls via the `DEBUG` env var:

```bash
DEBUG=montai:*,-montai:*:verbose montai story    # print each LLM call
DEBUG=montai:* montai story                      # including full message contents
```

## Project Structure

```
my-vlog-project/
  montai.yaml          # Project config
  AGENTS.md            # Optional: instructions/knowledge for the LLM
  STYLE.md             # Optional: writing style reference from previous scripts
  montai.db            # SQLite database (auto-created)
  .montai/             # Cache (transcoded videos, specs)
  output/               # Rendered videos
  fcpxml/               # Generated FCPXML files
```

## Output Compatibility

|  | Final Cut Pro | DaVinci Resolve | Remotion |
|--|---------------|-----------------|----------|
| Color depth | Passthrough (8/10bit) | Passthrough (8/10bit) | 8bit only |
| Color space | SDR and HDR (HLG/PQ) | SDR and HDR (HLG/PQ) | SDR only (Rec. 709) |
| Transitions | fade, slide, wipe | fade only | fade, slide, wipe |
| Text overlays | All positions | Centered only | All positions |
| Audio fades | Yes | No | Yes |

`preview` and `render` use Remotion, which renders each frame through the browser's canvas (8bit sRGB). HDR metadata and 10bit color depth cannot be preserved.

DaVinci Resolve only reliably imports Cross Dissolve (fade) from FCPXML — Slide and Wipe transitions fall back to dissolve. Audio fadeIn/fadeOut are also ignored by DaVinci.
