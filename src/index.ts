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
 * Everything else comes from the harness context (`sessions`, `commands`)
 * and Node builtins.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import z from "@deepseek-ai/schemastery";
import { buildStsSession, type DshEvent, type ExportSession } from "./sts.js";

const execFileAsync = promisify(execFile);

export const name = "session-export-hub";
export const inject = ["sessions", "commands"];

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
  redact: Array<{ pattern: string; replace: string }>;
}

/** Schemastery schema for the plugin's row config; validated by the loader at boot. */
export const Config = z.object({
  repo: z.string().required().description("Hub dataset id (owner/name)"),
  private: z.boolean().default(true).description("create/upload the dataset as private"),
  harness: z.string().default("deepseek-harness").description("STS `harness` field (Hub renderer/icon)"),
  trigger: z.union(["turn", "dispose", "manual"]).default("turn")
    .description("when to push: after every turn/end, on session dispose, or only via /share"),
  includeSystem: z.boolean().default(true).description("emit the request/header system prompt"),
  includeFeedback: z.boolean().default(false).description("emit feedback/record events"),
  cliPath: z.string().default("huggingface-cli").description("CLI binary for uploads (huggingface-cli or hf)"),
  token: z.string().default("").description("access token; empty uses HF_TOKEN or the CLI's cached login"),
  commitPrefix: z.string().default("dsh trace").description("prefix for upload commit messages"),
  redact: z.array(z.object({
    pattern: z.string().required().description("regex pattern (no flags; matched globally)"),
    replace: z.string().default("").description("replacement text"),
  })).default([]).description("redaction rules applied to every shipped text field"),
});

export const DEFAULTS: PluginConfig = {
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
// Minimal structural typing for the harness context we consume. Kept local so
// the plugin compiles with zero external dependencies.
// ---------------------------------------------------------------------------

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
  agent: { session: SessionLike };
  rawInput: string;
}

