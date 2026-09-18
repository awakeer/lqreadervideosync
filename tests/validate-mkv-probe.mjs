import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const videoPath = process.argv[2];
if (!videoPath) {
  throw new Error("Usage: node validate-mkv-probe.mjs <video.mkv>");
}

const extensionRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = fs.readFileSync(path.join(extensionRoot, "player", "player.js"), "utf8");
const start = bundle.indexOf("async function inspectMatroskaContainerFromFile(file, handlers)");
const end = bundle.indexOf("function hasMp4LikeExtension(fileName)");
assert.ok(start >= 0 && end > start, "Matroska parser functions were not found");

const context = {
  readAscii(bytes, start, end) {
    let value = "";
    for (let offset = start; offset < end; offset += 1) {
      value += String.fromCharCode(bytes[offset]);
    }
    return value;
  }
};
vm.createContext(context);
vm.runInContext(
  `${bundle.slice(start, end)}\n` +
    "globalThis.inspectMkv = inspectMatroskaContainerFromFile;",
  context
);

const fileDescriptor = fs.openSync(videoPath, "r");
try {
  const fileSize = fs.fstatSync(fileDescriptor).size;
  const testFile = {
    name: path.basename(videoPath),
    size: fileSize,
    slice(startOffset, endOffset) {
      return {
        async arrayBuffer() {
          const length = endOffset - startOffset;
          const buffer = Buffer.alloc(length);
          fs.readSync(fileDescriptor, buffer, 0, length, startOffset);
          return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        }
      };
    }
  };
  const probe = await context.inspectMkv(testFile, {});
  assert.ok(probe, "MKV fast probe returned null");
  assert.ok(probe.streams.some((stream) => stream.codecType === "video"), "Video stream was not detected");
  assert.ok(probe.streams.some((stream) => stream.codecType === "audio"), "Audio stream was not detected");
  process.stdout.write(`${JSON.stringify(probe, null, 2)}\n`);
} finally {
  fs.closeSync(fileDescriptor);
}
