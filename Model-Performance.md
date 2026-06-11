## Gemini

- **500 INTERNAL on out-of-range `videoMetadata.startOffset`** If `startOffset` in `videoMetadata` is past the uploaded video's duration, Gemini returns `500 INTERNAL` instead of a proper 400. `endOffset` past the end is handled fine (silently truncated). `startOffset == duration` correctly returns a 400. Reproducible on both `gemini-3-flash-preview` and `gemini-2.5-flash`.

### Gemini 3 Flash (`gemini-3.5-flash`)

- **Misreads `MM:SS` timestamps as concatenated decimal seconds** When `video-analysis` segments render as `MM:SS` and the model converts them to integer seconds for `watchSegment(startSeconds, endSeconds)`, it sometimes strips the colon instead of computing `MM*60+SS`. `00:XX` happens to give the right number, so the bug is silent until the minute digit is non-zero — e.g. `01:28` becomes `128` instead of `88`.

#### `gemini-3-flash-preview`

- **Omits required `name` when calling `updateStoryline` for new stories** The `name` parameter is marked `Optional` (to allow omitting it on subsequent updates), but is required on the first call to create a story. Flash frequently omits it even on the first call, likely because the schema shows it as optional and the description's "required on first call" nuance is ignored.
