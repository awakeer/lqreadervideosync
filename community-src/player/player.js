import {
  TRAINING_PRESETS,
  TRAINING_VARIANTS,
  buildMediaFingerprint,
  buildPlaybackBookmarkKey,
  buildTrainingPasses,
  canRestorePlaybackBookmark,
  completeTrainingPass,
  createDefaultTrainingSettings,
  listTrainingEpisodeTokens,
  normalizeEpisodeTrainingRecord,
  normalizeEpisodeTrainingRecords,
  normalizeTrainingSettings,
  resolveCurrentTrainingPass,
  resolvePlanCounts,
  sanitizeTrainingCounts,
  undoLastTrainingCompletion
} from "./training-state.js";

// src/shared/logger.ts
var localLogBufferLimit = 400;
var localLogBuffer = [];
var logSink = null;
var logSequence = 0;
function sanitizeMetadata(value, depth = 0) {
  if (value === null || value === void 0) {
    return value;
  }
  if (depth >= 4) {
    return "[MaxDepth]";
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((item) => sanitizeMetadata(item, depth + 1));
  }
  if (typeof value === "object") {
    const output = {};
    for (const [key, nestedValue] of Object.entries(value).slice(0, 80)) {
      output[key] = sanitizeMetadata(nestedValue, depth + 1);
    }
    return output;
  }
  return String(value);
}
function resolveLocation() {
  try {
    return globalThis.location?.href;
  } catch {
    return void 0;
  }
}
function resolveUserAgent() {
  try {
    return globalThis.navigator?.userAgent;
  } catch {
    return void 0;
  }
}
function setReaderSyncLogSink(sink, options) {
  logSink = sink;
  if (sink && options?.flushExisting !== false) {
    for (const entry of localLogBuffer) {
      sink(entry);
    }
  }
}
function log(level, scope, message, metadata) {
  const prefix = `[reader-sync:${scope}]`;
  if (metadata === void 0) {
    console[level](`${prefix} ${message}`);
  } else {
    console[level](`${prefix} ${message}`, metadata);
  }
  const entry = {
    id: `${Date.now()}-${++logSequence}`,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    scope,
    message,
    location: resolveLocation(),
    userAgent: resolveUserAgent()
  };
  if (metadata !== void 0) {
    entry.metadata = sanitizeMetadata(metadata);
  }
  localLogBuffer.push(entry);
  if (localLogBuffer.length > localLogBufferLimit) {
    localLogBuffer.splice(0, localLogBuffer.length - localLogBufferLimit);
  }
  try {
    logSink?.(entry);
  } catch (error) {
    console.warn(`${prefix} log sink failed`, error);
  }
}
function createLogger(scope) {
  return {
    debug(message, metadata) {
      log("debug", scope, message, metadata);
    },
    info(message, metadata) {
      log("info", scope, message, metadata);
    },
    warn(message, metadata) {
      log("warn", scope, message, metadata);
    },
    error(message, metadata) {
      log("error", scope, message, metadata);
    }
  };
}

// src/shared/protocol.ts
var PLAYER_PORT_NAME = "reader-sync-player";
function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}
function normalizeEpisodeSlug(fileName) {
  const sanitized = fileName.toLowerCase().replace(/\.[a-z0-9]{2,4}$/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const seasonEpisodeMatch = sanitized.match(/^(.*?)(s\d{1,2}e\d{1,2})\b/);
  if (seasonEpisodeMatch) {
    const seriesName = seasonEpisodeMatch[1].replace(/[^a-z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
    const episodeToken = seasonEpisodeMatch[2];
    return `${seriesName}_${episodeToken}`;
  }
  return sanitized.replace(/[^a-z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}
function resolveActiveSyncEntry(manifest2, currentTimeMs) {
  if (!manifest2 || manifest2.sync.length === 0) {
    return null;
  }
  let low = 0;
  let high = manifest2.sync.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const entry = manifest2.sync[middle];
    if (currentTimeMs < entry.startMs) {
      high = middle - 1;
      continue;
    }
    if (currentTimeMs > entry.endMs) {
      low = middle + 1;
      continue;
    }
    return entry;
  }
  let nearestEntry = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const entry of manifest2.sync) {
    if (currentTimeMs >= entry.startMs && currentTimeMs <= entry.endMs) {
      return entry;
    }
    const distance = currentTimeMs < entry.startMs ? entry.startMs - currentTimeMs : currentTimeMs - entry.endMs;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestEntry = entry;
    }
  }
  return nearestDistance <= 1500 ? nearestEntry : null;
}

// src/shared/runtime-sync-builder.ts
var SPEAKER_PREFIX_PATTERN = /^[A-Za-z][A-Za-z' .-]{0,40}:\s*/;
var APOSTROPHE_PATTERN = /[\u2018\u2019\u02bc]/g;
var NON_ALPHANUMERIC_PATTERN = /[^a-z0-9\s]/g;
var MULTISPACE_PATTERN = /\s+/g;
function normalizeAlignmentText(value) {
  return value.toLowerCase().trim().replace(SPEAKER_PREFIX_PATTERN, "").replace(APOSTROPHE_PATTERN, "'").replace(/\bwon't\b/g, "will not").replace(/\bcan't\b/g, "can not").replace(/\bshan't\b/g, "shall not").replace(/n't\b/g, " not").replace(/\blet's\b/g, "let us").replace(/\b(it|he|she|that|there|what|who|where|how)'s\b/g, "$1 is").replace(/'re\b/g, " are").replace(/'ve\b/g, " have").replace(/'ll\b/g, " will").replace(/'m\b/g, " am").replace(/\bgonna\b/g, "going to").replace(/\bwanna\b/g, "want to").replace(/\bgotta\b/g, "got to").replace(/\bkinda\b/g, "kind of").replace(/\bsorta\b/g, "sort of").replace(/(?:^|\s)'?cause\b/g, " because").replace(NON_ALPHANUMERIC_PATTERN, " ").replace(MULTISPACE_PATTERN, " ").trim();
}
function tokenizeAlignmentText(value) {
  return normalizeAlignmentText(value).split(" ").filter((token) => token.length >= 2 || token === "i" || token === "a");
}
function lcsLength(left, right) {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const row = new Array(right.length + 1).fill(0);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = 0;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const previous = row[rightIndex];
      if (left[leftIndex - 1] === right[rightIndex - 1]) {
        row[rightIndex] = diagonal + 1;
      } else {
        row[rightIndex] = Math.max(row[rightIndex], row[rightIndex - 1]);
      }
      diagonal = previous;
    }
  }
  return row[right.length] ?? 0;
}
function calculateSimilarity(left, right) {
  if (!left || !right) {
    return 0;
  }
  const leftTokens = tokenizeAlignmentText(left);
  const rightTokens = tokenizeAlignmentText(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }
  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  const overlapCount = Array.from(leftSet).filter((token) => rightSet.has(token)).length;
  const tokenOverlap = overlapCount / Math.max(leftSet.size, rightSet.size);
  const lcsRatio = lcsLength(leftTokens, rightTokens) / Math.max(leftTokens.length, rightTokens.length);
  let score = Math.max(lcsRatio, lcsRatio * 0.75 + tokenOverlap * 0.25);
  const normalizedLeft = normalizeAlignmentText(left);
  const normalizedRight = normalizeAlignmentText(right);
  if (Math.min(normalizedLeft.length, normalizedRight.length) >= 15 && tokenOverlap >= 0.45 && (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft))) {
    score = Math.max(score, 0.9);
  }
  return score;
}
function joinTranscriptText(segments) {
  return segments.map((segment) => normalizeAlignmentText(segment.text)).filter(Boolean).join(" ").trim();
}
function joinArticleText(paragraphs) {
  return paragraphs.map((paragraph) => normalizeAlignmentText(paragraph.text)).filter(Boolean).join(" ").trim();
}
function splitTimeRange(startMs, endMs, weights) {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0 || endMs <= startMs) {
    return weights.map(() => [startMs, endMs]);
  }
  const result = [];
  let cursor = startMs;
  for (let index = 0; index < weights.length; index += 1) {
    if (index === weights.length - 1) {
      result.push([cursor, endMs]);
      break;
    }
    const sliceDuration = Math.max(1, Math.round((endMs - startMs) * (weights[index] / totalWeight)));
    const nextCursor = Math.min(endMs, cursor + sliceDuration);
    result.push([cursor, nextCursor]);
    cursor = nextCursor;
  }
  return result;
}
function isLowSignalText(value) {
  if (value.includes("\u{1F3BC}")) {
    return true;
  }
  const normalized = normalizeAlignmentText(value);
  if (!normalized) {
    return true;
  }
  const tokens = tokenizeAlignmentText(normalized);
  return tokens.length <= 2 && normalized.length <= 12;
}
function trimLowSignalSegments(segments) {
  let startIndex = 0;
  let endIndex = segments.length;
  while (startIndex < endIndex && isLowSignalText(segments[startIndex]?.text ?? "")) {
    startIndex += 1;
  }
  while (endIndex > startIndex && isLowSignalText(segments[endIndex - 1]?.text ?? "")) {
    endIndex -= 1;
  }
  return startIndex < endIndex ? segments.slice(startIndex, endIndex) : segments;
}
function buildCandidate(transcriptSegments, articleParagraphs, transcriptStart, transcriptWindow, paragraphStart, paragraphWindow, baseTranscriptIndex, baseParagraphIndex) {
  const transcriptSlice = transcriptSegments.slice(transcriptStart, transcriptStart + transcriptWindow);
  const articleSlice = articleParagraphs.slice(paragraphStart, paragraphStart + paragraphWindow);
  if (transcriptSlice.length === 0 || articleSlice.length === 0) {
    return null;
  }
  const trimmedTranscriptSlice = trimLowSignalSegments(transcriptSlice);
  const transcriptText = joinTranscriptText(trimmedTranscriptSlice);
  const articleText = joinArticleText(articleSlice);
  if (!transcriptText || !articleText) {
    return null;
  }
  const similarity = calculateSimilarity(articleText, transcriptText);
  const lengthBalance = Math.min(articleText.length, transcriptText.length) / Math.max(articleText.length, transcriptText.length);
  const continuityPenalty = (transcriptStart - baseTranscriptIndex) * 0.09 + (paragraphStart - baseParagraphIndex) * 0.06;
  const windowPenalty = (transcriptWindow - 1) * 0.02 + (paragraphWindow - 1) * 0.015;
  const score = similarity * (0.85 + 0.15 * lengthBalance) - continuityPenalty - windowPenalty;
  return {
    transcriptStart,
    transcriptEnd: transcriptStart + transcriptWindow,
    paragraphStart,
    paragraphEnd: paragraphStart + paragraphWindow,
    similarity,
    score
  };
}
function findBestCandidate(transcriptSegments, articleParagraphs, transcriptIndex, paragraphIndex, options) {
  let bestCandidate = null;
  for (let transcriptOffset = 0; transcriptOffset <= options.maxTranscriptLookahead; transcriptOffset += 1) {
    const candidateTranscriptStart = transcriptIndex + transcriptOffset;
    if (candidateTranscriptStart >= transcriptSegments.length) {
      break;
    }
    for (let paragraphOffset = 0; paragraphOffset <= options.maxParagraphLookahead; paragraphOffset += 1) {
      const candidateParagraphStart = paragraphIndex + paragraphOffset;
      if (candidateParagraphStart >= articleParagraphs.length) {
        break;
      }
      for (let transcriptWindow = 1; transcriptWindow <= options.maxSegmentWindow; transcriptWindow += 1) {
        if (candidateTranscriptStart + transcriptWindow > transcriptSegments.length) {
          break;
        }
        for (let paragraphWindow = 1; paragraphWindow <= options.maxParagraphWindow; paragraphWindow += 1) {
          if (candidateParagraphStart + paragraphWindow > articleParagraphs.length) {
            break;
          }
          const candidate = buildCandidate(
            transcriptSegments,
            articleParagraphs,
            candidateTranscriptStart,
            transcriptWindow,
            candidateParagraphStart,
            paragraphWindow,
            transcriptIndex,
            paragraphIndex
          );
          if (!candidate) {
            continue;
          }
          if (!bestCandidate || candidate.score > bestCandidate.score) {
            bestCandidate = candidate;
          }
        }
      }
    }
  }
  return bestCandidate;
}
function calculateReanchorScore(candidate, baseTranscriptIndex, baseParagraphIndex) {
  const transcriptOffset = candidate.transcriptStart - baseTranscriptIndex;
  const paragraphOffset = candidate.paragraphStart - baseParagraphIndex;
  const windowPenalty = (candidate.transcriptEnd - candidate.transcriptStart - 1) * 0.015 + (candidate.paragraphEnd - candidate.paragraphStart - 1) * 0.012;
  return candidate.similarity - transcriptOffset * 0.02 - paragraphOffset * 0.012 - windowPenalty;
}
function findBestReanchorCandidate(transcriptSegments, articleParagraphs, transcriptIndex, paragraphIndex) {
  const options = {
    maxSegmentWindow: 4,
    maxParagraphWindow: 4,
    maxTranscriptLookahead: 24,
    maxParagraphLookahead: 12
  };
  let bestCandidate = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let transcriptOffset = 0; transcriptOffset <= options.maxTranscriptLookahead; transcriptOffset += 1) {
    const candidateTranscriptStart = transcriptIndex + transcriptOffset;
    if (candidateTranscriptStart >= transcriptSegments.length) {
      break;
    }
    for (let paragraphOffset = 0; paragraphOffset <= options.maxParagraphLookahead; paragraphOffset += 1) {
      const candidateParagraphStart = paragraphIndex + paragraphOffset;
      if (candidateParagraphStart >= articleParagraphs.length) {
        break;
      }
      for (let transcriptWindow = 1; transcriptWindow <= options.maxSegmentWindow; transcriptWindow += 1) {
        if (candidateTranscriptStart + transcriptWindow > transcriptSegments.length) {
          break;
        }
        for (let paragraphWindow = 1; paragraphWindow <= options.maxParagraphWindow; paragraphWindow += 1) {
          if (candidateParagraphStart + paragraphWindow > articleParagraphs.length) {
            break;
          }
          const candidate = buildCandidate(
            transcriptSegments,
            articleParagraphs,
            candidateTranscriptStart,
            transcriptWindow,
            candidateParagraphStart,
            paragraphWindow,
            transcriptIndex,
            paragraphIndex
          );
          if (!candidate) {
            continue;
          }
          const reanchorScore = calculateReanchorScore(candidate, transcriptIndex, paragraphIndex);
          if (!bestCandidate || reanchorScore > bestScore) {
            bestCandidate = candidate;
            bestScore = reanchorScore;
          }
        }
      }
    }
  }
  return bestCandidate;
}
function appendCandidateSyncEntries(syncEntries, transcriptSegments, articleParagraphs, candidate) {
  const transcriptSlice = trimLowSignalSegments(
    transcriptSegments.slice(candidate.transcriptStart, candidate.transcriptEnd)
  );
  const articleSlice = articleParagraphs.slice(candidate.paragraphStart, candidate.paragraphEnd);
  const weights = articleSlice.map((paragraph) => Math.max(1, normalizeAlignmentText(paragraph.text).length));
  const timeRanges = splitTimeRange(
    transcriptSlice[0]?.startMs ?? 0,
    transcriptSlice[transcriptSlice.length - 1]?.endMs ?? 0,
    weights
  );
  const transcriptSegmentIndexes = transcriptSlice.map((segment) => segment.index);
  for (let itemIndex = 0; itemIndex < articleSlice.length; itemIndex += 1) {
    const paragraph = articleSlice[itemIndex];
    const [startMs, endMs] = timeRanges[itemIndex] ?? [
      transcriptSlice[0]?.startMs ?? 0,
      transcriptSlice[transcriptSlice.length - 1]?.endMs ?? 0
    ];
    syncEntries.push({
      paragraphIndex: paragraph.paragraphIndex,
      startMs,
      endMs,
      transcriptSegmentIndexes,
      alignmentScore: candidate.similarity
    });
  }
}
function fillSmallGapSyncEntries(syncEntries, articleParagraphs, options) {
  if (syncEntries.length === 0) {
    return [];
  }
  const paragraphLookup = new Map(articleParagraphs.map((paragraph) => [paragraph.paragraphIndex, paragraph]));
  const filledEntries = [];
  for (let index = 0; index < syncEntries.length; index += 1) {
    const currentEntry = syncEntries[index];
    filledEntries.push(currentEntry);
    if (index === syncEntries.length - 1) {
      continue;
    }
    const nextEntry = syncEntries[index + 1];
    const missingCount = nextEntry.paragraphIndex - currentEntry.paragraphIndex - 1;
    const availableDuration = nextEntry.startMs - currentEntry.endMs;
    if (missingCount <= 0 || missingCount > options.maxGapParagraphs) {
      continue;
    }
    if (availableDuration <= 120 || availableDuration > options.maxGapDurationMs) {
      continue;
    }
    const missingParagraphs = [];
    for (let paragraphIndex = currentEntry.paragraphIndex + 1; paragraphIndex < nextEntry.paragraphIndex; paragraphIndex += 1) {
      const paragraph = paragraphLookup.get(paragraphIndex);
      if (!paragraph) {
        missingParagraphs.length = 0;
        break;
      }
      missingParagraphs.push(paragraph);
    }
    if (missingParagraphs.length === 0) {
      continue;
    }
    const weights = missingParagraphs.map((paragraph) => Math.max(1, normalizeAlignmentText(paragraph.text).length));
    const timeRanges = splitTimeRange(currentEntry.endMs, nextEntry.startMs, weights);
    for (let missingIndex = 0; missingIndex < missingParagraphs.length; missingIndex += 1) {
      const paragraph = missingParagraphs[missingIndex];
      const [startMs, endMs] = timeRanges[missingIndex] ?? [currentEntry.endMs, nextEntry.startMs];
      filledEntries.push({
        paragraphIndex: paragraph.paragraphIndex,
        startMs,
        endMs,
        transcriptSegmentIndexes: [],
        alignmentScore: 0.35
      });
    }
  }
  return filledEntries.sort((left, right) => left.paragraphIndex - right.paragraphIndex);
}
function estimateFallbackParagraphDurationMs(transcriptSegments, articleParagraphs, syncEntries) {
  if (syncEntries.length >= 2) {
    const totalAnchoredDuration = syncEntries[syncEntries.length - 1].endMs - syncEntries[0].startMs;
    const anchoredSpanParagraphs = syncEntries[syncEntries.length - 1].paragraphIndex - syncEntries[0].paragraphIndex + 1;
    if (totalAnchoredDuration > 0 && anchoredSpanParagraphs > 0) {
      return totalAnchoredDuration / anchoredSpanParagraphs;
    }
  }
  const transcriptDuration = Math.max(0, (transcriptSegments[transcriptSegments.length - 1]?.endMs ?? 0) - (transcriptSegments[0]?.startMs ?? 0));
  if (transcriptDuration > 0 && articleParagraphs.length > 0) {
    return transcriptDuration / articleParagraphs.length;
  }
  return 1500;
}
function fillRemainingGapSyncEntries(syncEntries, transcriptSegments, articleParagraphs) {
  if (syncEntries.length === 0) {
    return [];
  }
  const sortedEntries = [...syncEntries].sort((left, right) => left.paragraphIndex - right.paragraphIndex);
  const entryByParagraphIndex = new Map(sortedEntries.map((entry) => [entry.paragraphIndex, entry]));
  const fallbackParagraphDurationMs = estimateFallbackParagraphDurationMs(transcriptSegments, articleParagraphs, sortedEntries);
  const transcriptStartMs = Math.max(0, transcriptSegments[0]?.startMs ?? 0);
  const transcriptEndMs = Math.max(transcriptStartMs, transcriptSegments[transcriptSegments.length - 1]?.endMs ?? transcriptStartMs);
  const firstEntry = sortedEntries[0];
  if (firstEntry && firstEntry.paragraphIndex > articleParagraphs[0].paragraphIndex) {
    const headParagraphs = articleParagraphs.filter((paragraph) => paragraph.paragraphIndex < firstEntry.paragraphIndex);
    const headStartMs = Math.max(transcriptStartMs, firstEntry.startMs - fallbackParagraphDurationMs * headParagraphs.length);
    const headRanges = splitTimeRange(headStartMs, Math.max(headStartMs, firstEntry.startMs), headParagraphs.map((paragraph) => Math.max(1, normalizeAlignmentText(paragraph.text).length)));
    headParagraphs.forEach((paragraph, index) => {
      if (entryByParagraphIndex.has(paragraph.paragraphIndex)) {
        return;
      }
      const [startMs, endMs] = headRanges[index] ?? [headStartMs, firstEntry.startMs];
      entryByParagraphIndex.set(paragraph.paragraphIndex, {
        paragraphIndex: paragraph.paragraphIndex,
        startMs,
        endMs,
        transcriptSegmentIndexes: [],
        alignmentScore: 0.2
      });
    });
  }
  for (let index = 0; index < sortedEntries.length - 1; index += 1) {
    const currentEntry = sortedEntries[index];
    const nextEntry = sortedEntries[index + 1];
    const gapParagraphs = articleParagraphs.filter(
      (paragraph) => paragraph.paragraphIndex > currentEntry.paragraphIndex && paragraph.paragraphIndex < nextEntry.paragraphIndex
    );
    if (gapParagraphs.length === 0) {
      continue;
    }
    const gapStartMs = Math.min(currentEntry.endMs, nextEntry.startMs);
    const gapEndMs = Math.max(currentEntry.endMs, nextEntry.startMs);
    const ranges = gapEndMs > gapStartMs ? splitTimeRange(
      gapStartMs,
      gapEndMs,
      gapParagraphs.map((paragraph) => Math.max(1, normalizeAlignmentText(paragraph.text).length))
    ) : gapParagraphs.map((_, gapIndex) => {
      const startMs = currentEntry.endMs + gapIndex * fallbackParagraphDurationMs;
      return [startMs, startMs + fallbackParagraphDurationMs];
    });
    gapParagraphs.forEach((paragraph, gapIndex) => {
      if (entryByParagraphIndex.has(paragraph.paragraphIndex)) {
        return;
      }
      const [startMs, endMs] = ranges[gapIndex] ?? [currentEntry.endMs, nextEntry.startMs];
      entryByParagraphIndex.set(paragraph.paragraphIndex, {
        paragraphIndex: paragraph.paragraphIndex,
        startMs,
        endMs,
        transcriptSegmentIndexes: [],
        alignmentScore: 0.18
      });
    });
  }
  const lastEntry = sortedEntries[sortedEntries.length - 1];
  if (lastEntry && lastEntry.paragraphIndex < articleParagraphs[articleParagraphs.length - 1].paragraphIndex) {
    const tailParagraphs = articleParagraphs.filter((paragraph) => paragraph.paragraphIndex > lastEntry.paragraphIndex);
    const tailEndMs = Math.max(lastEntry.endMs, Math.min(transcriptEndMs, lastEntry.endMs + fallbackParagraphDurationMs * tailParagraphs.length));
    const tailRanges = splitTimeRange(lastEntry.endMs, tailEndMs, tailParagraphs.map((paragraph) => Math.max(1, normalizeAlignmentText(paragraph.text).length)));
    tailParagraphs.forEach((paragraph, index) => {
      if (entryByParagraphIndex.has(paragraph.paragraphIndex)) {
        return;
      }
      const [startMs, endMs] = tailRanges[index] ?? [lastEntry.endMs, tailEndMs];
      entryByParagraphIndex.set(paragraph.paragraphIndex, {
        paragraphIndex: paragraph.paragraphIndex,
        startMs,
        endMs,
        transcriptSegmentIndexes: [],
        alignmentScore: 0.2
      });
    });
  }
  return Array.from(entryByParagraphIndex.values()).sort((left, right) => left.paragraphIndex - right.paragraphIndex);
}
function sortSyncEntriesByTimeline(syncEntries) {
  return [...syncEntries].map((entry) => {
    const startMs = Math.max(0, entry.startMs);
    return {
      ...entry,
      startMs,
      endMs: Math.max(startMs + 1, entry.endMs)
    };
  }).sort((left, right) => {
    if (left.startMs !== right.startMs) {
      return left.startMs - right.startMs;
    }
    if (left.endMs !== right.endMs) {
      return left.endMs - right.endMs;
    }
    return left.paragraphIndex - right.paragraphIndex;
  });
}
function finalizeAlignmentResult(syncEntries, transcriptSegments, articleParagraphs) {
  const smallGapFilledEntries = fillSmallGapSyncEntries(
    syncEntries.sort((left, right) => left.paragraphIndex - right.paragraphIndex),
    articleParagraphs,
    {
      maxGapParagraphs: 3,
      maxGapDurationMs: 12e3
    }
  );
  const allFilledEntries = fillRemainingGapSyncEntries(smallGapFilledEntries, transcriptSegments, articleParagraphs);
  const timelineSortedEntries = sortSyncEntriesByTimeline(allFilledEntries);
  const anchoredParagraphCount = timelineSortedEntries.filter((entry) => entry.transcriptSegmentIndexes.length > 0).length;
  const unmatchedParagraphCount = articleParagraphs.length - timelineSortedEntries.length;
  return {
    syncEntries: timelineSortedEntries,
    matchedParagraphCount: anchoredParagraphCount,
    unmatchedParagraphCount,
    consumedSegmentCount: transcriptSegments.length
  };
}
function buildAlignmentOptions() {
  return {
    maxSegmentWindow: 3,
    maxParagraphWindow: 3,
    maxTranscriptLookahead: 4,
    maxParagraphLookahead: 4
  };
}
function createProgressReporter(transcriptSegments, articleParagraphs, onProgress) {
  return (phase, processedSegmentCount, processedParagraphCount, message) => {
    if (!onProgress) {
      return;
    }
    const progressBase = phase === "preparing" ? 0.04 : phase === "matching" ? 0.08 + 0.8 * Math.max(
      processedParagraphCount / Math.max(articleParagraphs.length, 1),
      processedSegmentCount / Math.max(transcriptSegments.length, 1)
    ) : phase === "smoothing" ? 0.93 : 1;
    onProgress({
      phase,
      processedParagraphCount,
      articleParagraphCount: articleParagraphs.length,
      processedSegmentCount,
      subtitleSegmentCount: transcriptSegments.length,
      percent: Math.max(0, Math.min(1, progressBase)),
      message
    });
  };
}
function yieldToBrowser() {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}
async function buildSyncEntriesAsync(transcriptSegments, articleParagraphs, onProgress) {
  const reportProgress = createProgressReporter(transcriptSegments, articleParagraphs, onProgress);
  reportProgress("preparing", 0, 0, "\u6B63\u5728\u51C6\u5907\u5B57\u5E55\u548C\u6587\u7AE0\u6BB5\u843D...");
  const syncEntries = [];
  let transcriptIndex = 0;
  let paragraphIndex = 0;
  let iterationCount = 0;
  let lastYieldAt = performance.now();
  const options = buildAlignmentOptions();
  const minimumMatchScore = 0.55;
  const rescueMatchScore = 0.48;
  const reanchorSimilarityThreshold = 0.74;
  const reanchorScoreThreshold = 0.56;
  while (transcriptIndex < transcriptSegments.length && paragraphIndex < articleParagraphs.length) {
    iterationCount += 1;
    const candidate = findBestCandidate(transcriptSegments, articleParagraphs, transcriptIndex, paragraphIndex, options);
    if (candidate && candidate.score >= minimumMatchScore) {
      appendCandidateSyncEntries(syncEntries, transcriptSegments, articleParagraphs, candidate);
      transcriptIndex = candidate.transcriptEnd;
      paragraphIndex = candidate.paragraphEnd;
    } else {
      const rescueCandidate = candidate && candidate.score >= rescueMatchScore && candidate.transcriptStart === transcriptIndex && candidate.paragraphStart === paragraphIndex ? candidate : null;
      if (rescueCandidate) {
        appendCandidateSyncEntries(syncEntries, transcriptSegments, articleParagraphs, rescueCandidate);
        transcriptIndex = rescueCandidate.transcriptEnd;
        paragraphIndex = rescueCandidate.paragraphEnd;
      } else {
        const currentTranscriptText = transcriptSegments[transcriptIndex]?.text ?? "";
        const currentParagraphText = articleParagraphs[paragraphIndex]?.text ?? "";
        if (isLowSignalText(currentTranscriptText)) {
          transcriptIndex += 1;
        } else if (isLowSignalText(currentParagraphText)) {
          paragraphIndex += 1;
        } else {
          const reanchorCandidate = findBestReanchorCandidate(
            transcriptSegments,
            articleParagraphs,
            transcriptIndex,
            paragraphIndex
          );
          const reanchorScore = reanchorCandidate ? calculateReanchorScore(reanchorCandidate, transcriptIndex, paragraphIndex) : Number.NEGATIVE_INFINITY;
          if (reanchorCandidate && reanchorCandidate.similarity >= reanchorSimilarityThreshold && reanchorScore >= reanchorScoreThreshold) {
            appendCandidateSyncEntries(syncEntries, transcriptSegments, articleParagraphs, reanchorCandidate);
            transcriptIndex = reanchorCandidate.transcriptEnd;
            paragraphIndex = reanchorCandidate.paragraphEnd;
            continue;
          }
          const skipTranscriptCandidate = findBestCandidate(
            transcriptSegments,
            articleParagraphs,
            Math.min(transcriptIndex + 1, transcriptSegments.length),
            paragraphIndex,
            options
          );
          const skipParagraphCandidate = findBestCandidate(
            transcriptSegments,
            articleParagraphs,
            transcriptIndex,
            Math.min(paragraphIndex + 1, articleParagraphs.length),
            options
          );
          const skipTranscriptScore = skipTranscriptCandidate?.score ?? -1;
          const skipParagraphScore = skipParagraphCandidate?.score ?? -1;
          if (skipTranscriptScore >= skipParagraphScore) {
            transcriptIndex += 1;
          } else {
            paragraphIndex += 1;
          }
        }
      }
    }
    if (iterationCount % 2 === 0 || performance.now() - lastYieldAt >= 20) {
      reportProgress("matching", transcriptIndex, paragraphIndex, `\u6B63\u5728\u5339\u914D\u7B2C ${Math.min(paragraphIndex + 1, articleParagraphs.length)}/${articleParagraphs.length} \u6BB5...`);
      await yieldToBrowser();
      lastYieldAt = performance.now();
    }
  }
  reportProgress("smoothing", transcriptIndex, paragraphIndex, "\u6B63\u5728\u5E73\u6ED1\u8865\u9F50\u5C0F\u7F3A\u53E3...");
  await yieldToBrowser();
  reportProgress("finalizing", transcriptIndex, articleParagraphs.length, "\u6B63\u5728\u751F\u6210\u6700\u7EC8\u540C\u6B65\u6E05\u5355...");
  const finalizedResult = finalizeAlignmentResult(syncEntries, transcriptSegments, articleParagraphs);
  return {
    ...finalizedResult,
    consumedSegmentCount: transcriptIndex
  };
}
async function buildRuntimeManifestFromSubtitleAsync(subtitleDocument, articleSnapshot2, onProgress) {
  const transcriptSegments = subtitleDocument.transcript.segments;
  const articleParagraphs = articleSnapshot2.paragraphs;
  if (transcriptSegments.length === 0) {
    throw new Error("\u5B57\u5E55\u6587\u4EF6\u91CC\u6CA1\u6709\u53EF\u7528\u5BF9\u767D\u6BB5\u3002");
  }
  if (articleParagraphs.length === 0) {
    throw new Error("\u6587\u7AE0\u5FEB\u7167\u4E3A\u7A7A\uFF0C\u65E0\u6CD5\u6267\u884C\u8FD0\u884C\u65F6\u5339\u914D\u3002");
  }
  const alignmentResult = await buildSyncEntriesAsync(transcriptSegments, articleParagraphs, onProgress);
  if (alignmentResult.syncEntries.length === 0) {
    throw new Error("\u5B57\u5E55\u4E0E\u5F53\u524D\u6587\u7AE0\u6CA1\u6709\u627E\u5230\u53EF\u7528\u5339\u914D\uFF0C\u6682\u65F6\u65E0\u6CD5\u751F\u6210\u540C\u6B65\u6E05\u5355\u3002");
  }
  const smoothedParagraphCount = alignmentResult.syncEntries.filter((entry) => entry.transcriptSegmentIndexes.length === 0).length;
  const coverageRatio = alignmentResult.matchedParagraphCount / articleParagraphs.length;
  if (alignmentResult.matchedParagraphCount < 3) {
    throw new Error(`\u76F4\u63A5\u547D\u4E2D\u7684\u951A\u70B9\u8FC7\u5C11 (${alignmentResult.matchedParagraphCount} \u6BB5)\uFF0C\u8BF7\u786E\u8BA4\u5F53\u524D\u9875\u9762\u548C\u5B57\u5E55\u662F\u5426\u5C5E\u4E8E\u540C\u4E00\u96C6\u3002`);
  }
  const manifest2 = {
    version: "1.0.0",
    source: {
      slug: normalizeEpisodeSlug(subtitleDocument.fileName),
      title: articleSnapshot2.title || subtitleDocument.metadata.title,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      generator: "reader-sync-extension-runtime-subtitle",
      mediaFileName: subtitleDocument.fileName,
      articleUrl: articleSnapshot2.articleUrl,
      articleId: articleSnapshot2.articleId ?? void 0,
      categoryId: articleSnapshot2.categoryId ?? void 0
    },
    transcript: {
      mode: subtitleDocument.transcript.mode,
      language: subtitleDocument.transcript.language,
      modelName: subtitleDocument.transcript.modelName,
      text: subtitleDocument.transcript.text,
      segments: transcriptSegments
    },
    article: {
      capturedAt: articleSnapshot2.capturedAt,
      title: articleSnapshot2.title,
      articleUrl: articleSnapshot2.articleUrl,
      paragraphs: articleParagraphs
    },
    sync: alignmentResult.syncEntries
  };
  return {
    manifest: manifest2,
    stats: {
      subtitleSegmentCount: transcriptSegments.length,
      articleParagraphCount: articleParagraphs.length,
      matchedParagraphCount: alignmentResult.matchedParagraphCount,
      unmatchedParagraphCount: alignmentResult.unmatchedParagraphCount,
      smoothedParagraphCount,
      consumedSegmentCount: alignmentResult.consumedSegmentCount,
      coverageRatio
    }
  };
}

