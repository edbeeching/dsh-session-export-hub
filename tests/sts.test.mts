import assert from "node:assert/strict";
import { buildStsSession, type DshEvent, type ExportSession } from "../src/sts.ts";

function ev(type: string, data: Record<string, any>, time = 1000, seq = 0): DshEvent {
  return { type, seq, time, data };
}

function session(events: DshEvent[]): ExportSession {
  return {
    id: "session-test-1",
    header: { createdAt: 1700000000000, cwd: "/home/user/proj", agentPreset: "standard", version: 0 },
    events,
  };
}

const OPTIONS = { harness: "deepseek-harness", includeSystem: true, includeFeedback: true };

const docsExample = session([
  ev("session/title", { title: "what time is it" }, 100, 0),
  ev("request/header", { header: { config: { model: "deepseek-v4-flash" }, system: "You are helpful." } }, 110, 1),
  ev("user/message", { role: "user", content: [{ type: "text", text: "what time is it?" }] }, 120, 2),
  ev("assistant/message", { message: { role: "assistant", content: [{ type: "reasoning", text: "let me check" }, { type: "text", text: "" }] } }, 130, 3),
  ev("tool/call", { turn: 1, step: 1, callId: "t1", name: "get_time", arguments: "{}" }, 140, 4),
  ev("tool/result", { message: { source: { kind: "tool", callId: "t1" }, content: [{ type: "tool-result", toolCallId: "t1", content: [{ type: "text", text: "2026-07-01T15:00:00Z" }], isError: false }] } }, 150, 5),
  ev("assistant/message", { message: { role: "assistant", content: [{ type: "text", text: "it is 15:00 UTC" }] } }, 160, 6),
  ev("turn/end", { turn: 1, reason: { kind: "completed" } }, 170, 7),
  ev("todo/write", { todos: [] }, 180, 8),
  ev("feedback/record", { text: "great work" }, 190, 9),
]);

function parseLines(text: string): Array<Record<string, any>> {
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const lines = parseLines(buildStsSession(docsExample, OPTIONS));

// 1. Header line shape and extra metadata.
const header = lines[0];
assert.equal(header.type, "session");
assert.equal(header.harness, "deepseek-harness");
assert.equal(header.id, "session-test-1");
assert.equal(header.name, "what time is it");
assert.equal(header.model, "deepseek-v4-flash");
assert.equal(header.cwd, "/home/user/proj");
assert.equal(header.createdAt, 1700000000000);

// 2. Request/header → leading system message.
assert.deepEqual(lines[1], {
  type: "message",
  message: { role: "system", content: "You are helpful.", timestamp: 110 },
});

// 3. user/message → user message with timestamp.
assert.deepEqual(lines[2], {
  type: "message",
  message: { role: "user", content: "what time is it?", timestamp: 120 },
});

// 4. assistant/message with reasoning → reasoningContent, empty content kept.
assert.deepEqual(lines[3], {
  type: "message",
  message: { role: "assistant", content: "", reasoningContent: "let me check", timestamp: 130 },
});

// 5. tool/call → assistant message with toolCalls (arguments stays a JSON string).
assert.deepEqual(lines[4], {
  type: "message",
  message: {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "t1", function: { name: "get_time", arguments: "{}" } }],
    timestamp: 140,
  },
});

// 6. tool/result → tool message stitched by toolCallId.
assert.deepEqual(lines[5], {
  type: "message",
  message: { role: "tool", toolCallId: "t1", content: "2026-07-01T15:00:00Z", timestamp: 150 },
});

// 7. Final assistant text.
assert.deepEqual(lines[6], {
  type: "message",
  message: { role: "assistant", content: "it is 15:00 UTC", timestamp: 160 },
});

// 8. turn/end and todo/write are dropped; feedback/record is included as system.
assert.equal(lines.length, 8);
assert.deepEqual(lines[7], {
  type: "message",
  message: { role: "system", content: "[feedback] great work", timestamp: 190 },
});

// 9. includeFeedback=false drops the feedback line.
const noFeedback = parseLines(buildStsSession(docsExample, { ...OPTIONS, includeFeedback: false }));
assert.equal(noFeedback.length, 7);
assert.ok(noFeedback.every((l) => !String(l.message?.content).includes("feedback")));

// 10. includeSystem=false drops the system prompt line.
const noSystem = parseLines(buildStsSession(docsExample, { ...OPTIONS, includeSystem: false }));
assert.equal(noSystem[0].type, "session");
assert.equal(noSystem[1].message.role, "user");

// 11. Tool errors are marked and missing toolCallId drops the result.
const errResult = session([
  ev("tool/call", { callId: "t9", name: "bash", arguments: "{}" }, 1, 0),
  ev("tool/result", { message: { source: { kind: "tool" }, content: [{ type: "tool-result", toolCallId: "t9", content: [{ type: "text", text: "boom" }], isError: true }] } }, 2, 1),
]);
const errLines = parseLines(buildStsSession(errResult, OPTIONS));
assert.equal(errLines[2].message.role, "tool");
assert.equal(errLines[2].message.toolCallId, "t9");
assert.equal(errLines[2].message.content, "[tool error] boom");

// 12. Redaction applies to every text field that ships.
const redacted = parseLines(
  buildStsSession(docsExample, { ...OPTIONS, redact: (s) => s.replace(/helpful/g, "REDACTED") }),
);
assert.ok(redacted.some((l) => l.message?.content === "You are REDACTED."));

// 13. Name falls back to the first user message.
const unnamed = session([ev("user/message", { content: [{ type: "text", text: "Fix the bug in src/main.ts please and also tell me about zstd frames" }] }, 1, 0)]);
const unnamedLines = parseLines(buildStsSession(unnamed, { ...OPTIONS, includeSystem: false }));
assert.equal(unnamedLines[0].name, "Fix the bug in src/main.ts please and also tell me about zstd frames");

// 14. A purely-streaming session (chunks only, no final messages) yields just the header.
const chunkOnly = session([
  ev("assistant/chunk", { turn: 1, step: 1, chunk: { type: "block-start", blockType: "text" } }, 1, 0),
  ev("text-chunks", { turn: 1, step: 1, texts: ["hel", "lo"] }, 2, 1),
]);
assert.equal(parseLines(buildStsSession(chunkOnly, OPTIONS)).length, 1);

console.log(`sts.test.mts: all ${14} checks passed`);
