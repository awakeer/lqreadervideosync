import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const player = fs.readFileSync(path.join(extensionRoot, "player", "player.js"), "utf8");
const html = fs.readFileSync(path.join(extensionRoot, "player", "player.html"), "utf8");

assert.match(player, /async function ensureMediaLibraryReadyForPlayback\(\)/, "Playback does not attempt cold-start media recovery");
assert.match(player, /verifyMediaLibraryPermission\(mediaLibraryDirectoryHandle, true\)/, "Playback recovery does not request folder permission from a user gesture");
assert.match(player, /async function togglePlayback\(\)/, "Playback is not guarded by a recovery-aware toggle");
assert.match(player, /void togglePlayback\(\)\.catch/, "Play button still calls video.play directly without recovery");
assert.match(player, /!mediaLibraryPermissionReady \|\| mediaLibraryBusy/, "Automatic media loading does not respect unavailable folder permission");
assert.match(player, /等待文件夹授权/, "Matched media is still shown as ready when folder permission is unavailable");
assert.match(player, /重新授权并扫描/, "The recovery action is not exposed after a cold start");
assert.match(html, /id="rescan-library"/);

process.stdout.write("cold-start media restore regression tests passed\n");
