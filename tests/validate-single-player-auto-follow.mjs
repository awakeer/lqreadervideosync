import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(extensionRoot, relativePath), "utf8");

const manifest = JSON.parse(read("manifest.json"));
const html = read("player/player.html");
const player = read("player/player.js");
const background = read("background/service-worker.js");
const content = read("content/index.js");

assert.equal(manifest.version, "2.1.1.11");
assert.doesNotMatch(html, /class="progress-nav"/, "The old three-step navigation is still visible");
assert.match(html, /id="player-view" class="view is-active single-player-view"/, "Player is not the initial and only main view");
assert.match(html, /id="resource-settings"/, "Media-library settings were not moved into the player screen");
assert.match(html, /id="manual-fallback"/, "Manual subtitle/video fallback was removed instead of being preserved");
assert.match(html, /data-automation-state="reader"/);
assert.match(html, /data-automation-state="subtitle"/);
assert.match(html, /data-automation-state="video"/);

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "Duplicate HTML ids detected");
for (const match of player.matchAll(/requireElement\("#([^"\)]+)"\)/g)) {
  assert.ok(ids.includes(match[1]), `Missing required player element #${match[1]}`);
}

assert.match(player, /function scheduleReaderDiscoveryWatchdog/);
assert.match(player, /type: "REQUEST_CONNECTED_TABS"/);
assert.match(player, /readerReloadFallbackUsed/);
assert.match(player, /type: "REFRESH_READER_TABS"/);
assert.match(player, /function beginReaderEpisodeTransition/);
assert.match(player, /mediaLibraryPendingRequest/);
assert.match(player, /while \(mediaLibraryPendingRequest/);
assert.match(player, /takePrioritizedMediaLibraryEntry/);
assert.match(player, /loadCurrentMediaLibraryMatchDuringBatch/);
assert.match(player, /isCurrentEpisodeGeneration/);
assert.match(player, /Ignored stale article snapshot after Reader episode change/);

assert.match(content, /window\.setInterval\(checkReaderLocationChange, 1e3\)/, "Reader SPA navigation watchdog is missing");
assert.match(content, /articleSnapshotGeneration/);
assert.match(content, /Discarding stale article snapshot after Reader navigation/);
assert.match(background, /articleSnapshot: null,[\s\S]*?error: null/, "Old article snapshot is not cleared on episode change");
assert.match(background, /Ignored stale article snapshot after Reader navigation/);
assert.match(background, /changeInfo\.status === "complete"/, "Completed Reader tabs are not actively recollected");

process.stdout.write("single-player auto-follow regression tests passed\n");
