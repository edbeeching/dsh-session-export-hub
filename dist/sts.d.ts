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
/** Render a DSH session as a complete STS-Format JSONL document (no trailing blank line). */
export declare function buildStsSession(session: ExportSession, opts: StsOptions): string;
