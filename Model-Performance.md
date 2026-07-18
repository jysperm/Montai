## Gemini

- **500 INTERNAL on out-of-range `videoMetadata.startOffset`** If `startOffset` in `videoMetadata` is past the uploaded video's duration, Gemini returns `500 INTERNAL` instead of a proper 400. `endOffset` past the end is handled fine (silently truncated). `startOffset == duration` correctly returns a 400. Reproducible on both `gemini-3-flash-preview` and `gemini-2.5-flash`.

### `gemini-3.5-flash`

- **Misreads `MM:SS` timestamps as concatenated decimal seconds** When `video-analysis` segments render as `MM:SS` and the model converts them to integer seconds, it sometimes strips the colon instead of computing `MM*60+SS`. `00:XX` happens to give the right number, so the bug is silent until the minute digit is non-zero — e.g. `01:28` becomes `128` instead of `88`. Mitigation: source-file timestamps exposed to the story agent now use `MM:SS` fields (`watchSegment.startTime`/`endTime`, timeline `startTime`/`endTime`) and are parsed by tools internally; timeline offsets and durations remain seconds.
- **Attempts function calls when function calling mode is `NONE`** On the initial story turn, all function declarations remain in the request for prompt-prefix caching, while `toolConfig.functionCallingConfig.mode` is set to `NONE`. The model still attempts a function call and terminates with `MALFORMED_FUNCTION_CALL`; reproduced on three consecutive requests. The captured payloads confirm that `NONE` reached the Gemini API correctly.

#### `gemini-3-flash-preview`

- **Omits required `name` when calling `updateStoryline` for new stories** The `name` parameter is marked `Optional` (to allow omitting it on subsequent updates), but is required on the first call to create a story. Flash frequently omits it even on the first call, likely because the schema shows it as optional and the description's "required on first call" nuance is ignored.
