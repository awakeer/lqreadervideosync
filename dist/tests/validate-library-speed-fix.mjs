import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const playerPath = path.join(extensionRoot, "player", "player.js");
const htmlPath = path.join(extensionRoot, "player", "player.html");
const source = fs.readFileSync(playerPath, "utf8");
const html = fs.readFileSync(htmlPath, "utf8");

const scanStart = source.indexOf('async function scanMediaDirectory(directoryHandle, pathParts = [], rootName = directoryHandle.name ?? "")');
const scanEnd = source.indexOf("async function resolveFileHandleFromPath", scanStart);
assert.ok(scanStart >= 0 && scanEnd > scanStart, "scanMediaDirectory was not found");

let metadataReads = 0;
let contentReads = 0;
const fakeFiles = Array.from({ length: 72 }, (_, index) => {
  const name = `S01E${String(index % 24 + 1).padStart(2, "0")}.eng.mp4`;
  return [name, {
    kind: "file",
    async getFile() {
      metadataReads += 1;
      return {
        name,
        size: 1000 + index,
        lastModified: 1700000000000 + index,
        slice() {
          contentReads += 1;
          throw new Error("Fast folder indexing must not read video bytes");
        }
      };
    }
  }];
});
const fakeDirectory = {
  async *entries() {
    yield* fakeFiles;
  }
};
const context = {
  MEDIA_LIBRARY_PROCESSED_DIRECTORY: "ReaderSync-Processed",
  supportedVideoExtensions: new Set(["mp4", "mkv"]),
  fileExtension: (name) => name.split(".").pop().toLowerCase(),
  extractEpisodeToken: (name) => name.match(/S\d{2}E\d{2}/i)?.[0].toUpperCase() ?? null,
  classifyMediaVariant: () => "english"
};
vm.createContext(context);
vm.runInContext(`${source.slice(scanStart, scanEnd)}\nglobalThis.scanMediaDirectoryForTest = scanMediaDirectory;`, context);
const entries = await context.scanMediaDirectoryForTest(fakeDirectory);
assert.equal(entries.length, 72);
assert.equal(metadataReads, 72);
assert.equal(contentReads, 0, "Folder indexing read video content instead of metadata only");

assert.match(html, /id="library-preprocess"[^>]*checked/, "Preprocessing is not enabled by default");
assert.match(source, /takePrioritizedMediaLibraryEntry\(remainingEntries, currentMediaLibraryMatch\?\.id\)/, "Current episode is not dynamically prioritized during preprocessing");
assert.match(source, /loadCurrentMediaLibraryMatchDuringBatch\(\)/, "A newly selected episode is not loaded during preprocessing");
assert.match(source, /trainingSnapshot\?\.currentPass\?\.variant/, "Training preprocessing does not target the episode's current pass");
assert.doesNotMatch(source, /TRAINING_VARIANTS\.filter\(\(variant\) => planCounts\[variant\] > 0\)/, "Training scan eagerly preprocesses every future variant and will regress startup speed");
assert.match(source, /Training target changed during background preprocessing; promoted the new target/, "A newly advanced training variant is not promoted into an active background queue");
assert.match(source, /remainingEntries\.push\(currentMediaLibraryMatch\)[\s\S]{0,700}takePrioritizedMediaLibraryEntry\(remainingEntries, currentMediaLibraryMatch\?\.id\)/, "The new training target must enter the queue before dynamic prioritization");
assert.match(source, /libraryPreprocess\.addEventListener\("change"[\s\S]*?scanAndPrepareMediaLibrary\(\)/, "Enabling preprocessing does not start it");
assert.match(source, /已命中预处理缓存，跳过重复检测/, "Processed cache does not have a direct-load path");

process.stdout.write("library speed-fix regression tests passed\n");
