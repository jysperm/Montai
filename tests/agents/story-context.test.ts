import { describe, expect, it } from 'vitest';
import { renderPrompt } from '../../src/prompts/index.js';

describe('story context prompt', () => {
  it('renders source media headers with MM:SS durations', () => {
    expect(renderPrompt('story-context', {
      fullVideoAnalyses: [{
        videoId: 1,
        filename: 'clip.mp4',
        duration: '02:05',
        overview: 'A clip.',
        segments: [{ startTime: '00:10', endTime: '00:20', description: 'A usable moment.' }],
        highlights: [{ startTime: '00:12', endTime: '00:15', reason: 'Strong visual.' }],
      }],
      summaryVideoAnalyses: [{
        videoId: 2,
        filename: 'other.mp4',
        duration: '06:11',
        overview: 'Another clip.',
      }],
      fullVoiceoverAnalyses: [{
        voiceoverId: 3,
        filename: 'narration.wav',
        duration: '00:42',
        overview: 'Narration.',
        transcription: [{ startTime: '00:01', endTime: '00:04', text: 'Opening line.' }],
      }],
      summaryVoiceoverAnalyses: [{
        voiceoverId: 4,
        filename: 'extra.wav',
        duration: '01:30',
        overview: 'Extra narration.',
      }],
      fullMusicAnalyses: [{
        musicId: 5,
        filename: 'theme.wav',
        duration: '03:20',
        overview: 'Music bed.',
        segments: [{ startTime: '00:00', endTime: '00:30', description: 'Intro.' }],
      }],
      summaryMusicAnalyses: [{
        musicId: 6,
        filename: 'alt.wav',
        duration: '02:15',
        overview: 'Alternative track.',
      }],
      generatedMusic: [{
        musicId: 7,
        duration: '00:30',
        prompt: 'gentle piano',
      }],
    })).toMatchInlineSnapshot(`
      "Creating a new video edit from source footage.


      ## Video Analyses

      --- Video ID 1 (clip.mp4, 02:05) ---
      Overview: A clip.
      Segments:
      - 00:10-00:20: A usable moment.
      Highlights:
      - 00:12-00:15: Strong visual.

      ### Other Videos (summary only)

      Segments, speech content, quality notes, and technical notes are omitted. Use \`getVideoAnalysis\` to retrieve full details.

      --- Video ID 2 (other.mp4, 06:11) ---
      Overview: Another clip.

      ## Voiceover Recordings

      Segments marked [SKIP] were identified during transcription as unusable (hesitations, repetitions, etc.) and should be excluded when selecting voiceover segments.

      --- Voiceover ID 3 (narration.wav, 00:42) ---
      Overview: Narration.
      Transcription:
      - 00:01-00:04: Opening line.

      ### Other Voiceovers (summary only)

      Transcription is omitted. Use \`getVoiceoverAnalysis\` to retrieve full details.

      --- Voiceover ID 4 (extra.wav, 01:30) ---
      Overview: Extra narration.
      ## Music Library

      --- Music ID 5 (theme.wav, 03:20) ---
      Overview: Music bed.
      Segments:
      - 00:00-00:30: Intro.

      ### Other Music (summary only)

      Segments are omitted. Use \`getMusicAnalysis\` to retrieve full details.

      --- Music ID 6 (alt.wav, 02:15) ---
      Overview: Alternative track.
      ### Generated Music

      Previously generated background music. Reuse by setting \`musicId\` in music items, same as library tracks.

      --- Music ID 7 (generated, 00:30) ---
      Prompt: gentle piano

      "
    `);
  });
});
