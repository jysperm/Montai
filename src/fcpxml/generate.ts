import { basename } from 'path';
import type { ExpandedTimeline, ExpandedClip } from '../schemas/timeline.js';
import { escapeXml, fcpName, framesToRational, round4, toRational } from './utils.js';
import { buildTitleLayout, makeTitleXml, titleEffectLines, titleEffectRef, titleEffectsNeeded } from './overlays.js';

export interface VideoFormatInfo {
  width: number;
  height: number;
  fpsNum: number;    // frame rate numerator, e.g. 60000
  fpsDen: number;    // frame rate denominator, e.g. 1001
  durationSeconds?: number | null;
  totalFrames?: number | null;
  bitDepth?: number | null;
  colorPrimaries?: string | null;
  colorTransfer?: string | null;
  audioChannels?: number | null;
  audioSampleRate?: number | null;
  startTimecode?: string | null;   // e.g. "15:03:38;24"
}

export function mapFcpxmlColorSpace(meta: VideoFormatInfo): string | null {
  const primaries = meta.colorPrimaries;
  const transfer = meta.colorTransfer;
  if (!primaries) return null;

  if (primaries === 'bt709') return '1-1-1 (Rec. 709)';
  if (primaries === 'bt2020') {
    if (transfer === 'pq') return '9-16-9 (Rec. 2020 PQ)';
    if (transfer === 'hlg') return '9-18-9 (Rec. 2020 HLG)';
    return '9-1-9 (Rec. 2020)';
  }
  return null;
}

export interface AudioFormatInfo {
  durationSeconds?: number | null;
  channels?: number | null;
  sampleRate?: number | null;
}

