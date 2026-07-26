---
description: Read when the user explicitly asks to work with more than one story — switching between stories, creating a second one, comparing them, or moving material between them.
gatedBy: [multiStory]
unlockTools: [listStories, switchStory]
---

Use `listStories` and `switchStory` only when the user explicitly mentions another story or asks for a second story to exist. Reworking the direction or rebuilding the timeline stays in the current story.

## What a story is

A story is one storyline plus its timeline. Everything else is project-level and shared between stories: the source videos and their analyses, the music library, generated music and narration, the output resolution, and the language settings.

So a second story can differ in structure, length, clip selection, pacing, narration, and music — nothing else. A vertical cut of a landscape edit, or one narrated in another language, cannot be done as a separate story; those are `montai.yaml` settings that apply to every story. Say so instead of creating a story that cannot deliver what was asked.

If the user is worried about losing the current state, tell them they can run `/mark` first — timeline checkpoints are theirs to make, you cannot create one.

## How switching behaves

`switchStory({ new: true })` starts an empty story — nothing is copied from the current one.

After a switch, an earlier story's storyline and timeline may still be visible further up in the conversation, now stale. Work from the most recent timeline block, and re-read it before changing anything.

`updateStoryline` and `updateTimeline` always write to whichever story is current, and there is no undo. After a detour into another story, switch back before writing.

## Porting material

Clip items are portable verbatim — `videoId` and source timestamps are project-wide.

Anchored items are not. `startClip` / `endClip` in overlay, music, and voiceover items index the clip order of the story they came from. Recompute every anchor against the target's clip order. Nothing validates them, so an off-by-one silently moves text or music onto the wrong shot.

## Common requests

- User asks how two stories differ → switch into each and read its computed timeline before answering. Switching into a story is not permission to edit it.
- User asks for a new story, whether derived from the current edit or unrelated to it → `switchStory({ new: true })`, then `updateStoryline` with a title and a kebab-case name saying what differs (`recap-60s`, `family-cut`, not `v2`). Nothing carries over: to derive from the current story, re-emit its items with anchors recomputed.
- User asks to bring material over from another story → switch to the source story, write out the items you need, switch back, re-anchor them, then `updateTimeline`.
