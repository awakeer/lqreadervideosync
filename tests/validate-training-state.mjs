import assert from "node:assert/strict";
import {
  TRAINING_PRESETS,
  buildMediaFingerprint,
  buildPlaybackBookmarkKey,
  buildTrainingPasses,
  canRestorePlaybackBookmark,
  completeTrainingPass,
  createDefaultTrainingSettings,
  normalizeEpisodeTrainingRecord,
  resolveCurrentTrainingPass,
  resolvePlanCounts,
  sanitizeTrainingCounts,
  undoLastTrainingCompletion
} from "../player/training-state.js";

assert.deepEqual(buildTrainingPasses(TRAINING_PRESETS.standard).map((pass) => pass.key), [
  "bilingual:1", "bilingual:2", "english:1", "english:2", "clean:1", "clean:2"
]);
assert.deepEqual(buildTrainingPasses(TRAINING_PRESETS.advanced).map((pass) => pass.key), [
  "english:1", "english:2", "clean:1", "clean:2"
]);
assert.deepEqual(sanitizeTrainingCounts({ bilingual: -2, english: 8, clean: 1 }), { bilingual: 0, english: 6, clean: 1 });
assert.deepEqual(sanitizeTrainingCounts({ bilingual: 0, english: 0, clean: 0 }), TRAINING_PRESETS.standard);

const settings = createDefaultTrainingSettings();
assert.equal(settings.enabled, false, "training must remain opt-in after upgrade");
assert.deepEqual(resolvePlanCounts({ ...settings, defaultPlanId: "advanced" }, normalizeEpisodeTrainingRecord(null)), TRAINING_PRESETS.advanced);
assert.deepEqual(resolvePlanCounts(settings, { ...normalizeEpisodeTrainingRecord(null), planId: "custom", customCounts: { bilingual: 1, english: 3, clean: 0 } }), { bilingual: 1, english: 3, clean: 0 });

let record = normalizeEpisodeTrainingRecord(null);
let pass = resolveCurrentTrainingPass(TRAINING_PRESETS.advanced, record.completed);
assert.equal(pass.key, "english:1");
record = completeTrainingPass(record, pass.variant, "2026-09-07T00:00:00.000Z");
assert.equal(resolveCurrentTrainingPass(TRAINING_PRESETS.advanced, record.completed).key, "english:2");
record = completeTrainingPass(record, "english");
assert.equal(resolveCurrentTrainingPass(TRAINING_PRESETS.advanced, record.completed).key, "clean:1");
const undone = undoLastTrainingCompletion(record);
assert.equal(undone.variant, "english");
assert.equal(resolveCurrentTrainingPass(TRAINING_PRESETS.advanced, undone.record.completed).key, "english:2");

const entry = { relativePath: "纯英/S01E01.eng.mp4", sourceSize: 123, sourceLastModified: 456 };
const identity = {
  episodeToken: "S01E01",
  variant: "english",
  mediaFingerprint: buildMediaFingerprint(null, entry),
  trainingPassKey: "english:1"
};
const key = buildPlaybackBookmarkKey(identity);
assert.notEqual(key, buildPlaybackBookmarkKey({ ...identity, trainingPassKey: "english:2" }), "each training pass needs an isolated bookmark");
const bookmark = { ...identity, currentTimeSeconds: 125, durationSeconds: 1320 };
assert.equal(canRestorePlaybackBookmark(bookmark, identity, 1320), true);
assert.equal(canRestorePlaybackBookmark(bookmark, { ...identity, episodeToken: "S01E02" }, 1320), false);
assert.equal(canRestorePlaybackBookmark(bookmark, { ...identity, variant: "clean" }, 1320), false);
assert.equal(canRestorePlaybackBookmark({ ...bookmark, currentTimeSeconds: 2.9 }, identity, 1320), false);

console.log("training state and playback bookmark tests passed");