// src/shared/subtitle-parser.ts
var ASS_TAG_PATTERN = /\{[^}]*\}/g;
var HTML_TAG_PATTERN = /<[^>]+>/g;
var SPEAKER_PREFIX_PATTERN2 = /^[A-Za-z][A-Za-z' .-]{0,40}:\s*/;
var MULTISPACE_PATTERN2 = /\s+/g;
var CJK_PATTERN = /[\u3400-\u9fff]/;
var LATIN_PATTERN = /[A-Za-z]/g;
function detectTextEncoding(bytes) {
  if (bytes.length >= 2) {
    if (bytes[0] === 255 && bytes[1] === 254) {
      return "utf-16le";
    }
    if (bytes[0] === 254 && bytes[1] === 255) {
      return "utf-16be";
    }
  }
  if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) {
    return "utf-8";
  }
  let nullByteCount = 0;
  for (const value of bytes) {
    if (value === 0) {
      nullByteCount += 1;
    }
  }
  return nullByteCount > bytes.length * 0.15 ? "utf-16le" : "utf-8";
}
async function readTextFile(file) {
  const buffer = new Uint8Array(await file.arrayBuffer());
  return new TextDecoder(detectTextEncoding(buffer), { fatal: false }).decode(buffer);
}
function normalizeWhitespace(value) {
  return value.replace(/\r/g, "").replace(/\uFEFF/g, "").replace(MULTISPACE_PATTERN2, " ").trim();
}
function stripSpeakerPrefix(value) {
  return value.replace(SPEAKER_PREFIX_PATTERN2, "").trim();
}
function scoreEnglishLikelihood(value) {
  const normalized = value.trim();
  if (!normalized) {
    return -100;
  }
  const latinCount = (normalized.match(LATIN_PATTERN) ?? []).length;
  const cjkCount = (normalized.match(CJK_PATTERN) ?? []).length;
  const asciiCount = Array.from(normalized).filter((character) => character.charCodeAt(0) <= 127).length;
  return latinCount * 3 + asciiCount - cjkCount * 4;
}
function pickPrimaryAndTranslation(rawLines) {
  const cleanedLines = rawLines.map((line) => normalizeWhitespace(stripSpeakerPrefix(line))).filter(Boolean);
  if (cleanedLines.length === 0) {
    return { text: "" };
  }
  if (cleanedLines.length === 1) {
    return { text: cleanedLines[0] };
  }
  const rankedLines = cleanedLines.map((line) => ({ line, score: scoreEnglishLikelihood(line) })).sort((left, right) => right.score - left.score);
  const primary = rankedLines[0]?.line ?? cleanedLines[0];
  const translation = cleanedLines.find((line) => line !== primary);
  return {
    text: primary,
    translation
  };
}
function toTranscriptSegments(lines) {
  const segments = lines.map((line, index) => ({
    index: index + 1,
    startMs: line.startMs,
    endMs: Math.max(line.endMs, line.startMs + 1),
    text: line.text
  })).filter((segment) => segment.text.length > 0 && segment.endMs > segment.startMs);
  return segments.map((segment, index) => ({
    ...segment,
    index: index + 1
  }));
}
function normalizeSubtitleText(value) {
  return value.replace(/\r/g, "").replace(/\uFEFF/g, "").replace(ASS_TAG_PATTERN, "").replace(HTML_TAG_PATTERN, "").replace(/\\N/gi, "\n").replace(/\\n/gi, "\n").replace(/\\h/gi, " ");
}
function parseAssTimestamp(value) {
  const match = value.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})$/);
  if (!match) {
    throw new Error(`\u65E0\u6548\u7684 ASS \u65F6\u95F4\u6233: ${value}`);
  }
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  const fractionRaw = match[4];
  const milliseconds = fractionRaw.length === 1 ? Number.parseInt(fractionRaw, 10) * 100 : fractionRaw.length === 2 ? Number.parseInt(fractionRaw, 10) * 10 : Number.parseInt(fractionRaw.slice(0, 3), 10);
  return (hours * 60 + minutes) * 60 * 1e3 + seconds * 1e3 + milliseconds;
}
function parseAssDialogue(text) {
  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalizedText.split("\n");
  let inEventsSection = false;
  let eventFormat = [];
  let title;
  const parsedLines = [];
  let translationCount = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("[")) {
      inEventsSection = line.toLowerCase() === "[events]";
      continue;
    }
    if (/^title:/i.test(line)) {
      title = normalizeWhitespace(line.slice(line.indexOf(":") + 1));
      continue;
    }
    if (!inEventsSection) {
      continue;
    }
    if (/^format:/i.test(line)) {
      eventFormat = line.slice(line.indexOf(":") + 1).split(",").map((value) => value.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue:/i.test(line)) {
      continue;
    }
    if (eventFormat.length === 0) {
      throw new Error("ASS \u6587\u4EF6\u7F3A\u5C11 [Events] Format \u5B9A\u4E49\u3002");
    }
    const rawFields = line.slice(line.indexOf(":") + 1).split(",");
    if (rawFields.length < eventFormat.length) {
      continue;
    }
    const fields = rawFields.slice(0, eventFormat.length - 1);
    fields.push(rawFields.slice(eventFormat.length - 1).join(","));
    const startIndex = eventFormat.indexOf("start");
    const endIndex = eventFormat.indexOf("end");
    const textIndex = eventFormat.indexOf("text");
    if (startIndex === -1 || endIndex === -1 || textIndex === -1) {
      throw new Error("ASS Events Format \u7F3A\u5C11 start/end/text \u5B57\u6BB5\u3002");
    }
    const normalizedDialogue = normalizeSubtitleText(fields[textIndex] ?? "");
    const { text: primaryText, translation } = pickPrimaryAndTranslation(normalizedDialogue.split("\n"));
    if (!primaryText) {
      continue;
    }
    if (translation) {
      translationCount += 1;
    }
    parsedLines.push({
      startMs: parseAssTimestamp(fields[startIndex] ?? ""),
      endMs: parseAssTimestamp(fields[endIndex] ?? ""),
      text: primaryText,
      translation
    });
  }
  return {
    title,
    segmentCount: parsedLines.length,
    translationCount,
    lines: parsedLines
  };
}
function parseSrtTimestamp(value) {
  const match = value.trim().match(/^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) {
    throw new Error(`\u65E0\u6548\u7684 SRT/VTT \u65F6\u95F4\u6233: ${value}`);
  }
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  const milliseconds = Number.parseInt(match[4], 10);
  return (hours * 60 + minutes) * 60 * 1e3 + seconds * 1e3 + milliseconds;
}
function parseSimpleTimedSubtitle(text, format) {
  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\uFEFF/g, "");
  const blocks = normalizedText.split(/\n{2,}/);
  const parsedLines = [];
  let translationCount = 0;
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0 || format === "vtt" && lines[0] === "WEBVTT") {
      continue;
    }
    const timingLineIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingLineIndex === -1) {
      continue;
    }
    const [startRaw, endRaw] = lines[timingLineIndex].split("-->").map((value) => value.trim().split(/\s+/)[0] ?? "");
    const textLines = lines.slice(timingLineIndex + 1).map((line) => normalizeSubtitleText(line));
    const { text: primaryText, translation } = pickPrimaryAndTranslation(textLines);
    if (!primaryText) {
      continue;
    }
    if (translation) {
      translationCount += 1;
    }
    parsedLines.push({
      startMs: parseSrtTimestamp(startRaw),
      endMs: parseSrtTimestamp(endRaw),
      text: primaryText,
      translation
    });
  }
  return {
    segmentCount: parsedLines.length,
    translationCount,
    lines: parsedLines
  };
}
function buildParsedDocument(fileName, format, metadata, lines) {
  const segments = toTranscriptSegments(lines);
  if (segments.length === 0) {
    throw new Error("\u5B57\u5E55\u6587\u4EF6\u91CC\u6CA1\u6709\u53EF\u7528\u5BF9\u767D\u6BB5\u3002");
  }
  return {
    fileName,
    format,
    transcript: {
      mode: `subtitle-${format}`,
      language: "en",
      modelName: format === "ass" ? "sidecar-ass-subtitle" : "sidecar-subtitle",
      text: segments.map((segment) => segment.text).join(" ").trim(),
      segments
    },
    metadata: {
      ...metadata,
      segmentCount: segments.length
    }
  };
}
async function parseSubtitleFile(file) {
  const text = await readTextFile(file);
  const fileName = file.name;
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "ass" || extension === "ssa") {
    const parsed = parseAssDialogue(text);
    return buildParsedDocument(fileName, "ass", parsed, parsed.lines);
  }
  if (extension === "srt") {
    const parsed = parseSimpleTimedSubtitle(text, "srt");
    return buildParsedDocument(fileName, "srt", parsed, parsed.lines);
  }
  if (extension === "vtt") {
    const parsed = parseSimpleTimedSubtitle(text, "vtt");
    return buildParsedDocument(fileName, "vtt", parsed, parsed.lines);
  }
  throw new Error(`\u5F53\u524D\u8FD8\u4E0D\u652F\u6301\u8BE5\u5B57\u5E55\u683C\u5F0F: ${extension || "unknown"}`);
}

// node_modules/@ffmpeg/ffmpeg/dist/esm/const.js
var CORE_VERSION = "0.12.9";
var CORE_URL = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd/ffmpeg-core.js`;
var FFMessageType;
(function(FFMessageType2) {
  FFMessageType2["LOAD"] = "LOAD";
  FFMessageType2["EXEC"] = "EXEC";
  FFMessageType2["FFPROBE"] = "FFPROBE";
  FFMessageType2["WRITE_FILE"] = "WRITE_FILE";
  FFMessageType2["READ_FILE"] = "READ_FILE";
  FFMessageType2["DELETE_FILE"] = "DELETE_FILE";
  FFMessageType2["RENAME"] = "RENAME";
  FFMessageType2["CREATE_DIR"] = "CREATE_DIR";
  FFMessageType2["LIST_DIR"] = "LIST_DIR";
  FFMessageType2["DELETE_DIR"] = "DELETE_DIR";
  FFMessageType2["ERROR"] = "ERROR";
  FFMessageType2["DOWNLOAD"] = "DOWNLOAD";
  FFMessageType2["PROGRESS"] = "PROGRESS";
  FFMessageType2["LOG"] = "LOG";
  FFMessageType2["MOUNT"] = "MOUNT";
  FFMessageType2["UNMOUNT"] = "UNMOUNT";
})(FFMessageType || (FFMessageType = {}));

// node_modules/@ffmpeg/ffmpeg/dist/esm/utils.js
var getMessageID = /* @__PURE__ */ (() => {
  let messageID = 0;
  return () => messageID++;
})();

// node_modules/@ffmpeg/ffmpeg/dist/esm/errors.js
var ERROR_UNKNOWN_MESSAGE_TYPE = new Error("unknown message type");
var ERROR_NOT_LOADED = new Error("ffmpeg is not loaded, call `await ffmpeg.load()` first");
var ERROR_TERMINATED = new Error("called FFmpeg.terminate()");
var ERROR_IMPORT_FAILURE = new Error("failed to import ffmpeg-core.js");

// node_modules/@ffmpeg/ffmpeg/dist/esm/classes.js
var FFmpeg = class {
  #worker = null;
  /**
   * #resolves and #rejects tracks Promise resolves and rejects to
   * be called when we receive message from web worker.
   */
  #resolves = {};
  #rejects = {};
  #logEventCallbacks = [];
  #progressEventCallbacks = [];
  loaded = false;
  /**
   * register worker message event handlers.
   */
  #registerHandlers = () => {
    if (this.#worker) {
      this.#worker.onmessage = ({ data: { id, type, data } }) => {
        switch (type) {
          case FFMessageType.LOAD:
            this.loaded = true;
            this.#resolves[id](data);
            break;
          case FFMessageType.MOUNT:
          case FFMessageType.UNMOUNT:
          case FFMessageType.EXEC:
          case FFMessageType.FFPROBE:
          case FFMessageType.WRITE_FILE:
          case FFMessageType.READ_FILE:
          case FFMessageType.DELETE_FILE:
          case FFMessageType.RENAME:
          case FFMessageType.CREATE_DIR:
          case FFMessageType.LIST_DIR:
          case FFMessageType.DELETE_DIR:
            this.#resolves[id](data);
            break;
          case FFMessageType.LOG:
            this.#logEventCallbacks.forEach((f) => f(data));
            break;
          case FFMessageType.PROGRESS:
            this.#progressEventCallbacks.forEach((f) => f(data));
            break;
          case FFMessageType.ERROR:
            this.#rejects[id](data);
            break;
        }
        delete this.#resolves[id];
        delete this.#rejects[id];
      };
    }
  };
  /**
   * Generic function to send messages to web worker.
   */
  #send = ({ type, data }, trans = [], signal) => {
    if (!this.#worker) {
      return Promise.reject(ERROR_NOT_LOADED);
    }
    return new Promise((resolve, reject) => {
      const id = getMessageID();
      this.#worker && this.#worker.postMessage({ id, type, data }, trans);
      this.#resolves[id] = resolve;
      this.#rejects[id] = reject;
      signal?.addEventListener("abort", () => {
        reject(new DOMException(`Message # ${id} was aborted`, "AbortError"));
      }, { once: true });
    });
  };
  on(event, callback) {
    if (event === "log") {
      this.#logEventCallbacks.push(callback);
    } else if (event === "progress") {
      this.#progressEventCallbacks.push(callback);
    }
  }
  off(event, callback) {
    if (event === "log") {
      this.#logEventCallbacks = this.#logEventCallbacks.filter((f) => f !== callback);
    } else if (event === "progress") {
      this.#progressEventCallbacks = this.#progressEventCallbacks.filter((f) => f !== callback);
    }
  }
  /**
   * Loads ffmpeg-core inside web worker. It is required to call this method first
   * as it initializes WebAssembly and other essential variables.
   *
   * @category FFmpeg
   * @returns `true` if ffmpeg core is loaded for the first time.
   */
  load = ({ classWorkerURL, ...config } = {}, { signal } = {}) => {
    if (!this.#worker) {
      this.#worker = classWorkerURL ? new Worker(new URL(classWorkerURL, import.meta.url), {
        type: "module"
      }) : (
        // We need to duplicated the code here to enable webpack
        // to bundle worekr.js here.
        new Worker(new URL("./worker.js", import.meta.url), {
          type: "module"
        })
      );
      this.#registerHandlers();
    }
    return this.#send({
      type: FFMessageType.LOAD,
      data: config
    }, void 0, signal);
  };
  /**
   * Execute ffmpeg command.
   *
   * @remarks
   * To avoid common I/O issues, ["-nostdin", "-y"] are prepended to the args
   * by default.
   *
   * @example
   * ```ts
   * const ffmpeg = new FFmpeg();
   * await ffmpeg.load();
   * await ffmpeg.writeFile("video.avi", ...);
   * // ffmpeg -i video.avi video.mp4
   * await ffmpeg.exec(["-i", "video.avi", "video.mp4"]);
   * const data = ffmpeg.readFile("video.mp4");
   * ```
   *
   * @returns `0` if no error, `!= 0` if timeout (1) or error.
   * @category FFmpeg
   */
  exec = (args, timeout = -1, { signal } = {}) => this.#send({
    type: FFMessageType.EXEC,
    data: { args, timeout }
  }, void 0, signal);
  /**
   * Execute ffprobe command.
   *
   * @example
   * ```ts
   * const ffmpeg = new FFmpeg();
   * await ffmpeg.load();
   * await ffmpeg.writeFile("video.avi", ...);
   * // Getting duration of a video in seconds: ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 video.avi -o output.txt
   * await ffmpeg.ffprobe(["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", "video.avi", "-o", "output.txt"]);
   * const data = ffmpeg.readFile("output.txt");
   * ```
   *
   * @returns `0` if no error, `!= 0` if timeout (1) or error.
   * @category FFmpeg
   */
  ffprobe = (args, timeout = -1, { signal } = {}) => this.#send({
    type: FFMessageType.FFPROBE,
    data: { args, timeout }
  }, void 0, signal);
  /**
   * Terminate all ongoing API calls and terminate web worker.
   * `FFmpeg.load()` must be called again before calling any other APIs.
   *
   * @category FFmpeg
   */
  terminate = () => {
    const ids = Object.keys(this.#rejects);
    for (const id of ids) {
      this.#rejects[id](ERROR_TERMINATED);
      delete this.#rejects[id];
      delete this.#resolves[id];
    }
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
      this.loaded = false;
    }
  };
  /**
   * Write data to ffmpeg.wasm.
   *
   * @example
   * ```ts
   * const ffmpeg = new FFmpeg();
   * await ffmpeg.load();
   * await ffmpeg.writeFile("video.avi", await fetchFile("../video.avi"));
   * await ffmpeg.writeFile("text.txt", "hello world");
   * ```
   *
   * @category File System
   */
  writeFile = (path, data, { signal } = {}) => {
    const trans = [];
    if (data instanceof Uint8Array) {
      trans.push(data.buffer);
    }
    return this.#send({
      type: FFMessageType.WRITE_FILE,
      data: { path, data }
    }, trans, signal);
  };
  mount = (fsType, options, mountPoint) => {
    const trans = [];
    return this.#send({
      type: FFMessageType.MOUNT,
      data: { fsType, options, mountPoint }
    }, trans);
  };
  unmount = (mountPoint) => {
    const trans = [];
    return this.#send({
      type: FFMessageType.UNMOUNT,
      data: { mountPoint }
    }, trans);
  };
  /**
   * Read data from ffmpeg.wasm.
   *
   * @example
   * ```ts
   * const ffmpeg = new FFmpeg();
   * await ffmpeg.load();
   * const data = await ffmpeg.readFile("video.mp4");
   * ```
   *
   * @category File System
   */
  readFile = (path, encoding = "binary", { signal } = {}) => this.#send({
    type: FFMessageType.READ_FILE,
    data: { path, encoding }
  }, void 0, signal);
  /**
   * Delete a file.
   *
   * @category File System
   */
  deleteFile = (path, { signal } = {}) => this.#send({
    type: FFMessageType.DELETE_FILE,
    data: { path }
  }, void 0, signal);
  /**
   * Rename a file or directory.
   *
   * @category File System
   */
  rename = (oldPath, newPath, { signal } = {}) => this.#send({
    type: FFMessageType.RENAME,
    data: { oldPath, newPath }
  }, void 0, signal);
  /**
   * Create a directory.
   *
   * @category File System
   */
  createDir = (path, { signal } = {}) => this.#send({
    type: FFMessageType.CREATE_DIR,
    data: { path }
  }, void 0, signal);
  /**
   * List directory contents.
   *
   * @category File System
   */
  listDir = (path, { signal } = {}) => this.#send({
    type: FFMessageType.LIST_DIR,
    data: { path }
  }, void 0, signal);
  /**
   * Delete an empty directory.
   *
   * @category File System
   */
  deleteDir = (path, { signal } = {}) => this.#send({
    type: FFMessageType.DELETE_DIR,
    data: { path }
  }, void 0, signal);
};

// node_modules/@ffmpeg/ffmpeg/dist/esm/types.js
var FFFSType;
(function(FFFSType2) {
  FFFSType2["MEMFS"] = "MEMFS";
  FFFSType2["NODEFS"] = "NODEFS";
  FFFSType2["NODERAWFS"] = "NODERAWFS";
  FFFSType2["IDBFS"] = "IDBFS";
  FFFSType2["WORKERFS"] = "WORKERFS";
  FFFSType2["PROXYFS"] = "PROXYFS";
})(FFFSType || (FFFSType = {}));