interface HarnessContext {
  logger: Logger;
  on(event: string, listener: (...args: any[]) => void): void;
  sessions: { list(): SessionLike[] };
  commands: {
    register(options: {
      name: string;
      description: string;
      input?: { hint?: string };
      recordInput?: boolean;
      handler(invocation: CommandInvocation): { kind: string; text: string };
    }): void;
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx: HarnessContext, config: Partial<PluginConfig> = {}): void {
  // The loader validates the row's config through `Config` at boot; validating
  // again here makes standalone/direct use fail fast with the same messages.
  const cfg: PluginConfig = Config({ ...DEFAULTS, ...config }) as unknown as PluginConfig;
  const redact = makeRedactor(cfg.redact);
  const inFlight = new Map<string, Promise<void>>();

  const push = (session: SessionLike, overrides: Partial<PluginConfig> = {}): Promise<void> => {
    const key = String(session.id);
    const existing = inFlight.get(key);
    if (existing) return existing; // never stack two pushes for the same session
    const effective = overrides && Object.keys(overrides).length > 0
      ? (Config({ ...cfg, ...overrides }) as unknown as PluginConfig)
      : cfg;
    const job = doPush(ctx, effective, session, makeRedactor(effective.redact)).catch((error: unknown) => {
      ctx.logger.warn(`session-export-hub: push failed for ${key}: ${String(error)}`);
    });
    inFlight.set(key, job);
    void job.finally(() => {
      if (inFlight.get(key) === job) inFlight.delete(key);
    });
    return job;
  };

  ctx.on("session/event", (session: SessionLike, event: DshEvent) => {
    if (cfg.trigger === "turn" && event.type === "turn/end") void push(session);
  });

  // In "turn" mode this is a final idempotent snapshot; in "dispose" mode it
  // is the only trigger; in "manual" mode nothing is pushed automatically.
  ctx.on("session/disposed", (session: SessionLike) => {
    if (cfg.trigger !== "manual") void push(session);
  });

  ctx.commands.register({
    name: "share",
    description: `push this session's traces to the Hub dataset (default: ${cfg.repo})`,
    input: { hint: "[repo]" },
    recordInput: false,
    handler: (invocation: CommandInvocation) => {
      const session = invocation.agent.session;
      const repo = invocation.rawInput.trim();
      void push(session, repo ? { repo } : {});
      return { kind: "success", text: `Pushing traces for session ${String(session.id)} to ${repo || cfg.repo}…` };
    },
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function doPush(
  ctx: HarnessContext,
  cfg: PluginConfig,
  session: SessionLike,
  redact: ((text: string) => string) | undefined,
): Promise<void> {
  const stsText = buildStsSession(
    session as ExportSession,
    {
      harness: cfg.harness,
      includeSystem: cfg.includeSystem,
      includeFeedback: cfg.includeFeedback,
      ...(redact ? { redact } : {}),
    },
  );
  const dir = await mkdtemp(join(tmpdir(), "dsh-sts-"));
  const file = join(dir, "session.jsonl");
  const pathInRepo = `${String(session.id)}/session.jsonl`;
  try {
    await writeFile(file, `${stsText}\n`, "utf8");
    await uploadWithRepoCreate(ctx, cfg, file, pathInRepo);
    ctx.logger.info(`session-export-hub: pushed ${String(session.id)} → ${cfg.repo} (${pathInRepo})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function uploadArgs(cfg: PluginConfig, file: string, pathInRepo: string): string[] {
  const args = ["upload", cfg.repo, file, pathInRepo, "--repo-type", "dataset", "--commit-message", `${cfg.commitPrefix}: ${pathInRepo}`];
  if (cfg.private) args.push("--private");
  if (cfg.token) args.push("--token", cfg.token);
  return args;
}

async function uploadWithRepoCreate(ctx: HarnessContext, cfg: PluginConfig, file: string, pathInRepo: string): Promise<void> {
  const args = uploadArgs(cfg, file, pathInRepo);
  try {
    await execFileAsync(cfg.cliPath, args, { timeout: 120_000 });
    return;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown })?.stderr ?? (error as Error).message ?? error);
    if (!/404|does not exist|not found|not_found|RepositoryNotFound/i.test(stderr)) throw error;
  }
  // Repo missing: create it via the Hub HTTP API (the `repo create` CLI flags
  // differ across huggingface-cli / hf versions), then retry the upload once.
  await ensureRepo(cfg);
  await execFileAsync(cfg.cliPath, args, { timeout: 120_000 });
}

/** Resolve the access token: config > HF_TOKEN > the CLI's cached login. */
function resolveToken(cfg: PluginConfig): string {
  if (cfg.token) return cfg.token;
  if (process.env.HF_TOKEN) return process.env.HF_TOKEN;
  try {
    return readFileSync(join(homedir(), ".cache", "huggingface", "token"), "utf8").trim();
  } catch {
    return "";
  }
}

/** Create the dataset repo via POST /api/repos/create; 409 (exists) is fine. */
async function ensureRepo(cfg: PluginConfig): Promise<void> {
  const token = resolveToken(cfg);
  if (!token) {
    throw new Error("no Hugging Face token found: set config.token, export HF_TOKEN, or run `huggingface-cli login`");
  }
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const [owner, name] = cfg.repo.split("/");
  if (!name) throw new Error(`repo id must be "owner/name", got ${JSON.stringify(cfg.repo)}`);
  // The create API namespaces the bare name under the authenticated user; an
  // org owner is passed via `organization`.
  const whoami = (await fetch("https://huggingface.co/api/whoami-v2", { headers })
    .then((r) => r.json())
    .catch(() => ({}))) as Record<string, unknown>;
  const body: Record<string, unknown> = { name, private: cfg.private, type: "dataset" };
  if (owner !== whoami.name) body.organization = owner;
  const response = await fetch("https://huggingface.co/api/repos/create", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`repo create failed (${response.status}): ${await response.text().catch(() => "")}`);
  }
}

function makeRedactor(rules: PluginConfig["redact"]): ((text: string) => string) | undefined {
  if (!rules || rules.length === 0) return undefined;
  const compiled = rules.map((r) => ({ re: new RegExp(r.pattern, "g"), replace: r.replace }));
  return (text: string) => compiled.reduce((acc, r) => acc.replace(r.re, r.replace), text);
}
