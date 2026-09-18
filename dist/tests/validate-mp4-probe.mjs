import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const videoPath = process.argv[2];
if (!videoPath) {
  throw new Error("Usage: node validate-mp4-probe.mjs <video.mp4>");
}

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(testDirectory, "..", "player", "player.js");
const bundle = fs.readFileSync(bundlePath, "utf8");
const start = bundle.indexOf("function parseMp4Probe(bytes)");
const end = bundle.indexOf("function describeStrategy(strategy)");
assert.ok(start >= 0 && end > start, "MP4 parser functions were not found in player.js");

const context = {};
vm.createContext(context);
vm.runInContext(
  `${bundle.slice(start, end)}\n` +
    "globalThis.runSplitProbe = (headBytes, tailBytes) => parseMp4ProbeFromParts(headBytes, tailBytes);",
  context
);

const file = fs.openSync(videoPath, "r");
try {
  const fileSize = fs.fstatSync(file).size;
  const scanSize = Math.min(fileSize, 16 * 1024 * 1024);
  const head = Buffer.alloc(scanSize);
  const tail = Buffer.alloc(scanSize);
  fs.readSync(file, head, 0, scanSize, 0);
  fs.readSync(file, tail, 0, scanSize, fileSize - scanSize);

  const probe = context.runSplitProbe(new Uint8Array(head), new Uint8Array(tail));
  assert.ok(probe, "Split MP4 probe returned null");
  assert.ok(probe.streams.some((stream) => stream.codecType === "video"), "Video stream was not detected");
  assert.ok(probe.streams.some((stream) => stream.codecType === "audio"), "Audio stream was not detected");
  process.stdout.write(`${JSON.stringify(probe, null, 2)}\n`);
} finally {
  fs.closeSync(file);
}
