import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const playerSource = fs.readFileSync(path.join(root, "player", "player.js"), "utf8");
const html = fs.readFileSync(path.join(root, "player", "player.html"), "utf8");

for (const id of [
  "training-route-card", "training-filmstrip", "training-enabled", "training-default-plan",
  "training-episode-plan", "training-complete-pass", "training-undo", "training-reset-episode",
  "season-progress-list"
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing training UI element: ${id}`);
}

assert.match(playerSource, /TRAINING_SETTINGS_KEY = "readerSyncTrainingSettingsV1"/);
assert.match(playerSource, /PLAYBACK_BOOKMARKS_KEY = "readerSyncPlaybackBookmarksV1"/);
assert.match(playerSource, /playbackRestoreGeneration \+= 1;[\s\S]{0,120}elements\.video\.currentTime = Math\.max\(0, entry\.startMs \/ 1e3\)/, "Reader paragraph clicks must cancel pending resume before seeking");
assert.match(playerSource, /await restoreCurrentPlaybackBookmark\(\);/);
assert.match(playerSource, /completeCurrentTrainingPass\("ended"\)/);
assert.match(playerSource, /inspectAndMaybePreprocessLibraryEntry\(entry, 0, 1, true\)/, "incompatible library variants must be converted on demand");
assert.doesNotMatch(playerSource, /await loadVideoFile\(originalFile, \{ enterPlayer: false/, "incompatible automatic library files must not be loaded as silent originals");
assert.match(playerSource, /function installManifest\(manifestValue\)[\s\S]{0,220}broadcastPlayerState\(true\)/, "manifest installation must re-broadcast a restored position after mappings become available");
assert.match(playerSource, /trainingPauseToggle\.addEventListener\("click"[\s\S]{0,180}await saveCurrentPlaybackBookmark\(\)[\s\S]{0,180}trainingSettings\.paused = !trainingSettings\.paused/, "training progress must be saved before pause changes bookmark identity");
assert.match(playerSource, /loadedEntry\?\.id === target\.id[\s\S]{0,180}else \{\s*await restoreCurrentPlaybackBookmark\(\)/, "resuming training on the same media must restore that pass's bookmark");

const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "player HTML contains duplicate element IDs");

console.log("training and resume integration checks passed");
