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
  colorSpace: auto  # auto: detect from footage (HDR if any source is BT.2020) | sdr | hdr
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

# Export FCPXML for Final Cut Pro (exports all stories, or pass a name)
montai export
```

### Preview & Render

You can also preview and render the timeline directly:

```bash
# Open Remotion Studio to preview the edit
montai preview

# Render the final video
montai render
```

Both commands load all stories by default, or pass a name to specify one (e.g. `montai render my-edit`).

## Export .fcpxml

`montai export` generates FCPXML 1.11 files in the `fcpxml/` directory, which can be imported into professional video editors. FCPXML preserves clips, transitions, and text overlays, and is recommended over `render` for HDR projects.

### Final Cut Pro

Use File → Import → XML to import the `.fcpxml` file. After importing, the media files will appear offline. To relink them, select the imported project in the browser, then use File → Relink Files and locate the directory containing your video files.

### DaVinci Resolve

Use File → Import → Timeline → Import AAF, EDL, XML, FCPXML and select the `.fcpxml` file. After importing, the media files will appear offline. To relink them, import the referenced video files into the Media Pool — Resolve will automatically match them to the timeline clips (requires "Automatically conform missing clips added to the media pool" in Project Settings → General Options, enabled by default).

If your source footage is HDR (e.g. HLG), you need to enable color management in Project Settings → Color Management, otherwise the HDR gamma curve won't be converted correctly and the output will look washed out:

- **Output SDR**: Set Color Science to "DaVinci YRGB Color Managed", enable Automatic Color Management, Color Processing Mode to "SDR", Output Color Space to "Rec.709 Gamma 2.4"
- **Output HDR**: Set Color Science to "DaVinci YRGB Color Managed", enable Automatic Color Management, Color Processing Mode to "HDR", Output Color Space to "HDR HLG"

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
| `export [name]` | Export FCPXML from a timeline |
| `render [name]` | Render video via Remotion |
| `preview [name]` | Open Remotion Studio for preview |

## Video Format Support

Resolution and frame rate are configurable via `output.resolution` and `output.fps`.

|  | `export` (FCPXML) | `preview` / `render` |
|--|-------------------|---------------------|
| Color depth | Preserves source (8/10bit) | 8bit only |
| Color space | SDR and HDR (HLG/PQ) | SDR only (Rec. 709) |

`preview` and `render` use Remotion, which renders each frame through the browser's canvas (8bit sRGB). HDR metadata and 10bit color depth cannot be preserved. For HDR or 10bit projects, use `export` to generate FCPXML and finish in a video editor.

## Project Structure

```
my-vlog-project/
  montai.yaml          # Project config
  montai.db            # SQLite database (auto-created)
  .montai/             # Cache (transcoded videos, specs)
  output/               # Rendered videos
  fcpxml/               # Generated FCPXML files
```