export function generateFcpxml(
  spec: ExpandedTimeline,
  videoMeta?: Map<string, VideoFormatInfo>,
  options?: { eventName?: string; projectTitle?: string; target?: 'fcp' | 'davinci' },
  audioMeta?: Map<string, AudioFormatInfo>,
  voiceoverMeta?: Map<string, AudioFormatInfo>,
): string {
  // FCP vs DaVinci: if a feature is silently ignored by DaVinci (no import
  // error), we don't branch on target — same output for both. We only branch
  // when DaVinci would produce wrong results, e.g. font size scaling: FCP needs
  // 2× (Essential Title template canvas is 3840×2160), DaVinci needs 1× (reads
  // text-style fontSize directly).
  const target = options?.target ?? 'fcp';

  // FCP built-in effect UIDs (title template UIDs live in overlays.ts)
  const CROSS_DISSOLVE_UID = 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265';
  const SLIDE_UID = 'FxPlug:6AAB0D54-FCD8-4EBD-A62D-D352A5ED1648';
  const WIPE_UID = 'FxPlug:857E2FBA-98DB-411B-A88C-CE6ABC1F65D8';
  const AUDIO_CROSSFADE_UID = 'FFAudioTransition';

  const { fps, width, height } = spec;
  const titleLayout = buildTitleLayout(width, height, target);
  let tsCounter = 0;
  const nextTs = () => `ts${++tsCounter}`;

  // --- Build format entries and asset resources ---
  const assetMap = new Map<string, string>(); // filename -> asset id
  const assetFormatMap = new Map<string, string>(); // filename -> format id
  const assetStartFrames = new Map<string, { frames: number; fpsNum: number; fpsDen: number }>();
  const assetLines: string[] = [];
  const formatLines: string[] = [];
  const formatMap = new Map<string, string>(); // format key -> format id
  let assetIndex = 1;

  // Dynamic resource ID allocation: r1 = sequence format, then effects, then per-source formats
  let nextResourceId = 2;
  // Allocate a resource id per title template the overlays require (see overlays.ts)
  const titleNeeds = titleEffectsNeeded(spec.textOverlays);
  const titleEffectId = titleNeeds.essential ? `r${nextResourceId++}` : null;
  const titleFadeId = titleNeeds.fade ? `r${nextResourceId++}` : null;
  const titleScaleId = titleNeeds.scale ? `r${nextResourceId++}` : null;
  // Determine which transition effects are used.
  // DaVinci only reliably imports Cross Dissolve, so map all transitions to fade.
  const usedTransitionTypes = new Set<string>();
  for (let i = 1; i < spec.clips.length; i++) {
    const trans = spec.clips[i].transition;
    if (trans) {
      usedTransitionTypes.add(trans.type);
    }
  }
  // Detect if audio loops need crossfade transitions
  const hasAudioLoops = (spec.audioTracks ?? []).some((a, i, arr) => {
    if (i === 0 || !a.sourceFile) return false;
    const prev = arr[i - 1];
    return prev.sourceFile && basename(a.sourceFile) === basename(prev.sourceFile)
      && a.startTimeSeconds < prev.endTimeSeconds;
  });
  const crossDissolveId = (usedTransitionTypes.has('fade') || hasAudioLoops) ? `r${nextResourceId++}` : null;
  const slideId = usedTransitionTypes.has('slide') ? `r${nextResourceId++}` : null;
  const wipeId = usedTransitionTypes.has('wipe') ? `r${nextResourceId++}` : null;
  const audioCrossfadeId = (usedTransitionTypes.size > 0 || hasAudioLoops) ? `r${nextResourceId++}` : null;
  let formatIndex = nextResourceId;

  let detectedHdr = false;

  function getOrCreateFormat(meta: VideoFormatInfo): string {
    const colorSpace = mapFcpxmlColorSpace(meta);
    const key = `${meta.width}x${meta.height}@${meta.fpsNum}/${meta.fpsDen}:${colorSpace ?? ''}`;
    const fpsApprox = Math.round(meta.fpsNum / meta.fpsDen);

    if (colorSpace && (colorSpace.includes('HLG') || colorSpace.includes('PQ'))) detectedHdr = true;

    // If it matches the sequence format, use r1
    if (meta.width === width && meta.height === height && meta.fpsNum === fps && meta.fpsDen === 1) {
      return 'r1';
    }
    if (formatMap.has(key)) return formatMap.get(key)!;

    const id = `r${formatIndex++}`;
    formatMap.set(key, id);
    const colorSpaceAttr = colorSpace ? ` colorSpace="${colorSpace}"` : '';
    formatLines.push(
      `        <format id="${id}" name="FFVideoFormat${meta.height}p${fpsApprox}" frameDuration="${meta.fpsDen}/${meta.fpsNum}s" width="${meta.width}" height="${meta.height}"${colorSpaceAttr} />`
    );
    return id;
  }

  for (const clip of spec.clips) {
    const filename = basename(clip.sourceFile);
    if (!assetMap.has(filename)) {
      const id = `asset-${assetIndex++}`;
      assetMap.set(filename, id);
      const maxEnd = spec.clips
        .filter((c) => basename(c.sourceFile) === filename)
        .reduce((max, c) => Math.max(max, c.endTimeSeconds), 0);

      const meta = videoMeta?.get(filename);
      const formatId = meta ? getOrCreateFormat(meta) : 'r1';
      assetFormatMap.set(filename, formatId);
      // Use source fps rational components for asset duration; fall back to sequence fps
      const assetFpsNum = meta?.fpsNum ?? fps;
      const assetFpsDen = meta?.fpsDen ?? 1;
      // Prefer frame-exact duration from totalFrames; fall back to seconds-based estimate
      let assetDuration: string;
      if (meta?.totalFrames && meta.totalFrames > 0) {
        assetDuration = `${meta.totalFrames * assetFpsDen}/${assetFpsNum}s`;
      } else {
        const assetSeconds = meta?.durationSeconds ?? (maxEnd + 10);
        const durationTicks = Math.floor(assetSeconds * assetFpsNum / assetFpsDen);
        assetDuration = `${durationTicks * assetFpsDen}/${assetFpsNum}s`;
      }

      // Compute asset start time from embedded timecode
      let assetStart = '0/1s';
      const tcStartFrames = meta?.startTimecode
        ? parseTimecodeToFrames(meta.startTimecode, assetFpsNum, assetFpsDen)
        : 0;
      if (tcStartFrames > 0) {
        assetStart = framesToRational(tcStartFrames, assetFpsNum, assetFpsDen);
      }
      assetStartFrames.set(filename, { frames: tcStartFrames, fpsNum: assetFpsNum, fpsDen: assetFpsDen });

      // Absolute file:// URL so FCP/DaVinci can locate the source media directly
      const srcUrl = `file://${escapeXml(clip.sourceFile || filename)}`;

      const audioAttrs = meta?.audioChannels
        ? ` audioSources="1" audioChannels="${meta.audioChannels}" audioRate="${meta.audioSampleRate ?? 48000}"`
        : '';
      assetLines.push(
        [
          `        <asset id="${id}" start="${assetStart}" duration="${assetDuration}" hasVideo="1" hasAudio="1"${audioAttrs} format="${formatId}">`,
          `            <media-rep kind="original-media" src="${srcUrl}" />`,
          `        </asset>`,
        ].join('\n')
      );
    }
  }

  // --- Build spine elements (sequential model with handle negotiation) ---
  // FCP sequential model: clips placed end-to-end with explicit offsets.
  // Transitions require source media handles (extra frames beyond clip in/out).
  // FCP requires roughly centered transitions — asymmetric ones render shortened.
  // Source shifts are pre-computed per clip considering both adjacent transitions:
  //   positive shift → creates pre-handle (for transition entering the clip)
  //   negative shift → creates post-handle (for transition leaving the clip)
  // When a clip can't satisfy both sides, the smaller deficit is prioritized.
  // Titles are nested inside clips as connected anchor items (lane=1).
  const spine: string[] = [];
  let seqOffset = 0;
  const I = '                    '; // base indent for spine children
  const II = I + '    '; // indent for items inside a clip

  // Pre-compute clip durations
  const clipDurations: number[] = [];
  for (const clip of spec.clips) {
    clipDurations.push((clip.endTimeSeconds - clip.startTimeSeconds) / clip.playbackRate);
  }

  // The ExpandedTimeline uses an "overlap model" (clips overlap by transition duration,
  // total time = sum(durations) - sum(transitions)), but FCPXML uses a "sequential model"
  // (clips placed end-to-end, transitions borrow handles from adjacent clips,
  // total time = sum(durations)). We build both coordinate systems and convert all
  // element positions (overlays, audio, voiceovers) from overlap to sequential via o2s().
  // For durations that represent fixed-length content (e.g. voiceover audio), use the
  // content's own duration rather than o2s(end) - o2s(start) to avoid stretching.
  const clipOverlapStarts: number[] = [];
  const clipSeqStarts: number[] = [];
  {
    let sOverlap = 0;
    let sSeq = 0;
    for (let i = 0; i < spec.clips.length; i++) {
      const trans = spec.clips[i].transition;
      if (i > 0 && trans) {
        sOverlap -= trans.durationSeconds;
      }
      clipOverlapStarts.push(sOverlap);
      clipSeqStarts.push(sSeq);
      sOverlap += clipDurations[i];
      sSeq += clipDurations[i];
    }
  }

  // Shorthand for overlapToSeq with pre-computed arrays.
  // o2s: inclusive boundary (>=), for start positions and general use.
  // o2sEnd: exclusive boundary (>), for end positions that fall exactly on a
  //   clip boundary — keeps them in the preceding clip instead of jumping to the next.
  const o2s = (t: number) => overlapToSeq(t, clipOverlapStarts, clipSeqStarts);
  const o2sEnd = (t: number) => overlapToSeq(t, clipOverlapStarts, clipSeqStarts, true);

  // Assign overlays to their parent clips (in sequential timeline positions)
  const clipOverlays = new Map<number, typeof spec.textOverlays>();
  for (const overlay of spec.textOverlays) {
    const seqStart = o2s(overlay.startTimeSeconds);
    for (let i = spec.clips.length - 1; i >= 0; i--) {
      if (seqStart >= clipSeqStarts[i]) {
        if (!clipOverlays.has(i)) clipOverlays.set(i, []);
        clipOverlays.get(i)!.push(overlay);
        break;
      }
    }
  }

  // Pre-compute transition frame counts (rounded to even for centering)
  const transFrames: number[] = new Array(spec.clips.length).fill(0);
  for (let i = 1; i < spec.clips.length; i++) {
    const clip = spec.clips[i];
    if (clip.transition) {
      let frames = Math.round(clip.transition.durationSeconds * fps);
      if (frames % 2 !== 0) frames += 1;
      transFrames[i] = frames;
    }
  }

  // Pre-compute source shifts. Each clip's valid shift range is [shiftMin, shiftMax]:
  //   shiftMin = pre-handle needed for incoming transition − natural pre-handle
  //   shiftMax = natural post-handle − post-handle needed for outgoing transition
  // We pick shift = clamp(0, shiftMin, shiftMax), preferring no shift when possible.
  const sourceShifts: number[] = new Array(spec.clips.length).fill(0);
  for (let i = 0; i < spec.clips.length; i++) {
    const clip = spec.clips[i];
    const meta = videoMeta?.get(basename(clip.sourceFile));
    if (!meta?.durationSeconds) continue;

    const preNeeded = (transFrames[i] / fps) / 2;
    const postNeeded = (i + 1 < spec.clips.length) ? (transFrames[i + 1] / fps) / 2 : 0;

    const shiftMin = preNeeded - clip.startTimeSeconds;
    const shiftMax = meta.durationSeconds - clip.endTimeSeconds - postNeeded;

    if (shiftMin <= shiftMax) {
      sourceShifts[i] = Math.max(shiftMin, Math.min(0, shiftMax));
    } else {
      // Can't satisfy both transitions — save at least one.
      const preFeasible = shiftMin <= (meta.durationSeconds - clip.endTimeSeconds);
      const postFeasible = -shiftMax <= clip.startTimeSeconds;
      if (preFeasible && postFeasible) {
        sourceShifts[i] = Math.abs(shiftMin) <= Math.abs(shiftMax) ? shiftMin : shiftMax;
      } else if (preFeasible) {
        sourceShifts[i] = shiftMin;
      } else if (postFeasible) {
        sourceShifts[i] = shiftMax;
      }
    }
  }

  // --- Build audio assets and assign anchor items to their parent clips ---
  // Each audio clip is placed as an anchor item (lane=-1) of the video clip
  // it starts on, with offset computed in that clip's source timebase.
  // DaVinci: volume and positioning work, but fadeIn/fadeOut ignored
  const audioAssetMap = new Map<string, string>();
  const clipAudioAnchors = new Map<number, string[]>();

  // Group consecutive same-file overlapping audio tracks (auto-loop segments) for spine transitions.
  type AudioTrack = NonNullable<typeof spec.audioTracks>[number];
  const audioGroups: AudioTrack[][] = [];
  for (const audio of spec.audioTracks ?? []) {
    if (!audio.sourceFile) continue;
    const prev = audioGroups[audioGroups.length - 1];
    const prevTrack = prev?.[prev.length - 1];
    if (prevTrack && basename(audio.sourceFile) === basename(prevTrack.sourceFile)
        && audio.startTimeSeconds < prevTrack.endTimeSeconds) {
      prev.push(audio);
    } else {
      audioGroups.push([audio]);
    }
  }

  // Register audio assets
  for (const group of audioGroups) {
    const filename = basename(group[0].sourceFile);
    if (!audioAssetMap.has(filename)) {
      const id = `audio-asset-${audioAssetMap.size + 1}`;
      audioAssetMap.set(filename, id);
      const meta = audioMeta?.get(filename);
      const sampleRate = meta?.sampleRate ?? 48000;
      const channels = meta?.channels ?? 2;
      const durationSeconds = meta?.durationSeconds ?? 600;
      const durationTicks = Math.round(durationSeconds * sampleRate);
      const srcUrl = `file://${escapeXml(group[0].sourceFile || filename)}`;
      assetLines.push([
        `        <asset id="${id}" start="0/1s" duration="${durationTicks}/${sampleRate}s" hasAudio="1" audioSources="1" audioChannels="${channels}" audioRate="${sampleRate}">`,
        `            <media-rep kind="original-media" src="${srcUrl}" />`,
        `        </asset>`,
      ].join('\n'));
    }
  }

  // Shorthands for top-level helpers with pre-bound context
  const apo = (startTime: number) => audioParentOffset(
    startTime, spec.clips, clipOverlapStarts, clipSeqStarts, assetStartFrames, sourceShifts, fps,
  );
  const avx = (vol: number, fadeIn: number, fadeOut: number, indent: string) =>
    audioVolumeXml(vol, fadeIn, fadeOut, indent, fps);

  const audioLaneEndTimes: number[] = [];
  function assignAudioLane(startTime: number, endTime: number, laneCount: number = 1): number {
    const EPS = 1e-6;
    for (let i = 0; ; i++) {
      let available = true;
      for (let j = 0; j < laneCount; j++) {
        if ((audioLaneEndTimes[i + j] ?? -Infinity) > startTime + EPS) {
          available = false;
          break;
        }
      }
      if (available) {
        for (let j = 0; j < laneCount; j++) {
          audioLaneEndTimes[i + j] = endTime;
        }
        return -(i + 1);
      }
    }
  }

  for (const group of audioGroups) {
    const groupSeqStart = o2s(group[0].startTimeSeconds);
    const groupSeqEnd = o2s(group[group.length - 1].endTimeSeconds);
    const laneCount = target === 'fcp' || group.length === 1 ? 1 : 2;
    const audioLane = assignAudioLane(groupSeqStart, groupSeqEnd, laneCount);
    const filename = basename(group[0].sourceFile);
    const audioAssetId = audioAssetMap.get(filename)!;
    const { parentClipIdx, offset: spineOffset } = apo(group[0].startTimeSeconds);
    if (!clipAudioAnchors.has(parentClipIdx)) clipAudioAnchors.set(parentClipIdx, []);

    if (group.length === 1) {
      // Single audio track: simple anchor item.
      // Cap duration at available source audio so the FCPXML clip doesn't
      // exceed the file length when sequential duration > overlap duration.
      const audio = group[0];
      const audioSeqStart = o2s(audio.startTimeSeconds);
      const audioSeqEnd = o2s(audio.endTimeSeconds);
      let seqDuration = audioSeqEnd - audioSeqStart;
      const meta = audioMeta?.get(filename);
      if (meta?.durationSeconds) {
        seqDuration = Math.min(seqDuration, meta.durationSeconds - audio.audioStartSeconds);
      }
      const clipDuration = toRational(seqDuration, fps);
      const clipStart = toRational(audio.audioStartSeconds, fps);
      const volXml = avx(audio.volume, audio.fadeInSeconds, audio.fadeOutSeconds, II);

      if (volXml) {
        clipAudioAnchors.get(parentClipIdx)!.push([
          `${II}<asset-clip ref="${audioAssetId}" lane="${audioLane}" name="${escapeXml(filename)}" offset="${spineOffset}" duration="${clipDuration}" start="${clipStart}">`,
          `${volXml}`, `${II}</asset-clip>`,
        ].join('\n'));
      } else {
        clipAudioAnchors.get(parentClipIdx)!.push(
          `${II}<asset-clip ref="${audioAssetId}" lane="${audioLane}" name="${escapeXml(filename)}" offset="${spineOffset}" duration="${clipDuration}" start="${clipStart}" />`
        );
      }
    } else if (target === 'fcp') {
      // FCP: secondary storyline (spine) with audio crossfade transitions.
      // FCPXML transitions borrow source media ("handles") from beyond each clip's
      // visible range. We shrink each clip to leave handles, then extend the last
      // clip to ensure the spine fully covers the target sequential duration.
      // Audio track times are in the overlap model (transitions shorten the timeline),
      // but the FCPXML spine uses sequential placement. Convert to sequential duration.
      const targetDuration = o2s(group[group.length - 1].endTimeSeconds)
        - o2s(group[0].startTimeSeconds);

      // First pass: compute clip starts and durations with handle shrinkage
      const spineClips: { audioStart: number; duration: number; fadeIn: number; fadeOut: number }[] = [];
      let totalTransitionDur = 0;

      for (let gi = 0; gi < group.length; gi++) {
        const audio = group[gi];
        const isFirst = gi === 0;
        const isLast = gi === group.length - 1;
        const trackDuration = audio.endTimeSeconds - audio.startTimeSeconds;

        const crossfadeIn = isFirst ? 0 : (group[gi - 1].endTimeSeconds - audio.startTimeSeconds);
        const crossfadeOut = isLast ? 0 : (audio.endTimeSeconds - group[gi + 1].startTimeSeconds);
        const handleIn = crossfadeIn / 2;
        const handleOut = crossfadeOut / 2;
        if (!isFirst) totalTransitionDur += crossfadeIn;

        spineClips.push({
          audioStart: audio.audioStartSeconds + handleIn,
          duration: trackDuration - handleIn - handleOut,
          fadeIn: isFirst ? audio.fadeInSeconds : 0,
          fadeOut: isLast ? audio.fadeOutSeconds : 0,
        });
      }

      // Extend the last clip to fill any shortfall from handle shrinkage.
      // FCPXML spine duration = sum of clip durations (transitions overlap but don't shorten it).
      const currentSpineDur = spineClips.reduce((s, c) => s + c.duration, 0);
      const shortfall = targetDuration - currentSpineDur;
      if (shortfall > 0) {
        const last = spineClips[spineClips.length - 1];
        const meta = audioMeta?.get(filename);
        const fileDuration = meta?.durationSeconds ?? 600;
        const maxExtend = fileDuration - last.audioStart - last.duration;
        last.duration += Math.min(shortfall, maxExtend);
      }

      // Second pass: emit spine XML
      const spineLines: string[] = [];
      const SI = `${II}    `;
      let seqOffset = 0;

      for (let gi = 0; gi < group.length; gi++) {
        const sc = spineClips[gi];

        // Add transition before this clip (except first)
        if (gi > 0 && crossDissolveId && audioCrossfadeId) {
          const crossfadeIn = group[gi - 1].endTimeSeconds - group[gi].startTimeSeconds;
          const crossfadeFrames = Math.round(crossfadeIn * fps);
          const boundaryFrames = Math.round(seqOffset * fps);
          const transOffsetFrames = boundaryFrames - Math.round(crossfadeFrames / 2);
          spineLines.push([
            `${SI}<transition name="Cross Dissolve" offset="${transOffsetFrames}/${fps}s" duration="${crossfadeFrames}/${fps}s">`,
            `${SI}    <filter-video ref="${crossDissolveId}" name="Cross Dissolve" />`,
            `${SI}    <filter-audio ref="${audioCrossfadeId}" name="Audio Cross Fade" />`,
            `${SI}</transition>`,
          ].join('\n'));
        }

        const volXml = avx(group[gi].volume, sc.fadeIn, sc.fadeOut, SI);
        const clipOffsetRational = toRational(seqOffset, fps);
        const clipDurationRational = toRational(sc.duration, fps);
        const clipStartRational = toRational(sc.audioStart, fps);

        if (volXml) {
          spineLines.push([
            `${SI}<asset-clip ref="${audioAssetId}" name="${escapeXml(filename)}" offset="${clipOffsetRational}" duration="${clipDurationRational}" start="${clipStartRational}">`,
            `${volXml}`, `${SI}</asset-clip>`,
          ].join('\n'));
        } else {
          spineLines.push(
            `${SI}<asset-clip ref="${audioAssetId}" name="${escapeXml(filename)}" offset="${clipOffsetRational}" duration="${clipDurationRational}" start="${clipStartRational}" />`
          );
        }

        seqOffset += sc.duration;
      }

      clipAudioAnchors.get(parentClipIdx)!.push([
        `${II}<spine lane="${audioLane}" offset="${spineOffset}">`,
        ...spineLines,
        `${II}</spine>`,
      ].join('\n'));
    } else {
      // DaVinci: separate lanes per loop segment with fadeIn/fadeOut (no spine transitions).
      // Alternate between two lanes (-N, -N-1) so overlapping segments don't conflict.
      for (let gi = 0; gi < group.length; gi++) {
        const audio = group[gi];
        const lane = gi % 2 === 0 ? audioLane : audioLane - 1;
        const { parentClipIdx: clipIdx, offset: clipOffset } = apo(audio.startTimeSeconds);
        if (!clipAudioAnchors.has(clipIdx)) clipAudioAnchors.set(clipIdx, []);
        const audioSeqStart = o2s(audio.startTimeSeconds);
        const audioSeqEnd = o2s(audio.endTimeSeconds);
        const clipDuration = toRational(audioSeqEnd - audioSeqStart, fps);
        const clipStart = toRational(audio.audioStartSeconds, fps);
        const volXml = avx(audio.volume, audio.fadeInSeconds, audio.fadeOutSeconds, II);

        if (volXml) {
          clipAudioAnchors.get(clipIdx)!.push([
            `${II}<asset-clip ref="${audioAssetId}" lane="${lane}" name="${escapeXml(filename)}" offset="${clipOffset}" duration="${clipDuration}" start="${clipStart}">`,
            `${volXml}`, `${II}</asset-clip>`,
          ].join('\n'));
        } else {
          clipAudioAnchors.get(clipIdx)!.push(
            `${II}<asset-clip ref="${audioAssetId}" lane="${lane}" name="${escapeXml(filename)}" offset="${clipOffset}" duration="${clipDuration}" start="${clipStart}" />`
          );
        }
      }
    }
  }
  let audioLaneCounter = -(audioLaneEndTimes.length + 1);

  // --- Build voiceover assets and assign anchor items to their parent clips ---
  const voiceoverAssetMap = new Map<string, string>();
  for (const vo of spec.voiceoverTracks ?? []) {
    if (!vo.sourceFile) continue;
    const filename = basename(vo.sourceFile);
    if (!voiceoverAssetMap.has(filename)) {
      const id = `vo-asset-${voiceoverAssetMap.size + 1}`;
      voiceoverAssetMap.set(filename, id);
      const meta = voiceoverMeta?.get(filename);
      const sampleRate = meta?.sampleRate ?? 48000;
      const channels = meta?.channels ?? 1;
      const durationSeconds = meta?.durationSeconds ?? 600;
      const durationTicks = Math.round(durationSeconds * sampleRate);
      const srcUrl = `file://${escapeXml(vo.sourceFile || filename)}`;
      assetLines.push([
        `        <asset id="${id}" start="0/1s" duration="${durationTicks}/${sampleRate}s" hasAudio="1" audioSources="1" audioChannels="${channels}" audioRate="${sampleRate}">`,
        `            <media-rep kind="original-media" src="${srcUrl}" />`,
        `        </asset>`,
      ].join('\n'));
    }
  }

  for (const vo of spec.voiceoverTracks ?? []) {
    if (!vo.sourceFile) continue;
    const voLane = audioLaneCounter--;
    const filename = basename(vo.sourceFile);
    const voAssetId = voiceoverAssetMap.get(filename)!;
    const { parentClipIdx, offset: spineOffset } = apo(vo.startTimeSeconds);
    if (!clipAudioAnchors.has(parentClipIdx)) clipAudioAnchors.set(parentClipIdx, []);

    // Use audio duration directly — o2s(end)-o2s(start) would stretch the clip
    // when the voiceover spans a video transition boundary.
    const clipDuration = toRational(vo.endTimeSeconds - vo.startTimeSeconds, fps);
    const clipStart = toRational(vo.audioStartSeconds, fps);
    const volXml = avx(vo.volume, 0, 0, II);

    if (volXml) {
      clipAudioAnchors.get(parentClipIdx)!.push([
        `${II}<asset-clip ref="${voAssetId}" lane="${voLane}" name="${escapeXml(filename)}" offset="${spineOffset}" duration="${clipDuration}" start="${clipStart}">`,
        `${volXml}`, `${II}</asset-clip>`,
      ].join('\n'));
    } else {
      clipAudioAnchors.get(parentClipIdx)!.push(
        `${II}<asset-clip ref="${voAssetId}" lane="${voLane}" name="${escapeXml(filename)}" offset="${spineOffset}" duration="${clipDuration}" start="${clipStart}" />`
      );
    }
  }

  // --- Generate spine elements ---
  for (let i = 0; i < spec.clips.length; i++) {
    const clip = spec.clips[i];
    const clipDuration = clipDurations[i];
    const assetId = getAssetId(clip, spec.clips);

    // Emit centered transition if both sides have sufficient handles after shifts
    if (i > 0 && transFrames[i] > 0) {
      const halfTransSec = (transFrames[i] / fps) / 2;
      const prevClip = spec.clips[i - 1];
      const prevMeta = videoMeta?.get(basename(prevClip.sourceFile));
      const prevPostHandle = prevMeta?.durationSeconds
        ? prevMeta.durationSeconds - (prevClip.endTimeSeconds + sourceShifts[i - 1])
        : Infinity;
      const curPreHandle = clip.startTimeSeconds + sourceShifts[i];

      if (curPreHandle >= halfTransSec && prevPostHandle >= halfTransSec) {
        const boundaryFrames = Math.round(seqOffset * fps);
        const halfFrames = transFrames[i] / 2;
        const transOffsetFrames = boundaryFrames - halfFrames;
        const transType = clip.transition!.type; // DaVinci: Slide/Wipe fall back to dissolve
        const transDir = clip.transition!.direction;

        // Resolve effect ref and name based on transition type
        let videoEffectRef: string | null = null;
        let videoEffectName = '';
        let directionParam = '';
        if (transType === 'fade' && crossDissolveId) {
          videoEffectRef = crossDissolveId;
          videoEffectName = 'Cross Dissolve';
        } else if (transType === 'slide' && slideId) {
          videoEffectRef = slideId;
          videoEffectName = 'Slide';
          directionParam = `${I}        <param name="Direction" key="4" value="${fcpDirectionValue(transDir)}" />`;
        } else if (transType === 'wipe' && wipeId) {
          videoEffectRef = wipeId;
          videoEffectName = 'Wipe';
          directionParam = `${I}        <param name="Direction" key="13" value="${fcpDirectionValue(transDir)}" />`;
        }

        if (videoEffectRef && audioCrossfadeId) {
          const filterVideoLines: string[] = [];
          if (directionParam) {
            filterVideoLines.push(`${I}    <filter-video ref="${videoEffectRef}" name="${videoEffectName}">`);
            filterVideoLines.push(directionParam);
            filterVideoLines.push(`${I}    </filter-video>`);
          } else {
            filterVideoLines.push(`${I}    <filter-video ref="${videoEffectRef}" name="${videoEffectName}" />`);
          }
          spine.push([
            `${I}<transition offset="${transOffsetFrames}/${fps}s" duration="${transFrames[i]}/${fps}s">`,
            ...filterVideoLines,
            `${I}    <filter-audio ref="${audioCrossfadeId}" name="Audio Cross Fade" />`,
            `${I}</transition>`,
          ].join('\n'));
        } else {
          spine.push(`${I}<transition offset="${transOffsetFrames}/${fps}s" duration="${transFrames[i]}/${fps}s" />`);
        }
      }
    }

    // Compute source start time: timecode offset + clip in-point (with shift)
    const clipFilename = basename(clip.sourceFile);
    const tcInfo = assetStartFrames.get(clipFilename);
    const effectiveStartSeconds = clip.startTimeSeconds + sourceShifts[i];
    let clipStart: string;
    if (tcInfo && tcInfo.frames > 0) {
      const clipOffsetFrames = Math.round(effectiveStartSeconds * tcInfo.fpsNum / tcInfo.fpsDen);
      clipStart = framesToRational(tcInfo.frames + clipOffsetFrames, tcInfo.fpsNum, tcInfo.fpsDen);
    } else {
      clipStart = toRational(effectiveStartSeconds, fps);
    }

    const clipFormatId = assetFormatMap.get(clipFilename);
    const formatAttr = clipFormatId && clipFormatId !== 'r1' ? ` format="${clipFormatId}"` : '';

    // Check for overlay titles and audio anchor items attached to this clip
    const overlays = clipOverlays.get(i) || [];
    const audioAnchors = clipAudioAnchors.get(i) || [];
    const hasCrop = !!(clip.crop || clip.cropEnd);
    const hasRotation = !!(clip.rotation && clip.rotation % 360 !== 0);
    const clipVolumeXml = audioVolumeXml(clip.volume, 0, 0, I, fps);
    const hasClipVolume = !!clipVolumeXml;
    // <adjust-conform> default is "fit" (contain). Emit only when overriding to cover.
    // DaVinci ignores this element; users must set project Image Scaling manually there.
    const conformXml = clip.fit === 'cover' ? `${II}<adjust-conform type="fill" />` : null;
    const hasChildren = overlays.length > 0 || audioAnchors.length > 0 || hasCrop || hasRotation || hasClipVolume || !!conformXml;
    if (!hasChildren) {
      spine.push(
        `${I}<asset-clip ref="${assetId}" name="${escapeXml(clipFilename)}" offset="${toRational(seqOffset, fps)}" duration="${toRational(clipDuration, fps)}" start="${clipStart}"${formatAttr} tcFormat="NDF" />`
      );
    } else {
      spine.push(
        `${I}<asset-clip ref="${assetId}" name="${escapeXml(clipFilename)}" offset="${toRational(seqOffset, fps)}" duration="${toRational(clipDuration, fps)}" start="${clipStart}"${formatAttr} tcFormat="NDF">`
      );

      // Crop/transform: intrinsic params must appear before anchor items (titles, audio) per DTD
      // DTD ordering: adjust-crop → adjust-conform → adjust-transform
      if (hasRotation) {
        // Rotation forces an adjust-transform for the rotation itself.
        // Semantics: rotation fixes source orientation before fit/conform; crop values refer
        // to the rotated frame. FCP imports adjust-conform before adjust-transform, so rotated
        // clips need a compensating scale to match Montai's rotate-before-fit semantics.
        // For static crop + 90° multiples on FCP, use native adjust-crop with edge values
        // remapped back to the pre-rotation source axes so crop clips inside the conformed
        // content box instead of the full sequence frame.
        //
        // LIMITATION: rotation + cropEnd (Ken Burns) is not supported in FCPXML export.
        // FCP's pan-mode adjust-crop (needed for Ken Burns) and adjust-transform (needed
        // for rotation) can't be combined sensibly — the pan rect operates on the source,
        // the rotation on the composited frame, and interleaving them would require either
        // animated adjust-transform keyframes (more XML than the feature warrants) or
        // dropping rotation. For now we keep rotation and degrade cropEnd to static,
        // using cropEnd as the composition target (typically the intended final framing).
        // Remotion render/preview does animate the Ken Burns with rotation, so the two
        // outputs will differ on this specific combination.
        // FCP rotation is counter-clockwise for positive degrees; CSS/Remotion is clockwise.
        // Negate so FCPXML output matches the Remotion render visually.
        const rotDeg = -clip.rotation!;
        const fitScale = rotationFitScale(clip, width, height);
        const effectiveCrop = clip.cropEnd ?? clip.crop;
        const fcpCrop = effectiveCrop && target === 'fcp'
          ? cropForFcpPreRotation(effectiveCrop, clip.rotation!)
          : null;
        if (fcpCrop) {
          spine.push(`${II}<adjust-crop mode="crop">`);
          spine.push(`${II}    <crop-rect left="${fcpCrop.left}" top="${fcpCrop.top}" right="${fcpCrop.right}" bottom="${fcpCrop.bottom}" />`);
          spine.push(`${II}</adjust-crop>`);
          if (conformXml) spine.push(conformXml);
          if (isEffectivelyOne(fitScale)) {
            spine.push(`${II}<adjust-transform rotation="${round4(rotDeg)}" />`);
          } else {
            spine.push(`${II}<adjust-transform scale="${round4(fitScale)} ${round4(fitScale)}" rotation="${round4(rotDeg)}" />`);
          }
        } else if (effectiveCrop) {
          if (conformXml) spine.push(conformXml);
          const t = cropToFcpTransform(effectiveCrop, width, height);
          const s = t.scale * fitScale;
          spine.push(`${II}<adjust-transform position="${round4(t.posX)} ${round4(t.posY)}" scale="${round4(s)} ${round4(s)}" rotation="${round4(rotDeg)}" />`);
        } else if (isEffectivelyOne(fitScale)) {
          if (conformXml) spine.push(conformXml);
          spine.push(`${II}<adjust-transform rotation="${round4(rotDeg)}" />`);
        } else {
          if (conformXml) spine.push(conformXml);
          spine.push(`${II}<adjust-transform scale="${round4(fitScale)} ${round4(fitScale)}" rotation="${round4(rotDeg)}" />`);
        }
      } else if (hasCrop) {
        if (clip.cropEnd) {
          if (target === 'davinci') {
            // DaVinci ignores adjust-crop mode="pan". Fall back to static adjust-transform
            // using the end state (cropEnd) as that's typically the intended composition.
            const t = cropToFcpTransform(clip.cropEnd, width, height);
            if (conformXml) spine.push(conformXml);
            spine.push(`${II}<adjust-transform position="${round4(t.posX)} ${round4(t.posY)}" scale="${round4(t.scale)} ${round4(t.scale)}" />`);
          } else {
            // FCP: Ken Burns via pan mode with two pan-rect elements (start → end)
            const cropStart = clip.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
            spine.push(`${II}<adjust-crop mode="pan">`);
            spine.push(`${II}    <pan-rect left="${cropStart.left}" top="${cropStart.top}" right="${cropStart.right}" bottom="${cropStart.bottom}" />`);
            spine.push(`${II}    <pan-rect left="${clip.cropEnd.left}" top="${clip.cropEnd.top}" right="${clip.cropEnd.right}" bottom="${clip.cropEnd.bottom}" />`);
            spine.push(`${II}</adjust-crop>`);
            if (conformXml) spine.push(conformXml);
          }
        } else if (clip.crop) {
          if (target === 'davinci') {
            // DaVinci: adjust-crop mode="crop" shows black bars instead of filling.
            // Use adjust-transform (scale + position) to achieve the same visual result.
            const t = cropToFcpTransform(clip.crop, width, height);
            if (conformXml) spine.push(conformXml);
            spine.push(`${II}<adjust-transform position="${round4(t.posX)} ${round4(t.posY)}" scale="${round4(t.scale)} ${round4(t.scale)}" />`);
          } else {
            // FCP: native crop support
            spine.push(`${II}<adjust-crop mode="crop">`);
            spine.push(`${II}    <crop-rect left="${clip.crop.left}" top="${clip.crop.top}" right="${clip.crop.right}" bottom="${clip.crop.bottom}" />`);
            spine.push(`${II}</adjust-crop>`);
            if (conformXml) spine.push(conformXml);
          }
        }
      } else if (conformXml) {
        spine.push(conformXml);
      }

      if (clipVolumeXml) {
        spine.push(clipVolumeXml);
      }

      for (let oi = 0; oi < overlays.length; oi++) {
        const overlay = overlays[oi];
        const overlaySeqStart = o2s(overlay.startTimeSeconds);
        const overlaySeqEnd = o2sEnd(overlay.endTimeSeconds);
        const deltaInClip = overlaySeqStart - clipSeqStarts[i];

        // Title offset must be in the parent clip's source timebase. When the
        // source fps differs from the sequence fps (e.g. 59.94 vs 50), this offset
        // can't align with both frame grids — FCP warns "not on edit frame boundary"
        // but the title displays correctly.
        let titleOffset: string;
        if (tcInfo && tcInfo.frames > 0) {
          const clipInFrames = Math.round(effectiveStartSeconds * tcInfo.fpsNum / tcInfo.fpsDen);
          const deltaFrames = Math.round(deltaInClip * tcInfo.fpsNum / tcInfo.fpsDen);
          titleOffset = framesToRational(tcInfo.frames + clipInFrames + deltaFrames, tcInfo.fpsNum, tcInfo.fpsDen);
        } else {
          titleOffset = toRational(effectiveStartSeconds + deltaInClip, fps);
        }

        const overlayDurationSeconds = overlaySeqEnd - overlaySeqStart;
        const titleDuration = toRational(overlayDurationSeconds, fps);
        // KNOWN ISSUE (pop/slide/static long corner text in narrow frames): the
        // narrow-frame floor+scale path renders text oversized then shrinks it,
        // so long left/right-aligned text overflows the frame and is clipped
        // before the down-scale. Affects all templates. Tracked in
        // drafts/fcp-overlay-narrow-frame-clipping.md.
        const effectRef = titleEffectRef(overlay, { essentialId: titleEffectId, fadeId: titleFadeId, scaleId: titleScaleId });
        spine.push(makeTitleXml(overlay.text, nextTs(), titleOffset, titleDuration, II, effectRef, overlay.position, overlay.style, titleLayout, oi + 1, overlay.animation, overlayDurationSeconds, fps));
      }

      // Audio anchor items attached to this clip
      spine.push(...audioAnchors);

      spine.push(`${I}</asset-clip>`);
    }

    seqOffset += clipDuration;
  }
  const totalDuration = toRational(seqOffset, fps);

  const sequenceColorSpaceAttr = detectedHdr ? '' : ' colorSpace="1-1-1 (Rec. 709)"';
  const effectLines: string[] = [];
  effectLines.push(...titleEffectLines({ essentialId: titleEffectId, fadeId: titleFadeId, scaleId: titleScaleId }));
  if (crossDissolveId) effectLines.push(`        <effect id="${crossDissolveId}" name="Cross Dissolve" uid="${CROSS_DISSOLVE_UID}" />`);
  if (slideId) effectLines.push(`        <effect id="${slideId}" name="Slide" uid="${SLIDE_UID}" />`);
  if (wipeId) effectLines.push(`        <effect id="${wipeId}" name="Wipe" uid="${WIPE_UID}" />`);
  if (audioCrossfadeId) effectLines.push(`        <effect id="${audioCrossfadeId}" name="Audio Cross Fade" uid="${AUDIO_CROSSFADE_UID}" />`);

  const allFormatLines = [
    `        <format id="r1" name="FFVideoFormat${height}p${Math.round(fps)}" frameDuration="1/${fps}s" width="${width}" height="${height}"${sequenceColorSpaceAttr} />`,
    ...formatLines,
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.11">
    <resources>
${allFormatLines.join('\n')}${effectLines.length > 0 ? '\n' + effectLines.join('\n') : ''}
${assetLines.join('\n')}
    </resources>
    <library>
        <event name="${fcpName(options?.eventName ?? 'Montai Export')}">
            <project name="${fcpName(options?.projectTitle ?? spec.name)}">
                <sequence format="r1" duration="${totalDuration}" tcStart="0/1s" tcFormat="NDF">
                    <spine>
${spine.join('\n')}
                    </spine>
                </sequence>
            </project>
        </event>
    </library>
</fcpxml>
`;
}


function audioParentOffset(
  startTimeSeconds: number,
  clips: { sourceFile: string; startTimeSeconds: number }[],
  clipOverlapStarts: number[],
  clipSeqStarts: number[],
  assetStartFrames: Map<string, { frames: number; fpsNum: number; fpsDen: number }>,
  sourceShifts: number[],
  fps: number,
): { parentClipIdx: number; offset: string } {
  const audioSeqStart = overlapToSeq(startTimeSeconds, clipOverlapStarts, clipSeqStarts);
  let parentClipIdx = 0;
  for (let ci = clips.length - 1; ci >= 0; ci--) {
    if (audioSeqStart >= clipSeqStarts[ci]) { parentClipIdx = ci; break; }
  }
  const parentClip = clips[parentClipIdx];
  const parentClipFilename = basename(parentClip.sourceFile);
  const parentTcInfo = assetStartFrames.get(parentClipFilename);
  const parentEffectiveStart = parentClip.startTimeSeconds + sourceShifts[parentClipIdx];
  const deltaInClip = audioSeqStart - clipSeqStarts[parentClipIdx];
  let offset: string;
  if (parentTcInfo && parentTcInfo.frames > 0) {
    const clipInFrames = Math.round(parentEffectiveStart * parentTcInfo.fpsNum / parentTcInfo.fpsDen);
    const deltaFrames = Math.round(deltaInClip * parentTcInfo.fpsNum / parentTcInfo.fpsDen);
    offset = framesToRational(parentTcInfo.frames + clipInFrames + deltaFrames, parentTcInfo.fpsNum, parentTcInfo.fpsDen);
  } else {
    offset = toRational(parentEffectiveStart + deltaInClip, fps);
  }
  return { parentClipIdx, offset };
}

function parseTimecodeToFrames(tc: string, fpsNum: number, fpsDen: number): number {
  const isDF = tc.includes(';');
  const parts = tc.split(/[:;]/);
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const s = parseInt(parts[2], 10);
  const f = parseInt(parts[3], 10);
  const nomFps = Math.round(fpsNum / fpsDen);
  const tcMultiplier = nomFps > 30 ? Math.ceil(nomFps / 30) : 1;
  const tcNomFps = Math.round(nomFps / tcMultiplier);
  let tcFrames: number;
  if (isDF) {
    const D = tcNomFps === 30 ? 2 : 0;
    const totalMinutes = h * 60 + m;
    const dropMinutes = totalMinutes - Math.floor(totalMinutes / 10);
    tcFrames = h * 3600 * tcNomFps + m * 60 * tcNomFps + s * tcNomFps + f - D * dropMinutes;
  } else {
    tcFrames = h * 3600 * tcNomFps + m * 60 * tcNomFps + s * tcNomFps + f;
  }
  return tcFrames * tcMultiplier;
}

function audioVolumeXml(vol: number, fadeInSec: number, fadeOutSec: number, indent: string, fps: number): string {
  if (vol === 1 && fadeInSec === 0 && fadeOutSec === 0) return '';
  const dB = vol === 1 ? '0' : String(Math.round(20 * Math.log10(vol)));
  if (fadeInSec > 0 || fadeOutSec > 0) {
    const fadeElements: string[] = [];
    if (fadeInSec > 0) fadeElements.push(`${indent}            <fadeIn type="linear" duration="${toRational(fadeInSec, fps)}"/>`);
    if (fadeOutSec > 0) fadeElements.push(`${indent}            <fadeOut type="linear" duration="${toRational(fadeOutSec, fps)}"/>`);
    return [
      ``, `${indent}    <adjust-volume amount="${dB}dB">`,
      `${indent}        <param name="amount" value="${dB}dB">`,
      ...fadeElements,
      `${indent}        </param>`, `${indent}    </adjust-volume>`,
    ].join('\n');
  }
  return `\n${indent}    <adjust-volume amount="${dB}dB"/>`;
}

function getAssetId(clip: ExpandedClip, clips: ExpandedClip[]): string {
  const filename = basename(clip.sourceFile);
  const seen = new Set<string>();
  let index = 0;
  for (const c of clips) {
    const fn = basename(c.sourceFile);
    if (!seen.has(fn)) { index++; seen.add(fn); }
    if (fn === filename) return `asset-${index}`;
  }
  return 'asset-1';
}

/**
 * Convert a time position from the overlap model to the sequential model.
 * Finds which clip the time falls in, then maps it to the corresponding
 * sequential position: seqStart[i] + (t - overlapStart[i]).
 * The offset within a clip is the same in both models; only the cumulative
 * start positions differ (sequential doesn't subtract transition durations).
 *
 * When `exclusive` is true, uses strict `>` instead of `>=` for boundary
 * matching. This keeps a time that falls exactly on a clip's overlap start
 * in the preceding clip — use this for end-time positions (e.g. overlay end)
 * so they don't jump to the next clip at transition boundaries.
 */
function overlapToSeq(t: number, clipOverlapStarts: number[], clipSeqStarts: number[], exclusive = false): number {
  for (let i = clipOverlapStarts.length - 1; i >= 0; i--) {
    if (exclusive ? t > clipOverlapStarts[i] : t >= clipOverlapStarts[i]) {
      return clipSeqStarts[i] + (t - clipOverlapStarts[i]);
    }
  }
  return t;
}

function fcpDirectionValue(direction?: string): string {
  switch (direction) {
    case 'from-right': return '0';
    case 'from-bottom': return '1';
    case 'from-left': return '2';
    case 'from-top': return '3';
    default: return '0';
  }
}

function isEffectivelyOne(n: number): boolean {
  return Math.abs(n - 1) < 1e-6;
}

function conformedSize(
  sourceWidth: number,
  sourceHeight: number,
  seqWidth: number,
  seqHeight: number,
  fit: 'contain' | 'cover',
): { width: number; height: number } {
  const scale = fit === 'cover'
    ? Math.max(seqWidth / sourceWidth, seqHeight / sourceHeight)
    : Math.min(seqWidth / sourceWidth, seqHeight / sourceHeight);
  return { width: sourceWidth * scale, height: sourceHeight * scale };
}

function rotatedDimensions(width: number, height: number, degrees: number): { width: number; height: number } {
  const theta = (degrees * Math.PI) / 180;
  const absCos = Math.abs(Math.cos(theta));
  const absSin = Math.abs(Math.sin(theta));
  return {
    width: width * absCos + height * absSin,
    height: width * absSin + height * absCos,
  };
}

function rotationFitScale(clip: ExpandedClip, seqWidth: number, seqHeight: number): number {
  const sourceWidth = clip.sourceWidth ?? seqWidth;
  const sourceHeight = clip.sourceHeight ?? seqHeight;
  const fit = clip.fit === 'cover' ? 'cover' : 'contain';
  const base = conformedSize(sourceWidth, sourceHeight, seqWidth, seqHeight, fit);
  const baseAfterRotation = rotatedDimensions(base.width, base.height, clip.rotation ?? 0);
  const rotatedSource = rotatedDimensions(sourceWidth, sourceHeight, clip.rotation ?? 0);
  const desired = conformedSize(rotatedSource.width, rotatedSource.height, seqWidth, seqHeight, fit);
  const scale = desired.width / baseAfterRotation.width;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function cropForFcpPreRotation(
  crop: { left: number; top: number; right: number; bottom: number },
  rotation: number,
): { left: number; top: number; right: number; bottom: number } | null {
  const normalized = ((rotation % 360) + 360) % 360;
  const rightAngle = [0, 90, 180, 270].find((angle) => Math.abs(normalized - angle) < 1e-6);
  if (rightAngle === undefined) return null;
  switch (rightAngle) {
    case 0:
      return crop;
    case 90:
      return { left: crop.top, top: crop.right, right: crop.bottom, bottom: crop.left };
    case 180:
      return { left: crop.right, top: crop.bottom, right: crop.left, bottom: crop.top };
    case 270:
      return { left: crop.bottom, top: crop.left, right: crop.top, bottom: crop.right };
    default:
      return null;
  }
}

/**
 * Convert crop values (% of post-rotation source content per edge) to equivalent adjust-transform
 * params for the DaVinci fallback and FCP's arbitrary-angle rotation fallback. Assumes
 * the post-conform content fills the sequence frame — accurate for matched aspect or
 * cover with source aspect ≈ sequence aspect, an approximation otherwise.
 */
function cropToFcpTransform(
  crop: { left: number; top: number; right: number; bottom: number },
  seqWidth: number,
  seqHeight: number,
): { scale: number; posX: number; posY: number } {
  const visibleWidthFrac = 1 - (crop.left + crop.right) / 100;
  const visibleHeightFrac = 1 - (crop.top + crop.bottom) / 100;
  const s = Math.max(1 / Math.max(visibleWidthFrac, 0.01), 1 / Math.max(visibleHeightFrac, 0.01));
  // Center the visible region. FCP coordinates: Y-up, origin at canvas center.
  const posX = -s * (crop.left - crop.right) / 200 * seqWidth;
  const posY = -s * (crop.bottom - crop.top) / 200 * seqHeight;
  return { scale: s, posX, posY };
}
