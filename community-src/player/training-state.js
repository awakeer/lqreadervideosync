export const TRAINING_VARIANTS = ["bilingual", "english", "clean"];

export const TRAINING_PRESETS = {
  standard: { bilingual: 2, english: 2, clean: 2 },
  advanced: { bilingual: 0, english: 2, clean: 2 }
};

export function sanitizeTrainingCounts(value, fallback = TRAINING_PRESETS.standard) {
  const source = value && typeof value === "object" ? value : fallback;
  const counts = {};
  for (const variant of TRAINING_VARIANTS) {
    const parsed = Number.parseInt(String(source[variant] ?? fallback[variant] ?? 0), 10);
    counts[variant] = Number.isFinite(parsed) ? Math.min(6, Math.max(0, parsed)) : 0;
  }
  if (TRAINING_VARIANTS.every((variant) => counts[variant] === 0)) {
    return { ...fallback };
  }
  return counts;
}

export function createDefaultTrainingSettings() {
  return {
    enabled: false,
    paused: false,
    defaultPlanId: "standard",
    customCounts: { ...TRAINING_PRESETS.standard }
  };
}

export function normalizeTrainingSettings(value) {
  const defaults = createDefaultTrainingSettings();
  if (!value || typeof value !== "object") {
    return defaults;
  }
  return {
    enabled: value.enabled === true,
    paused: value.paused === true,
    defaultPlanId: ["standard", "advanced", "custom"].includes(value.defaultPlanId) ? value.defaultPlanId : defaults.defaultPlanId,
    customCounts: sanitizeTrainingCounts(value.customCounts, defaults.customCounts)
  };
}

export function normalizeCompletionCounts(value) {
  const source = value && typeof value === "object" ? value : {};
  const counts = {};
  for (const variant of TRAINING_VARIANTS) {
    const parsed = Number.parseInt(String(source[variant] ?? 0), 10);
    counts[variant] = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }
  return counts;
}

export function normalizeEpisodeTrainingRecord(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    planId: ["standard", "advanced", "custom"].includes(source.planId) ? source.planId : null,
    customCounts: source.customCounts ? sanitizeTrainingCounts(source.customCounts) : null,
    completed: normalizeCompletionCounts(source.completed),
    history: Array.isArray(source.history) ? source.history.filter((variant) => TRAINING_VARIANTS.includes(variant)).slice(-100) : [],
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null
  };
}

export function normalizeEpisodeTrainingRecords(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  const records = {};
  for (const [episodeToken, record] of Object.entries(value)) {
    if (/^S\d{2}E\d{2}$/i.test(episodeToken)) {
      records[episodeToken.toUpperCase()] = normalizeEpisodeTrainingRecord(record);
    }
  }
  return records;
}

export function resolvePlanCounts(settings, episodeRecord) {
  const planId = episodeRecord?.planId ?? settings.defaultPlanId;
  if (planId === "custom") {
    return sanitizeTrainingCounts(episodeRecord?.customCounts ?? settings.customCounts);
  }
  return { ...(TRAINING_PRESETS[planId] ?? TRAINING_PRESETS.standard) };
}

export function buildTrainingPasses(counts) {
  const normalized = sanitizeTrainingCounts(counts);
  const passes = [];
  for (const variant of TRAINING_VARIANTS) {
    for (let ordinal = 1; ordinal <= normalized[variant]; ordinal += 1) {
      passes.push({
        variant,
        ordinal,
        key: `${variant}:${ordinal}`
      });
    }
  }
  return passes;
}

export function resolveCurrentTrainingPass(counts, completedValue) {
  const completed = normalizeCompletionCounts(completedValue);
  const passes = buildTrainingPasses(counts);
  const completedTotal = TRAINING_VARIANTS.reduce((sum, variant) => sum + Math.min(completed[variant], counts[variant] ?? 0), 0);
  for (let index = 0; index < passes.length; index += 1) {
    const pass = passes[index];
    if (completed[pass.variant] < pass.ordinal) {
      return { ...pass, index, total: passes.length, completedTotal };
    }
  }
  return null;
}

export function completeTrainingPass(recordValue, variant, completedAt = new Date().toISOString()) {
  const record = normalizeEpisodeTrainingRecord(recordValue);
  if (!TRAINING_VARIANTS.includes(variant)) {
    return record;
  }
  record.completed[variant] += 1;
  record.history.push(variant);
  record.history = record.history.slice(-100);
  record.updatedAt = completedAt;
  return record;
}

export function undoLastTrainingCompletion(recordValue, updatedAt = new Date().toISOString()) {
  const record = normalizeEpisodeTrainingRecord(recordValue);
  const variant = record.history.pop() ?? null;
  if (variant) {
    record.completed[variant] = Math.max(0, record.completed[variant] - 1);
    record.updatedAt = updatedAt;
  }
  return { record, variant };
}

export function buildMediaFingerprint(file, entry) {
  const name = entry?.relativePath ?? file?.name ?? "unknown";
  const size = Number(entry?.sourceSize ?? file?.size ?? 0);
  const modified = Number(entry?.sourceLastModified ?? file?.lastModified ?? 0);
  return `${String(name).toLowerCase()}@${size}:${modified}`;
}

export function buildPlaybackBookmarkKey(identity) {
  const parts = [
    identity.episodeToken ?? "manual",
    identity.variant ?? "unknown",
    identity.mediaFingerprint ?? "unknown",
    identity.trainingPassKey ?? "ordinary"
  ];
  return parts.map((part) => encodeURIComponent(String(part))).join("|");
}

export function canRestorePlaybackBookmark(bookmark, identity, durationSeconds) {
  if (!bookmark || !identity || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return false;
  }
  if (bookmark.episodeToken !== identity.episodeToken || bookmark.variant !== identity.variant || bookmark.mediaFingerprint !== identity.mediaFingerprint || bookmark.trainingPassKey !== identity.trainingPassKey) {
    return false;
  }
  return Number.isFinite(bookmark.currentTimeSeconds) && bookmark.currentTimeSeconds >= 3 && bookmark.currentTimeSeconds < durationSeconds;
}

export function listTrainingEpisodeTokens(mediaEntries, records) {
  const tokens = new Set();
  for (const entry of mediaEntries ?? []) {
    if (/^S\d{2}E\d{2}$/i.test(entry?.episodeToken ?? "")) {
      tokens.add(entry.episodeToken.toUpperCase());
    }
  }
  for (const token of Object.keys(records ?? {})) {
    if (/^S\d{2}E\d{2}$/i.test(token)) {
      tokens.add(token.toUpperCase());
    }
  }
  return Array.from(tokens).sort();
}
