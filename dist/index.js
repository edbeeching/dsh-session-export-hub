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
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildStsSession } from "./sts.js";
const execFileAsync = promisify(execFile);
export const name = "session-export-hub";
export const inject = ["sessions", "commands"];
export const DEFAULTS = {
    repo: "edbeeching/dsh-agent-traces",
    private: true,
    harness: "deepseek-harness",
    trigger: "turn",
    includeSystem: true,
    includeFeedback: false,
    cliPath: "huggingface-cli",
    token: process.env.HF_TOKEN ?? "",
    commitPrefix: "dsh trace",
    redact: [],
};
// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
export function apply(ctx, config = {}) {
    const cfg = { ...DEFAULTS, ...config };
    const redact = makeRedactor(cfg.redact);
    const inFlight = new Map();
    const push = (session) => {
        const key = String(session.id);
        const existing = inFlight.get(key);
        if (existing)
            return existing; // never stack two pushes for the same session
        const job = doPush(ctx, cfg, session, redact).catch((error) => {
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
        description: `push this session's traces to the Hub dataset (${cfg.repo})`,
        input: { hint: "" },
        recordInput: false,
        handler: (invocation) => {
            const session = invocation.agent.session;
            void push(session);
            return { kind: "success", text: `Pushing traces for session ${String(session.id)} to ${cfg.repo}…` };
        },
    });
}
// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
async function doPush(ctx, cfg, session, redact) {
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
        await uploadWithRepoCreate(ctx, cfg, file, pathInRepo);
        ctx.logger.info(`session-export-hub: pushed ${String(session.id)} → ${cfg.repo} (${pathInRepo})`);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
function uploadArgs(cfg, file, pathInRepo) {
    const args = ["upload", cfg.repo, file, pathInRepo, "--repo-type", "dataset", "--commit-message", `${cfg.commitPrefix}: ${pathInRepo}`];
    if (cfg.private)
        args.push("--private");
    if (cfg.token)
        args.push("--token", cfg.token);
    return args;
}
async function uploadWithRepoCreate(ctx, cfg, file, pathInRepo) {
    const args = uploadArgs(cfg, file, pathInRepo);
    try {
        await execFileAsync(cfg.cliPath, args, { timeout: 120_000 });
        return;
    }
    catch (error) {
        const stderr = String(error?.stderr ?? error.message ?? error);
        if (!/404|does not exist|not found|not_found|RepositoryNotFound/i.test(stderr))
            throw error;
    }
    // Repo missing: create it via the Hub HTTP API (the `repo create` CLI flags
    // differ across huggingface-cli / hf versions), then retry the upload once.
    await ensureRepo(cfg);
    await execFileAsync(cfg.cliPath, args, { timeout: 120_000 });
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
/** Create the dataset repo via POST /api/repos/create; 409 (exists) is fine. */
async function ensureRepo(cfg) {
    const token = resolveToken(cfg);
    if (!token) {
        throw new Error("no Hugging Face token found: set config.token, export HF_TOKEN, or run `huggingface-cli login`");
    }
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    const [owner, name] = cfg.repo.split("/");
    if (!name)
        throw new Error(`repo id must be "owner/name", got ${JSON.stringify(cfg.repo)}`);
    // The create API namespaces the bare name under the authenticated user; an
    // org owner is passed via `organization`.
    const whoami = (await fetch("https://huggingface.co/api/whoami-v2", { headers })
        .then((r) => r.json())
        .catch(() => ({})));
    const body = { name, private: cfg.private, type: "dataset" };
    if (owner !== whoami.name)
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
function makeRedactor(rules) {
    if (!rules || rules.length === 0)
        return undefined;
    const compiled = rules.map((r) => ({ re: new RegExp(r.pattern, "g"), replace: r.replace }));
    return (text) => compiled.reduce((acc, r) => acc.replace(r.re, r.replace), text);
}
