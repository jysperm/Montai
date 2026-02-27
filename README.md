# CutFlow

AI-powered vlog auto-editing CLI tool. Analyzes raw footage with Gemini, generates storylines, and produces edited videos via FCPXML or Remotion.

## Install

```bash
git clone https://github.com/jysperm/CutFlow.git
cd CutFlow
npm ci
npm link
```

This makes the `cutflow` command available globally. Requires `ffmpeg` and `ffprobe` on PATH. A [Gemini API key](https://aistudio.google.com/apikeys) is needed (set `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` environment variable).

## Quick Start

1. Create a project directory with your video files and a `cutflow.yaml`:

```yaml
videos:
  - .
intermediateLanguage: zh
output:
  resolution: 1080p
  fps: 50
models:
  analyze: gemini-3-flash-preview
  storyline: gemini-3-pro-preview
  edit: gemini-3-pro-preview
```

2. Run the pipeline:

```bash
# Analyze all videos (uploads to Gemini, generates per-video summaries)
cutflow analyze

# Add project context facts to improve analysis and editing
cutflow analyze --add-fact "This is a trip to Tokyo with my family"

# View AI-generated project overview (synthesizes all video summaries + facts)
cutflow analyze --project

# Generate a storyline from the summaries
cutflow storyline

# Generate timeline and FCPXML via agent loop
cutflow edit

# Export FCPXML for Final Cut Pro
cutflow export
```

### Remotion Preview & Render

You can also preview and render the timeline directly via Remotion:

```bash
# Open Remotion Studio to preview the edit
cutflow remotion studio

# Render the final video
cutflow remotion render
```

Both commands use the latest timeline by default, or pass a name to specify one (e.g. `cutflow remotion render my-edit`).

## Commands

| Command | Description |
|---------|-------------|
| `analyze` | Upload videos to Gemini, generate per-video summaries |
| `analyze --add-fact <text>` | Add a project fact (AI merges into existing facts) |
| `analyze --project` | Show AI-generated project overview (regenerates if stale) |
| `analyze --list` | List all videos and their analysis status |
| `analyze --show <filename>` | Show the stored summary for a video |
| `storyline` | Generate a narrative storyline from all video summaries |
| `edit` | Run an agent loop to produce a timeline |
| `export [name]` | Export FCPXML from a timeline (omit name for latest) |
| `remotion render [name]` | Render video via Remotion |
| `remotion studio [name]` | Open Remotion Studio for preview |

## Project Structure

```
my-vlog-project/
  cutflow.yaml          # Project config
  cutflow.db            # SQLite database (auto-created)
  .cutflow/             # Cache (transcoded videos, specs)
  output/               # Rendered videos
  fcpxml/               # Generated FCPXML files
```
