import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(rootDir, "player", "player.js"), "utf8");
const start = source.indexOf("var SPEAKER_PREFIX_PATTERN");
const end = source.indexOf("function joinTranscriptText", start);
assert.ok(start >= 0 && end > start, "alignment helper source should be discoverable");

const context = {};
vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}\nglobalThis.testApi = { normalizeAlignmentText, tokenizeAlignmentText, calculateSimilarity };`, context);

assert.equal(context.testApi.normalizeAlignmentText("I'm gonna call you."), "i am going to call you");
assert.equal(context.testApi.normalizeAlignmentText("I am going to call you."), "i am going to call you");
assert.equal(context.testApi.calculateSimilarity("I don't want to go.", "I do not want to go."), 1);
assert.equal(context.testApi.calculateSimilarity("You're gonna be okay.", "You are going to be okay."), 1);
assert.deepEqual(Array.from(context.testApi.tokenizeAlignmentText("I have a plan.")), ["i", "have", "a", "plan"]);
assert.ok(context.testApi.calculateSimilarity("We need to leave now.", "The monkey stole the remote.") < 0.4);

console.log("Alignment normalization validation passed.");
