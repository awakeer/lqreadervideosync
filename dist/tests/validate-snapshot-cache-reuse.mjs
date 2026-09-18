import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const content = fs.readFileSync(path.join(extensionRoot, "content", "index.js"), "utf8");
const background = fs.readFileSync(path.join(extensionRoot, "background", "service-worker.js"), "utf8");

const helperStart = content.indexOf("function canReuseCollectedArticleSnapshot");
const helperEnd = content.indexOf("function ensureArticleSnapshotCollection", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "Snapshot cache helper was not found");

const context = {
  lastCollectedArticleSnapshot: { paragraphs: [{ paragraphIndex: 0 }] },
  lastCollectedArticleUrl: "https://aim-read.top/daily-feed/203",
  lastCollectedArticleSnapshotAt: 10_000,
  articleSnapshotCacheMaxAgeMs: 120_000,
  Date,
  Boolean
};
vm.createContext(context);
vm.runInContext(`${content.slice(helperStart, helperEnd)}\nglobalThis.canReuse = canReuseCollectedArticleSnapshot;`, context);

assert.equal(context.canReuse("https://aim-read.top/daily-feed/203", 20_000), true, "Fresh same-article snapshot was not reused");
assert.equal(context.canReuse("https://aim-read.top/daily-feed/204", 20_000), false, "Snapshot leaked across Reader episodes");
assert.equal(context.canReuse("https://aim-read.top/daily-feed/203", 140_000), false, "Expired snapshot was reused forever");

assert.match(content, /Replaying cached article snapshot instead of refetching all pages/);
assert.match(content, /payload: lastCollectedArticleSnapshot/);
assert.match(background, /if \(hasReusableArticleSnapshot\(targetTabId\)\)[\s\S]{0,260}else \{\s*await collectPreferredArticleSnapshot\(targetTabId\)/, "Background still forces a Reader refetch when it already has a fresh snapshot");

process.stdout.write("snapshot cache-reuse regression tests passed\n");
