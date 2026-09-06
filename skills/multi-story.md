---
description: Read when the user explicitly asks to create, switch, compare, or move material between multiple stories.
gatedBy: [multiStory]
unlockTools: [listStories, switchStory]
---

A story contains one storyline and timeline. Source media, analyses, generated assets, output resolution, and language settings are project-wide. A second story can change structure, length, clip selection, pacing, narration, and music, but not project settings such as aspect ratio or language.

Use story tools only when the user explicitly refers to another story or wants a new one; a new direction or rebuilt edit remains in the current story. `switchStory({ new: true })` creates an empty story and copies nothing. If the user wants a checkpoint rather than another edit, they can run `/mark`; the agent cannot create marks.

After switching, work from the newly provided storyline and latest timeline, not older story state still visible in conversation. Updates always affect the current story and there is no undo, so switch back before writing after a comparison. To compare stories, switch into each and read its computed timeline; reading a story does not authorize changing it.

Clip items can move between stories unchanged because video ids and source times are project-wide. Overlay, music, and voiceover anchors cannot: `startClip` and `endClip` index the target story's clip order and must be recomputed. Anchor mistakes are not validated and silently move an item to the wrong shot. For a derived edit, create the empty story, save a kebab-case name describing the difference (`recap-60s`, not `v2`), then copy the intended items with corrected anchors.
