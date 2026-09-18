import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  TRAINING_VARIANTS,
  buildTrainingPasses,
  normalizeEpisodeTrainingRecord,
  resolveCurrentTrainingPass,
  resolvePlanCounts
} from "../player/training-state.js";

const extensionRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const playerBundle = fs.readFileSync(path.join(extensionRoot, "player", "player.js"), "utf8");
const mediaStart = playerBundle.indexOf("function fileExtension(fileName)");
const mediaEnd = playerBundle.indexOf("function scoreTitleSimilarity(left, right)");
assert.ok(mediaStart >= 0 && mediaEnd > mediaStart, "Media-library functions were not found");

const context = {
  supportedVideoExtensions: new Set(["mp4", "mkv"]),
  pageContext: null,
  articleSnapshot: null,
  localSubtitleMatch: null,
  mediaLibraryEntries: [],
  mediaLibrarySettings: { preprocess: true, preferredVariant: "english" },
  trainingSettings: { enabled: false, paused: false, defaultPlanId: "advanced", customCounts: { bilingual: 0, english: 2, clean: 2 } },
  trainingRecords: {},
  TRAINING_VARIANTS,
  buildTrainingPasses,
  normalizeEpisodeTrainingRecord,
  resolveCurrentTrainingPass,
  resolvePlanCounts
};
vm.createContext(context);
vm.runInContext(
  `${playerBundle.slice(mediaStart, mediaEnd)}\n` +
    "globalThis.testApi = { extractEpisodeToken, buildReaderEpisodeKey, classifyMediaVariant, detectSingleMediaLibraryVariant, resolveMediaLibraryMatch, takePrioritizedMediaLibraryEntry, isMediaLibraryEntryReady };",
  context
);

assert.equal(context.testApi.extractEpisodeToken("Friends S1E2.mp4"), "S01E02");
assert.equal(context.testApi.extractEpisodeToken("S01E01.eng.mp4"), "S01E01");
assert.equal(context.testApi.extractEpisodeToken("SE01.01.mkv"), "S01E01");
assert.equal(context.testApi.buildReaderEpisodeKey({ articleId: 101, title: "正在加载", articleUrl: "https://aim-read.top/daily-feed/101" }), "article:101");
assert.equal(context.testApi.buildReaderEpisodeKey({ articleId: 101, title: "Friends S01E01", articleUrl: "https://aim-read.top/daily-feed/101" }), "article:101");
assert.equal(context.testApi.classifyMediaVariant("「纯英」/S01E01.eng.mp4"), "english");
assert.equal(context.testApi.classifyMediaVariant("「双语」/Friends.S01E01.mp4"), "bilingual");
assert.equal(context.testApi.classifyMediaVariant("「双语」/Friends.S01E01.chi.eng.mp4"), "bilingual");
assert.equal(context.testApi.classifyMediaVariant("「无字」/Friends.S01E01.mkv"), "clean");
assert.equal(context.testApi.detectSingleMediaLibraryVariant([
  { variant: "english" },
  { variant: "english" },
  { variant: "unknown" }
]), "english");
assert.equal(context.testApi.detectSingleMediaLibraryVariant([
  { variant: "english" },
  { variant: "bilingual" }
]), null);

context.pageContext = { title: "Friends S01E01 The Pilot" };
context.mediaLibraryEntries = [
  { id: "clean", episodeToken: "S01E01", variant: "clean", processedFileName: "ready-clean.mp4", relativePath: "无字/S01E01.mkv" },
  { id: "english", episodeToken: "S01E01", variant: "english", processedFileName: null, relativePath: "纯英/S01E01.eng.mp4" },
  { id: "bilingual", episodeToken: "S01E01", variant: "bilingual", processedFileName: null, relativePath: "双语/S01E01.mp4" }
];
assert.equal(context.testApi.resolveMediaLibraryMatch().id, "english");
context.trainingSettings.enabled = true;
context.trainingRecords.S01E01 = { completed: { bilingual: 0, english: 2, clean: 0 }, history: ["english", "english"] };
assert.equal(context.testApi.resolveMediaLibraryMatch().id, "clean", "training target must override the manual media preference");
context.trainingSettings.paused = true;
assert.equal(context.testApi.resolveMediaLibraryMatch().id, "english", "pausing training must restore the manual media preference");
context.trainingSettings.enabled = false;
context.trainingSettings.paused = false;
context.mediaLibrarySettings.preferredVariant = "clean";
assert.equal(context.testApi.resolveMediaLibraryMatch().id, "clean");
context.mediaLibrarySettings.preferredVariant = "bilingual";
assert.equal(context.testApi.resolveMediaLibraryMatch().id, "bilingual");
context.mediaLibrarySettings.preferredVariant = "english";
context.mediaLibraryEntries = context.mediaLibraryEntries.filter((entry) => entry.variant !== "english");
assert.equal(context.testApi.resolveMediaLibraryMatch(), null, "Strict version selection silently fell back to another variant");

const pendingEntries = [{ id: "old" }, { id: "new" }, { id: "later" }];
assert.equal(context.testApi.takePrioritizedMediaLibraryEntry(pendingEntries, "new").id, "new", "New Reader episode was not promoted ahead of the background queue");
assert.deepEqual(Array.from(pendingEntries, (entry) => entry.id), ["old", "later"]);
assert.equal(context.testApi.isMediaLibraryEntryReady({ processedFileName: "ready.mp4" }), true);
assert.equal(context.testApi.isMediaLibraryEntryReady({ probe: {}, assessment: { isRecommendedProfile: true } }), true);
assert.equal(context.testApi.isMediaLibraryEntryReady({ probe: {}, assessment: { isRecommendedProfile: false } }), false);

const optionalLibraryPath = process.argv[2];
if (optionalLibraryPath) {
  const videoFiles = [];
  function collectVideos(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "ReaderSync-Processed") {
          continue;
        }
        collectVideos(fullPath);
      } else if (/\.(mp4|mkv)$/i.test(entry.name)) {
        videoFiles.push(fullPath);
      }
    }
  }
  collectVideos(optionalLibraryPath);
  const unmatched = videoFiles.filter((filePath) => !context.testApi.extractEpisodeToken(filePath));
  assert.deepEqual(unmatched, [], `Unmatched video file names:\n${unmatched.join("\n")}`);
  const rootName = path.basename(optionalLibraryPath);
  const unrecognizedVariants = videoFiles.filter((filePath) => {
    const relativePath = path.relative(optionalLibraryPath, filePath).replaceAll(path.sep, "/");
    return context.testApi.classifyMediaVariant(`${rootName}/${relativePath}`) === "unknown";
  });
  assert.deepEqual(unrecognizedVariants, [], `Unrecognized video variants:\n${unrecognizedVariants.join("\n")}`);
  process.stdout.write(`real library names matched: ${videoFiles.length}\n`);
}

process.stdout.write("media-library matching tests passed\n");
