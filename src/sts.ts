/**
 * Map DeepSeek Harness session events onto the Hugging Face "Session Trace
 * Simple Format" (STS-Format): a JSONL file with a `session` header line
 * followed by `message` envelope lines. See
 * https://huggingface.co/docs/hub/en/session-traces-format
 *
 * The module is dependency-free and side-effect-free so it can run under
 * `node --experimental-strip-types` in tests, or compiled with tsc for the
 * plugin.
 */

export interface DshEvent {
  type: string;
  seq?: number;
  time?: number;
  data?: Record<string, any>;
}

export interface ExportSession {
  id: string;
  /** Session header facts; unknown/absent keys are simply dropped. */
  header?: Record<string, unknown>;
  /** Events in canonical (seq) order. */
  events: DshEvent[];
}

export interface StsOptions {
  /** Value for the required `harness` field; picks the Hub renderer/icon. */
  harness: string;
  /** Emit the `request/header` system prompt as a leading `system` message. */
  includeSystem: boolean;
  /** Emit `feedback/record` events as `system` messages. */
  includeFeedback: boolean;
  /** Optional per-text redactor, applied to every text field that ships. */
  redact?: (text: string) => string;
}

/** Content blocks as seen in DSH events (`{type, text, ...}` blocks). */
type Block = { type?: string; text?: string; content?: Block[]; [k: string]: any };

function pick(blocks: Block[] | undefined, type: string): Block[] {
  const out: Block[] = [];
  for (const b of blocks ?? []) {
    if (b?.type === type) out.push(b);
    else if (Array.isArray(b?.content)) out.push(...pick(b.content, type));
  }
  return out;
}

function joinText(blocks: Block[] | undefined): string {
  return (blocks ?? [])
    .map((b) => b?.text ?? "")
    .filter((s) => s.length > 0)
    .join("\n");
}

function contentText(blocks: Block[] | undefined): string {
  return joinText(pick(blocks, "text"));
}

function reasoningText(blocks: Block[] | undefined): string {
  return joinText(pick(blocks, "reasoning"));
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** Turn a DSH event into an STS message envelope, or null to drop the event. */
function eventToMessage(event: DshEvent, opts: StsOptions): Record<string, any> | null {
  const data = event.data ?? {};
  const time = event.time;
  const redact = (s: string) => (opts.redact ? opts.redact(s) : s);

  switch (event.type) {
    case "user/message": {
      const text = redact(contentText(data.content));
      if (!text) return null;
      const m: Record<string, any> = { role: "user", content: text };
      if (time !== undefined) m.timestamp = time;
      return { type: "message", message: m };
    }
    case "assistant/message": {
      const msg = data.message ?? {};
      const content = redact(contentText(msg.content));
      const reasoning = redact(reasoningText(msg.content));
      const toolCalls = msg.toolCalls ?? [];
      if (!content && !reasoning && toolCalls.length === 0) return null;
      const m: Record<string, any> = { role: "assistant", content };
      if (reasoning) m.reasoningContent = reasoning;
      if (toolCalls.length > 0) m.toolCalls = toolCalls;
      if (time !== undefined) m.timestamp = time;
      return { type: "message", message: m };
    }
    case "tool/call": {
      // `arguments` is already a JSON string, exactly as STS expects.
      const m: Record<string, any> = {
        role: "assistant",
        content: "",
        toolCalls: [{ id: data.callId, function: { name: data.name, arguments: data.arguments ?? "{}" } }],
      };
      if (time !== undefined) m.timestamp = time;
      return { type: "message", message: m };
    }
    case "tool/result": {
      const block = pick(data.message?.content ?? [], "tool-result")[0];
      const toolCallId = block?.toolCallId ?? data.message?.source?.callId;
      const raw = redact(contentText(block?.content));
      const text = block?.isError ? `[tool error] ${raw}` : raw;
      if (toolCallId === undefined) return null;
      const m: Record<string, any> = { role: "tool", toolCallId, content: text };
      if (time !== undefined) m.timestamp = time;
      return { type: "message", message: m };
    }
    case "request/header": {
      if (!opts.includeSystem) return null;
      const system = redact(data.header?.system ?? "");
      if (!system) return null;
      return { type: "message", message: { role: "system", content: system, timestamp: time } };
    }
    case "feedback/record": {
      if (!opts.includeFeedback) return null;
      const text = redact(String(data.text ?? data.content ?? JSON.stringify(data)));
      return { type: "message", message: { role: "system", content: `[feedback] ${text}`, timestamp: time } };
    }
    default:
      return null;
  }
}

/** Build the STS header line's `name` and `model` from the event stream. */
function collectFacts(session: ExportSession): { name?: string; model?: string } {
  let name: string | undefined;
  let model: string | undefined;
  let firstUserText: string | undefined;
  for (const e of session.events) {
    const data = e.data ?? {};
    switch (e.type) {
      case "session/title":
        if (typeof data.title === "string" && data.title.length > 0) name = data.title;
        break;
      case "request/header":
        model = data.header?.config?.model;
        break;
      case "user/message": {
        if (firstUserText === undefined) {
          const text = contentText(data.content);
          if (text) firstUserText = truncate(text, 80);
        }
        break;
      }
    }
  }
  return { name: name ?? firstUserText, model };
}

/** Render a DSH session as a complete STS-Format JSONL document (no trailing blank line). */
export function buildStsSession(session: ExportSession, opts: StsOptions): string {
  const { name, model } = collectFacts(session);
  const header: Record<string, any> = {
    type: "session",
    harness: opts.harness,
    id: String(session.id),
    name: name ?? "Untitled session",
  };
  if (model) header.model = model;
  // Extra metadata is allowed by the format and ignored by the viewer.
  for (const key of ["createdAt", "cwd", "delegationDepth", "agentPreset", "version"]) {
    const value = session.header?.[key];
    if (value !== undefined) header[key] = value;
  }

  const lines = [JSON.stringify(header)];
  let lastSystem: string | undefined;
  for (const event of session.events) {
    const envelope = eventToMessage(event, opts);
    if (!envelope) continue;
    // Repeated request/header events (one per turn) carry the same system
    // prompt; keep only the first occurrence of an identical prompt.
    if (envelope.message?.role === "system") {
      const content = String(envelope.message.content ?? "");
      if (content === lastSystem) continue;
      lastSystem = content;
    }
    lines.push(JSON.stringify(envelope));
  }
  return lines.join("\n");
}
