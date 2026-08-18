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
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import z from "@deepseek-ai/schemastery";
import { buildStsSession } from "./sts.js";
const execFileAsync = promisify(execFile);
export const name = "session-export-hub";
export const inject = ["commands"];
/** Default dataset name when `repo` is unset: `<your-username>/dsh-agent-traces`. */
export const DEFAULT_DATASET_NAME = "dsh-agent-traces";
/** Schemastery schema for the plugin's row config; validated by the loader at boot. */
export const Config = z.object({
    repo: z.string().default("").description("Hub dataset id (owner/name); empty defaults to <your-username>/dsh-agent-traces"),
    private: z.boolean().default(true).description("create/upload the dataset as private"),
    harness: z.string().default("deepseek-harness").description("STS `harness` field (Hub renderer/icon)"),
    trigger: z.union(["turn", "dispose", "manual"]).default("turn")
        .description("when to push: after every turn/end, on session dispose, or only via /share"),
    includeSystem: z.boolean().default(true).description("emit the request/header system prompt"),
    includeFeedback: z.boolean().default(false).description("emit feedback/record events"),
    cliPath: z.string().default("huggingface-cli").description("CLI binary for uploads (huggingface-cli or hf)"),
    token: z.string().default("").description("access token; empty uses HF_TOKEN or the CLI's cached login"),
    commitPrefix: z.string().default("dsh trace").description("prefix for upload commit messages"),
    redactSecrets: z.boolean().default(true).description("redact built-in secret patterns (SSH keys, common API tokens)"),
    redact: z.array(z.object({
        pattern: z.string().required().description("regex pattern (no flags; matched globally)"),
        replace: z.string().default("").description("replacement text"),
    })).default([]).description("extra redaction rules applied after the built-ins"),
});
export const DEFAULTS = {
    repo: "",
    private: true,
    harness: "deepseek-harness",
    trigger: "turn",
    includeSystem: true,
    includeFeedback: false,
    cliPath: "huggingface-cli",
    // Keep this in sync with the schema default; the env / cached-token fallback
    // lives in resolveToken(), not here (the loader passes the schema default and
    // would otherwise override any env-derived value here).
    token: "",
    commitPrefix: "dsh trace",
    redactSecrets: true,
    redact: [],
};
/**
 * High-signal secrets redacted by default (see `redactSecrets`). Each `pattern`
 * is a regex source compiled with the `g` flag. `[\s\S]` also spans the `\n`
 * escapes of a JSON string, so a PEM block inside tool-call arguments is still
 * caught. Keep these narrow and high-signal to avoid masking ordinary text.
 */
