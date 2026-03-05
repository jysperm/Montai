# Montai

AI-powered tool that extracts storylines from unscripted footage and generates edited vlogs.

## Install

```bash
git clone https://github.com/jysperm/Montai.git
cd Montai
npm ci
npm link
```

This makes the `montai` command available globally. Requires `ffmpeg` and `ffprobe` on PATH. A [Gemini API key](https://aistudio.google.com/apikeys) is needed (set `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` environment variable).

## Quick Start

1. Create a project directory with your video files and a `montai.yaml`:

```yaml
videos:
  - .
intermediateLanguage: zh
output:
  resolution: 1080p
  fps: 50
models:
  analysis: gemini-3-flash-preview
  editing: gemini-3-pro-preview
```

2. Run the pipeline:

```bash
# Analyze all videos (uploads to Gemini, generates per-video summaries)
montai analyze

# Add project context facts to improve analysis and editing
montai analyze --add-fact "This is a trip to Tokyo with my family"

# View AI-generated project overview (synthesizes all video summaries + facts)
montai analyze --project

# Interactive story session — generates storyline and timeline conversationally
montai story

# Export FCPXML for Final Cut Pro
montai export
```

### Remotion Preview & Render

You can also preview and render the timeline directly via Remotion:

```bash
# Open Remotion Studio to preview the edit
montai remotion studio

# Render the final video
montai remotion render
```

Both commands use the latest timeline by default, or pass a name to specify one (e.g. `montai remotion render my-edit`).

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
| `story --hint <text>` | Initial direction hint for new story |
| `export [name]` | Export FCPXML from a timeline (omit name for latest) |
| `remotion render [name]` | Render video via Remotion |
| `remotion studio [name]` | Open Remotion Studio for preview |

## Project Structure

```
my-vlog-project/
  montai.yaml          # Project config
  montai.db            # SQLite database (auto-created)
  .montai/             # Cache (transcoded videos, specs)
  output/               # Rendered videos
  fcpxml/               # Generated FCPXML files
```
