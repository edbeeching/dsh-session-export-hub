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
 * Config is declared as a schemastery `Config` schema (the DSH convention):
 * the loader validates the row's config at boot, the web settings surface can
 * render it, and `apply()` re-validates defensively for standalone use.
 * Everything else comes from the harness context (`commands` and the session
 * lifecycle events) and Node builtins.
 */
import z from "@deepseek-ai/schemastery";
import { type DshEvent } from "./sts.js";
export declare const name = "session-export-hub";
export declare const inject: string[];
/** Default dataset name when `repo` is unset: `<your-username>/dsh-agent-traces`. */
export declare const DEFAULT_DATASET_NAME = "dsh-agent-traces";
export interface PluginConfig {
    /** Hub dataset id ("owner/name"); empty defaults to `<your-username>/dsh-agent-traces`. */
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
    /** Apply built-in secret patterns (SSH keys, common API tokens) before `redact`. */
    redactSecrets: boolean;
    /** Extra regex redaction rules applied after the built-ins, to every shipped text field. */
    redact: Array<{
        pattern: string;
        replace: string;
    }>;
}
/** Schemastery schema for the plugin's row config; validated by the loader at boot. */
export declare const Config: z<Schemastery.ObjectS<{
    repo: z<string, string>;
    private: z<boolean, boolean>;
    harness: z<string, string>;
    trigger: z<"turn" | "dispose" | "manual", "turn" | "dispose" | "manual">;
    includeSystem: z<boolean, boolean>;
    includeFeedback: z<boolean, boolean>;
    cliPath: z<string, string>;
    token: z<string, string>;
    commitPrefix: z<string, string>;
    redactSecrets: z<boolean, boolean>;
    redact: z<({
        pattern?: string | null | undefined;
        replace?: string | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
        pattern: z<string, string>;
        replace: z<string, string>;
    }>[]>;
}>, Schemastery.ObjectT<{
    repo: z<string, string>;
    private: z<boolean, boolean>;
    harness: z<string, string>;
    trigger: z<"turn" | "dispose" | "manual", "turn" | "dispose" | "manual">;
    includeSystem: z<boolean, boolean>;
    includeFeedback: z<boolean, boolean>;
    cliPath: z<string, string>;
    token: z<string, string>;
    commitPrefix: z<string, string>;
    redactSecrets: z<boolean, boolean>;
    redact: z<({
        pattern?: string | null | undefined;
        replace?: string | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
        pattern: z<string, string>;
        replace: z<string, string>;
    }>[]>;
}>>;
export declare const DEFAULTS: PluginConfig;
/**
 * High-signal secrets redacted by default (see `redactSecrets`). Each `pattern`
 * is a regex source compiled with the `g` flag. `[\s\S]` also spans the `\n`
 * escapes of a JSON string, so a PEM block inside tool-call arguments is still
 * caught. Keep these narrow and high-signal to avoid masking ordinary text.
 */
export declare const SECRET_PATTERNS: Array<{
    pattern: string;
    replace: string;
}>;
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
    rawInput: string;
}
interface HarnessContext {
    logger: Logger;
    on(event: string, listener: (...args: any[]) => void): void;
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
export declare function makeRedactor(rules: PluginConfig["redact"], includeSecrets?: boolean): ((text: string) => string) | undefined;
export {};