export const SECRET_PATTERNS = [
    // PEM / PKCS#8 / OpenSSH private keys (any key type).
    { pattern: "-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----", replace: "[redacted: private key]" },
    // SSH public keys (authorized_keys lines and id_*.pub bodies).
    { pattern: "ssh-(rsa|ed25519|dss|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521)[ \\t]+[A-Za-z0-9+/=]+", replace: "[redacted: ssh public key]" },
    // Hugging Face tokens.
    { pattern: "\\bhf_[A-Za-z0-9]{20,}\\b", replace: "hf_[redacted]" },
    // OpenAI (legacy and project-scoped).
    { pattern: "\\bsk-(proj-)?[A-Za-z0-9_-]{20,}", replace: "[redacted: openai key]" },
    // Anthropic.
    { pattern: "\\bsk-ant-[A-Za-z0-9_-]{10,}", replace: "[redacted: anthropic key]" },
    // AWS access key ids.
    { pattern: "\\b(?:AKIA|ASIA|AIDA)[0-9A-Z]{16}\\b", replace: "[redacted: aws key]" },
    // GitHub tokens (classic gh*_ and fine-grained github_pat_).
    { pattern: "\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\\b", replace: "[redacted: github token]" },
    { pattern: "\\bgithub_pat_[A-Za-z0-9_]{20,}\\b", replace: "[redacted: github token]" },
    // Slack tokens.
    { pattern: "\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b", replace: "[redacted: slack token]" },
    // JSON Web Tokens (three base64url segments).
    { pattern: "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b", replace: "[redacted: jwt]" },
];
// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
export function apply(ctx, config = {}) {
    // The loader validates the row's config through `Config` at boot; validating
    // again here makes standalone/direct use fail fast with the same messages.
    const cfg = Config({ ...DEFAULTS, ...config });
    const redact = makeRedactor(cfg.redact, cfg.redactSecrets);
    const inFlight = new Map();
    const push = (session, overrides = {}) => {
        const key = String(session.id);
        const existing = inFlight.get(key);
        if (existing)
            return existing; // never stack two pushes for the same session
        const effective = overrides && Object.keys(overrides).length > 0
            ? Config({ ...cfg, ...overrides })
            : cfg;
        const job = doPush(ctx, effective, session, makeRedactor(effective.redact, effective.redactSecrets)).catch((error) => {
            ctx.logger.warn(`session-export-hub: push failed for ${key}: ${String(error)}`);
        });
        inFlight.set(key, job);
        void job.finally(() => {
            if (inFlight.get(key) === job)
                inFlight.delete(key);
        });
        return job;
    };
    ctx.on("session/event", (session, event) => {
        if (cfg.trigger === "turn" && event.type === "turn/end")
            void push(session);
    });
    // In "turn" mode this is a final idempotent snapshot; in "dispose" mode it
    // is the only trigger; in "manual" mode nothing is pushed automatically.
    ctx.on("session/disposed", (session) => {
        if (cfg.trigger !== "manual")
            void push(session);
    });
    ctx.commands.register({
        name: "share",
        description: `push this session's traces to the Hub dataset (default: ${cfg.repo || `<you>/${DEFAULT_DATASET_NAME}`})`,
        input: { hint: "[repo]" },
        recordInput: false,
        handler: (invocation) => {
            const session = invocation.agent.session;
            const repo = invocation.rawInput.trim();
            void push(session, repo ? { repo } : {});
            return { kind: "success", text: `Pushing traces for session ${String(session.id)} to ${repo || cfg.repo || `<you>/${DEFAULT_DATASET_NAME}`}…` };
        },
    });
}
// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
async function doPush(ctx, cfg, session, redact) {
    const repo = await resolveRepo(cfg);
    const stsText = buildStsSession(session, {
        harness: cfg.harness,
        includeSystem: cfg.includeSystem,
        includeFeedback: cfg.includeFeedback,
        ...(redact ? { redact } : {}),
    });
    const dir = await mkdtemp(join(tmpdir(), "dsh-sts-"));
    const file = join(dir, "session.jsonl");
    const pathInRepo = `${String(session.id)}/session.jsonl`;
    try {
        await writeFile(file, `${stsText}\n`, "utf8");
        await uploadWithRepoCreate(ctx, cfg, repo, file, pathInRepo);
        ctx.logger.info(`session-export-hub: pushed ${String(session.id)} → ${repo} (${pathInRepo})`);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
/** Fail fast with an actionable message when the target repo is unset/malformed. */
function assertRepo(repo) {
    const value = String(repo ?? "").trim();
    if (!value) {
        throw new Error('session-export-hub: no dataset repo configured — set `repo: "<owner>/<name>"` in your profile\'s cordis.patch.yml');
    }
    const parts = value.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`session-export-hub: repo id must be "owner/name", got ${JSON.stringify(repo)}`);
    }
}
function uploadArgs(cfg, repo, file, pathInRepo) {
    const args = ["upload", repo, file, pathInRepo, "--repo-type", "dataset", "--commit-message", `${cfg.commitPrefix}: ${pathInRepo}`];
    if (cfg.private)
        args.push("--private");
    return args;
}
/**
 * Pass the token via `HF_TOKEN` in the child environment rather than `--token`
 * on argv, so it never appears in a `ps` listing.
 */
