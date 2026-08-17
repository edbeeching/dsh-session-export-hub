/**
 * dsh-session-export-hub — a DeepSeek Harness (cordis) plugin that exports
 * session telemetry as Hugging Face Session Traces (STS-Format) JSONL and
 * pushes it to a private Hub dataset.
 *
 * Transport: shells out to `huggingface-cli` (the Python CLI from
 * huggingface_hub) by default — it is already installed and authenticated in
 * typical setups — or to `hf` if `cliPath` is overridden. The dataset repo is
 * created as private on first push if it does not exist yet.
 *
 * Zero runtime dependencies: everything comes from the harness context
 * (`sessions`, `commands`) and Node builtins.
 */
import { type DshEvent } from "./sts.js";
export declare const name = "session-export-hub";
export declare const inject: string[];
export interface PluginConfig {
    /** Hub dataset id, e.g. "edbeeching/dsh-agent-traces". */
    repo: string;
    /** Create the dataset as private and pass --private on uploads. */
    private: boolean;
    /** Value for the STS `harness` field (renderer/icon selection on the Hub). */
    harness: string;
    /** "turn": push after every turn/end · "dispose": push when a session closes · "manual": only via /share. */
    trigger: "turn" | "dispose" | "manual";
    /** Emit the request/header system prompt as a leading system message. */
    includeSystem: boolean;
    /** Emit feedback/record events as system messages. */
    includeFeedback: boolean;
    /** CLI binary used for uploads ("huggingface-cli" or "hf"). */
    cliPath: string;
    /** Access token; empty uses the CLI's cached login (HF_TOKEN also works). */
    token: string;
    /** Prefix for the commit message on each upload. */
    commitPrefix: string;
    /** Regex redaction rules applied to every shipped text field. */
    redact: Array<{
        pattern: string;
        replace: string;
    }>;
}
export declare const DEFAULTS: PluginConfig;
interface Logger {
    info(message: string): void;
    warn(message: string): void;
}
interface SessionLike {
    id: unknown;
    header?: Record<string, unknown>;
    events: DshEvent[];
}
interface CommandInvocation {
    agent: {
        session: SessionLike;
    };
}
interface HarnessContext {
    logger: Logger;
    on(event: string, listener: (...args: any[]) => void): void;
    sessions: {
        list(): SessionLike[];
    };
    commands: {
        register(options: {
            name: string;
            description: string;
            input?: {
                hint?: string;
            };
            recordInput?: boolean;
            handler(invocation: CommandInvocation): {
                kind: string;
                text: string;
            };
        }): void;
    };
}
export declare function apply(ctx: HarnessContext, config?: Partial<PluginConfig>): void;
export {};
