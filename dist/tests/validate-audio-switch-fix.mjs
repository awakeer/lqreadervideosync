import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "player", "player.js"), "utf8");

assert.match(source, /normalizedAudioCodecs\.every\(\(codecName\) => codecName === "aac"\)/, "only AAC audio should be treated as directly playable");
assert.match(source, /command\.push\("-c:a", "aac", "-ac", "2", "-b:a", ENCODING_PROFILE\.audioBitrate\)/, "incompatible audio must be converted to AAC");
assert.match(source, /\["-i", inputPath, "-map", "0:v:0", "-map", "0:a\?"\]/, "the optional source audio track must be mapped during conversion");
assert.match(source, /正在为当前选择准备兼容音视频/, "version switching must visibly enter on-demand compatibility processing");
assert.match(source, /getProcessedMediaFile\(entry\)[\s\S]{0,900}codecName: "aac"/, "version switching must load the prepared AAC result");
assert.match(source, /throw new Error\(`当前视频的音轨或画面格式无法由浏览器直接播放/, "a failed compatibility conversion must stop instead of loading a silent original");
assert.match(source, /if \(resolveLoadedMediaEntry\(\)\?\.id === entry\.id\)/, "media reuse must compare the selected library entry identity");
assert.doesNotMatch(source, /sourceVideoFile\?\.name === expectedName/, "same-named files in different variant folders must not suppress a version switch");
assert.match(source, /await saveCurrentPlaybackBookmark\(\);[\s\S]{0,180}sourceVideoFile = file;\s*loadedMediaLibraryEntryId = targetEntryId \?\? null;/, "the old bookmark must be saved before the new media identity is installed");
assert.match(source, /loadKnownCompatibleLibraryFile\(processedFile, processedProbe, entry\.id, options\)/, "processed media must install the target entry identity before restore");

const loadStart = source.indexOf("async function loadMediaLibraryEntry(entry, options)");
const loadEnd = source.indexOf("async function autoLoadMatchedMedia()", loadStart);
assert.ok(loadStart >= 0 && loadEnd > loadStart, "loadMediaLibraryEntry was not found");
let loadedEntryId = "english-entry";
let processedLookupCount = 0;
const context = {
  mediaLibraryDirectoryHandle: {},
  mediaLibraryPermissionReady: true,
  mediaLibraryAutoLoadBusy: false,
  mediaLibraryBusy: false,
  isCurrentMediaLibraryRequest: () => true,
  resolveLoadedMediaEntry: () => loadedEntryId ? { id: loadedEntryId } : null,
  getProcessedMediaFile: async () => {
    processedLookupCount += 1;
    throw new Error("lookup-reached");
  },
  updateMediaLibraryUi: () => {}
};
vm.createContext(context);
vm.runInContext(`${source.slice(loadStart, loadEnd)}\nglobalThis.loadEntryForTest = loadMediaLibraryEntry;`, context);
const cleanEntry = { id: "clean-entry", name: "S01E01.mp4", relativePath: "clean/S01E01.mp4" };
await assert.rejects(context.loadEntryForTest(cleanEntry, { allowDuringBatch: true }), /lookup-reached/);
assert.equal(processedLookupCount, 1, "same-named media in another variant folder was incorrectly treated as already loaded");
loadedEntryId = "clean-entry";
await context.loadEntryForTest(cleanEntry, { allowDuringBatch: true });
assert.equal(processedLookupCount, 1, "the exact loaded media entry should be reused without another lookup");

process.stdout.write("audio-switch compatibility regression tests passed\n");
