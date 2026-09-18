import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const content = fs.readFileSync(path.join(extensionRoot, "content", "index.js"), "utf8");
const player = fs.readFileSync(path.join(extensionRoot, "player", "player.js"), "utf8");

const collectStart = content.indexOf("function collectAndSendPageContext(options)");
const collectEnd = content.indexOf("function scheduleCollect", collectStart);
assert.ok(collectStart >= 0 && collectEnd > collectStart, "Forced page-context collector was not found");

const sentMessages = [];
const context = {
  controller: {
    collectPageContext: () => ({
      articleUrl: "https://aim-read.top/daily-feed/203?categoryId=59",
      articleId: 203,
      categoryId: 59,
      title: "Friends S01E03",
      paragraphs: [{ paragraphIndex: 0 }, { paragraphIndex: 1 }]
    }),
    bindParagraphClicks: () => {}
  },
  logger2: { debug: () => {} },
  postRuntimeMessage: (message) => sentMessages.push(message),
  ensureArticleSnapshotCollection: () => Promise.resolve(),
  lastPageContextSignature: null,
  lastPageContextParagraphIndexes: [],
  lastPageContextSentAt: 0,
  Date,
  JSON,
  Promise
};
vm.createContext(context);
vm.runInContext(content.slice(collectStart, collectEnd), context);

context.collectAndSendPageContext();
assert.equal(sentMessages.length, 1, "Initial Reader context was not sent");
context.collectAndSendPageContext();
assert.equal(sentMessages.length, 1, "Unchanged Reader context bypassed normal deduplication");
context.lastPageContextSentAt = 0;
context.collectAndSendPageContext({ force: true });
assert.equal(sentMessages.length, 2, "Reconnect did not force an unchanged Reader context to be resent");
assert.equal(sentMessages[1].type, "PAGE_CONTEXT_UPDATE");
assert.equal(sentMessages[1].payload.articleId, 203);

assert.match(content, /collectAndSendPageContext\(\{ force: true \}\);[\s\S]{0,120}return nextPort;/, "Content-port reconnect does not force rehydration");
assert.match(content, /case "COLLECT_PAGE_CONTEXT":[\s\S]{0,100}collectAndSendPageContext\(\{ force: true \}\)/, "Explicit Reader recognition still uses deduplicated collection");
assert.match(content, /document\.addEventListener\("visibilitychange"[\s\S]{0,180}collectAndSendPageContext\(\{ force: true \}\)/, "Reader tab resume does not reannounce context");
assert.match(player, /function refreshReaderConnectionAfterResume/);
assert.match(player, /document\.addEventListener\("visibilitychange"[\s\S]{0,180}refreshReaderConnectionAfterResume\(\)/, "Player resume does not request Reader state");

process.stdout.write("resume reconnect regression tests passed\n");
