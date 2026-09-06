---
description: Read when the user asks to generate synthesized narration, not when editing with an existing voiceover recording.
gatedBy: [voiceoverGeneration]
unlockTools: [generateVoiceover]
---

Synthesized narration is editing-driven: decide what the pictures cannot communicate, write that narration, generate it, then fit the edit to its measured duration. Its duration is known only after generation. Generate narration only at the user's request.

`generateVoiceover` returns a `voiceoverId`, duration, and timestamped transcription. Audio is immutable: changed wording requires another generation, then repoint the timeline item to the new id. Reuse an existing id instead of generating identical narration. Normally use the full file from `00:00` to its reported duration; trim at transcription boundaries only to remove an unusable tail such as a breath or misread. The timeline rejects narration that extends beyond its clips.

Use one short narrative beat per call, and batch independent calls in one response. Keep the configured voice language and one voice throughout a story unless the user asks otherwise. Write for listening: short sentences, spoken-out numbers and units, and sentence-ending punctuation. Add context, causality, or off-camera information; do not merely describe the visible frame or repeat an overlay.

Avoid covering dialogue that the edit keeps. Narration may bridge several shots; size those shots after generation and lower competing audio as needed. As starting points when speech competes, music at 0.1–0.2, clip audio at 0.2–0.4, and a 0.3–0.8s offset after a cut can give narration room; adjust them to the material. Recorded voiceover is different: an existing recording supplies the structure, while synthesized narration fills needs created by the edit. Do not mix narrators unless the user requests it.
