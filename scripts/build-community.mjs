import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, "dist");
const publicDir = path.join(rootDir, "public");
const resourcesDir = path.join(rootDir, "resources");
const sourceDir = path.join(rootDir, "src");
const communityDir = path.join(rootDir, "community-src");
const ffmpegCoreDir = path.join(rootDir, "node_modules", "@ffmpeg", "core", "dist", "esm");
const ffmpegRuntimeDir = path.join(rootDir, "node_modules", "@ffmpeg", "ffmpeg", "dist", "esm");

async function copyFile(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination);
}

async function build() {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await copyFile(path.join(publicDir, "manifest.json"), path.join(outputDir, "manifest.json"));
  await cp(path.join(publicDir, "icons"), path.join(outputDir, "icons"), { recursive: true });
  await cp(resourcesDir, path.join(outputDir, "resources"), { recursive: true });
  await copyFile(path.join(communityDir, "subtitles-index.json"), path.join(outputDir, "resources", "subtitles-index.json"));

  await copyFile(path.join(communityDir, "background", "service-worker.js"), path.join(outputDir, "background", "service-worker.js"));
  await copyFile(path.join(communityDir, "content", "index.js"), path.join(outputDir, "content", "index.js"));
  await copyFile(path.join(communityDir, "player", "player.js"), path.join(outputDir, "player", "player.js"));
  await copyFile(path.join(communityDir, "player", "training-state.js"), path.join(outputDir, "player", "training-state.js"));
  await copyFile(path.join(sourceDir, "player", "player.html"), path.join(outputDir, "player", "player.html"));
  await copyFile(path.join(sourceDir, "player", "player.css"), path.join(outputDir, "player", "player.css"));

  await mkdir(path.join(outputDir, "vendor", "ffmpeg"), { recursive: true });
  await copyFile(path.join(ffmpegCoreDir, "ffmpeg-core.js"), path.join(outputDir, "vendor", "ffmpeg", "ffmpeg-core.js"));
  await copyFile(path.join(ffmpegCoreDir, "ffmpeg-core.wasm"), path.join(outputDir, "vendor", "ffmpeg", "ffmpeg-core.wasm"));
  await cp(ffmpegRuntimeDir, path.join(outputDir, "vendor", "ffmpeg-runtime"), { recursive: true });

  await copyFile(path.join(rootDir, "LICENSE.md"), path.join(outputDir, "LICENSE.md"));
  await copyFile(path.join(rootDir, "NOTICE.md"), path.join(outputDir, "NOTICE.md"));
  await copyFile(path.join(rootDir, "THIRD_PARTY_NOTICES.md"), path.join(outputDir, "THIRD_PARTY_NOTICES.md"));
  await cp(path.join(rootDir, "tests"), path.join(outputDir, "tests"), { recursive: true });
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