// node_modules/@ffmpeg/util/dist/esm/errors.js
var ERROR_RESPONSE_BODY_READER = new Error("failed to get response body reader");
var ERROR_INCOMPLETED_DOWNLOAD = new Error("failed to complete download");

// node_modules/@ffmpeg/util/dist/esm/index.js
var readFromBlobOrFile = (blob) => new Promise((resolve, reject) => {
  const fileReader = new FileReader();
  fileReader.onload = () => {
    const { result } = fileReader;
    if (result instanceof ArrayBuffer) {
      resolve(new Uint8Array(result));
    } else {
      resolve(new Uint8Array());
    }
  };
  fileReader.onerror = (event) => {
    reject(Error(`File could not be read! Code=${event?.target?.error?.code || -1}`));
  };
  fileReader.readAsArrayBuffer(blob);
});
var fetchFile = async (file) => {
  let data;
  if (typeof file === "string") {
    if (/data:_data\/([a-zA-Z]*);base64,([^"]*)/.test(file)) {
      data = atob(file.split(",")[1]).split("").map((c) => c.charCodeAt(0));
    } else {
      data = await (await fetch(file)).arrayBuffer();
    }
  } else if (file instanceof URL) {
    data = await (await fetch(file)).arrayBuffer();
  } else if (file instanceof File || file instanceof Blob) {
    data = await readFromBlobOrFile(file);
  } else {
    return new Uint8Array();
  }
  return new Uint8Array(data);
};

// src/player/media-compatibility.ts
var preferredContainerFormats = /* @__PURE__ */ new Set(["mov", "mp4", "m4a", "3gp", "3g2", "mj2"]);
var browserPlayableVideoCodecs = /* @__PURE__ */ new Set(["hevc", "h264", "avc1"]);
var hevcSampleEntries = /* @__PURE__ */ new Set(["hvc1", "hev1"]);
var h264SampleEntries = /* @__PURE__ */ new Set(["avc1", "avc2", "avc3", "avc4"]);
var aacSampleEntries = /* @__PURE__ */ new Set(["mp4a"]);
var browserPlayableVideoCodecLabels = /* @__PURE__ */ new Map([
  ["hevc", "HEVC(HVC1)"],
  ["h264", "H.264/AVC"],
  ["avc1", "H.264/AVC"]
]);
function buildOutputVideoName(fileName, strategy) {
  const lastDotIndex = fileName.lastIndexOf(".");
  const stem = lastDotIndex === -1 ? fileName : fileName.slice(0, lastDotIndex);
  if (!strategy) {
    return `${stem}.avc1.aac.mp4`;
  }
  const videoProfile = strategy.videoAction === "copy" ? normalizeOutputCodecSlug(strategy.videoCodec) : "avc1";
  const audioProfile = strategy.audioAction === "copy" ? "source-audio" : "aac";
  return `${stem}.${videoProfile}.${audioProfile}.mp4`;
}
function buildMediaTranscodeStrategy(fileName, probe) {
  const resolvedContainerFormats = resolveContainerFormats(fileName, probe.containerFormats);
  const videoStream = probe.streams.find((stream) => stream.codecType === "video");
  const audioStreams = probe.streams.filter((stream) => stream.codecType === "audio");
  if (!videoStream) {
    throw new Error("\u8F93\u5165\u6587\u4EF6\u7F3A\u5C11\u89C6\u9891\u6D41\uFF0C\u65E0\u6CD5\u8FDB\u5165\u64AD\u653E\u5668\u3002");
  }
  const containerAction = isPreferredContainer(resolvedContainerFormats) ? "copy" : "remux";
  const normalizedVideoCodec = normalizeCodecName(videoStream.codecName);
  const videoAction = browserPlayableVideoCodecs.has(normalizedVideoCodec) ? "copy" : "transcode";
  const normalizedAudioCodecs = audioStreams.map((stream) => normalizeCodecName(stream.codecName));
  const audioAction = normalizedAudioCodecs.length === 0 || normalizedAudioCodecs.every((codecName) => codecName === "aac") ? "copy" : "transcode";
  return {
    containerAction,
    videoAction,
    audioAction,
    videoCodec: normalizedVideoCodec,
    audioCodecs: normalizedAudioCodecs,
    outputFileName: buildOutputVideoName(fileName, {
      videoAction,
      audioAction,
      videoCodec: normalizedVideoCodec
    })
  };
}
function assessMediaCompatibility(fileName, probe) {
  const resolvedContainerFormats = resolveContainerFormats(fileName, probe.containerFormats);
  const strategy = buildMediaTranscodeStrategy(fileName, probe);
  const reasons = [];
  if (strategy.containerAction === "remux") {
    reasons.push(`\u5C01\u88C5\u683C\u5F0F\u4E3A ${formatContainerFormats(resolvedContainerFormats)}\uFF0C\u4E0D\u5728\u63A8\u8350\u7684 MP4/MOV \u57FA\u7EBF\u5185`);
  }
  if (strategy.videoAction === "transcode") {
    reasons.push(`\u89C6\u9891\u7F16\u7801\u4E3A ${formatVideoCodec(strategy.videoCodec)}\uFF0CChrome \u65E0\u6CD5\u7A33\u5B9A\u76F4\u63A5\u64AD\u653E\uFF0C\u9700\u8F6C\u4E3A H.264/AVC`);
  }
  if (strategy.audioAction === "transcode") {
    reasons.push(`\u97F3\u9891\u7F16\u7801\u4E3A ${formatAudioCodecs(strategy.audioCodecs)}\uFF0C\u4E0D\u662F\u76EE\u6807 AAC`);
  }
  if (reasons.length === 0) {
    return {
      isRecommendedProfile: true,
      reasons,
      summary: "\u5DF2\u547D\u4E2D\u63A8\u8350\u64AD\u653E\u57FA\u7EBF\uFF0C\u5C06\u76F4\u63A5\u8FDB\u5165\u539F\u751F\u64AD\u653E\u5668\u3002",
      detail: `\u5C01\u88C5 ${formatContainerFormats(resolvedContainerFormats)}\uFF0C\u89C6\u9891 ${formatVideoCodec(strategy.videoCodec)}\uFF0C\u97F3\u9891 ${formatAudioCodecs(strategy.audioCodecs)}\u3002`
    };
  }
  return {
    isRecommendedProfile: false,
    reasons,
    summary: "\u5F53\u524D\u6587\u4EF6\u504F\u79BB\u63A8\u8350\u64AD\u653E\u57FA\u7EBF\uFF0C\u5EFA\u8BAE\u5148\u505A\u672C\u5730\u9884\u5904\u7406\u3002",
    detail: reasons.join("\uFF1B")
  };
}
function formatContainerFormats(containerFormats) {
  return containerFormats.length > 0 ? containerFormats.join(", ") : "unknown";
}
function formatAudioCodecs(audioCodecs) {
  return audioCodecs.length > 0 ? audioCodecs.join(", ") : "none";
}
function resolveContainerFormatsForDisplay(fileName, containerFormats) {
  return resolveContainerFormats(fileName, containerFormats);
}
function isPreferredContainer(containerFormats) {
  return containerFormats.some((format) => preferredContainerFormats.has(format));
}
function normalizeCodecName(codecName) {
  const normalized = codecName.trim().toLowerCase();
  if (hevcSampleEntries.has(normalized)) {
    return "hevc";
  }
  if (h264SampleEntries.has(normalized)) {
    return "h264";
  }
  if (aacSampleEntries.has(normalized)) {
    return "aac";
  }
  return normalized;
}
function normalizeOutputCodecSlug(codecName) {
  const normalized = normalizeCodecName(codecName);
  if (normalized === "hevc") {
    return "hvc1";
  }
  if (normalized === "h264" || normalized === "avc1") {
    return "avc1";
  }
  return normalized.replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "") || "video";
}
function formatVideoCodec(codecName) {
  const normalized = normalizeCodecName(codecName);
  return browserPlayableVideoCodecLabels.get(normalized) ?? codecName;
}
function resolveContainerFormats(fileName, containerFormats) {
  if (containerFormats.length > 0) {
    return containerFormats;
  }
  const extension = fileName.split(".").pop()?.trim().toLowerCase() ?? "";
  switch (extension) {
    case "mkv":
      return ["matroska"];
    case "mp4":
    case "m4v":
      return ["mp4"];
    case "mov":
      return ["mov"];
    case "webm":
      return ["webm"];
    case "avi":
      return ["avi"];
    default:
      return containerFormats;
  }
}

// src/player/browser-ffmpeg-service.ts
var ENCODING_PROFILE = Object.freeze({
  crf: "28",
  preset: "ultrafast",
  audioBitrate: "96k",
  pixelFormat: "yuv420p",
  maxWidth: "1280"
});
var LOCAL_CORE_ASSETS = Object.freeze({
  coreURL: {
    path: "vendor/ffmpeg/ffmpeg-core.js",
    mimeType: "text/javascript"
  },
  wasmURL: {
    path: "vendor/ffmpeg/ffmpeg-core.wasm",
    mimeType: "application/wasm"
  },
  classWorkerURL: {
    path: "vendor/ffmpeg-runtime/worker.js",
    mimeType: "text/javascript"
  }
});
var BrowserFfmpegService = class {
  ffmpeg = new FFmpeg();
  loaded = false;
  coreAssetUrls = null;
  recentLogs = [];
  activeHandlers = null;
  constructor() {
    this.ffmpeg.on("log", ({ message }) => {
      this.recentLogs.push(message);
      if (this.recentLogs.length > 60) {
        this.recentLogs.splice(0, this.recentLogs.length - 60);
      }
      this.activeHandlers?.onLog?.(message);
    });
    this.ffmpeg.on("progress", ({ progress, time }) => {
      this.activeHandlers?.onProgress?.({ progress, time });
    });
  }
  async inspectFile(file, handlers = {}) {
    const fastProbe = await inspectMp4ContainerFromFile(file, handlers) ?? await inspectMatroskaContainerFromFile(file, handlers);
    if (fastProbe) {
      return fastProbe;
    }
    await this.ensureLoaded(handlers);
    const jobKey = crypto.randomUUID();
    const inputPath = `${jobKey}-${sanitizeFileName(file.name)}`;
    const probeOutputPath = `${jobKey}-probe.null`;
    this.activeHandlers = handlers;
    this.recentLogs.length = 0;
    try {
      handlers.onStatusChange?.({
        phase: "writing-input",
        detail: { message: "\u6B63\u5728\u5199\u5165\u5F85\u68C0\u6D4B\u6587\u4EF6\u5230\u6D4F\u89C8\u5668\u672C\u5730\u5185\u5B58\u6587\u4EF6\u7CFB\u7EDF" }
      });
      await this.ffmpeg.writeFile(inputPath, await fetchFile(file));
      handlers.onStatusChange?.({
        phase: "probing",
        detail: { message: "\u6B63\u5728\u89E3\u6790\u5BB9\u5668\u3001\u89C6\u9891\u6D41\u548C\u97F3\u9891\u6D41\u4FE1\u606F" }
      });
      this.recentLogs.length = 0;
      const probe = await inspectMedia(this.ffmpeg, inputPath, probeOutputPath, this.recentLogs);
      return probe;
    } catch (error) {
      throw enrichWithRecentLogs(error, this.recentLogs);
    } finally {
      this.activeHandlers = null;
      await safeDelete(this.ffmpeg, inputPath);
      await safeDelete(this.ffmpeg, probeOutputPath);
    }
  }
  async transcodeFile(file, probe, handlers = {}) {
    await this.ensureLoaded(handlers);
    const strategy = buildMediaTranscodeStrategy(file.name, probe);
    const jobKey = crypto.randomUUID();
    const inputPath = `${jobKey}-${sanitizeFileName(file.name)}`;
    const outputPath = `${jobKey}-${strategy.outputFileName}`;
    this.activeHandlers = handlers;
    this.recentLogs.length = 0;
    try {
      handlers.onStatusChange?.({
        phase: "writing-input",
        detail: { message: "\u6B63\u5728\u5199\u5165\u5F85\u9884\u5904\u7406\u6587\u4EF6" }
      });
      await this.ffmpeg.writeFile(inputPath, await fetchFile(file));
      handlers.onStatusChange?.({
        phase: "transcoding",
        detail: {
          message: describeStrategy(strategy)
        }
      });
      const exitCode = await this.ffmpeg.exec(buildTranscodeCommand(inputPath, outputPath, strategy));
      if (exitCode !== 0) {
        throw new Error(buildCommandFailureMessage("FFmpeg", exitCode, this.recentLogs));
      }
      handlers.onStatusChange?.({
        phase: "finalizing-output",
        detail: { message: "FFmpeg \u5DF2\u5B8C\u6210\u7F16\u7801\uFF0C\u6B63\u5728\u5C01\u53E3 MP4 \u8F93\u51FA" }
      });
      await waitForLogFlush();
      handlers.onStatusChange?.({
        phase: "reading-output",
        detail: { message: "\u6B63\u5728\u8BFB\u53D6\u9884\u5904\u7406\u7ED3\u679C\u5E76\u751F\u6210\u53EF\u64AD\u653E\u6587\u4EF6" }
      });
      const outputData = await this.ffmpeg.readFile(outputPath);
      const outputBytes = normalizeBinaryFileData(outputData);
      if (outputBytes.byteLength === 0) {
        throw new Error("FFmpeg \u8F93\u51FA\u6587\u4EF6\u4E3A\u7A7A\uFF0C\u672A\u751F\u6210\u53EF\u64AD\u653E MP4\u3002");
      }
      const outputBlob = new Blob([copyBytesToArrayBuffer(outputBytes)], { type: "video/mp4" });
      const outputFile = new File([outputBlob], strategy.outputFileName, { type: "video/mp4" });
      handlers.onStatusChange?.({
        phase: "completed",
        detail: { message: `\u9884\u5904\u7406\u5B8C\u6210\uFF0C\u8F93\u51FA ${formatBytes(outputBytes.byteLength)}` }
      });
      return {
        file: outputFile,
        blob: outputBlob,
        strategy,
        probe
      };
    } catch (error) {
      throw enrichWithRecentLogs(error, this.recentLogs);
    } finally {
      this.activeHandlers = null;
      await safeDelete(this.ffmpeg, inputPath);
      await safeDelete(this.ffmpeg, outputPath);
    }
  }
  terminate() {
    this.ffmpeg.terminate();
    this.loaded = false;
    this.coreAssetUrls = null;
  }
  async ensureLoaded(handlers) {
    if (this.loaded) {
      handlers.onStatusChange?.({
        phase: "ready",
        detail: { message: "\u5185\u7F6E FFmpeg Core \u5DF2\u5C31\u7EEA" }
      });
      return;
    }
    handlers.onStatusChange?.({
      phase: "loading-core",
      detail: { message: "\u6B63\u5728\u88C5\u8F7D\u6269\u5C55\u5185\u7F6E FFmpeg Core" }
    });
    if (!this.coreAssetUrls) {
      this.coreAssetUrls = await loadLocalCoreAssetUrls();
    }
    await this.ffmpeg.load(this.coreAssetUrls);
    this.loaded = true;
    handlers.onStatusChange?.({
      phase: "ready",
      detail: { message: "\u5185\u7F6E FFmpeg Core \u88C5\u8F7D\u5B8C\u6210" }
    });
  }
};
async function inspectMp4ContainerFromFile(file, handlers) {
  if (!hasMp4LikeExtension(file.name)) {
    return null;
  }
  handlers.onStatusChange?.({
    phase: "probing",
    detail: { message: "\u6B63\u5728\u5FEB\u901F\u8BFB\u53D6 MP4 \u5143\u6570\u636E" }
  });
  const maxScanBytes = Math.min(file.size, 16 * 1024 * 1024);
  const headBytes = new Uint8Array(await file.slice(0, maxScanBytes).arrayBuffer());
  let probe = parseMp4Probe(headBytes);
  if (probe) {
    return probe;
  }
  if (file.size <= maxScanBytes) {
    return null;
  }
  const tailStart = Math.max(0, file.size - maxScanBytes);
  const tailBytes = new Uint8Array(await file.slice(tailStart, file.size).arrayBuffer());
  probe = parseMp4ProbeFromParts(headBytes, tailBytes);
  return probe;
}
async function inspectMatroskaContainerFromFile(file, handlers) {
  const extension = file.name.split(".").pop()?.trim().toLowerCase() ?? "";
  if (extension !== "mkv" && extension !== "webm") {
    return null;
  }
  handlers.onStatusChange?.({
    phase: "probing",
    detail: { message: "正在快速读取 MKV/WebM 轨道元数据" }
  });
  const scanBytes = new Uint8Array(await file.slice(0, Math.min(file.size, 8 * 1024 * 1024)).arrayBuffer());
  const tracksPattern = [22, 84, 174, 107];
  let searchOffset = 0;
  while (searchOffset < scanBytes.byteLength) {
    const tracksOffset = findBytePattern(scanBytes, tracksPattern, searchOffset);
    if (tracksOffset < 0) {
      break;
    }
    searchOffset = tracksOffset + 1;
    const tracksSize = readEbmlVariableInteger(scanBytes, tracksOffset + tracksPattern.length, true);
    if (!tracksSize) {
      continue;
    }
    const tracksStart = tracksOffset + tracksPattern.length + tracksSize.length;
    const tracksEnd = Math.min(scanBytes.byteLength, tracksStart + tracksSize.value);
    const streams = [];
    let offset = tracksStart;
    while (offset < tracksEnd) {
      const element = readEbmlElement(scanBytes, offset, tracksEnd);
      if (!element) {
        break;
      }
      if (element.id === 174) {
        const stream = parseMatroskaTrackEntry(scanBytes, element.dataStart, element.end, streams.length);
        if (stream) {
          streams.push(stream);
        }
      }
      offset = element.end;
    }
    if (streams.some((stream) => stream.codecType === "video")) {
      return { containerFormats: [extension === "webm" ? "webm" : "matroska"], streams };
    }
  }
  return null;
}
function findBytePattern(bytes, pattern, fromOffset = 0) {
  outer: for (let offset = fromOffset; offset <= bytes.byteLength - pattern.length; offset += 1) {
    for (let index = 0; index < pattern.length; index += 1) {
      if (bytes[offset + index] !== pattern[index]) {
        continue outer;
      }
    }
    return offset;
  }
  return -1;
}
function readEbmlVariableInteger(bytes, offset, stripMarker) {
  if (offset >= bytes.byteLength || bytes[offset] === 0) {
    return null;
  }
  let length = 1;
  let marker = 128;
  while (length <= 8 && (bytes[offset] & marker) === 0) {
    length += 1;
    marker >>= 1;
  }
  if (length > 8 || offset + length > bytes.byteLength) {
    return null;
  }
  let value = stripMarker ? bytes[offset] & marker - 1 : bytes[offset];
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + bytes[offset + index];
  }
  return { value, length };
}
function readEbmlElement(bytes, offset, limit) {
  const id = readEbmlVariableInteger(bytes, offset, false);
  if (!id) {
    return null;
  }
  const size = readEbmlVariableInteger(bytes, offset + id.length, true);
  if (!size || !Number.isSafeInteger(size.value)) {
    return null;
  }
  const dataStart = offset + id.length + size.length;
  const end = dataStart + size.value;
  if (end > limit || end <= offset) {
    return null;
  }
  return { id: id.value, dataStart, end };
}
function readEbmlUnsigned(bytes, start, end) {
  let value = 0;
  for (let offset = start; offset < end; offset += 1) {
    value = value * 256 + bytes[offset];
  }
  return value;
}
function parseMatroskaTrackEntry(bytes, start, end, index) {
  let offset = start;
  let trackType = null;
  let codecId = null;
  let width;
  let height;
  while (offset < end) {
    const element = readEbmlElement(bytes, offset, end);
    if (!element) {
      break;
    }
    if (element.id === 131) {
      trackType = readEbmlUnsigned(bytes, element.dataStart, element.end);
    } else if (element.id === 134) {
      codecId = readAscii(bytes, element.dataStart, element.end);
    } else if (element.id === 224) {
      let videoOffset = element.dataStart;
      while (videoOffset < element.end) {
        const videoElement = readEbmlElement(bytes, videoOffset, element.end);
        if (!videoElement) {
          break;
        }
        if (videoElement.id === 176) {
          width = readEbmlUnsigned(bytes, videoElement.dataStart, videoElement.end);
        } else if (videoElement.id === 186) {
          height = readEbmlUnsigned(bytes, videoElement.dataStart, videoElement.end);
        }
        videoOffset = videoElement.end;
      }
    }
    offset = element.end;
  }
  if (!codecId || trackType !== 1 && trackType !== 2) {
    return null;
  }
  const codecMap = {
    "V_MPEG4/ISO/AVC": "h264",
    "V_MPEGH/ISO/HEVC": "hevc",
    "V_VP9": "vp9",
    "V_AV1": "av1",
    "A_AAC": "aac",
    "A_OPUS": "opus",
    "A_VORBIS": "vorbis",
    "A_AC3": "ac3",
    "A_EAC3": "eac3",
    "A_DTS": "dts"
  };
  return {
    codecType: trackType === 1 ? "video" : "audio",
    codecName: codecMap[codecId] ?? codecId.toLowerCase(),
    index,
    width,
    height
  };
}
function hasMp4LikeExtension(fileName) {
  const extension = fileName.split(".").pop()?.trim().toLowerCase() ?? "";
  return extension === "mp4" || extension === "m4v" || extension === "mov";
}
function parseMp4Probe(bytes) {
  const rootBoxes = parseMp4Boxes(bytes, 0, bytes.byteLength);
  const ftyp = rootBoxes.find((box) => box.type === "ftyp");
  const moov = rootBoxes.find((box) => box.type === "moov");
  if (!ftyp || !moov) {
    return null;
  }
  return buildMp4Probe(bytes, ftyp, bytes, moov);
}
function parseMp4ProbeFromParts(headBytes, tailBytes) {
  const headBoxes = parseMp4Boxes(headBytes, 0, headBytes.byteLength);
  const ftyp = headBoxes.find((box) => box.type === "ftyp");
  const moov = findMp4BoxInSlice(tailBytes, "moov");
  if (!ftyp || !moov) {
    return null;
  }
  return buildMp4Probe(headBytes, ftyp, tailBytes, moov);
}
function buildMp4Probe(ftypBytes, ftyp, moovBytes, moov) {
  const majorBrand = readAscii(ftypBytes, ftyp.payloadStart, Math.min(ftyp.payloadStart + 4, ftyp.end));
  const compatibleBrands = /* @__PURE__ */ new Set();
  for (let offset = ftyp.payloadStart + 8; offset + 4 <= ftyp.end; offset += 4) {
    compatibleBrands.add(readAscii(ftypBytes, offset, offset + 4));
  }
  const streams = parseMp4Streams(moovBytes, moov.payloadStart, moov.end);
  if (!streams.some((stream) => stream.codecType === "video")) {
    return null;
  }
  return {
    containerFormats: resolveMp4ContainerFormats(majorBrand, compatibleBrands),
    streams
  };
}
function findMp4BoxInSlice(bytes, expectedType) {
  const typeBytes = Array.from(expectedType, (character) => character.charCodeAt(0));
  for (let typeOffset = bytes.byteLength - typeBytes.length; typeOffset >= 4; typeOffset -= 1) {
    if (!typeBytes.every((value, index) => bytes[typeOffset + index] === value)) {
      continue;
    }
    const boxStart = typeOffset - 4;
    const size32 = readUint32(bytes, boxStart);
    let headerSize = 8;
    let boxSize = size32;
    if (size32 === 1) {
      if (boxStart + 16 > bytes.byteLength) {
        continue;
      }
      boxSize = readUint64AsNumber(bytes, boxStart + 8);
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = bytes.byteLength - boxStart;
    }
    if (!Number.isSafeInteger(boxSize) || boxSize < headerSize || boxStart + boxSize > bytes.byteLength) {
      continue;
    }
    return {
      type: expectedType,
      start: boxStart,
      end: boxStart + boxSize,
      payloadStart: boxStart + headerSize
    };
  }
  return null;
}
function parseMp4Boxes(bytes, start, end) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size32 = readUint32(bytes, offset);
    const type = readAscii(bytes, offset + 4, offset + 8);
    let headerSize = 8;
    let boxSize = size32;
    if (size32 === 1) {
      if (offset + 16 > end) {
        break;
      }
      boxSize = readUint64AsNumber(bytes, offset + 8);
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = end - offset;
    }
    if (boxSize < headerSize || offset + boxSize > end) {
      break;
    }
    boxes.push({
      type,
      start: offset,
      end: offset + boxSize,
      payloadStart: offset + headerSize
    });
    offset += boxSize;
  }
  return boxes;
}
function parseMp4Streams(bytes, moovStart, moovEnd) {
  const streams = [];
  const tracks = parseMp4Boxes(bytes, moovStart, moovEnd).filter((box) => box.type === "trak");
  for (const track of tracks) {
    const handlerType = findMp4HandlerType(bytes, track);
    const stsd = findNestedMp4Box(bytes, track, ["mdia", "minf", "stbl", "stsd"]);
    if (!handlerType || !stsd || stsd.payloadStart + 16 > stsd.end) {
      continue;
    }
    const sampleEntryStart = stsd.payloadStart + 8;
    const sampleEntrySize = readUint32(bytes, sampleEntryStart);
    if (sampleEntrySize < 8 || sampleEntryStart + sampleEntrySize > stsd.end) {
      continue;
    }
    const sampleEntryType = readAscii(bytes, sampleEntryStart + 4, sampleEntryStart + 8);
    if (handlerType === "vide") {
      streams.push({
        codecType: "video",
        codecName: sampleEntryType,
        index: streams.length,
        width: readUint16(bytes, sampleEntryStart + 32),
        height: readUint16(bytes, sampleEntryStart + 34)
      });
    } else if (handlerType === "soun") {
      streams.push({
        codecType: "audio",
        codecName: sampleEntryType,
        index: streams.length
      });
    }
  }
  return streams;
}
function findMp4HandlerType(bytes, track) {
  const hdlr = findNestedMp4Box(bytes, track, ["mdia", "hdlr"]);
  if (!hdlr || hdlr.payloadStart + 12 > hdlr.end) {
    return null;
  }
  return readAscii(bytes, hdlr.payloadStart + 8, hdlr.payloadStart + 12);
}
function findNestedMp4Box(bytes, root, path) {
  let current = root;
  for (const type of path) {
    if (!current) {
      return null;
    }
    current = parseMp4Boxes(bytes, current.payloadStart, current.end).find((box) => box.type === type) ?? null;
  }
  return current;
}
function resolveMp4ContainerFormats(majorBrand, compatibleBrands) {
  const brands = /* @__PURE__ */ new Set([majorBrand, ...compatibleBrands]);
  if (brands.has("qt  ")) {
    return ["mov"];
  }
  return ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"];
}
function readUint16(bytes, offset) {
  if (offset + 2 > bytes.byteLength) {
    return 0;
  }
  return bytes[offset] << 8 | bytes[offset + 1];
}
function readUint32(bytes, offset) {
  if (offset + 4 > bytes.byteLength) {
    return 0;
  }
  return bytes[offset] * 16777216 + (bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0;
}
function readUint64AsNumber(bytes, offset) {
  const high = readUint32(bytes, offset);
  const low = readUint32(bytes, offset + 4);
  return high * 4294967296 + low;
}
function readAscii(bytes, start, end) {
  let value = "";
  for (let offset = start; offset < end && offset < bytes.byteLength; offset += 1) {
    value += String.fromCharCode(bytes[offset]);
  }
  return value;
}
function describeStrategy(strategy) {
  const videoStep = strategy.videoAction === "copy" ? `\u89C6\u9891\u76F4\u63A5\u590D\u7528(${strategy.videoCodec})` : `\u89C6\u9891\u8F6C H.264/AVC`;
  const audioStep = strategy.audioAction === "copy" ? `\u97F3\u9891\u76F4\u63A5\u590D\u7528(${strategy.audioCodecs.length > 0 ? strategy.audioCodecs.join(", ") : "none"})` : `\u97F3\u9891\u8F6C AAC`;
  const containerStep = strategy.containerAction === "copy" ? "\u6CBF\u7528 MP4/MOV \u57FA\u7EBF" : "\u91CD\u5C01\u88C5\u4E3A MP4";
  return `${containerStep}\uFF1B${videoStep}\uFF1B${audioStep}`;
}
function buildTranscodeCommand(inputPath, outputPath, strategy) {
  const command = ["-i", inputPath, "-map", "0:v:0", "-map", "0:a?"];
  if (strategy.videoAction === "copy") {
    command.push("-c:v", "copy");
  } else {
    command.push(
      "-c:v",
      "libx264",
      "-preset",
      ENCODING_PROFILE.preset,
      "-crf",
      ENCODING_PROFILE.crf,
      "-vf",
      `scale='min(${ENCODING_PROFILE.maxWidth},iw)':-2`,
      "-pix_fmt",
      ENCODING_PROFILE.pixelFormat
    );
  }
  if (strategy.videoAction === "transcode") {
    command.push("-tag:v", "avc1");
  } else if (strategy.videoCodec === "hevc") {
    command.push("-tag:v", "hvc1");
  }
  if (strategy.audioAction === "copy") {
    command.push("-c:a", "copy");
  } else {
    command.push("-c:a", "aac", "-ac", "2", "-b:a", ENCODING_PROFILE.audioBitrate);
  }
  command.push("-sn", "-dn", "-movflags", "+faststart", outputPath);
  return command;
}
async function inspectMedia(ffmpeg, inputPath, probeOutputPath, recentLogs) {
  const exitCode = await ffmpeg.exec([
    "-v",
    "info",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c",
    "copy",
    "-t",
    "0.1",
    "-f",
    "null",
    probeOutputPath
  ]);
  if (exitCode !== 0) {
    throw new Error(buildCommandFailureMessage("probe(ffmpeg)", exitCode, recentLogs));
  }
  await waitForLogFlush();
  return parseProbeFromLogs(recentLogs);
}
function parseProbeFromLogs(logs) {
  const inputLine = logs.find((line) => line.startsWith("Input #0,"));
  const videoLines = logs.filter((line) => line.includes("Video:"));
  const audioLines = logs.filter((line) => line.includes("Audio:"));
  if (videoLines.length === 0) {
    throw new Error(`\u65E0\u6CD5\u4ECE FFmpeg \u65E5\u5FD7\u4E2D\u89E3\u6790\u89C6\u9891\u6D41\u4FE1\u606F\u3002
Recent logs:
${logs.slice(-20).join("\n")}`);
  }
  const containerFormats = inputLine?.match(/^Input #0,\s+(.+),\s+from\b/)?.[1]?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  const streams = videoLines.map((line, index) => {
    const codecName = line.match(/Video:\s+([^\s,(]+)/)?.[1];
    const width = line.match(/(\d{2,5})x(\d{2,5})/);
    if (!codecName || !width) {
      throw new Error(`\u65E0\u6CD5\u4ECE FFmpeg \u65E5\u5FD7\u4E2D\u89E3\u6790\u89C6\u9891\u7F16\u7801\u8BE6\u60C5\u3002
Recent logs:
${logs.slice(-20).join("\n")}`);
    }
    return {
      codecType: "video",
      codecName,
      index,
      width: Number.parseInt(width[1], 10),
      height: Number.parseInt(width[2], 10)
    };
  });
  audioLines.forEach((line, index) => {
    const codecName = line.match(/Audio:\s+([^\s,(]+)/)?.[1];
    if (!codecName) {
      return;
    }
    streams.push({
      codecType: "audio",
      codecName,
      index
    });
  });
  return {
    containerFormats,
    streams
  };
}
async function loadLocalCoreAssetUrls() {
  const [coreResponse, wasmResponse, classWorkerResponse] = await Promise.all([
    fetch(chrome.runtime.getURL(LOCAL_CORE_ASSETS.coreURL.path), { cache: "force-cache" }),
    fetch(chrome.runtime.getURL(LOCAL_CORE_ASSETS.wasmURL.path), { cache: "force-cache" }),
    fetch(chrome.runtime.getURL(LOCAL_CORE_ASSETS.classWorkerURL.path), { cache: "force-cache" })
  ]);
  if (!coreResponse.ok) {
    throw new Error(`\u65E0\u6CD5\u52A0\u8F7D\u6269\u5C55\u5185\u7F6E FFmpeg Core \u8D44\u6E90\uFF1A${LOCAL_CORE_ASSETS.coreURL.path} (${coreResponse.status})`);
  }
  if (!wasmResponse.ok) {
    throw new Error(`\u65E0\u6CD5\u52A0\u8F7D\u6269\u5C55\u5185\u7F6E FFmpeg Core \u8D44\u6E90\uFF1A${LOCAL_CORE_ASSETS.wasmURL.path} (${wasmResponse.status})`);
  }
  if (!classWorkerResponse.ok) {
    throw new Error(
      `\u65E0\u6CD5\u52A0\u8F7D\u6269\u5C55\u5185\u7F6E FFmpeg Runtime Worker\uFF1A${LOCAL_CORE_ASSETS.classWorkerURL.path} (${classWorkerResponse.status})`
    );
  }
  return {
    coreURL: chrome.runtime.getURL(LOCAL_CORE_ASSETS.coreURL.path),
    wasmURL: chrome.runtime.getURL(LOCAL_CORE_ASSETS.wasmURL.path),
    classWorkerURL: chrome.runtime.getURL(LOCAL_CORE_ASSETS.classWorkerURL.path)
  };
}
async function safeDelete(ffmpeg, filePath) {
  try {
    await ffmpeg.deleteFile(filePath);
  } catch {
    return;
  }
}
function sanitizeFileName(fileName) {
  return fileName.replaceAll(/[^\w.-]+/g, "_");
}
function buildCommandFailureMessage(commandName, exitCode, logs) {
  const tail = logs.slice(-12).join("\n");
  return `${commandName} exited with code ${exitCode}${tail ? `
Recent logs:
${tail}` : ""}`;
}
function normalizeBinaryFileData(outputData) {
  return outputData instanceof Uint8Array ? outputData : new TextEncoder().encode(outputData);
}
function copyBytesToArrayBuffer(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
function formatBytes(byteLength) {
  if (byteLength < 1024) {
    return `${byteLength} B`;
  }
  if (byteLength < 1024 * 1024) {
    return `${(byteLength / 1024).toFixed(1)} KiB`;
  }
  if (byteLength < 1024 * 1024 * 1024) {
    return `${(byteLength / 1024 / 1024).toFixed(1)} MiB`;
  }
  return `${(byteLength / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
function enrichWithRecentLogs(error, recentLogs) {
  if (error instanceof Error && !error.message.includes("Recent logs:")) {
    return new Error(`${error.message}
Recent logs:
${recentLogs.slice(-12).join("\n")}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}
function waitForLogFlush() {
  return new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
}

// src/shared/theme.ts
var playerThemeStorageKey = "reader-sync-player-theme";
function sanitizeReaderSyncThemeMode(value) {
  return value === "light" || value === "dark" || value === "auto" ? value : "auto";
}
function resolveReaderSyncThemeMode(mode, prefersDark) {
  if (mode === "auto") {
    return prefersDark ? "dark" : "light";
  }
  return mode;
}

// src/player/player.ts
var logger = createLogger("player");
var supportedSubtitleExtensions = /* @__PURE__ */ new Set(["ass", "ssa", "srt", "vtt"]);
var supportedVideoExtensions = /* @__PURE__ */ new Set(["mp4", "mkv"]);
var themeModeOrder = ["auto", "light", "dark"];
function requireElement(selector) {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}
var elements = {
  exportLogs: requireElement("#export-logs"),
  themeToggle: requireElement("#theme-toggle"),
  readerStatusPill: requireElement("#reader-status-pill"),
  readerStatusText: requireElement("#reader-status-text"),
  readerContextValue: requireElement("#reader-context-value"),
  automationReaderCard: requireElement('[data-automation-state="reader"]'),
  automationSubtitleCard: requireElement('[data-automation-state="subtitle"]'),
  automationVideoCard: requireElement('[data-automation-state="video"]'),
  automationVideoStatus: requireElement("#automation-video-status"),
  subtitleView: requireElement("#subtitle-view"),
  videoView: requireElement("#video-view"),
  playerView: requireElement("#player-view"),
  mediaLibraryCard: requireElement(".media-library-card"),
  mediaLibraryStatus: requireElement("#media-library-status"),
  mediaLibraryMatch: requireElement("#media-library-match"),
  libraryProgress: requireElement("#library-progress"),
  chooseLibraryFolder: requireElement("#choose-library-folder"),
  rescanLibrary: requireElement("#rescan-library"),
  cancelLibraryScan: requireElement("#cancel-library-scan"),
  libraryPreprocess: requireElement("#library-preprocess"),
  libraryVariant: requireElement("#library-variant"),
  steps: Array.from(document.querySelectorAll(".step")),
  localSubtitleChoice: requireElement('[data-subtitle-choice="local"]'),
  onlineSubtitleChoice: requireElement('[data-subtitle-choice="online"]'),
  subtitleDrop: requireElement("#subtitle-drop"),
  subtitleFile: requireElement("#subtitle-file"),
  localSubtitleState: requireElement("#local-subtitle-state"),
  subtitleFileState: requireElement("#subtitle-file-state"),
  subtitleResultTitle: requireElement("#subtitle-result-title"),
  subtitleResultDetail: requireElement("#subtitle-result-detail"),
  toVideo: requireElement("#to-video"),
  backSubtitle: requireElement("#back-subtitle"),
  videoSubtitleChip: requireElement("#video-subtitle-chip"),
  videoDrop: requireElement("#video-drop"),
  videoFile: requireElement("#video-file"),
  videoDropTitle: requireElement("#video-drop-title"),
  videoDropDesc: requireElement("#video-drop-desc"),
  videoName: requireElement("#video-name"),
  videoContainer: requireElement("#video-container"),
  videoCodec: requireElement("#video-codec"),
  audioCodec: requireElement("#audio-codec"),
  videoPlan: requireElement("#video-plan"),
  processingBox: requireElement("#processing-box"),
  processingProgress: requireElement("#processing-progress"),
  processingText: requireElement("#processing-text"),
  riskPlay: requireElement("#risk-play"),
  processPlay: requireElement("#process-play"),
  playerWrap: requireElement("#player-wrap"),
  changeEpisode: requireElement("#change-episode"),
  playerNote: requireElement("#player-note"),
  video: requireElement("#video"),
  playToggle: requireElement("#play-toggle"),
  timeReadout: requireElement("#time-readout"),
  playbackRateTrigger: requireElement("#playback-rate-trigger"),
  playbackRateValue: requireElement("#playback-rate-value"),
  playbackRateOptions: requireElement("#playback-rate-options"),
  playbackRateOptionButtons: Array.from(document.querySelectorAll(".rate-option")),
  expandToggle: requireElement("#expand-toggle"),
  pipToggle: requireElement("#pip-toggle"),
  playerStatus: requireElement("#player-status"),
  playerVideoPill: requireElement("#player-video-pill"),
  playerSubtitlePill: requireElement("#player-subtitle-pill"),
  playerReaderPill: requireElement("#player-reader-pill"),
  trainingRouteCard: requireElement("#training-route-card"),
  trainingRouteTitle: requireElement("#training-route-title"),
  trainingRouteStatus: requireElement("#training-route-status"),
  trainingTarget: requireElement("#training-target"),
  trainingFilmstrip: requireElement("#training-filmstrip"),
  trainingRestartPass: requireElement("#training-restart-pass"),
  trainingUndo: requireElement("#training-undo"),
  trainingCompletePass: requireElement("#training-complete-pass"),
  trainingSummary: requireElement("#training-summary"),
  trainingEnabled: requireElement("#training-enabled"),
  trainingDefaultPlan: requireElement("#training-default-plan"),
  trainingCustomCounts: requireElement("#training-custom-counts"),
  trainingCustomBilingual: requireElement("#training-custom-bilingual"),
  trainingCustomEnglish: requireElement("#training-custom-english"),
  trainingCustomClean: requireElement("#training-custom-clean"),
  trainingEpisodePlan: requireElement("#training-episode-plan"),
  trainingPauseToggle: requireElement("#training-pause-toggle"),
  trainingResetEpisode: requireElement("#training-reset-episode"),
  seasonProgressSummary: requireElement("#season-progress-summary"),
  seasonProgressList: requireElement("#season-progress-list"),
  riskDialog: requireElement("#risk-dialog"),
  cancelRisk: requireElement("#cancel-risk"),
  confirmRisk: requireElement("#confirm-risk"),
  feedbackDialog: requireElement("#feedback-dialog"),
  feedbackForm: requireElement("#feedback-form"),
  feedbackDescription: requireElement("#feedback-description"),
  feedbackIncludeScreenshot: requireElement("#feedback-include-screenshot"),
  feedbackStatus: requireElement("#feedback-status"),
  cancelFeedback: requireElement("#cancel-feedback"),
  confirmFeedback: requireElement("#confirm-feedback")
};
var browserFfmpegService = new BrowserFfmpegService();
var playerPort = null;
var playerPortReconnectTimer = null;
var playerPageUnloading = false;
var connectedTabs = [];
var activePageTabId = null;
var pageContext = null;
var articleSnapshot = null;
var articleSnapshotError = null;
var subtitleIndex = [];
var subtitleIndexLoaded = false;
var selectedSubtitleMode = "local";
var localSubtitleMatch = null;
var loadedSubtitleDocument = null;
var currentRuntimeBuild = null;
var runtimeBuildInFlight = false;
var runtimeBuildFingerprint = null;
var runtimeBuildRequestedFingerprint = null;
var runtimeBuildFailedFingerprint = null;
var runtimeBuildToken = 0;
var articleSnapshotRequestIssuedAt = null;
var articleSnapshotLastRequestedAt = 0;
var manifest = null;
var transcriptSegmentsByIndex = /* @__PURE__ */ new Map();
var articleParagraphsByIndex = /* @__PURE__ */ new Map();
var sourceVideoFile = null;
var sourceVideoProbe = null;
var sourceVideoAssessment = null;
var sourceVideoStrategy = null;
var sourceVideoInspectionError = null;
var videoObjectUrl = null;
var processedVideoFile = null;
var processedVideoObjectUrl = null;
var currentVideoVariant = null;
var videoInspectionBusy = false;
var videoTranscodeBusy = false;
var videoInspectionToken = 0;
var lastBroadcastAt = 0;
var playerThemeMode = "auto";
var themeMediaQuery = null;
var compactLayoutRaf = null;
var feedbackExportBusy = false;
var mediaLibraryDirectoryHandle = null;
var mediaLibraryEntries = [];
var currentMediaLibraryMatch = null;
var mediaLibraryBusy = false;
var mediaLibraryPermissionReady = false;
var mediaLibraryCancelRequested = false;
var mediaLibraryAutoLoadBusy = false;
var mediaLibraryPendingRequest = null;
var loadedMediaLibraryEntryId = null;
var desiredMediaLibraryEntryId = null;
var mediaLibraryLoadGeneration = 0;
var mediaLibrarySettings = { preprocess: true, preferredVariant: "english" };
var activeEpisodeKey = null;
var episodeGeneration = 0;
var readerDiscoveryTimer = null;
var readerDiscoveryAttempt = 0;
var readerReloadFallbackUsed = false;
var lastReaderResumeRefreshAt = 0;
var TRAINING_SETTINGS_KEY = "readerSyncTrainingSettingsV1";
var TRAINING_RECORDS_KEY = "readerSyncTrainingRecordsV1";
var PLAYBACK_BOOKMARKS_KEY = "readerSyncPlaybackBookmarksV1";
var trainingSettings = createDefaultTrainingSettings();
var trainingRecords = {};
var playbackBookmarks = {};
var playbackBookmarkSaveTimer = null;
var playbackRestoreGeneration = 0;
var playbackRestoreBusy = false;
var trainingCompletionBusy = false;
var videoSourceChangeBusy = false;
setReaderSyncLogSink((entry) => {
  try {
    chrome.runtime.sendMessage({ type: "LOG_ENTRY", payload: entry });
  } catch {
  }
}, { flushExisting: false });
function clearPlayerPortReconnectTimer() {
  if (playerPortReconnectTimer !== null) {
    window.clearTimeout(playerPortReconnectTimer);
    playerPortReconnectTimer = null;
  }
}
function schedulePlayerPortReconnect(delayMs = 280) {
  if (playerPortReconnectTimer !== null) {
    return;
  }
  playerPortReconnectTimer = window.setTimeout(() => {
    playerPortReconnectTimer = null;
    connectPlayerPort();
  }, delayMs);
}
function connectPlayerPort() {
  if (playerPort) {
    return playerPort;
  }
  clearPlayerPortReconnectTimer();
  const nextPort = chrome.runtime.connect({ name: PLAYER_PORT_NAME });
  playerPort = nextPort;
  nextPort.onMessage.addListener(handleRuntimeMessage);
  nextPort.onDisconnect.addListener(() => {
    if (playerPort === nextPort) {
      playerPort = null;
    }
    if (!playerPageUnloading) {
      schedulePlayerPortReconnect();
    }
  });
  return nextPort;
}
function resolvePlayerTheme(mode) {
  const prefersDark = themeMediaQuery?.matches ?? window.matchMedia("(prefers-color-scheme: dark)").matches;
  return resolveReaderSyncThemeMode(mode, prefersDark);
}
function applyPlayerThemeMode(mode) {
  playerThemeMode = mode;
  const resolvedTheme = resolvePlayerTheme(mode);
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.themeMode = mode;
  elements.themeToggle.textContent = mode === "auto" ? "\u81EA" : mode === "light" ? "\u65E5" : "\u591C";
  const label = mode === "auto" ? "\u5F53\u524D\u8DDF\u968F\u6D4F\u89C8\u5668\uFF0C\u70B9\u51FB\u5207\u6362\u5230\u65E5\u95F4\u4E3B\u9898" : mode === "light" ? "\u5F53\u524D\u65E5\u95F4\u4E3B\u9898\uFF0C\u70B9\u51FB\u5207\u6362\u5230\u591C\u95F4\u4E3B\u9898" : "\u5F53\u524D\u591C\u95F4\u4E3B\u9898\uFF0C\u70B9\u51FB\u5207\u6362\u5230\u81EA\u52A8\u4E3B\u9898";
  elements.themeToggle.setAttribute("aria-label", label);
  elements.themeToggle.title = label;
}
async function loadPlayerTheme() {
  themeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  themeMediaQuery.addEventListener("change", () => {
    if (playerThemeMode === "auto") {
      applyPlayerThemeMode("auto");
    }
  });
  const stored = await chrome.storage.local.get(playerThemeStorageKey);
  applyPlayerThemeMode(sanitizeReaderSyncThemeMode(stored[playerThemeStorageKey]));
}
async function cyclePlayerThemeMode() {
  const currentIndex = themeModeOrder.indexOf(playerThemeMode);
  const nextThemeMode = themeModeOrder[(currentIndex + 1) % themeModeOrder.length] ?? "auto";
  applyPlayerThemeMode(nextThemeMode);
  await chrome.storage.local.set({ [playerThemeStorageKey]: nextThemeMode });
}
function postRuntimeMessage(message) {
  const port = connectPlayerPort();
  try {
    port.postMessage(message);
    return true;
  } catch (error) {
    logger.warn("Player port postMessage failed", { type: message.type, error });
    if (playerPort === port) {
      playerPort = null;
    }
    schedulePlayerPortReconnect();
    return false;
  }
}
function setView(stepName) {
  elements.playerView.classList.add("is-active");
  document.body.dataset.workflowState = stepName;
  scheduleCompactLayoutCheck();
}
function updateAutomationCard(card, state) {
  card.classList.toggle("is-ready", state === "ready");
  card.classList.toggle("is-busy", state === "busy");
  card.classList.toggle("is-error", state === "error");
}
function stopReaderDiscoveryWatchdog() {
  if (readerDiscoveryTimer !== null) {
    window.clearTimeout(readerDiscoveryTimer);
    readerDiscoveryTimer = null;
  }
}
function scheduleReaderDiscoveryWatchdog(options) {
  const reset = options?.reset === true;
  const allowReload = options?.allowReload !== false;
  if (reset) {
    stopReaderDiscoveryWatchdog();
    readerDiscoveryAttempt = 0;
    if (options?.resetReloadFallback === true) {
      readerReloadFallbackUsed = false;
    }
  }
  if (pageContext || connectedTabs.length > 1 || readerDiscoveryTimer !== null) {
    return;
  }
  const delays = [0, 600, 1500, 3e3, 8e3, 12e3];
  const delay = delays[Math.min(readerDiscoveryAttempt, delays.length - 1)];
  readerDiscoveryTimer = window.setTimeout(() => {
    readerDiscoveryTimer = null;
    if (pageContext || connectedTabs.length > 1) {
      return;
    }
    const shouldReloadOnce = allowReload && !readerReloadFallbackUsed && readerDiscoveryAttempt >= 3;
    if (shouldReloadOnce) {
      readerReloadFallbackUsed = true;
      postRuntimeMessage({ type: "REFRESH_READER_TABS" });
    } else {
      postRuntimeMessage({ type: "REQUEST_CONNECTED_TABS" });
      postRuntimeMessage({ type: "REQUEST_ACTIVE_PAGE_CONTEXT" });
    }
    readerDiscoveryAttempt += 1;
    scheduleReaderDiscoveryWatchdog({ allowReload });
  }, delay);
}
function refreshReaderConnectionAfterResume() {
  const now = Date.now();
  if (now - lastReaderResumeRefreshAt < 500) {
    return;
  }
  lastReaderResumeRefreshAt = now;
  postRuntimeMessage({ type: "REQUEST_CONNECTED_TABS" });
  postRuntimeMessage({ type: "REQUEST_ACTIVE_PAGE_CONTEXT" });
  postRuntimeMessage({ type: "REQUEST_ACTIVE_ARTICLE_SNAPSHOT" });
}
function formatPlaybackRate(rate) {
  return `${Number.isInteger(rate) ? rate.toFixed(1) : String(rate)}x`;
}
function setPlaybackRate(rate) {
  const normalizedRate = clamp(rate, 0.5, 2);
  elements.video.playbackRate = normalizedRate;
  elements.playbackRateValue.textContent = formatPlaybackRate(normalizedRate);
  for (const option of elements.playbackRateOptionButtons) {
    const optionRate = Number(option.dataset.rate);
    const active = Math.abs(optionRate - normalizedRate) < 1e-3;
    option.classList.toggle("is-active", active);
    option.setAttribute("aria-selected", active ? "true" : "false");
  }
}
function setRateMenuOpen(open) {
  elements.playbackRateOptions.classList.toggle("is-open", open);
  elements.playbackRateTrigger.setAttribute("aria-expanded", open ? "true" : "false");
}
function resolveViewportWidth() {
  return Math.min(window.innerWidth, window.visualViewport?.width ?? window.innerWidth);
}
function updateCompactLayoutMode() {
  compactLayoutRaf = null;
  const viewportWidth = resolveViewportWidth();
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const portraitLike = viewportWidth > 0 && viewportHeight > viewportWidth;
  const contentOverflow = document.documentElement.scrollWidth > Math.ceil(document.documentElement.clientWidth + 1);
  document.body.classList.toggle("layout-compact", viewportWidth <= 920 || portraitLike || contentOverflow);
}
function scheduleCompactLayoutCheck() {
  if (compactLayoutRaf !== null) {
    return;
  }
  compactLayoutRaf = window.requestAnimationFrame(updateCompactLayoutMode);
}
function fileExtension(fileName) {
  const extension = fileName.split(".").pop()?.trim().toLowerCase() ?? "";
  return extension;
}
function normalizeTextToken(value) {
  return value.toLowerCase().replace(/&/g, " and ").replace(/\b(the|one|with|where|after|and|part|friends|episode|season)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
function extractEpisodeToken(value) {
  const seasonEpisodeMatch = value.match(/S(\d{1,2})E(\d{1,2})/i);
  if (seasonEpisodeMatch) {
    return `S${seasonEpisodeMatch[1].padStart(2, "0")}E${seasonEpisodeMatch[2].padStart(2, "0")}`;
  }
  const compactSeasonEpisodeMatch = value.match(/(?:^|[^a-z0-9])S(?:E)?(\d{1,2})[ ._-]+(\d{1,2})(?=[^0-9]|$)/i);
  if (compactSeasonEpisodeMatch) {
    return `S${compactSeasonEpisodeMatch[1].padStart(2, "0")}E${compactSeasonEpisodeMatch[2].padStart(2, "0")}`;
  }
  const verboseMatch = value.match(/(?:season|第)\s*(\d{1,2}).{0,6}(?:episode|集|e)\s*(\d{1,2})/i);
  if (verboseMatch) {
    return `S${verboseMatch[1].padStart(2, "0")}E${verboseMatch[2].padStart(2, "0")}`;
  }
  return null;
}
function buildReaderEpisodeKey(context) {
  if (!context) {
    return null;
  }
  if (context.articleId !== null && context.articleId !== void 0) {
    return `article:${String(context.articleId)}`;
  }
  const episodeToken = extractEpisodeToken([context.title ?? "", context.articleUrl ?? ""].join(" "));
  if (episodeToken) {
    return `episode:${episodeToken}`;
  }
  return context.articleUrl ? `url:${context.articleUrl}` : null;
}
function isCurrentEpisodeGeneration(generation) {
  return generation === void 0 || generation === null || generation === episodeGeneration;
}
function isCurrentMediaLibraryRequest(options) {
  return isCurrentEpisodeGeneration(options?.episodeGeneration) && (options?.mediaLoadGeneration === void 0 || options?.mediaLoadGeneration === null || options.mediaLoadGeneration === mediaLibraryLoadGeneration);
}
function beginReaderEpisodeTransition(nextContext) {
  const nextKey = buildReaderEpisodeKey(nextContext);
  if (!nextKey || nextKey === activeEpisodeKey) {
    return false;
  }
  const previousKey = activeEpisodeKey;
  void saveCurrentPlaybackBookmark().catch((error) => logger.warn("Failed to save progress before Reader episode change", { error }));
  playbackRestoreGeneration += 1;
  activeEpisodeKey = nextKey;
  episodeGeneration += 1;
  runtimeBuildToken += 1;
  resetRuntimeSubtitleBuild();
  runtimeBuildFingerprint = null;
  articleSnapshot = null;
  articleSnapshotError = null;
  localSubtitleMatch = null;
  if (selectedSubtitleMode === "local") {
    loadedSubtitleDocument = null;
  }
  manifest = null;
  transcriptSegmentsByIndex.clear();
  articleParagraphsByIndex.clear();
  mediaLibraryPendingRequest = null;
  loadedMediaLibraryEntryId = null;
  desiredMediaLibraryEntryId = null;
  mediaLibraryLoadGeneration += 1;
  currentMediaLibraryMatch = null;
  videoInspectionToken += 1;
  videoInspectionBusy = false;
  if (previousKey !== null || sourceVideoFile) {
    sourceVideoFile = null;
    resetVideoDecisionState();
    elements.playerVideoPill.textContent = "\u89C6\u9891\uFF1A\u6B63\u5728\u8DDF\u968F Reader \u6362\u96C6";
    elements.playerSubtitlePill.textContent = "\u5B57\u5E55\uFF1A\u6B63\u5728\u91CD\u65B0\u5339\u914D";
    elements.playerNote.textContent = "Reader \u5DF2\u5207\u6362\u5267\u96C6\uFF0C\u6B63\u5728\u52A0\u8F7D\u5BF9\u5E94\u5B57\u5E55\u4E0E\u89C6\u9891\u3002";
    elements.playerStatus.textContent = "\u6362\u96C6\u4E2D\uFF1A\u65B0\u5267\u96C6\u5C06\u4ECE 00:00 \u6682\u505C\u5C31\u7EEA\u3002";
  }
  logger.info("Reader episode transition started", {
    previousKey,
    nextKey,
    episodeGeneration
  });
  return true;
}
var MEDIA_LIBRARY_DB_NAME = "reader-sync-media-library";
var MEDIA_LIBRARY_STORE_NAME = "handles";
var MEDIA_LIBRARY_ROOT_KEY = "root-directory";
var MEDIA_LIBRARY_INDEX_KEY = "readerSyncMediaLibraryIndexV1";
var MEDIA_LIBRARY_SETTINGS_KEY = "readerSyncMediaLibrarySettingsV1";
var MEDIA_LIBRARY_PROCESSED_DIRECTORY = "ReaderSync-Processed";
function openMediaLibraryDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MEDIA_LIBRARY_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(MEDIA_LIBRARY_STORE_NAME)) {
        request.result.createObjectStore(MEDIA_LIBRARY_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地媒体库数据库。"));
  });
}
async function readMediaLibraryHandle() {
  const database = await openMediaLibraryDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(MEDIA_LIBRARY_STORE_NAME, "readonly");
      const request = transaction.objectStore(MEDIA_LIBRARY_STORE_NAME).get(MEDIA_LIBRARY_ROOT_KEY);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error("无法读取媒体文件夹授权。"));
    });
  } finally {
    database.close();
  }
}
async function writeMediaLibraryHandle(handle) {
  const database = await openMediaLibraryDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(MEDIA_LIBRARY_STORE_NAME, "readwrite");
      transaction.objectStore(MEDIA_LIBRARY_STORE_NAME).put(handle, MEDIA_LIBRARY_ROOT_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("无法保存媒体文件夹授权。"));
    });
  } finally {
    database.close();
  }
}
async function verifyMediaLibraryPermission(handle, requestPermission = false) {
  if (!handle) {
    return false;
  }
  const options = { mode: "readwrite" };
  if (await handle.queryPermission(options) === "granted") {
    return true;
  }
  return requestPermission && await handle.requestPermission(options) === "granted";
}
function classifyMediaVariant(relativePath) {
  const normalized = relativePath.toLowerCase();
  if (/双语|中英|bilingual|chi.*eng|eng.*chi/.test(normalized)) {
    return "bilingual";
  }
  if (/纯英|英文|\.eng\b|english/.test(normalized)) {
    return "english";
  }
  if (/无字|无字幕|clean|nosub/.test(normalized)) {
    return "clean";
  }
  return "unknown";
}
function detectSingleMediaLibraryVariant(entries) {
  const recognizedVariants = new Set(entries.map((entry) => entry.variant).filter((variant) => variant === "english" || variant === "bilingual" || variant === "clean"));
  return recognizedVariants.size === 1 ? Array.from(recognizedVariants)[0] : null;
}
async function scanMediaDirectory(directoryHandle, pathParts = [], rootName = directoryHandle.name ?? "") {
  const results = [];
  for await (const [name, handle] of directoryHandle.entries()) {
    if (handle.kind === "directory") {
      if (name === MEDIA_LIBRARY_PROCESSED_DIRECTORY) {
        continue;
      }
      results.push(...await scanMediaDirectory(handle, [...pathParts, name], rootName));
      continue;
    }
    if (handle.kind !== "file" || !supportedVideoExtensions.has(fileExtension(name))) {
      continue;
    }
    const relativePath = [...pathParts, name].join("/");
    const classificationPath = [rootName, relativePath].filter(Boolean).join("/");
    const file = await handle.getFile();
    results.push({
      id: relativePath.toLowerCase(),
      name,
      relativePath,
      pathParts: [...pathParts, name],
      episodeToken: extractEpisodeToken(relativePath),
      variant: classifyMediaVariant(classificationPath),
      sourceSize: file.size,
      sourceLastModified: file.lastModified,
      processedFileName: null,
      probe: null,
      assessment: null,
      preprocessError: null
    });
  }
  return results;
}
async function resolveFileHandleFromPath(rootHandle, pathParts) {
  let directory = rootHandle;
  for (const part of pathParts.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(part);
  }
  return directory.getFileHandle(pathParts[pathParts.length - 1]);
}
async function getProcessedMediaFile(entry) {
  if (!entry.processedFileName || !mediaLibraryDirectoryHandle) {
    return null;
  }
  try {
    const directory = await mediaLibraryDirectoryHandle.getDirectoryHandle(MEDIA_LIBRARY_PROCESSED_DIRECTORY);
    const handle = await directory.getFileHandle(entry.processedFileName);
    const file = await handle.getFile();
    if (file.size === 0) {
      entry.processedFileName = null;
      return null;
    }
    return file;
  } catch {
    entry.processedFileName = null;
    return null;
  }
}
async function getOriginalMediaFile(entry) {
  if (!mediaLibraryDirectoryHandle) {
    throw new Error("媒体文件夹尚未授权。")
  }
  const handle = await resolveFileHandleFromPath(mediaLibraryDirectoryHandle, entry.pathParts);
  return handle.getFile();
}
function mediaLibrarySourceText() {
  return [pageContext?.title ?? "", articleSnapshot?.title ?? "", localSubtitleMatch?.id ?? ""].filter(Boolean).join(" ");
}
function trainingVariantLabel(variant) {
  return { bilingual: "双语版", english: "纯英版", clean: "无字幕版" }[variant] ?? "未知版本";
}
function trainingPlanLabel(planId) {
  return { standard: "标准六遍", advanced: "进阶四遍", custom: "我的自定义" }[planId] ?? "默认方案";
}
function currentReaderEpisodeToken() {
  return extractEpisodeToken(mediaLibrarySourceText());
}
function getEpisodeTrainingRecord(episodeToken, create = false) {
  if (!episodeToken) {
    return null;
  }
  const normalizedToken = episodeToken.toUpperCase();
  const existing = trainingRecords[normalizedToken];
  if (existing) {
    return normalizeEpisodeTrainingRecord(existing);
  }
  if (!create) {
    return normalizeEpisodeTrainingRecord(null);
  }
  const next = normalizeEpisodeTrainingRecord(null);
  trainingRecords[normalizedToken] = next;
  return next;
}
function getTrainingSnapshot(episodeToken = currentReaderEpisodeToken()) {
  if (!episodeToken) {
    return null;
  }
  const record = getEpisodeTrainingRecord(episodeToken, false);
  const counts = resolvePlanCounts(trainingSettings, record);
  const passes = buildTrainingPasses(counts);
  const currentPass = resolveCurrentTrainingPass(counts, record.completed);
  const completedTotal = TRAINING_VARIANTS.reduce((sum, variant) => sum + Math.min(record.completed[variant], counts[variant]), 0);
  return { episodeToken, record, counts, passes, currentPass, completedTotal, total: passes.length };
}
function isTrainingControlActive() {
  if (!trainingSettings.enabled || trainingSettings.paused) {
    return false;
  }
  const snapshot = getTrainingSnapshot();
  return Boolean(snapshot);
}
function currentTrainingTargetVariant() {
  if (!isTrainingControlActive()) {
    return null;
  }
  const snapshot = getTrainingSnapshot();
  return snapshot?.currentPass?.variant ?? snapshot?.passes.at(-1)?.variant ?? null;
}
function effectiveMediaVariantPreference() {
  return currentTrainingTargetVariant() ?? mediaLibrarySettings.preferredVariant;
}
function resolveLoadedMediaEntry() {
  const loaded = loadedMediaLibraryEntryId ? mediaLibraryEntries.find((entry) => entry.id === loadedMediaLibraryEntryId) : null;
  const loadedExpectedName = loaded?.processedFileName ?? loaded?.name;
  if (loaded && sourceVideoFile?.name === loadedExpectedName) {
    return loaded;
  }
  if (!currentMediaLibraryMatch || !sourceVideoFile) {
    return null;
  }
  const expectedName = currentMediaLibraryMatch.processedFileName ?? currentMediaLibraryMatch.name;
  return sourceVideoFile.name === expectedName ? currentMediaLibraryMatch : null;
}
function currentTrainingPassKey() {
  const snapshot = getTrainingSnapshot();
  return isTrainingControlActive() && snapshot?.currentPass ? snapshot.currentPass.key : "ordinary";
}
function buildCurrentPlaybackIdentity() {
  if (!sourceVideoFile) {
    return null;
  }
  const entry = resolveLoadedMediaEntry();
  const episodeToken = entry?.episodeToken ?? currentReaderEpisodeToken();
  return {
    episodeToken: episodeToken ?? null,
    variant: entry?.variant ?? "unknown",
    mediaFingerprint: buildMediaFingerprint(sourceVideoFile, entry),
    trainingPassKey: currentTrainingPassKey()
  };
}
async function persistLearningState() {
  await chrome.storage.local.set({
    [TRAINING_SETTINGS_KEY]: trainingSettings,
    [TRAINING_RECORDS_KEY]: trainingRecords,
    [PLAYBACK_BOOKMARKS_KEY]: playbackBookmarks
  });
}
async function restoreLearningState() {
  const stored = await chrome.storage.local.get([TRAINING_SETTINGS_KEY, TRAINING_RECORDS_KEY, PLAYBACK_BOOKMARKS_KEY]);
  trainingSettings = normalizeTrainingSettings(stored[TRAINING_SETTINGS_KEY]);
  trainingRecords = normalizeEpisodeTrainingRecords(stored[TRAINING_RECORDS_KEY]);
  const storedBookmarks = stored[PLAYBACK_BOOKMARKS_KEY];
  playbackBookmarks = storedBookmarks && typeof storedBookmarks === "object" ? storedBookmarks : {};
}
function clearBookmarkSaveTimer() {
  if (playbackBookmarkSaveTimer !== null) {
    window.clearTimeout(playbackBookmarkSaveTimer);
    playbackBookmarkSaveTimer = null;
  }
}
async function saveCurrentPlaybackBookmark() {
  clearBookmarkSaveTimer();
  if (playbackRestoreBusy || videoSourceChangeBusy || !Number.isFinite(elements.video.duration) || elements.video.duration <= 0) {
    return;
  }
  const identity = buildCurrentPlaybackIdentity();
  if (!identity) {
    return;
  }
  const key = buildPlaybackBookmarkKey(identity);
  const currentTimeSeconds = Number(elements.video.currentTime);
  if (!Number.isFinite(currentTimeSeconds) || currentTimeSeconds < 3 || elements.video.ended) {
    delete playbackBookmarks[key];
  } else {
    playbackBookmarks[key] = {
      ...identity,
      currentTimeSeconds,
      durationSeconds: elements.video.duration,
      updatedAt: new Date().toISOString()
    };
  }
  await chrome.storage.local.set({ [PLAYBACK_BOOKMARKS_KEY]: playbackBookmarks });
}
function schedulePlaybackBookmarkSave(delayMs = 2500) {
  if (playbackRestoreBusy || videoSourceChangeBusy || playbackBookmarkSaveTimer !== null) {
    return;
  }
  playbackBookmarkSaveTimer = window.setTimeout(() => {
    playbackBookmarkSaveTimer = null;
    void saveCurrentPlaybackBookmark().catch((error) => logger.warn("Failed to save playback bookmark", { error }));
  }, delayMs);
}
async function clearCurrentPlaybackBookmark(identity = buildCurrentPlaybackIdentity()) {
  if (!identity) {
    return;
  }
  delete playbackBookmarks[buildPlaybackBookmarkKey(identity)];
  await chrome.storage.local.set({ [PLAYBACK_BOOKMARKS_KEY]: playbackBookmarks });
}
async function clearEpisodePlaybackBookmarks(episodeToken) {
  for (const [key, bookmark] of Object.entries(playbackBookmarks)) {
    if (bookmark?.episodeToken === episodeToken) {
      delete playbackBookmarks[key];
    }
  }
  await chrome.storage.local.set({ [PLAYBACK_BOOKMARKS_KEY]: playbackBookmarks });
}
async function restoreCurrentPlaybackBookmark() {
  const restoreGeneration = playbackRestoreGeneration;
  const identity = buildCurrentPlaybackIdentity();
  if (!identity) {
    return false;
  }
  const readerEpisodeToken = currentReaderEpisodeToken();
  if (identity.episodeToken && readerEpisodeToken && identity.episodeToken !== readerEpisodeToken) {
    return false;
  }
  const bookmark = playbackBookmarks[buildPlaybackBookmarkKey(identity)];
  if (!canRestorePlaybackBookmark(bookmark, identity, elements.video.duration)) {
    return false;
  }
  playbackRestoreBusy = true;
  try {
    elements.video.pause();
    elements.video.currentTime = Math.min(bookmark.currentTimeSeconds, Math.max(0, elements.video.duration - 0.25));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    if (restoreGeneration !== playbackRestoreGeneration) {
      return false;
    }
    syncPlayerReadout();
    broadcastPlayerState(true);
    elements.playerStatus.textContent = `已恢复到 ${formatTime(elements.video.currentTime)}，Reader 台本已跟随。`;
    logger.info("Restored playback bookmark", { ...identity, currentTimeSeconds: bookmark.currentTimeSeconds });
    return true;
  } finally {
    playbackRestoreBusy = false;
  }
}
function updateTrainingUi() {
  const episodeToken = currentReaderEpisodeToken();
  const snapshot = getTrainingSnapshot(episodeToken);
  const enabled = trainingSettings.enabled;
  const active = enabled && !trainingSettings.paused;
  elements.trainingEnabled.checked = enabled;
  elements.trainingDefaultPlan.value = trainingSettings.defaultPlanId;
  elements.trainingCustomCounts.classList.toggle("is-hidden", trainingSettings.defaultPlanId !== "custom");
  elements.trainingCustomBilingual.value = String(trainingSettings.customCounts.bilingual);
  elements.trainingCustomEnglish.value = String(trainingSettings.customCounts.english);
  elements.trainingCustomClean.value = String(trainingSettings.customCounts.clean);
  elements.trainingEpisodePlan.disabled = !episodeToken;
  elements.trainingEpisodePlan.value = snapshot?.record.planId ?? "default";
  elements.trainingPauseToggle.disabled = !enabled;
  elements.trainingPauseToggle.textContent = trainingSettings.paused ? "继续训练" : "暂停训练";
  elements.trainingResetEpisode.disabled = !episodeToken || !snapshot || snapshot.completedTotal === 0 && snapshot.record.history.length === 0;
  elements.libraryVariant.disabled = mediaLibraryBusy || isTrainingControlActive();
  elements.trainingRouteCard.classList.toggle("is-disabled", !enabled || trainingSettings.paused);
  elements.trainingRouteCard.classList.toggle("is-complete", Boolean(enabled && snapshot && !snapshot.currentPass));
  elements.trainingFilmstrip.replaceChildren();
  if (!enabled) {
    elements.trainingRouteTitle.textContent = "尚未启用训练计划";
    elements.trainingRouteStatus.textContent = "选择训练方案后，插件会记录遍数并自动切换视频版本。";
    elements.trainingTarget.textContent = "未启用";
    elements.trainingSummary.textContent = "选择方案后开始本机训练记录";
  } else if (!episodeToken || !snapshot) {
    elements.trainingRouteTitle.textContent = "等待 Reader 识别剧集";
    elements.trainingRouteStatus.textContent = "识别剧集后会载入该集的独立训练进度。";
    elements.trainingTarget.textContent = trainingSettings.paused ? "已暂停" : "等待剧集";
    elements.trainingSummary.textContent = `${trainingPlanLabel(trainingSettings.defaultPlanId)} · 等待当前剧集`;
  } else {
    const selectedPlanId = snapshot.record.planId ?? trainingSettings.defaultPlanId;
    elements.trainingSummary.textContent = `${trainingPlanLabel(selectedPlanId)} · ${snapshot.completedTotal}/${snapshot.total} 遍`;
    if (trainingSettings.paused) {
      elements.trainingRouteTitle.textContent = `${episodeToken} · 训练已暂停`;
      elements.trainingRouteStatus.textContent = "当前使用资源设置中的手动视频版本，继续训练后恢复自动路线。";
      elements.trainingTarget.textContent = "已暂停";
    } else if (!snapshot.currentPass) {
      elements.trainingRouteTitle.textContent = `${episodeToken} · 本集训练完成`;
      elements.trainingRouteStatus.textContent = `已完成 ${snapshot.total} 遍，可以切换 Reader 进入下一集。`;
      elements.trainingTarget.textContent = "完成 ✓";
    } else {
      const pass = snapshot.currentPass;
      const targetExists = mediaLibraryEntries.some((entry) => entry.episodeToken === episodeToken && entry.variant === pass.variant);
      elements.trainingRouteTitle.textContent = `${episodeToken} · 第 ${pass.index + 1}/${pass.total} 遍`;
      elements.trainingRouteStatus.textContent = targetExists ? `当前目标：${trainingVariantLabel(pass.variant)}第 ${pass.ordinal} 遍；播放结束后自动进入下一遍。` : `媒体目录中缺少${trainingVariantLabel(pass.variant)}，训练已等待资源。`;
      elements.trainingTarget.textContent = `${trainingVariantLabel(pass.variant)} · ${pass.ordinal}`;
    }
    for (let index = 0; index < snapshot.passes.length; index += 1) {
      const pass = snapshot.passes[index];
      const node = document.createElement("span");
      node.className = "training-pass";
      node.textContent = `${trainingVariantLabel(pass.variant).replace("版", "")} ${pass.ordinal}`;
      if (snapshot.record.completed[pass.variant] >= pass.ordinal) {
        node.classList.add("is-done");
      } else if (snapshot.currentPass?.key === pass.key) {
        node.classList.add("is-current");
        node.setAttribute("aria-current", "step");
      }
      elements.trainingFilmstrip.append(node);
    }
  }
  const loadedEntry = resolveLoadedMediaEntry();
  const currentPass = snapshot?.currentPass ?? null;
  const loadedMatchesTarget = Boolean(currentPass && loadedEntry && loadedEntry.episodeToken === episodeToken && loadedEntry.variant === currentPass.variant);
  elements.trainingRestartPass.disabled = !active || !currentPass || !loadedMatchesTarget;
  elements.trainingCompletePass.disabled = !active || !currentPass || !loadedMatchesTarget;
  elements.trainingUndo.disabled = !episodeToken || !snapshot || snapshot.record.history.length === 0;
  const episodeTokens = listTrainingEpisodeTokens(mediaLibraryEntries, trainingRecords);
  const totalCompleted = episodeTokens.reduce((sum, token) => sum + (getTrainingSnapshot(token)?.completedTotal ?? 0), 0);
  const totalTargets = episodeTokens.reduce((sum, token) => sum + (getTrainingSnapshot(token)?.total ?? 0), 0);
  elements.seasonProgressSummary.textContent = episodeTokens.length > 0 ? `${episodeTokens.length} 集 · 已完成 ${totalCompleted}/${totalTargets} 遍` : "等待媒体目录或训练记录";
  elements.seasonProgressList.replaceChildren();
  for (const token of episodeTokens) {
    const itemSnapshot = getTrainingSnapshot(token);
    const item = document.createElement("div");
    item.className = "season-progress-item";
    if (token === episodeToken) {
      item.classList.add("is-current");
    }
    const label = document.createElement("strong");
    label.textContent = token;
    const detail = document.createElement("small");
    detail.textContent = `双 ${itemSnapshot.record.completed.bilingual} · 英 ${itemSnapshot.record.completed.english} · 无 ${itemSnapshot.record.completed.clean}`;
    const total = document.createElement("span");
    total.textContent = `${itemSnapshot.completedTotal}/${itemSnapshot.total}`;
    item.append(label, detail, total);
    elements.seasonProgressList.append(item);
  }
}
async function restartCurrentTrainingPass() {
  playbackRestoreGeneration += 1;
  await clearCurrentPlaybackBookmark();
  elements.video.pause();
  elements.video.currentTime = 0;
  syncPlayerReadout();
  broadcastPlayerState(true);
  elements.playerStatus.textContent = "本遍已回到开头，等待播放。";
}
async function syncTrainingTargetMedia({ restart = true } = {}) {
  playbackRestoreGeneration += 1;
  const snapshot = getTrainingSnapshot();
  updateTrainingUi();
  if (!trainingSettings.enabled || trainingSettings.paused || !snapshot?.currentPass) {
    currentMediaLibraryMatch = resolveMediaLibraryMatch();
    updateMediaLibraryUi();
    return;
  }
  const target = resolveMediaLibraryMatch();
  currentMediaLibraryMatch = target;
  if (!target) {
    elements.video.pause();
    updateMediaLibraryUi();
    updateTrainingUi();
    return;
  }
  const loadedEntry = resolveLoadedMediaEntry();
  if (loadedEntry?.id === target.id) {
    if (restart) {
      await restartCurrentTrainingPass();
    } else {
      await restoreCurrentPlaybackBookmark();
    }
    updateTrainingUi();
    return;
  }
  elements.video.pause();
  await autoLoadMatchedMedia();
  updateTrainingUi();
}
async function completeCurrentTrainingPass(source = "manual") {
  if (trainingCompletionBusy || !isTrainingControlActive()) {
    return;
  }
  const snapshot = getTrainingSnapshot();
  const loadedEntry = resolveLoadedMediaEntry();
  if (!snapshot?.currentPass || !loadedEntry || loadedEntry.episodeToken !== snapshot.episodeToken || loadedEntry.variant !== snapshot.currentPass.variant) {
    elements.playerStatus.textContent = "当前视频版本与训练目标不一致，未记录本遍。";
    return;
  }
  trainingCompletionBusy = true;
  try {
    const previousIdentity = buildCurrentPlaybackIdentity();
    if (previousIdentity) {
      await clearCurrentPlaybackBookmark(previousIdentity);
    }
    const nextRecord = completeTrainingPass(snapshot.record, snapshot.currentPass.variant);
    trainingRecords[snapshot.episodeToken] = nextRecord;
    await persistLearningState();
    const nextSnapshot = getTrainingSnapshot(snapshot.episodeToken);
    logger.info("Training pass completed", { episodeToken: snapshot.episodeToken, pass: snapshot.currentPass.key, source });
    if (!nextSnapshot?.currentPass) {
      elements.video.pause();
      elements.playerStatus.textContent = `${snapshot.episodeToken} 的训练计划已全部完成。`;
      updateTrainingUi();
      return;
    }
    elements.playerStatus.textContent = `已完成一遍，正在准备${trainingVariantLabel(nextSnapshot.currentPass.variant)}第 ${nextSnapshot.currentPass.ordinal} 遍。`;
    await syncTrainingTargetMedia({ restart: true });
  } finally {
    trainingCompletionBusy = false;
    updateTrainingUi();
  }
}
async function undoTrainingCompletion() {
  const episodeToken = currentReaderEpisodeToken();
  if (!episodeToken) {
    return;
  }
  const currentRecord = getEpisodeTrainingRecord(episodeToken, false);
  const result = undoLastTrainingCompletion(currentRecord);
  if (!result.variant) {
    return;
  }
  trainingRecords[episodeToken] = result.record;
  await persistLearningState();
  elements.playerStatus.textContent = `已撤销上一次${trainingVariantLabel(result.variant)}完成记录。`;
  await syncTrainingTargetMedia({ restart: true });
}
async function resetCurrentEpisodeTraining() {
  const episodeToken = currentReaderEpisodeToken();
  if (!episodeToken || !window.confirm(`确定清除 ${episodeToken} 的全部训练次数和播放进度吗？`)) {
    return;
  }
  delete trainingRecords[episodeToken];
  await clearEpisodePlaybackBookmarks(episodeToken);
  await persistLearningState();
  await syncTrainingTargetMedia({ restart: true });
}
function readCustomTrainingCountsFromUi() {
  const raw = {
    bilingual: elements.trainingCustomBilingual.value,
    english: elements.trainingCustomEnglish.value,
    clean: elements.trainingCustomClean.value
  };
  const counts = sanitizeTrainingCounts(raw, trainingSettings.customCounts);
  const rawTotal = TRAINING_VARIANTS.reduce((sum, variant) => sum + Math.min(6, Math.max(0, Number.parseInt(String(raw[variant]), 10) || 0)), 0);
  if (rawTotal === 0) {
    elements.trainingCustomEnglish.setCustomValidity("至少设置一个训练遍次");
    elements.trainingRouteStatus.textContent = "自定义计划至少需要一遍训练。";
    return null;
  }
  elements.trainingCustomEnglish.setCustomValidity("");
  return counts;
}
async function applyTrainingSettingsChange({ syncMedia = true, restart = true } = {}) {
  await persistLearningState();
  updateTrainingUi();
  updateMediaLibraryUi();
  if (syncMedia) {
    await syncTrainingTargetMedia({ restart });
  }
}
function resolveMediaLibraryMatch() {
  const episodeToken = extractEpisodeToken(mediaLibrarySourceText());
  if (!episodeToken) {
    return null;
  }
  let candidates = mediaLibraryEntries.filter((entry) => entry.episodeToken === episodeToken);
  if (candidates.length === 0) {
    return null;
  }
  const preference = effectiveMediaVariantPreference();
  if (preference !== "auto") {
    candidates = candidates.filter((entry) => entry.variant === preference);
    if (candidates.length === 0) {
      return null;
    }
  }
  const variantRanks = ["english", "bilingual", "clean", "unknown"];
  return candidates.sort((left, right) => {
    const variantDelta = variantRanks.indexOf(left.variant) - variantRanks.indexOf(right.variant);
    if (variantDelta !== 0) {
      return variantDelta;
    }
    return Number(Boolean(right.processedFileName)) - Number(Boolean(left.processedFileName)) || left.relativePath.localeCompare(right.relativePath);
  })[0];
}
function updateMediaLibraryUi() {
  elements.mediaLibraryCard.classList.toggle("is-busy", mediaLibraryBusy);
  elements.chooseLibraryFolder.disabled = mediaLibraryBusy;
  elements.rescanLibrary.disabled = mediaLibraryBusy || !mediaLibraryDirectoryHandle;
  elements.rescanLibrary.textContent = mediaLibraryPermissionReady ? "重新扫描" : "重新授权并扫描";
  elements.cancelLibraryScan.disabled = !mediaLibraryBusy;
  elements.libraryPreprocess.disabled = mediaLibraryBusy;
  elements.libraryVariant.disabled = mediaLibraryBusy || isTrainingControlActive();
  elements.libraryPreprocess.checked = mediaLibrarySettings.preprocess;
  elements.libraryVariant.value = mediaLibrarySettings.preferredVariant;
  if (!mediaLibraryDirectoryHandle) {
    elements.mediaLibraryStatus.textContent = "尚未配置媒体文件夹。目录只在本机读取，插件不会上传视频。";
  } else if (!mediaLibraryPermissionReady) {
    elements.mediaLibraryStatus.textContent = `已记住“${mediaLibraryDirectoryHandle.name}”，点击“重新扫描”恢复文件夹权限。`;
  } else if (!mediaLibraryBusy) {
    const processedCount = mediaLibraryEntries.filter((entry) => entry.processedFileName).length;
    const failedCount = mediaLibraryEntries.filter((entry) => entry.preprocessError).length;
    elements.mediaLibraryStatus.textContent = `已配置“${mediaLibraryDirectoryHandle.name}”：索引 ${mediaLibraryEntries.length} 个视频，预处理 ${processedCount} 个${failedCount > 0 ? `，失败 ${failedCount} 个` : ""}。`;
  }
  const episodeToken = extractEpisodeToken(mediaLibrarySourceText());
  const variantLabels = { english: "纯英版", bilingual: "双语版", clean: "无字幕版", auto: "自动选择" };
  const effectivePreference = effectiveMediaVariantPreference();
  const preferredVariantLabel = variantLabels[effectivePreference] ?? effectivePreference;
  if (currentMediaLibraryMatch && !mediaLibraryPermissionReady) {
    const suffix = currentMediaLibraryMatch.processedFileName ? " · 已预处理" : "";
    elements.mediaLibraryMatch.textContent = `当前剧集 ${currentMediaLibraryMatch.episodeToken}：${currentMediaLibraryMatch.relativePath}${suffix} · 等待文件夹授权`;
  } else if (currentMediaLibraryMatch) {
    const suffix = currentMediaLibraryMatch.processedFileName ? " · 已预处理" : "";
    elements.mediaLibraryMatch.textContent = `当前剧集 ${currentMediaLibraryMatch.episodeToken}：${currentMediaLibraryMatch.relativePath}${suffix}`;
  } else {
    elements.mediaLibraryMatch.textContent = !mediaLibraryPermissionReady && mediaLibraryDirectoryHandle && episodeToken ? `当前剧集 ${episodeToken}：等待文件夹授权后匹配` : episodeToken ? `当前剧集 ${episodeToken}：媒体库中没有${preferredVariantLabel}匹配文件` : "当前剧集：等待 Reader 页面识别";
  }
  if (!mediaLibraryDirectoryHandle) {
    elements.automationVideoStatus.textContent = "请在资源设置中选择媒体文件夹。";
    updateAutomationCard(elements.automationVideoCard, "busy");
  } else if (!mediaLibraryPermissionReady) {
    elements.automationVideoStatus.textContent = currentMediaLibraryMatch ? "已找到对应视频，但需要重新授权文件夹后才能载入。" : "媒体文件夹需要重新授权。";
    updateAutomationCard(elements.automationVideoCard, "error");
  } else if (currentMediaLibraryMatch) {
    elements.automationVideoStatus.textContent = mediaLibraryBusy ? `已匹配 ${currentMediaLibraryMatch.episodeToken}，正在后台处理。` : `已匹配 ${currentMediaLibraryMatch.episodeToken} · ${preferredVariantLabel}`;
    updateAutomationCard(elements.automationVideoCard, mediaLibraryBusy || mediaLibraryAutoLoadBusy ? "busy" : "ready");
  } else if (episodeToken) {
    elements.automationVideoStatus.textContent = `${episodeToken} 未找到${preferredVariantLabel}，不会自动改用其他版本。${isTrainingControlActive() ? " 请配置该版本或暂停训练。" : ""}`;
    updateAutomationCard(elements.automationVideoCard, "error");
  } else {
    elements.automationVideoStatus.textContent = "等待 Reader 识别当前剧集。";
    updateAutomationCard(elements.automationVideoCard, "busy");
  }
}
async function persistMediaLibraryState() {
  await chrome.storage.local.set({
    [MEDIA_LIBRARY_INDEX_KEY]: mediaLibraryEntries.map(({ id, name, relativePath, pathParts, episodeToken, variant, sourceSize, sourceLastModified, processedFileName, probe, assessment, preprocessError }) => ({ id, name, relativePath, pathParts, episodeToken, variant, sourceSize, sourceLastModified, processedFileName, probe, assessment, preprocessError })),
    [MEDIA_LIBRARY_SETTINGS_KEY]: mediaLibrarySettings
  });
}
function buildProcessedMediaCacheToken(relativePath) {
  let pathHash = 2166136261;
  for (const character of relativePath) {
    pathHash ^= character.charCodeAt(0);
    pathHash = Math.imul(pathHash, 16777619);
  }
  return (pathHash >>> 0).toString(16).padStart(8, "0");
}
async function discoverProcessedMediaFiles(entries) {
  let directory;
  try {
    directory = await mediaLibraryDirectoryHandle.getDirectoryHandle(MEDIA_LIBRARY_PROCESSED_DIRECTORY);
  } catch {
    return;
  }
  const processedFiles = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== "file" || fileExtension(name) !== "mp4") {
      continue;
    }
    const file = await handle.getFile();
    if (file.size > 0) {
      processedFiles.push({ name, lastModified: file.lastModified });
    }
  }
  for (const entry of entries) {
    const token = buildProcessedMediaCacheToken(entry.relativePath);
    const cached = processedFiles.find((file) => file.name.includes(`-${token}-`) && file.lastModified >= entry.sourceLastModified);
    if (cached) {
      entry.processedFileName = cached.name;
      entry.preprocessError = null;
    }
  }
}
async function writeProcessedMediaFile(result, entry) {
  const directory = await mediaLibraryDirectoryHandle.getDirectoryHandle(MEDIA_LIBRARY_PROCESSED_DIRECTORY, { create: true });
  const uniquePrefix = entry.relativePath.replaceAll(/[^a-z0-9]+/gi, "-").replaceAll(/^-|-$/g, "").slice(-80);
  const outputName = `${uniquePrefix}-${buildProcessedMediaCacheToken(entry.relativePath)}-${result.file.name.slice(-80)}`;
  const fileHandle = await directory.getFileHandle(outputName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(result.blob);
  } finally {
    await writable.close();
  }
  return outputName;
}
function takePrioritizedMediaLibraryEntry(remainingEntries, desiredEntryId) {
  if (!Array.isArray(remainingEntries) || remainingEntries.length === 0) {
    return null;
  }
  const desiredIndex = desiredEntryId ? remainingEntries.findIndex((entry) => entry.id === desiredEntryId) : -1;
  const nextIndex = desiredIndex >= 0 ? desiredIndex : 0;
  return remainingEntries.splice(nextIndex, 1)[0] ?? null;
}
function isMediaLibraryEntryReady(entry) {
  return Boolean(entry?.processedFileName || entry?.probe && entry?.assessment?.isRecommendedProfile);
}
async function loadCurrentMediaLibraryMatchDuringBatch() {
  currentMediaLibraryMatch = resolveMediaLibraryMatch();
  const match = currentMediaLibraryMatch;
  if (!match || loadedMediaLibraryEntryId === match.id || !isMediaLibraryEntryReady(match)) {
    return false;
  }
  const pendingRequest = mediaLibraryPendingRequest;
  const request = pendingRequest?.id === match.id && isCurrentMediaLibraryRequest(pendingRequest) ? pendingRequest : {
    id: match.id,
    episodeGeneration,
    mediaLoadGeneration: mediaLibraryLoadGeneration
  };
  if (!isCurrentMediaLibraryRequest(request)) {
    return false;
  }
  if (mediaLibraryPendingRequest?.id === request.id) {
    mediaLibraryPendingRequest = null;
  }
  logger.info("Loading newly selected episode ahead of background preprocessing", {
    entryId: match.id,
    episodeToken: match.episodeToken,
    episodeGeneration: request.episodeGeneration
  });
  await loadMediaLibraryEntry(match, {
    allowDuringBatch: true,
    episodeGeneration: request.episodeGeneration,
    mediaLoadGeneration: request.mediaLoadGeneration
  });
  return loadedMediaLibraryEntryId === match.id;
}
async function inspectAndMaybePreprocessLibraryEntry(entry, index, total, shouldPreprocess) {
  const file = await getOriginalMediaFile(entry);
  elements.mediaLibraryStatus.textContent = `正在检测 ${index + 1}/${total}：${entry.relativePath}`;
  const probe = await browserFfmpegService.inspectFile(file);
  const assessment = assessMediaCompatibility(file.name, probe);
  entry.probe = probe;
  entry.assessment = assessment;
  if (!assessment.isRecommendedProfile && shouldPreprocess) {
    elements.mediaLibraryStatus.textContent = `正在预处理 ${index + 1}/${total}：${entry.relativePath}`;
    const result = await browserFfmpegService.transcodeFile(file, probe, {
      onProgress: ({ progress }) => {
        const fileProgress = Number.isFinite(progress) ? clamp(progress, 0, 1) : 0;
        elements.libraryProgress.value = Math.round((index + fileProgress) / total * 100);
      }
    });
    entry.processedFileName = await writeProcessedMediaFile(result, entry);
  }
}
async function scanAndPrepareMediaLibrary() {
  if (!mediaLibraryDirectoryHandle || mediaLibraryBusy) {
    return;
  }
  if (!await verifyMediaLibraryPermission(mediaLibraryDirectoryHandle, true)) {
    throw new Error("未获得媒体文件夹读取和写入权限。")
  }
  mediaLibraryPermissionReady = true;
  mediaLibraryBusy = true;
  mediaLibraryCancelRequested = false;
  elements.libraryProgress.value = 0;
  updateMediaLibraryUi();
  try {
    const previousById = new Map(mediaLibraryEntries.map((entry) => [entry.id, entry]));
    const scanned = await scanMediaDirectory(mediaLibraryDirectoryHandle);
    mediaLibraryEntries = scanned.map((entry) => {
      const previous = previousById.get(entry.id);
      const sourceUnchanged = previous && (previous.sourceSize === entry.sourceSize && previous.sourceLastModified === entry.sourceLastModified || previous.sourceSize == null && Boolean(previous.processedFileName));
      return {
        ...entry,
        probe: sourceUnchanged ? previous.probe ?? null : null,
        assessment: sourceUnchanged ? previous.assessment ?? null : null,
        processedFileName: sourceUnchanged ? previous.processedFileName ?? null : null,
        preprocessError: sourceUnchanged ? previous.preprocessError ?? null : null
      };
    });
    await discoverProcessedMediaFiles(mediaLibraryEntries);
    const onlyAvailableVariant = detectSingleMediaLibraryVariant(mediaLibraryEntries);
    if (onlyAvailableVariant && mediaLibrarySettings.preferredVariant !== "auto" && mediaLibrarySettings.preferredVariant !== onlyAvailableVariant) {
      logger.info("媒体库只包含一个字幕版本，已自动调整版本选择。", {
        previousVariant: mediaLibrarySettings.preferredVariant,
        availableVariant: onlyAvailableVariant
      });
      mediaLibrarySettings.preferredVariant = onlyAvailableVariant;
    }
    currentMediaLibraryMatch = resolveMediaLibraryMatch();
    await persistMediaLibraryState();
    updateMediaLibraryUi();
    updateTrainingUi();
    if (!mediaLibrarySettings.preprocess) {
      mediaLibraryBusy = false;
      updateMediaLibraryUi();
      await autoLoadMatchedMedia();
      return;
    }
    const preferredEntries = [];
    for (const episodeToken of new Set(mediaLibraryEntries.map((entry) => entry.episodeToken).filter(Boolean))) {
      const ranks = ["english", "bilingual", "clean", "unknown"];
      const episodeEntries = mediaLibraryEntries.filter((entry) => entry.episodeToken === episodeToken);
      const trainingSnapshot = trainingSettings.enabled && !trainingSettings.paused ? getTrainingSnapshot(episodeToken) : null;
      const requiredVariant = trainingSnapshot?.currentPass?.variant ?? (mediaLibrarySettings.preferredVariant === "auto" ? null : mediaLibrarySettings.preferredVariant);
      const candidates = episodeEntries.filter((entry) => requiredVariant === null || entry.variant === requiredVariant);
      candidates.sort((left, right) => ranks.indexOf(left.variant) - ranks.indexOf(right.variant) || left.relativePath.localeCompare(right.relativePath));
      if (candidates[0]) {
        preferredEntries.push(candidates[0]);
      }
    }
    preferredEntries.sort((left, right) => left.episodeToken.localeCompare(right.episodeToken));
    const remainingEntries = [...preferredEntries];
    let processedEntryCount = 0;
    while (!mediaLibraryCancelRequested) {
      currentMediaLibraryMatch = resolveMediaLibraryMatch();
      if (currentMediaLibraryMatch && !isMediaLibraryEntryReady(currentMediaLibraryMatch) && !preferredEntries.some((item) => item.id === currentMediaLibraryMatch.id)) {
        preferredEntries.push(currentMediaLibraryMatch);
        remainingEntries.push(currentMediaLibraryMatch);
        logger.info("Training target changed during background preprocessing; promoted the new target", {
          entryId: currentMediaLibraryMatch.id,
          episodeToken: currentMediaLibraryMatch.episodeToken,
          variant: currentMediaLibraryMatch.variant
        });
      }
      if (remainingEntries.length === 0) {
        break;
      }
      const entry = takePrioritizedMediaLibraryEntry(remainingEntries, currentMediaLibraryMatch?.id);
      if (!entry) {
        break;
      }
      const index = processedEntryCount;
      if (!entry.processedFileName && (!entry.probe || !entry.assessment || !entry.assessment.isRecommendedProfile)) {
        try {
          await inspectAndMaybePreprocessLibraryEntry(entry, index, preferredEntries.length, true);
          entry.preprocessError = null;
        } catch (error) {
          if (mediaLibraryCancelRequested) {
            throw error;
          }
          entry.preprocessError = error instanceof Error ? error.message : String(error);
          elements.mediaLibraryStatus.textContent = `预处理失败，已继续下一集：${entry.relativePath}`;
        }
        await persistMediaLibraryState();
      }
      processedEntryCount += 1;
      elements.libraryProgress.value = Math.round(processedEntryCount / Math.max(1, preferredEntries.length) * 100);
      const currentEpisodeLoaded = await loadCurrentMediaLibraryMatchDuringBatch();
      if (currentEpisodeLoaded) {
        elements.mediaLibraryStatus.textContent = `当前集已优先就绪，正在后台预处理其余剧集 ${processedEntryCount}/${preferredEntries.length}。`;
      }
      if (entry.assessment?.isRecommendedProfile || entry.processedFileName) {
        continue;
      }
    }
    await persistMediaLibraryState();
  } catch (error) {
    if (!mediaLibraryCancelRequested) {
      throw error;
    }
    await persistMediaLibraryState();
  } finally {
    mediaLibraryBusy = false;
    currentMediaLibraryMatch = resolveMediaLibraryMatch();
    updateMediaLibraryUi();
    if (mediaLibraryCancelRequested) {
      elements.mediaLibraryStatus.textContent = "已停止批量处理；已完成的索引和预处理结果均已保留。";
    }
  }
  if (!mediaLibraryCancelRequested) {
    await autoLoadMatchedMedia();
  }
}
async function chooseMediaLibraryFolder() {
  if (typeof window.showDirectoryPicker !== "function") {
    throw new Error("当前 Chrome 不支持文件夹访问，请升级浏览器。")
  }
  const handle = await window.showDirectoryPicker({ id: "reader-sync-media-library", mode: "readwrite" });
  mediaLibraryDirectoryHandle = handle;
  mediaLibraryPermissionReady = true;
  await writeMediaLibraryHandle(handle);
  mediaLibraryEntries = [];
  await scanAndPrepareMediaLibrary();
}
async function loadKnownCompatibleLibraryFile(file, probe, targetEntryId, options) {
  if (!isCurrentMediaLibraryRequest(options)) {
    return;
  }
  await saveCurrentPlaybackBookmark();
  playbackRestoreGeneration += 1;
  sourceVideoFile = file;
  loadedMediaLibraryEntryId = targetEntryId ?? null;
  resetVideoDecisionState(file.name);
  elements.videoDropTitle.textContent = "视频已从媒体库载入";
  elements.videoDropDesc.textContent = file.name;
  elements.playerVideoPill.textContent = `视频：${file.name}`;
  videoObjectUrl = URL.createObjectURL(file);
  elements.video.src = videoObjectUrl;
  elements.video.load();
  sourceVideoProbe = probe;
  sourceVideoAssessment = assessMediaCompatibility(file.name, probe);
  sourceVideoStrategy = buildMediaTranscodeStrategy(file.name, probe);
  const description = describeVideoProbe(file.name, probe);
  elements.videoContainer.textContent = description.container;
  elements.videoCodec.textContent = description.video;
  elements.audioCodec.textContent = description.audio;
  elements.videoPlan.textContent = "媒体库缓存可直接播放";
  elements.processingProgress.value = 100;
  elements.processingText.textContent = "已命中预处理缓存，跳过重复检测";
  updateVideoDecisionControls();
  await playOriginalVideoFile({ enterPlayer: false, episodeGeneration: options?.episodeGeneration, mediaLoadGeneration: options?.mediaLoadGeneration });
}
async function loadMediaLibraryEntry(entry, options) {
  if (!entry || !mediaLibraryDirectoryHandle || !mediaLibraryPermissionReady || mediaLibraryAutoLoadBusy || !options?.allowDuringBatch && mediaLibraryBusy || !isCurrentMediaLibraryRequest(options)) {
    return;
  }
  if (resolveLoadedMediaEntry()?.id === entry.id) {
    return;
  }
  mediaLibraryAutoLoadBusy = true;
  updateMediaLibraryUi();
  try {
    const processedFile = await getProcessedMediaFile(entry);
    if (!isCurrentMediaLibraryRequest(options)) {
      return;
    }
    if (processedFile) {
      const processedProbe = {
        containerFormats: ["mp4"],
        streams: [
          { codecType: "video", codecName: "h264", index: 0 },
          { codecType: "audio", codecName: "aac", index: 1 }
        ]
      };
      await loadKnownCompatibleLibraryFile(processedFile, processedProbe, entry.id, options);
      if (isCurrentMediaLibraryRequest(options)) {
        loadedMediaLibraryEntryId = entry.id;
      }
      return;
    }
    const originalFile = await getOriginalMediaFile(entry);
    if (!isCurrentMediaLibraryRequest(options)) {
      return;
    }
    if (!entry.probe || !entry.assessment || !entry.assessment.isRecommendedProfile) {
      elements.mediaLibraryStatus.textContent = `正在为当前选择准备兼容音视频：${entry.relativePath}`;
      await inspectAndMaybePreprocessLibraryEntry(entry, 0, 1, true);
      entry.preprocessError = null;
      await persistMediaLibraryState();
      if (!isCurrentMediaLibraryRequest(options)) {
        return;
      }
      const preparedFile = await getProcessedMediaFile(entry);
      if (preparedFile) {
        const preparedProbe = {
          containerFormats: ["mp4"],
          streams: [
            { codecType: "video", codecName: "h264", index: 0 },
            { codecType: "audio", codecName: "aac", index: 1 }
          ]
        };
        await loadKnownCompatibleLibraryFile(preparedFile, preparedProbe, entry.id, options);
        if (isCurrentMediaLibraryRequest(options)) {
          loadedMediaLibraryEntryId = entry.id;
        }
        return;
      }
    }
    if (entry.assessment?.isRecommendedProfile && entry.probe) {
      await loadKnownCompatibleLibraryFile(originalFile, entry.probe, entry.id, options);
    } else {
      throw new Error(`当前视频的音轨或画面格式无法由浏览器直接播放，自动兼容处理未生成结果：${entry.relativePath}`);
    }
    if (isCurrentMediaLibraryRequest(options)) {
      loadedMediaLibraryEntryId = entry.id;
    }
  } finally {
    mediaLibraryAutoLoadBusy = false;
    updateMediaLibraryUi();
  }
}
async function autoLoadMatchedMedia() {
  currentMediaLibraryMatch = resolveMediaLibraryMatch();
  updateMediaLibraryUi();
  updateTrainingUi();
  const match = currentMediaLibraryMatch;
  const nextDesiredEntryId = match?.id ?? null;
  const desiredEntryChanged = nextDesiredEntryId !== desiredMediaLibraryEntryId;
  if (desiredEntryChanged) {
    desiredMediaLibraryEntryId = nextDesiredEntryId;
    mediaLibraryLoadGeneration += 1;
  }
  mediaLibraryPendingRequest = match ? { id: match.id, episodeGeneration, mediaLoadGeneration: mediaLibraryLoadGeneration } : null;
  if (!match && loadedMediaLibraryEntryId) {
    loadedMediaLibraryEntryId = null;
    sourceVideoFile = null;
    resetVideoDecisionState();
    elements.playerVideoPill.textContent = "视频：所选版本没有匹配文件";
    elements.playerStatus.textContent = "当前剧集没有所选视频版本，已停止使用上一版本。";
  }
  if (match && mediaLibraryBusy && desiredEntryChanged) {
    elements.mediaLibraryStatus.textContent = `Reader 已切换到 ${match.episodeToken}；当前文件处理完成后将优先加载这一集。`;
    logger.info("Episode switch queued ahead of background preprocessing", {
      entryId: match.id,
      episodeToken: match.episodeToken,
      episodeGeneration,
      videoInspectionBusy,
      videoTranscodeBusy
    });
  }
  if (!match || !mediaLibraryPermissionReady || mediaLibraryBusy || mediaLibraryAutoLoadBusy || videoInspectionBusy || videoTranscodeBusy) {
    return;
  }
  while (mediaLibraryPendingRequest && !mediaLibraryBusy && !videoInspectionBusy && !videoTranscodeBusy) {
    const request = mediaLibraryPendingRequest;
    mediaLibraryPendingRequest = null;
    if (!isCurrentMediaLibraryRequest(request)) {
      continue;
    }
    const requestedEntry = mediaLibraryEntries.find((entry) => entry.id === request.id);
    if (!requestedEntry) {
      continue;
    }
    await loadMediaLibraryEntry(requestedEntry, { episodeGeneration: request.episodeGeneration, mediaLoadGeneration: request.mediaLoadGeneration });
  }
}
async function ensureMediaLibraryReadyForPlayback() {
  if (!mediaLibraryDirectoryHandle) {
    return Boolean(sourceVideoFile && videoObjectUrl);
  }
  if (!mediaLibraryPermissionReady) {
    const granted = await verifyMediaLibraryPermission(mediaLibraryDirectoryHandle, true);
    if (!granted) {
      updateMediaLibraryUi();
      elements.playerStatus.textContent = "播放前需要重新授权媒体文件夹，请点击“重新授权并扫描”。";
      return false;
    }
    mediaLibraryPermissionReady = true;
    updateMediaLibraryUi();
  }
  currentMediaLibraryMatch = resolveMediaLibraryMatch();
  if (!sourceVideoFile && currentMediaLibraryMatch) {
    await autoLoadMatchedMedia();
  }
  if (!sourceVideoFile || !videoObjectUrl || videoInspectionBusy || videoTranscodeBusy) {
    elements.playerStatus.textContent = "正在恢复本地视频，请稍候再播放。";
    return false;
  }
  return true;
}
async function togglePlayback() {
  if (elements.video.paused) {
    if (!await ensureMediaLibraryReadyForPlayback()) {
      return;
    }
    await elements.video.play();
  } else {
    elements.video.pause();
  }
  broadcastPlayerState(true);
}
async function restoreMediaLibrary() {
  const stored = await chrome.storage.local.get([MEDIA_LIBRARY_INDEX_KEY, MEDIA_LIBRARY_SETTINGS_KEY]);
  const savedSettings = stored[MEDIA_LIBRARY_SETTINGS_KEY];
  if (savedSettings && typeof savedSettings === "object") {
    mediaLibrarySettings = {
      preprocess: savedSettings.preprocess === true,
      preferredVariant: ["english", "bilingual", "clean", "auto"].includes(savedSettings.preferredVariant) ? savedSettings.preferredVariant : "english"
    };
  }
  mediaLibraryEntries = Array.isArray(stored[MEDIA_LIBRARY_INDEX_KEY]) ? stored[MEDIA_LIBRARY_INDEX_KEY] : [];
  mediaLibraryDirectoryHandle = await readMediaLibraryHandle();
  mediaLibraryPermissionReady = mediaLibraryDirectoryHandle ? await verifyMediaLibraryPermission(mediaLibraryDirectoryHandle, false) : false;
  currentMediaLibraryMatch = resolveMediaLibraryMatch();
  updateMediaLibraryUi();
  if (mediaLibraryDirectoryHandle && mediaLibraryPermissionReady) {
    await autoLoadMatchedMedia();
  }
}
function scoreTitleSimilarity(left, right) {
  const leftTokens = new Set(normalizeTextToken(left).split(" ").filter(Boolean));
  const rightTokens = new Set(normalizeTextToken(right).split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}
async function loadSubtitleIndex() {
  if (subtitleIndexLoaded) {
    return;
  }
  const response = await fetch(chrome.runtime.getURL("resources/subtitles-index.json"));
  if (!response.ok) {
    throw new Error(`\u672C\u5730\u5B57\u5E55\u7D22\u5F15\u52A0\u8F7D\u5931\u8D25 (${response.status})`);
  }
  const payload = await response.json();
  subtitleIndex = Array.isArray(payload.subtitles) ? payload.subtitles : [];
  subtitleIndexLoaded = true;
}
function resolveLocalSubtitleMatch() {
  const sourceTexts = [
    pageContext?.title ?? "",
    articleSnapshot?.title ?? "",
    articleSnapshot?.paragraphs.slice(0, 12).map((paragraph) => paragraph.text).join(" ") ?? ""
  ].filter(Boolean);
  const combined = sourceTexts.join(" ");
  const episodeToken = extractEpisodeToken(combined);
  if (episodeToken) {
    const exactMatch = subtitleIndex.find((entry) => entry.id === episodeToken);
    if (exactMatch) {
      return exactMatch;
    }
  }
  let best = null;
  for (const entry of subtitleIndex) {
    const score = Math.max(scoreTitleSimilarity(combined, entry.title), scoreTitleSimilarity(pageContext?.title ?? "", entry.title));
    if (!best || score > best.score) {
      best = { entry, score };
    }
  }
  return best && best.score >= 0.42 ? best.entry : null;
}
function currentReaderBlockReason() {
  if (connectedTabs.length === 0 && !pageContext) {
    return "\u8BF7\u5148\u6253\u5F00\u4E00\u4E2A aim-read \u9605\u8BFB\u9875\u3002";
  }
  if (connectedTabs.length > 1) {
    return `\u68C0\u6D4B\u5230 ${connectedTabs.length} \u4E2A reader \u9875\u9762\uFF0C\u8BF7\u53EA\u4FDD\u7559\u4E00\u4E2A\u3002`;
  }
  if (articleSnapshotError) {
    return `\u5168\u6587\u83B7\u53D6\u5931\u8D25\uFF1A${articleSnapshotError}`;
  }
  return null;
}
function updateReaderUi() {
  const blockReason = currentReaderBlockReason();
  elements.readerStatusPill.classList.toggle("is-blocked", blockReason !== null);
  if (blockReason) {
    elements.readerStatusText.textContent = blockReason;
  } else if (pageContext) {
    elements.readerStatusText.textContent = `\u5DF2\u68C0\u6D4B\u5230 reader \u9875\u9762\uFF1A${pageContext.title || pageContext.articleUrl}`;
  } else {
    elements.readerStatusText.textContent = "\u6B63\u5728\u68C0\u6D4B reader \u9875\u9762\u2026";
  }
  const title = pageContext?.title ?? articleSnapshot?.title ?? "\u7B49\u5F85 reader \u9875\u9762";
  const paragraphCount = articleSnapshot?.paragraphs.length ?? pageContext?.paragraphs.length ?? 0;
  elements.readerContextValue.textContent = paragraphCount > 0 ? `${title} \xB7 ${paragraphCount} \u6BB5\u6B63\u6587` : title;
  elements.playerReaderPill.textContent = pageContext ? `reader\uFF1A${pageContext.title || "\u5DF2\u7ED1\u5B9A"}` : "reader\uFF1A\u7B49\u5F85\u7ED1\u5B9A";
  if (pageContext && !blockReason) {
    updateAutomationCard(elements.automationReaderCard, articleSnapshot ? "ready" : "busy");
  } else if (connectedTabs.length > 1 || articleSnapshotError) {
    updateAutomationCard(elements.automationReaderCard, "error");
  } else {
    updateAutomationCard(elements.automationReaderCard, "busy");
  }
}
function updateSubtitleChoiceUi() {
  elements.localSubtitleChoice.classList.toggle("is-selected", selectedSubtitleMode === "local");
  elements.subtitleDrop.classList.toggle("is-selected", selectedSubtitleMode === "manual");
  elements.onlineSubtitleChoice.classList.remove("is-selected");
  if (selectedSubtitleMode === "local") {
    if (localSubtitleMatch) {
      elements.localSubtitleState.textContent = `\u5DF2\u5339\u914D\uFF1A${localSubtitleMatch.fileName}`;
      elements.subtitleResultTitle.textContent = "\u5DF2\u4F7F\u7528\u672C\u5730\u81EA\u52A8\u5339\u914D";
      elements.subtitleResultDetail.textContent = `\u5F53\u524D\u5B57\u5E55\uFF1A${localSubtitleMatch.fileName} \xB7 \u82F1\u6587\u4E3B\u7EBF + \u4E2D\u6587\u5B57\u5E55\u4FDD\u7559`;
    } else {
      elements.localSubtitleState.textContent = subtitleIndexLoaded ? "\u672A\u5339\u914D\u5230\u5F53\u524D\u5267\u96C6" : "\u6B63\u5728\u52A0\u8F7D\u672C\u5730\u5B57\u5E55\u7D22\u5F15";
      elements.subtitleResultTitle.textContent = "\u7B49\u5F85\u672C\u5730\u5B57\u5E55\u5339\u914D";
      elements.subtitleResultDetail.textContent = currentReaderBlockReason() ?? "\u6B63\u5728\u6839\u636E reader \u9875\u9762\u8BC6\u522B\u5267\u96C6\u3002";
    }
  } else if (loadedSubtitleDocument) {
    elements.subtitleResultTitle.textContent = "\u5DF2\u4F7F\u7528\u624B\u52A8\u5B57\u5E55";
    elements.subtitleResultDetail.textContent = `\u5F53\u524D\u5B57\u5E55\uFF1A${loadedSubtitleDocument.fileName} \xB7 ${loadedSubtitleDocument.metadata.segmentCount} \u6761\u5B57\u5E55`;
  } else {
    elements.subtitleResultTitle.textContent = "\u7B49\u5F85\u624B\u52A8\u5B57\u5E55";
    elements.subtitleResultDetail.textContent = "\u8BF7\u62D6\u5165 ASS\u3001SSA\u3001SRT \u6216 VTT \u5B57\u5E55\u6587\u4EF6\u3002";
  }
  const buildResult = currentRuntimeBuild;
  const ready = loadedSubtitleDocument !== null && buildResult !== null && manifest !== null && currentReaderBlockReason() === null;
  elements.toVideo.disabled = !ready;
  updateAutomationCard(elements.automationSubtitleCard, ready ? "ready" : runtimeBuildFailedFingerprint ? "error" : "busy");
  if (ready && buildResult) {
    elements.subtitleResultTitle.textContent = selectedSubtitleMode === "local" ? "\u5DF2\u4F7F\u7528\u672C\u5730\u81EA\u52A8\u5339\u914D" : "\u5DF2\u4F7F\u7528\u624B\u52A8\u5B57\u5E55";
    elements.subtitleResultDetail.textContent = `\u5DF2\u751F\u6210\u8FD0\u884C\u65F6\u6E05\u5355\uFF1A\u8986\u76D6 ${Math.round(buildResult.stats.coverageRatio * 100)}%\uFF0C\u547D\u4E2D ${buildResult.stats.matchedParagraphCount}/${buildResult.stats.articleParagraphCount} \u6BB5\u3002`;
  } else if (loadedSubtitleDocument && !currentRuntimeBuild) {
    elements.subtitleResultTitle.textContent = "\u6B63\u5728\u6784\u5EFA\u540C\u6B65\u7D22\u5F15";
    elements.subtitleResultDetail.textContent = currentReaderBlockReason() ?? "\u5B57\u5E55\u5DF2\u8F7D\u5165\uFF0C\u6B63\u5728\u7B49\u5F85 reader \u5168\u6587\u5FEB\u7167\u5E76\u751F\u6210\u8FD0\u884C\u65F6\u5339\u914D\u3002";
  }
  const subtitleName = loadedSubtitleDocument?.fileName ?? "\u7B49\u5F85\u5B57\u5E55";
  elements.videoSubtitleChip.textContent = subtitleName;
  elements.playerSubtitlePill.textContent = `\u5B57\u5E55\uFF1A${subtitleName}`;
}
function updateAllUi() {
  updateReaderUi();
  updateSubtitleChoiceUi();
  updateTrainingUi();
}
function setSubtitleStatus(message) {
  elements.subtitleResultDetail.textContent = message;
}
function resetRuntimeSubtitleBuild() {
  currentRuntimeBuild = null;
  runtimeBuildInFlight = false;
  runtimeBuildRequestedFingerprint = null;
  runtimeBuildFailedFingerprint = null;
  articleSnapshotRequestIssuedAt = null;
  articleSnapshotLastRequestedAt = 0;
}
function resolveRuntimeBuildFingerprint() {
  if (!loadedSubtitleDocument || !articleSnapshot) {
    return null;
  }
  return [
    loadedSubtitleDocument.fileName,
    loadedSubtitleDocument.metadata.segmentCount,
    articleSnapshot.articleUrl,
    articleSnapshot.paragraphs.length
  ].join("::");
}
function requestArticleSnapshot() {
  const now = Date.now();
  if (articleSnapshotRequestIssuedAt === null) {
    articleSnapshotRequestIssuedAt = now;
  }
  if (now - articleSnapshotLastRequestedAt < 4e3) {
    return;
  }
  articleSnapshotLastRequestedAt = now;
  postRuntimeMessage({ type: "REQUEST_ACTIVE_ARTICLE_SNAPSHOT" });
}
function rebuildManifestLookups(manifestValue) {
  transcriptSegmentsByIndex = new Map(
    manifestValue.transcript.segments.map((segment) => [segment.index, segment])
  );
  articleParagraphsByIndex = new Map(
    (manifestValue.article?.paragraphs ?? []).map((paragraph) => [paragraph.paragraphIndex, paragraph])
  );
}
function installManifest(manifestValue) {
  manifest = manifestValue;
  rebuildManifestLookups(manifestValue);
  elements.playerStatus.textContent = `\u540C\u6B65\u5DF2\u5C31\u7EEA\uFF1A${manifestValue.sync.length} \u6761\u6620\u5C04\u3002`;
  broadcastPlayerState(true);
}
function maybeRebuildRuntimeSubtitleManifest() {
  if (!loadedSubtitleDocument) {
    return;
  }
  if (articleSnapshotError) {
    setSubtitleStatus(`\u5B57\u5E55\u5DF2\u8F7D\u5165\uFF0C\u7B49\u5F85\u5168\u6587\u6587\u7AE0\u5FEB\u7167\uFF1A${articleSnapshotError}`);
    return;
  }
  if (!articleSnapshot) {
    setSubtitleStatus("\u5B57\u5E55\u5DF2\u8F7D\u5165\uFF0C\u6B63\u5728\u83B7\u53D6\u5168\u6587\u6587\u7AE0\u5FEB\u7167\u3002");
    requestArticleSnapshot();
    return;
  }
  const fingerprint = resolveRuntimeBuildFingerprint();
  if (!fingerprint) {
    return;
  }
  if (fingerprint === runtimeBuildFingerprint && currentRuntimeBuild) {
    updateSubtitleChoiceUi();
    return;
  }
  if (fingerprint === runtimeBuildFailedFingerprint || runtimeBuildInFlight && fingerprint === runtimeBuildRequestedFingerprint) {
    return;
  }
  const activeBuildToken = ++runtimeBuildToken;
  const activeSubtitleDocument = loadedSubtitleDocument;
  const activeArticleSnapshot = articleSnapshot;
  runtimeBuildInFlight = true;
  runtimeBuildRequestedFingerprint = fingerprint;
  currentRuntimeBuild = null;
  setSubtitleStatus("\u5B57\u5E55\u5DF2\u8F7D\u5165\uFF0C\u6B63\u5728\u6267\u884C\u8FD0\u884C\u65F6\u5339\u914D... 0%");
  void buildRuntimeManifestFromSubtitleAsync(activeSubtitleDocument, activeArticleSnapshot, (progress) => {
    if (activeBuildToken !== runtimeBuildToken) {
      return;
    }
    setSubtitleStatus(`\u5B57\u5E55\u5DF2\u8F7D\u5165\uFF0C\u6B63\u5728\u6267\u884C\u8FD0\u884C\u65F6\u5339\u914D... ${Math.round(progress.percent * 100)}% \xB7 ${progress.message}`);
  }).then((buildResult) => {
    if (activeBuildToken !== runtimeBuildToken) {
      return;
    }
    runtimeBuildInFlight = false;
    runtimeBuildFingerprint = fingerprint;
    runtimeBuildRequestedFingerprint = null;
    runtimeBuildFailedFingerprint = null;
    currentRuntimeBuild = buildResult;
    installManifest(buildResult.manifest);
    elements.subtitleResultTitle.textContent = selectedSubtitleMode === "local" ? "\u5DF2\u4F7F\u7528\u672C\u5730\u81EA\u52A8\u5339\u914D" : "\u5DF2\u4F7F\u7528\u624B\u52A8\u5B57\u5E55";
    elements.subtitleResultDetail.textContent = `\u5DF2\u751F\u6210\u8FD0\u884C\u65F6\u6E05\u5355\uFF1A\u8986\u76D6 ${Math.round(buildResult.stats.coverageRatio * 100)}%\uFF0C\u547D\u4E2D ${buildResult.stats.matchedParagraphCount}/${buildResult.stats.articleParagraphCount} \u6BB5\u3002`;
    updateSubtitleChoiceUi();
    logger.info("Runtime subtitle manifest built", {
      subtitleFile: activeSubtitleDocument.fileName,
      articleId: activeArticleSnapshot.articleId,
      matchedParagraphCount: buildResult.stats.matchedParagraphCount
    });
  }).catch((error) => {
    if (activeBuildToken !== runtimeBuildToken) {
      return;
    }
    resetRuntimeSubtitleBuild();
    runtimeBuildFailedFingerprint = fingerprint;
    const message = error instanceof Error ? error.message : String(error);
    setSubtitleStatus(`\u5B57\u5E55\u5339\u914D\u5931\u8D25\uFF1A${message}`);
    updateSubtitleChoiceUi();
    logger.warn("Runtime subtitle manifest failed", { message });
  });
}
async function installSubtitleFile(file, mode, options) {
  if (!isCurrentEpisodeGeneration(options?.episodeGeneration)) {
    return;
  }
  selectedSubtitleMode = mode;
  elements.subtitleFileState.textContent = file.name;
  const parsed = await parseSubtitleFile(file);
  if (!isCurrentEpisodeGeneration(options?.episodeGeneration)) {
    return;
  }
  loadedSubtitleDocument = parsed;
  resetRuntimeSubtitleBuild();
  elements.playerSubtitlePill.textContent = `\u5B57\u5E55\uFF1A${parsed.fileName}`;
  updateSubtitleChoiceUi();
  maybeRebuildRuntimeSubtitleManifest();
}
async function loadLocalSubtitle(match, expectedEpisodeGeneration) {
  const response = await fetch(chrome.runtime.getURL(match.path));
  if (!response.ok) {
    throw new Error(`\u672C\u5730\u5B57\u5E55\u52A0\u8F7D\u5931\u8D25 (${response.status})`);
  }
  const blob = await response.blob();
  if (!isCurrentEpisodeGeneration(expectedEpisodeGeneration)) {
    return;
  }
  const file = new File([blob], match.fileName, { type: "text/plain" });
  await installSubtitleFile(file, "local", { episodeGeneration: expectedEpisodeGeneration });
}
async function refreshLocalSubtitleMatch() {
  const expectedEpisodeGeneration = episodeGeneration;
  await loadSubtitleIndex();
  if (!isCurrentEpisodeGeneration(expectedEpisodeGeneration)) {
    return;
  }
  localSubtitleMatch = resolveLocalSubtitleMatch();
  updateSubtitleChoiceUi();
  void autoLoadMatchedMedia().catch((error) => {
    elements.mediaLibraryStatus.textContent = `自动匹配视频失败：${error instanceof Error ? error.message : String(error)}`;
  });
  if (selectedSubtitleMode !== "local" || !localSubtitleMatch || currentReaderBlockReason() !== null) {
    return;
  }
  if (loadedSubtitleDocument?.fileName === localSubtitleMatch.fileName) {
    maybeRebuildRuntimeSubtitleManifest();
    return;
  }
  try {
    await loadLocalSubtitle(localSubtitleMatch, expectedEpisodeGeneration);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.localSubtitleState.textContent = message;
    elements.subtitleResultTitle.textContent = "\u672C\u5730\u5B57\u5E55\u52A0\u8F7D\u5931\u8D25";
    elements.subtitleResultDetail.textContent = "\u8BF7\u6539\u7528\u624B\u52A8\u62D6\u5165\u5B57\u5E55\u3002";
  }
}
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "00:00.000";
  }
  const minutes = Math.floor(seconds / 60);
  const wholeSeconds = Math.floor(seconds % 60);
  const milliseconds = Math.floor(seconds % 1 * 1e3);
  return `${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}
function syncPlayerReadout() {
  const duration = Number.isFinite(elements.video.duration) ? elements.video.duration : 0;
  elements.timeReadout.textContent = `${formatTime(elements.video.currentTime)} / ${formatTime(duration)}`;
  elements.playToggle.textContent = elements.video.paused ? "\u64AD\u653E" : "\u6682\u505C";
}
function describeVideoProbe(fileName, probe) {
  const videoStream = probe.streams.find((stream) => stream.codecType === "video");
  const audioStreams = probe.streams.filter((stream) => stream.codecType === "audio");
  const container = formatContainerFormats(resolveContainerFormatsForDisplay(fileName, probe.containerFormats));
  const video = videoStream ? `${formatVideoCodec(videoStream.codecName)}${videoStream.width && videoStream.height ? ` ${videoStream.width}x${videoStream.height}` : ""}` : "none";
  const audio = formatAudioCodecs(audioStreams.map((stream) => stream.codecName));
  return {
    container,
    video,
    audio,
    detail: `\u5C01\u88C5 ${container}\uFF0C\u89C6\u9891 ${video}\uFF0C\u97F3\u9891 ${audio}`
  };
}
function describeTranscodePlan(strategy) {
  const containerStep = strategy.containerAction === "copy" ? "\u5C01\u88C5\u65E0\u9700\u91CD\u505A" : "\u91CD\u5C01\u88C5\u5230 MP4";
  const videoStep = strategy.videoAction === "copy" ? `\u89C6\u9891\u590D\u7528 ${formatVideoCodec(strategy.videoCodec)}` : "\u89C6\u9891\u8F6C H.264/AVC";
  const audioStep = strategy.audioAction === "copy" ? `\u97F3\u9891\u590D\u7528 ${formatAudioCodecs(strategy.audioCodecs)}` : `\u97F3\u9891\u8F6C AAC\uFF08\u5F53\u524D ${formatAudioCodecs(strategy.audioCodecs)}\uFF09`;
  return `${containerStep}\uFF1B${videoStep}\uFF1B${audioStep}`;
}
function setProcessingProgress(message, percent) {
  elements.processingBox.classList.add("is-active");
  if (typeof percent === "number" && Number.isFinite(percent)) {
    elements.processingProgress.value = Math.min(100, Math.max(0, Math.round(percent * 100)));
  }
  elements.processingText.textContent = message;
}
function setVideoTranscodeProgress(message, progress) {
  if (!Number.isFinite(progress)) {
    return;
  }
  const clampedProgress = clamp(progress, 0, 1);
  const visibleProgress = clampedProgress >= 1 ? 0.99 : clampedProgress;
  setProcessingProgress(`${message} \xB7 ${Math.round(visibleProgress * 100)}%`, visibleProgress);
}
function updateVideoDecisionControls() {
  const hasSourceVideo = sourceVideoFile !== null;
  const canDirectPlay = hasSourceVideo && !videoInspectionBusy && !videoTranscodeBusy;
  const canPreprocess = hasSourceVideo && sourceVideoProbe !== null && sourceVideoAssessment !== null && !sourceVideoAssessment.isRecommendedProfile && !videoInspectionBusy && !videoTranscodeBusy;
  elements.riskPlay.disabled = !canDirectPlay;
  elements.processPlay.disabled = !(canPreprocess || sourceVideoAssessment?.isRecommendedProfile && canDirectPlay);
  elements.processPlay.textContent = sourceVideoAssessment?.isRecommendedProfile ? "\u76F4\u63A5\u8FDB\u5165\u64AD\u653E" : "\u4E00\u952E\u5904\u7406\u5E76\u64AD\u653E";
}
function revokeProcessedVideoArtifact() {
  if (processedVideoObjectUrl) {
    URL.revokeObjectURL(processedVideoObjectUrl);
    processedVideoObjectUrl = null;
  }
  processedVideoFile = null;
}
function resetVideoDecisionState(fileName) {
  videoSourceChangeBusy = true;
  elements.video.pause();
  const currentVideoObjectUrl = videoObjectUrl;
  const currentProcessedVideoObjectUrl = processedVideoObjectUrl;
  videoObjectUrl = null;
  processedVideoObjectUrl = null;
  elements.video.removeAttribute("src");
  elements.video.src = "";
  elements.video.currentTime = 0;
  if (currentVideoObjectUrl) {
    URL.revokeObjectURL(currentVideoObjectUrl);
  }
  if (currentProcessedVideoObjectUrl) {
    URL.revokeObjectURL(currentProcessedVideoObjectUrl);
  }
  elements.video.load();
  processedVideoFile = null;
  sourceVideoProbe = null;
  sourceVideoAssessment = null;
  sourceVideoStrategy = null;
  sourceVideoInspectionError = null;
  currentVideoVariant = null;
  elements.videoName.textContent = fileName ?? "\u672A\u5BFC\u5165";
  elements.videoContainer.textContent = "\u7B49\u5F85\u68C0\u6D4B";
  elements.videoCodec.textContent = "\u7B49\u5F85\u68C0\u6D4B";
  elements.audioCodec.textContent = "\u7B49\u5F85\u68C0\u6D4B";
  elements.videoPlan.textContent = "\u5BFC\u5165\u540E\u5224\u65AD";
  elements.processingBox.classList.remove("is-active");
  elements.processingProgress.value = 0;
  elements.processingText.textContent = "\u6B63\u5728\u51C6\u5907";
  elements.processPlay.textContent = "\u4E00\u952E\u5904\u7406\u5E76\u64AD\u653E";
  updateVideoDecisionControls();
  videoSourceChangeBusy = false;
}
function buildBrowserFfmpegStatusMessage(event) {
  if (event.detail?.message) {
    return event.detail.message;
  }
  switch (event.phase) {
    case "loading-core":
      return "\u6B63\u5728\u88C5\u8F7D\u5185\u7F6E FFmpeg Core";
    case "ready":
      return "\u5185\u7F6E FFmpeg Core \u5DF2\u5C31\u7EEA";
    case "writing-input":
      return "\u6B63\u5728\u5199\u5165\u8F93\u5165\u6587\u4EF6";
    case "probing":
      return "\u6B63\u5728\u68C0\u6D4B\u771F\u5B9E\u97F3\u89C6\u9891\u6D41";
    case "transcoding":
      return "\u6B63\u5728\u672C\u5730\u9884\u5904\u7406";
    case "finalizing-output":
      return "\u6B63\u5728\u5C01\u53E3 MP4 \u8F93\u51FA";
    case "reading-output":
      return "\u6B63\u5728\u8BFB\u53D6\u9884\u5904\u7406\u7ED3\u679C";
    case "completed":
      return "\u9884\u5904\u7406\u5B8C\u6210";
    default:
      return "\u6B63\u5728\u5904\u7406";
  }
}
async function loadVideoFile(file, options) {
  if (!isCurrentMediaLibraryRequest(options)) {
    return;
  }
  const extension = fileExtension(file.name);
  if (!supportedVideoExtensions.has(extension)) {
    elements.videoDropTitle.textContent = "\u53EA\u63A5\u53D7 MP4 \u6216 MKV";
    elements.videoDropDesc.textContent = "\u8BF7\u91CD\u65B0\u62D6\u5165\u6B63\u786E\u683C\u5F0F\u7684\u89C6\u9891\u6587\u4EF6\u3002";
    throw new Error("\u53EA\u652F\u6301 MP4 \u6216 MKV \u89C6\u9891\u6587\u4EF6\u3002");
  }
  await saveCurrentPlaybackBookmark();
  playbackRestoreGeneration += 1;
  sourceVideoFile = file;
  resetVideoDecisionState(file.name);
  elements.videoDropTitle.textContent = "\u89C6\u9891\u5DF2\u5BFC\u5165";
  elements.videoDropDesc.textContent = file.name;
  elements.playerVideoPill.textContent = `\u89C6\u9891\uFF1A${file.name}`;
  videoObjectUrl = URL.createObjectURL(file);
  elements.video.src = videoObjectUrl;
  elements.video.load();
  const token = ++videoInspectionToken;
  videoInspectionBusy = true;
  updateVideoDecisionControls();
  setProcessingProgress("\u6B63\u5728\u68C0\u6D4B\u771F\u5B9E\u97F3\u89C6\u9891\u6D41...", 0);
  try {
    const probe = await browserFfmpegService.inspectFile(file, {
      onStatusChange: (event) => setProcessingProgress(buildBrowserFfmpegStatusMessage(event)),
      onProgress: ({ progress }) => setProcessingProgress("\u6B63\u5728\u68C0\u6D4B\u771F\u5B9E\u97F3\u89C6\u9891\u6D41...", progress)
    });
    if (token !== videoInspectionToken || !isCurrentMediaLibraryRequest(options)) {
      return;
    }
    const assessment = assessMediaCompatibility(file.name, probe);
    const strategy = buildMediaTranscodeStrategy(file.name, probe);
    const probeDescription = describeVideoProbe(file.name, probe);
    sourceVideoProbe = probe;
    sourceVideoAssessment = assessment;
    sourceVideoStrategy = strategy;
    elements.videoContainer.textContent = probeDescription.container;
    elements.videoCodec.textContent = probeDescription.video;
    elements.audioCodec.textContent = probeDescription.audio;
    elements.videoPlan.textContent = assessment.isRecommendedProfile ? "\u53EF\u76F4\u63A5\u64AD\u653E" : describeTranscodePlan(strategy);
    elements.processingText.textContent = assessment.summary;
    elements.processingProgress.value = assessment.isRecommendedProfile ? 100 : 0;
    if (assessment.isRecommendedProfile) {
      videoInspectionBusy = false;
      updateVideoDecisionControls();
      await playOriginalVideoFile({ enterPlayer: options?.enterPlayer ?? true, episodeGeneration: options?.episodeGeneration, mediaLoadGeneration: options?.mediaLoadGeneration });
    }
  } catch (error) {
    if (token !== videoInspectionToken || !isCurrentMediaLibraryRequest(options)) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sourceVideoInspectionError = message;
    elements.videoPlan.textContent = "\u68C0\u6D4B\u5931\u8D25";
    elements.processingText.textContent = message;
    throw error;
  } finally {
    if (token === videoInspectionToken && isCurrentMediaLibraryRequest(options)) {
      videoInspectionBusy = false;
      updateVideoDecisionControls();
    }
    if (mediaLibraryPendingRequest && !mediaLibraryAutoLoadBusy) {
      void autoLoadMatchedMedia();
    }
  }
}
async function playOriginalVideoFile(options) {
  if (!isCurrentMediaLibraryRequest(options)) {
    return;
  }
  if (!sourceVideoFile || !videoObjectUrl) {
    throw new Error("\u8BF7\u5148\u62D6\u5165\u89C6\u9891\u6587\u4EF6\u3002");
  }
  currentVideoVariant = "original";
  elements.video.src = videoObjectUrl;
  elements.video.load();
  await waitForVideoMetadata();
  if (!isCurrentMediaLibraryRequest(options)) {
    return;
  }
  elements.playerVideoPill.textContent = `\u89C6\u9891\uFF1A${sourceVideoFile.name}`;
  elements.playerNote.textContent = sourceVideoAssessment?.isRecommendedProfile ? "\u5DF2\u547D\u4E2D\u63A8\u8350\u64AD\u653E\u57FA\u7EBF\uFF0C\u5F00\u59CB\u540C\u6B65 reader \u9875\u9762\u3002" : "\u6B63\u5728\u8BD5\u64AD\u539F\u59CB\u6587\u4EF6\uFF0C\u82E5\u5931\u8D25\u8BF7\u8FD4\u56DE\u4E00\u952E\u5904\u7406\u3002";
  elements.playerStatus.textContent = sourceVideoAssessment?.isRecommendedProfile ? "\u89C6\u9891\u53EF\u76F4\u63A5\u64AD\u653E\u3002" : "\u6B63\u5728\u8BD5\u64AD\u539F\u59CB\u6587\u4EF6\uFF1B\u5982\u65E0\u58F0\u6216\u9ED1\u5C4F\uFF0C\u8BF7\u5207\u6362\u4E0B\u4E00\u96C6\u540E\u91CD\u65B0\u4E00\u952E\u5904\u7406\u3002";
  await restoreCurrentPlaybackBookmark();
  updateTrainingUi();
  if (options?.enterPlayer) {
    setView("player");
  }
}
async function playProcessedVideoFile() {
  if (!processedVideoFile || !processedVideoObjectUrl) {
    throw new Error("\u5F53\u524D\u8FD8\u6CA1\u6709\u9884\u5904\u7406\u7ED3\u679C\u3002");
  }
  currentVideoVariant = "processed";
  elements.video.src = processedVideoObjectUrl;
  elements.video.load();
  await waitForVideoMetadata();
  elements.playerVideoPill.textContent = `\u89C6\u9891\uFF1A${processedVideoFile.name}`;
  elements.playerNote.textContent = "\u5DF2\u5B8C\u6210\u517C\u5BB9\u5904\u7406\uFF0C\u5F00\u59CB\u540C\u6B65 reader \u9875\u9762\u3002";
  elements.playerStatus.textContent = "\u517C\u5BB9\u5224\u65AD\u5B8C\u6210\uFF0C\u53EF\u4EE5\u64AD\u653E\u3001\u8C03\u901F\u3001\u6C89\u6D78\u6216\u5207\u6362\u753B\u4E2D\u753B\u3002";
  await restoreCurrentPlaybackBookmark();
  updateTrainingUi();
  setView("player");
}
function waitForVideoMetadata(timeoutMs = 12e3) {
  if (elements.video.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(elements.video.duration)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("\u89C6\u9891\u6587\u4EF6\u5DF2\u751F\u6210\uFF0C\u4F46\u6D4F\u89C8\u5668\u672A\u80FD\u8BFB\u53D6 metadata\uFF0C\u8BF7\u8FD4\u56DE\u4F7F\u7528\u539F\u6587\u4EF6\u8BD5\u64AD\u6216\u91CD\u65B0\u5904\u7406\u3002"));
    }, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timeout);
      elements.video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      elements.video.removeEventListener("error", handleError);
    };
    const handleLoadedMetadata = () => {
      if (!Number.isFinite(elements.video.duration)) {
        return;
      }
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      const message = elements.video.error?.message || `\u6D4F\u89C8\u5668\u65E0\u6CD5\u8BFB\u53D6\u5904\u7406\u540E\u89C6\u9891\uFF0C\u9519\u8BEF\u7801 ${elements.video.error?.code ?? "unknown"}\u3002`;
      reject(new Error(message));
    };
    elements.video.addEventListener("loadedmetadata", handleLoadedMetadata);
    elements.video.addEventListener("error", handleError);
  });
}
async function preprocessVideoFile() {
  if (!sourceVideoFile || !sourceVideoProbe || !sourceVideoStrategy) {
    throw new Error("\u8BF7\u5148\u62D6\u5165\u5E76\u5B8C\u6210\u68C0\u6D4B\u3002");
  }
  if (sourceVideoAssessment?.isRecommendedProfile) {
    await playOriginalVideoFile({ enterPlayer: true });
    return;
  }
  if (videoInspectionBusy || videoTranscodeBusy) {
    throw new Error("\u5F53\u524D\u5DF2\u6709\u89C6\u9891\u4EFB\u52A1\u5728\u6267\u884C\u3002");
  }
  const sourceFile = sourceVideoFile;
  const sourceProbe = sourceVideoProbe;
  const strategy = sourceVideoStrategy;
  videoTranscodeBusy = true;
  updateVideoDecisionControls();
  setProcessingProgress("\u51C6\u5907\u5199\u5165\u89C6\u9891\u5E76\u542F\u52A8\u9884\u5904\u7406...", 0);
  try {
    revokeProcessedVideoArtifact();
    const result = await browserFfmpegService.transcodeFile(sourceFile, sourceProbe, {
      onStatusChange: (event) => {
        const message = buildBrowserFfmpegStatusMessage(event);
        if (event.phase === "finalizing-output" || event.phase === "reading-output") {
          setProcessingProgress(message, 0.99);
          return;
        }
        if (event.phase === "completed") {
          setProcessingProgress(message, 1);
          return;
        }
        setProcessingProgress(message);
      },
      onProgress: ({ progress }) => {
        setVideoTranscodeProgress(describeTranscodePlan(strategy), progress);
      }
    });
    processedVideoFile = result.file;
    processedVideoObjectUrl = URL.createObjectURL(result.blob);
    elements.videoName.textContent = result.file.name;
    elements.videoPlan.textContent = "\u5DF2\u751F\u6210\u517C\u5BB9\u7248\u672C";
    setProcessingProgress(`\u5DF2\u751F\u6210 ${result.file.name}\uFF0C\u6B63\u5728\u8FDB\u5165\u64AD\u653E\u3002`, 1);
    await playProcessedVideoFile();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.processingText.textContent = message;
    elements.playerStatus.textContent = message;
    throw error;
  } finally {
    videoTranscodeBusy = false;
    updateVideoDecisionControls();
  }
}
function resolveActiveParagraphIndex(currentTimeMs) {
  return resolveActiveSyncEntry(manifest, currentTimeMs)?.paragraphIndex ?? null;
}
function broadcastPlayerState(force = false) {
  const now = Date.now();
  if (!force && now - lastBroadcastAt < 250) {
    return;
  }
  lastBroadcastAt = now;
  const state = elements.video.error ? "error" : elements.video.ended ? "ended" : elements.video.paused ? "paused" : "playing";
  const currentTimeMs = Math.round(elements.video.currentTime * 1e3);
  postRuntimeMessage({
    type: "PLAYER_STATE_UPDATE",
    payload: {
      currentTimeMs,
      state,
      activeParagraphIndex: resolveActiveParagraphIndex(currentTimeMs),
      manifestSlug: manifest?.source.slug ?? null,
      playbackRate: elements.video.playbackRate
    }
  });
}
function broadcastIdlePlayerState() {
  postRuntimeMessage({
    type: "PLAYER_STATE_UPDATE",
    payload: {
      currentTimeMs: 0,
      state: "idle",
      activeParagraphIndex: null,
      manifestSlug: manifest?.source.slug ?? null,
      playbackRate: elements.video.playbackRate
    }
  });
}
function setFeedbackBusy(busy) {
  feedbackExportBusy = busy;
  elements.confirmFeedback.disabled = busy;
  elements.cancelFeedback.disabled = busy;
  elements.exportLogs.disabled = busy;
}
function openFeedbackDialog() {
  elements.feedbackStatus.textContent = "\u786E\u8BA4\u540E\u4F1A\u751F\u6210 zip \u538B\u7F29\u5305\u5E76\u6253\u5F00\u53CD\u9988\u9875\u3002";
  elements.feedbackStatus.classList.remove("is-error");
  elements.feedbackDialog.showModal();
}
async function exportFeedbackBundle() {
  if (feedbackExportBusy) {
    return;
  }
  setFeedbackBusy(true);
  elements.feedbackStatus.textContent = "\u6B63\u5728\u6574\u7406\u65E5\u5FD7\u5E76\u751F\u6210\u53CD\u9988\u538B\u7F29\u5305...";
  elements.feedbackStatus.classList.remove("is-error");
  logger.info("User requested feedback log export", {
    includeScreenshot: elements.feedbackIncludeScreenshot.checked,
    hasDescription: elements.feedbackDescription.value.trim().length > 0
  });
  postRuntimeMessage({
    type: "EXPORT_FEEDBACK_BUNDLE",
    payload: {
      description: elements.feedbackDescription.value,
      includeScreenshot: elements.feedbackIncludeScreenshot.checked
    }
  });
}
function seekToParagraph(paragraphIndex) {
  const entry = manifest?.sync.find((item) => item.paragraphIndex === paragraphIndex);
  if (!entry) {
    return;
  }
  playbackRestoreGeneration += 1;
  elements.video.currentTime = Math.max(0, entry.startMs / 1e3);
  broadcastPlayerState(true);
}
function applyPlayerControl(command) {
  if (command.type === "PLAYER_SEEK_COMMAND") {
    seekToParagraph(command.payload.paragraphIndex);
    return;
  }
  if (command.type !== "PLAYER_CONTROL_COMMAND") {
    return;
  }
  const payload = command.payload;
  if (payload.command === "toggle_playback") {
    void togglePlayback().catch((error) => {
      elements.playerStatus.textContent = error instanceof Error ? error.message : String(error);
    });
  } else if (payload.command === "seek_by") {
    playbackRestoreGeneration += 1;
    elements.video.currentTime = Math.max(0, elements.video.currentTime + (payload.deltaMs ?? 0) / 1e3);
  } else if (payload.command === "step_playback_rate") {
    const nextRate = clamp(elements.video.playbackRate + (payload.step ?? 0) * 0.25, 0.5, 2);
    setPlaybackRate(nextRate);
  }
  broadcastPlayerState(true);
}
function handleRuntimeMessage(message) {
  switch (message.type) {
    case "CONNECTED_TABS_RESPONSE":
      connectedTabs = message.payload.tabs;
      activePageTabId = message.payload.preferredTabId;
      if (connectedTabs.length === 1) {
        const onlyTab = connectedTabs[0];
        if (onlyTab && message.payload.preferredTabId !== onlyTab.tabId) {
          postRuntimeMessage({ type: "SET_PREFERRED_TAB", payload: { tabId: onlyTab.tabId } });
        }
      }
      updateAllUi();
      void refreshLocalSubtitleMatch();
      if (connectedTabs.length === 0 && !pageContext) {
        scheduleReaderDiscoveryWatchdog({ allowReload: true });
      } else {
        stopReaderDiscoveryWatchdog();
      }
      return;
    case "ACTIVE_PAGE_CONTEXT_RESPONSE":
      activePageTabId = message.payload.tabId;
      if (message.payload.pageContext) {
        beginReaderEpisodeTransition(message.payload.pageContext);
      }
      pageContext = message.payload.pageContext;
      updateAllUi();
      if (pageContext) {
        stopReaderDiscoveryWatchdog();
      } else {
        scheduleReaderDiscoveryWatchdog({ allowReload: true });
      }
      void refreshLocalSubtitleMatch();
      void autoLoadMatchedMedia().catch((error) => {
        elements.mediaLibraryStatus.textContent = `自动匹配视频失败：${error instanceof Error ? error.message : String(error)}`;
      });
      return;
    case "ACTIVE_ARTICLE_SNAPSHOT_RESPONSE":
      if (message.payload.articleSnapshot && pageContext) {
        const incomingSnapshot = message.payload.articleSnapshot;
        const articleIdMatches = incomingSnapshot.articleId === null || pageContext.articleId === null || incomingSnapshot.articleId === pageContext.articleId;
        const articleUrlMatches = !incomingSnapshot.articleUrl || !pageContext.articleUrl || incomingSnapshot.articleUrl === pageContext.articleUrl;
        if (!articleIdMatches || !articleUrlMatches) {
          logger.warn("Ignored stale article snapshot after Reader episode change", {
            incomingArticleId: incomingSnapshot.articleId,
            activeArticleId: pageContext.articleId,
            incomingArticleUrl: incomingSnapshot.articleUrl,
            activeArticleUrl: pageContext.articleUrl
          });
          return;
        }
      }
      articleSnapshot = message.payload.articleSnapshot;
      articleSnapshotError = message.payload.error;
      if (articleSnapshot || articleSnapshotError) {
        articleSnapshotRequestIssuedAt = null;
        articleSnapshotLastRequestedAt = 0;
      }
      updateAllUi();
      void refreshLocalSubtitleMatch();
      maybeRebuildRuntimeSubtitleManifest();
      void autoLoadMatchedMedia().catch((error) => {
        elements.mediaLibraryStatus.textContent = `自动匹配视频失败：${error instanceof Error ? error.message : String(error)}`;
      });
      return;
    case "PLAYER_SEEK_COMMAND":
    case "PLAYER_CONTROL_COMMAND":
      applyPlayerControl(message);
      return;
    case "EXPORT_FEEDBACK_BUNDLE_RESULT":
      setFeedbackBusy(false);
      if (message.payload.ok) {
        elements.feedbackStatus.classList.remove("is-error");
        elements.feedbackStatus.textContent = `\u5DF2\u751F\u6210 ${message.payload.fileName ?? "\u53CD\u9988\u538B\u7F29\u5305"}\uFF0C\u65E5\u5FD7 ${message.payload.logCount ?? 0} \u6761\u3002`;
        window.setTimeout(() => {
          if (elements.feedbackDialog.open) {
            elements.feedbackDialog.close();
          }
        }, 1200);
      } else {
        elements.feedbackStatus.classList.add("is-error");
        elements.feedbackStatus.textContent = message.payload.error ?? "\u5BFC\u51FA\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002";
      }
      return;
    default:
      return;
  }
}
function bindDropZone(zone, callback) {
  for (const eventName of ["dragenter", "dragover"]) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.add("is-dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.remove("is-dragging");
    });
  }
  zone.addEventListener("drop", (event) => {
    const dragEvent = event;
    const file = dragEvent.dataTransfer?.files[0];
    if (file) {
      callback(file);
    }
  });
}
function resetEpisode() {
  activeEpisodeKey = null;
  if (pageContext) {
    beginReaderEpisodeTransition(pageContext);
  }
  broadcastIdlePlayerState();
  postRuntimeMessage({ type: "REQUEST_CONNECTED_TABS" });
  postRuntimeMessage({ type: "REQUEST_ACTIVE_PAGE_CONTEXT" });
  postRuntimeMessage({ type: "REQUEST_ACTIVE_ARTICLE_SNAPSHOT" });
  scheduleReaderDiscoveryWatchdog({ reset: true, allowReload: true, resetReloadFallback: true });
  void refreshLocalSubtitleMatch();
}
function attachEvents() {
  elements.exportLogs.addEventListener("click", openFeedbackDialog);
  elements.cancelFeedback.addEventListener("click", () => {
    if (!feedbackExportBusy) {
      elements.feedbackDialog.close();
    }
  });
  elements.feedbackForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void exportFeedbackBundle();
  });
  elements.themeToggle.addEventListener("click", () => {
    void cyclePlayerThemeMode().catch((error) => {
      logger.warn("Failed to persist player theme", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
  elements.chooseLibraryFolder.addEventListener("click", () => {
    void chooseMediaLibraryFolder().catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      elements.mediaLibraryStatus.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  elements.rescanLibrary.addEventListener("click", () => {
    void scanAndPrepareMediaLibrary().catch((error) => {
      elements.mediaLibraryStatus.textContent = error instanceof Error ? error.message : String(error);
      mediaLibraryBusy = false;
      updateMediaLibraryUi();
    });
  });
  elements.cancelLibraryScan.addEventListener("click", () => {
    if (!mediaLibraryBusy) {
      return;
    }
    mediaLibraryCancelRequested = true;
    elements.mediaLibraryStatus.textContent = "正在停止当前预处理，已完成的结果会保留…";
    browserFfmpegService.terminate();
  });
  elements.libraryPreprocess.addEventListener("change", () => {
    mediaLibrarySettings.preprocess = elements.libraryPreprocess.checked;
    void persistMediaLibraryState().then(() => {
      if (mediaLibrarySettings.preprocess && mediaLibraryDirectoryHandle) {
        return scanAndPrepareMediaLibrary();
      }
    }).catch((error) => {
      elements.mediaLibraryStatus.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  elements.libraryVariant.addEventListener("change", () => {
    mediaLibrarySettings.preferredVariant = elements.libraryVariant.value;
    currentMediaLibraryMatch = resolveMediaLibraryMatch();
    updateMediaLibraryUi();
    void persistMediaLibraryState();
    void autoLoadMatchedMedia().catch((error) => {
      elements.mediaLibraryStatus.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  elements.trainingEnabled.addEventListener("change", () => {
    void (async () => {
      await saveCurrentPlaybackBookmark();
      trainingSettings.enabled = elements.trainingEnabled.checked;
      trainingSettings.paused = false;
      await applyTrainingSettingsChange({ restart: trainingSettings.enabled });
    })().catch((error) => {
      elements.trainingRouteStatus.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  elements.trainingDefaultPlan.addEventListener("change", () => {
    void (async () => {
      await saveCurrentPlaybackBookmark();
      trainingSettings.defaultPlanId = elements.trainingDefaultPlan.value;
      await applyTrainingSettingsChange();
    })().catch((error) => {
      elements.trainingRouteStatus.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  for (const input of [elements.trainingCustomBilingual, elements.trainingCustomEnglish, elements.trainingCustomClean]) {
    input.addEventListener("change", () => {
      void (async () => {
        const counts = readCustomTrainingCountsFromUi();
        if (!counts) {
          return;
        }
        await saveCurrentPlaybackBookmark();
        trainingSettings.customCounts = counts;
        const episodeToken = currentReaderEpisodeToken();
        const record = episodeToken ? getEpisodeTrainingRecord(episodeToken, false) : null;
        if (episodeToken && record?.planId === "custom") {
          record.customCounts = { ...counts };
          trainingRecords[episodeToken] = record;
        }
        await applyTrainingSettingsChange();
      })().catch((error) => {
        elements.trainingRouteStatus.textContent = error instanceof Error ? error.message : String(error);
      });
    });
  }
  elements.trainingEpisodePlan.addEventListener("change", () => {
    const episodeToken = currentReaderEpisodeToken();
    if (!episodeToken) {
      return;
    }
    void (async () => {
      await saveCurrentPlaybackBookmark();
      const record = getEpisodeTrainingRecord(episodeToken, true);
      record.planId = elements.trainingEpisodePlan.value === "default" ? null : elements.trainingEpisodePlan.value;
      record.customCounts = record.planId === "custom" ? { ...trainingSettings.customCounts } : null;
      record.updatedAt = new Date().toISOString();
      trainingRecords[episodeToken] = record;
      await applyTrainingSettingsChange();
    })().catch((error) => {
      elements.trainingRouteStatus.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  elements.trainingPauseToggle.addEventListener("click", () => {
    void (async () => {
      await saveCurrentPlaybackBookmark();
      trainingSettings.paused = !trainingSettings.paused;
      await applyTrainingSettingsChange({ syncMedia: !trainingSettings.paused, restart: false });
    })().catch((error) => {
      elements.trainingRouteStatus.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  elements.trainingRestartPass.addEventListener("click", () => {
    void restartCurrentTrainingPass().catch((error) => {
      elements.playerStatus.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  elements.trainingCompletePass.addEventListener("click", () => {
    void completeCurrentTrainingPass("manual").catch((error) => {
      elements.playerStatus.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  elements.trainingUndo.addEventListener("click", () => {
    void undoTrainingCompletion().catch((error) => {
      elements.playerStatus.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  elements.trainingResetEpisode.addEventListener("click", () => {
    void resetCurrentEpisodeTraining().catch((error) => {
      elements.playerStatus.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  elements.localSubtitleChoice.addEventListener("click", () => {
    selectedSubtitleMode = "local";
    void refreshLocalSubtitleMatch();
  });
  elements.onlineSubtitleChoice.addEventListener("click", () => {
    elements.subtitleResultTitle.textContent = "\u5728\u7EBF\u5339\u914D\u6682\u672A\u5F00\u653E";
    elements.subtitleResultDetail.textContent = "\u540E\u7EED\u4ECE GitHub \u5B57\u5E55\u4ED3\u5E93\u52A8\u6001\u66F4\u65B0\u3002";
  });
  elements.subtitleFile.addEventListener("change", () => {
    const file = elements.subtitleFile.files?.[0];
    if (!file) {
      return;
    }
    const extension = fileExtension(file.name);
    if (!supportedSubtitleExtensions.has(extension)) {
      elements.subtitleFileState.textContent = "\u53EA\u652F\u6301 ASS/SSA/SRT/VTT";
      return;
    }
    void installSubtitleFile(file, "manual").catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      elements.subtitleResultTitle.textContent = "\u5B57\u5E55\u52A0\u8F7D\u5931\u8D25";
      elements.subtitleResultDetail.textContent = message;
    });
  });
  bindDropZone(elements.subtitleDrop, (file) => {
    void installSubtitleFile(file, "manual").catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      elements.subtitleResultTitle.textContent = "\u5B57\u5E55\u52A0\u8F7D\u5931\u8D25";
      elements.subtitleResultDetail.textContent = message;
    });
  });
  elements.toVideo.addEventListener("click", () => setView("video"));
  elements.backSubtitle.addEventListener("click", () => setView("subtitle"));
  elements.videoFile.addEventListener("change", () => {
    const file = elements.videoFile.files?.[0];
    if (file) {
      void loadVideoFile(file).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        elements.videoDropTitle.textContent = "\u89C6\u9891\u52A0\u8F7D\u5931\u8D25";
        elements.videoDropDesc.textContent = message;
      });
    }
  });
  bindDropZone(elements.videoDrop, (file) => {
    void loadVideoFile(file).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      elements.videoDropTitle.textContent = "\u89C6\u9891\u52A0\u8F7D\u5931\u8D25";
      elements.videoDropDesc.textContent = message;
    });
  });
  elements.processPlay.addEventListener("click", () => {
    void preprocessVideoFile().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      elements.processingText.textContent = message;
    });
  });
  elements.riskPlay.addEventListener("click", () => {
    elements.riskDialog.showModal();
  });
  elements.cancelRisk.addEventListener("click", () => elements.riskDialog.close());
  elements.confirmRisk.addEventListener("click", () => {
    elements.riskDialog.close();
    void playOriginalVideoFile({ enterPlayer: true });
  });
  elements.changeEpisode.addEventListener("click", resetEpisode);
  elements.playToggle.addEventListener("click", () => {
    void togglePlayback().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      elements.playerStatus.textContent = message;
    });
  });
  elements.playbackRateTrigger.addEventListener("click", () => {
    setRateMenuOpen(!elements.playbackRateOptions.classList.contains("is-open"));
  });
  for (const option of elements.playbackRateOptionButtons) {
    option.addEventListener("click", () => {
      const rate = Number(option.dataset.rate);
      if (!Number.isFinite(rate)) {
        return;
      }
      setPlaybackRate(rate);
      setRateMenuOpen(false);
      elements.playerStatus.textContent = `\u500D\u901F\u5DF2\u5207\u6362\u4E3A ${formatPlaybackRate(rate)}\u3002`;
      broadcastPlayerState(true);
    });
  }
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Node) || elements.playbackRateTrigger.contains(target) || elements.playbackRateOptions.contains(target)) {
      return;
    }
    setRateMenuOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setRateMenuOpen(false);
    }
  });
  elements.expandToggle.addEventListener("click", () => {
    elements.playerWrap.classList.toggle("is-expanded");
    const expanded = elements.playerWrap.classList.contains("is-expanded");
    document.body.classList.toggle("immersive-active", expanded);
    elements.expandToggle.textContent = expanded ? "\u9000\u51FA\u6C89\u6D78" : "\u6C89\u6D78";
    elements.playerStatus.textContent = expanded ? "\u5DF2\u8FDB\u5165\u6C89\u6D78\u64AD\u653E\u3002" : "\u5DF2\u9000\u51FA\u6C89\u6D78\u64AD\u653E\u3002";
  });
  elements.pipToggle.addEventListener("click", () => {
    void togglePictureInPicture();
  });
  for (const eventName of ["loadedmetadata", "timeupdate", "play", "pause", "ratechange", "seeked", "ended"]) {
    elements.video.addEventListener(eventName, () => {
      syncPlayerReadout();
      broadcastPlayerState(eventName !== "timeupdate");
      if (eventName === "timeupdate") {
        schedulePlaybackBookmarkSave();
      } else if (eventName === "pause" || eventName === "seeked") {
        void saveCurrentPlaybackBookmark().catch((error) => logger.warn("Failed to save playback bookmark", { error }));
      } else if (eventName === "ended") {
        void saveCurrentPlaybackBookmark().then(() => completeCurrentTrainingPass("ended")).catch((error) => {
          elements.playerStatus.textContent = error instanceof Error ? error.message : String(error);
        });
      }
    });
  }
  window.addEventListener("resize", scheduleCompactLayoutCheck);
  window.visualViewport?.addEventListener("resize", scheduleCompactLayoutCheck);
  window.visualViewport?.addEventListener("scroll", scheduleCompactLayoutCheck);
  window.addEventListener("pageshow", refreshReaderConnectionAfterResume);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      refreshReaderConnectionAfterResume();
    } else {
      void saveCurrentPlaybackBookmark();
    }
  });
}
async function togglePictureInPicture() {
  if (!document.pictureInPictureEnabled || typeof elements.video.requestPictureInPicture !== "function") {
    elements.playerStatus.textContent = "\u5F53\u524D\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u753B\u4E2D\u753B\u3002";
    return;
  }
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      elements.playerStatus.textContent = "\u5DF2\u9000\u51FA\u753B\u4E2D\u753B\u3002";
    } else {
      await elements.video.requestPictureInPicture();
      elements.playerStatus.textContent = "\u5DF2\u8FDB\u5165\u753B\u4E2D\u753B\u3002";
    }
  } catch (error) {
    elements.playerStatus.textContent = error instanceof Error ? error.message : "\u753B\u4E2D\u753B\u542F\u52A8\u5931\u8D25\u3002";
  }
}
async function bootstrap() {
  elements.video.controls = true;
  setView("player");
  await loadPlayerTheme();
  attachEvents();
  await restoreLearningState();
  await restoreMediaLibrary();
  connectPlayerPort();
  postRuntimeMessage({ type: "REQUEST_CONNECTED_TABS" });
  scheduleReaderDiscoveryWatchdog({ reset: true, allowReload: true, resetReloadFallback: true });
  await loadSubtitleIndex();
  updateAllUi();
  void refreshLocalSubtitleMatch();
  scheduleCompactLayoutCheck();
}
window.addEventListener("beforeunload", () => {
  void saveCurrentPlaybackBookmark();
  playerPageUnloading = true;
});
void bootstrap().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  elements.readerStatusText.textContent = message;
  elements.readerStatusPill.classList.add("is-blocked");
});
//# sourceMappingURL=player.js.map
