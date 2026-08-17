/**
 * Smoke harness: feed a raw DSH session-log dump (the output of the Python
 * decompressor, i.e. header line + event lines as JSON) through the STS
 * mapper and report what maps and what is dropped.
 *
 *   node --experimental-strip-types scripts/smoke.mts <input.jsonl> [output.jsonl]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { buildStsSession, type DshEvent, type ExportSession } from "../src/sts.ts";

const [, , inputPath, outputPath] = process.argv;
if (!inputPath) {
  console.error("usage: smoke.mts <input-session.jsonl> [output.jsonl]");
  process.exit(1);
}

const lines = readFileSync(inputPath, "utf8").split("\n").filter((l) => l.trim());
const header = JSON.parse(lines[0]);
const events: DshEvent[] = lines.slice(1).map((l) => JSON.parse(l));

const session: ExportSession = {
  id: header.id ?? "unknown",
  header,
  events,
};

const sts = buildStsSession(session, {
  harness: "deepseek-harness",
  includeSystem: true,
  includeFeedback: true,
});

if (outputPath) writeFileSync(outputPath, `${sts}\n`, "utf8");

const mapped = new Set(["user/message", "assistant/message", "tool/call", "tool/result", "request/header", "feedback/record"]);
const byType = new Map<string, number>();
for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);

console.log(`session id      : ${session.id}`);
console.log(`header fields   : ${Object.keys(header).join(", ")}`);
console.log(`events total    : ${events.length}`);
console.log(`STS lines       : ${sts.split("\n").length} (header + ${sts.split("\n").length - 1} messages)`);
console.log(`mapped types    : ${[...byType.keys()].filter((t) => mapped.has(t)).join(", ") || "(none)"}`);
console.log(`dropped (noise) : ${[...byType.keys()].filter((t) => !mapped.has(t)).join(", ")}`);
console.log("--- first 12 STS lines ---");
console.log(sts.split("\n").slice(0, 12).join("\n"));
