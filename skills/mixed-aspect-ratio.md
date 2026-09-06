---
description: Read when source clips mix portrait and landscape orientations, or differ from the output aspect ratio.
---

The current output shape applies to every clip and story; timeline items cannot change it or select a per-clip fit mode. Video analyses do not reliably state source dimensions. Treat orientation as uncertain until confirmed with `watchSegment`; `qualityNotes` may flag wrongly oriented footage but is not confirmation. After rotation or crop, use `previewFrame` to confirm the conformed result—orientation and framing are easy to misjudge without seeing the output. Do not infer orientation from filenames or neighboring clips.

Montai conforms sources after `rotation`:

- Landscape output contains cross-oriented sources, preserving the whole frame with black bars.
- Vertical and square output cover the frame, cropping off-aspect edges around the center.

Use `rotation` first for footage stored sideways. `crop` then zooms and pans inside the conformed source rectangle; it does not change the aspect ratio or remove black bars, and its scale is shared across axes. A small asymmetric crop can recover a subject displaced by zoom-fill: `crop: { right: 15 }` hides 15% on the right and shifts the content right. Keep asymmetric values small because panning also increases zoom. `crop` to `cropEnd` can follow a moving subject.

Group similar shapes when practical so the treatment reads consistently. Treat pillarboxed footage as an intentional insert rather than an opening or establishing shot, and remember that overlays are positioned on the output frame, so corner text can land over black bars. Preview representative cross-oriented shots where subject framing matters; choose another shot when the subject cannot survive the conform.

If most footage conflicts with the output shape, explain the tradeoff and ask whether the user wants to change the project output before building the edit. Otherwise use one consistent treatment.