function uploadEnv(cfg) {
    const env = { ...process.env };
    const token = resolveToken(cfg);
    if (token)
        env.HF_TOKEN = token;
    return env;
}
async function uploadWithRepoCreate(ctx, cfg, repo, file, pathInRepo) {
    const args = uploadArgs(cfg, repo, file, pathInRepo);
    const env = uploadEnv(cfg);
    try {
        await execFileAsync(cfg.cliPath, args, { timeout: 120_000, env });
        return;
    }
    catch (error) {
        const stderr = String(error?.stderr ?? error.message ?? error);
        if (!/404|does not exist|not found|not_found|RepositoryNotFound/i.test(stderr))
            throw error;
    }
    // Repo missing: create it via the Hub HTTP API (the `repo create` CLI flags
    // differ across huggingface-cli / hf versions), then retry the upload once.
    await ensureRepo(cfg, repo);
    await execFileAsync(cfg.cliPath, args, { timeout: 120_000, env });
}
/** Resolve the access token: config > HF_TOKEN > the CLI's cached login. */
function resolveToken(cfg) {
    if (cfg.token)
        return cfg.token;
    if (process.env.HF_TOKEN)
        return process.env.HF_TOKEN;
    try {
        return readFileSync(join(homedir(), ".cache", "huggingface", "token"), "utf8").trim();
    }
    catch {
        return "";
    }
}
let cachedUsername;
/** Resolve the authenticated username from a token via whoami-v2 ("" on failure). */
async function whoamiName(token) {
    if (cachedUsername)
        return cachedUsername;
    const response = await fetch("https://huggingface.co/api/whoami-v2", {
        headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (!response || !response.ok)
        return "";
    const data = (await response.json().catch(() => ({})));
    const name = typeof data.name === "string" ? data.name : "";
    if (name)
        cachedUsername = name;
    return name;
}
/** Effective repo id: explicit config, else `<authenticated-user>/dsh-agent-traces`. */
async function resolveRepo(cfg) {
    const explicit = String(cfg.repo ?? "").trim();
    if (explicit) {
        assertRepo(explicit);
        return explicit;
    }
    const token = resolveToken(cfg);
    if (!token) {
        throw new Error("no Hugging Face token found: set config.token, export HF_TOKEN, or run `huggingface-cli login` (default repo is <you>/dsh-agent-traces)");
    }
    const username = await whoamiName(token);
    if (!username) {
        throw new Error('could not resolve your Hugging Face username — set `repo: "<owner>/<name>"` explicitly');
    }
    return `${username}/${DEFAULT_DATASET_NAME}`;
}
/** Create the dataset repo via POST /api/repos/create; 409 (exists) is fine. */
async function ensureRepo(cfg, repo) {
    const token = resolveToken(cfg);
    if (!token) {
        throw new Error("no Hugging Face token found: set config.token, export HF_TOKEN, or run `huggingface-cli login`");
    }
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    const [owner, name] = repo.split("/");
    const username = await whoamiName(token);
    const body = { name, private: cfg.private, type: "dataset" };
    // The create API namespaces the bare name under the authenticated user; an
    // org owner is passed via `organization`.
    if (owner !== username)
        body.organization = owner;
    const response = await fetch("https://huggingface.co/api/repos/create", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });
    if (!response.ok && response.status !== 409) {
        throw new Error(`repo create failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
}
export function makeRedactor(rules, includeSecrets = true) {
    const sources = includeSecrets ? [...SECRET_PATTERNS, ...(rules ?? [])] : (rules ?? []);
    if (sources.length === 0)
        return undefined;
    const compiled = [];
    for (const rule of sources) {
        let re;
        try {
            re = new RegExp(rule.pattern, "g");
        }
        catch (error) {
            // Fail with a readable message instead of a bare SyntaxError at boot.
            throw new Error(`session-export-hub: invalid redact pattern ${JSON.stringify(rule.pattern)}: ${error.message}`);
        }
        compiled.push({ re, replace: rule.replace });
    }
    return (text) => compiled.reduce((acc, r) => acc.replace(r.re, r.replace), text);
}
