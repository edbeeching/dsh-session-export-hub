# dsh-session-export-hub

> Repository: <https://github.com/edbeeching/dsh-session-export-hub>

A [DeepSeek Harness](https://github.com/deepseek-ai) (cordis) plugin that exports
session telemetry as **Hugging Face Session Traces (STS-Format)** JSONL and
pushes it to a **private Hub dataset**, where it renders in the Hub's trace
viewer (Data Studio). Think of it as "pi-share-hf, but for DSH sessions".

- **Format**: [Session Traces Simple Format](https://huggingface.co/docs/hub/en/session-traces-format)
  (header line + `message` envelopes; `reasoningContent` → thinking blocks,
  `toolCalls`/`toolCallId` → stitched tool call/result pairs).
- **Transport**: shells out to `huggingface-cli` (default) or `hf`, using your
  cached CLI login; creates the dataset via the Hub HTTP API if it is missing.
- **Redaction by default**: SSH keys and common API tokens are scrubbed before
  upload (see [Security & redaction](#security--redaction)).
- **Zero runtime dependencies**: only Node builtins + the harness context.

## What is pushed

Each session is converted from the in-memory event stream (`session.events`):

| DSH event | STS output |
|---|---|
| `session` header + `session/title` | `session` header line (`name`, `model`, `cwd`, …) |
| `user/message` | `message` with `role: "user"` |
| `assistant/message` | `message` with `role: "assistant"` (+ `reasoningContent`) |
| `tool/call` | `message` with `role: "assistant"` and `toolCalls` |
| `tool/result` | `message` with `role: "tool"` and `toolCallId` (errors prefixed `[tool error]`) |
| `request/header` | leading `message` with `role: "system"` (deduped; opt-out) |
| `feedback/record` | `message` with `role: "system"` (opt-in) |
| chunks / turns / todos / compaction / approval / web requests … | dropped (streaming + control noise) |

Files land at `<repo>/<session-id>/session.jsonl` and are **replaced on every
push**, so the viewer always shows the current state of the session.

> ⚠️ Traces contain prompts, tool arguments, command output, file contents and
> local paths. The dataset is created **private** by default, and built-in
> secret patterns (SSH keys, common API tokens) are redacted automatically —
> but redaction is **best effort**, not a guarantee. Review the
> [Security & redaction](#security--redaction) section before enabling uploads.

## Install into a profile

The package declares `dsh.bundle` (see `cordis.patch.yml`), so installing it
activates the plugin layer automatically — no manual patch row needed:

```bash
# from the git repo
dsh plugin --profile web add github:edbeeching/dsh-session-export-hub

# or from a local checkout / tarball
dsh plugin --profile web add /path/to/dsh-session-export-hub
dsh plugin --profile web add ./dsh-session-export-hub-0.1.0.tgz   # pnpm pack output
```

`dist/` is committed to the repo and there is no `prepare` script, so a git
install needs **no `allowBuilds` permission** (pnpm runs no code at install
time). Remove with `dsh plugin --profile web remove dsh-session-export-hub`.

> **`repo` is optional.** If unset, the plugin defaults to
> `<your-username>/dsh-agent-traces` (resolved from your logged-in HF account).
> Override it to point at a specific dataset (see below).

### Configuration

Config is declared as a schemastery `Config` schema: the loader **validates
the row's config at boot** (invalid values fail with a readable message) and
defaults are applied automatically. The table below lists every key.

| key | default | meaning |
|---|---|---|
| `repo` | `<your-username>/dsh-agent-traces` | Hub dataset id (`owner/name`); set it to override the default |
| `private` | `true` | create/upload with private visibility |
| `harness` | `deepseek-harness` | STS `harness` field (renderer/icon on the Hub) |
| `trigger` | `turn` | `turn` = push after every turn/end (+ final push on dispose) · `dispose` = push when a session closes · `manual` = only via `/share` |
| `includeSystem` | `true` | emit the system prompt as a `system` message |
| `includeFeedback` | `false` | emit `feedback/record` events as `system` messages |
| `cliPath` | `huggingface-cli` | CLI binary for uploads (`hf` also works) |
| `token` | `HF_TOKEN` env, else cached `~/.cache/huggingface/token` | access token (passed via `HF_TOKEN`, never on argv) |
| `commitPrefix` | `dsh trace` | prefix for the upload commit message |
| `redactSecrets` | `true` | redact built-in secret patterns (SSH keys, common API tokens) |
| `redact` | `[]` | extra `[{ pattern, replace }]` regex rules, applied after the built-ins |

Override per profile by adding a row with the same id to the profile's
`cordis.patch.yml` (a later layer's `config` replaces the whole value, not
just changed keys):

```yaml
- patch:
    - id: session-export-hub
      config:
        # optional — defaults to <your-username>/dsh-agent-traces
        repo: your-username/your-dataset
        private: true
        redactSecrets: true
        trigger: turn
        redact:
          - pattern: 'my_internal_project_[A-Za-z0-9]+'
            replace: '[redacted]'
```

The `/share` command pushes the current session immediately; an optional
argument overrides the dataset for that one push:

```
/share                          # push to the configured repo
/share org/other-traces         # push this session to a different dataset
```

## Security & redaction

This plugin ships **private by default** and redacts high-signal secrets by
default, but treat it as a last line of defence, not a guarantee: a custom tool
can emit a secret in any shape, and regexes only catch the shapes below.

**Built-in patterns** (`redactSecrets: true`, on by default) are applied to
every text field that ships — message content, reasoning, tool call arguments
and results, and the session title:

- SSH private keys: any PEM / PKCS#8 / OpenSSH `-----BEGIN … PRIVATE KEY-----` block.
- SSH public keys: `ssh-rsa`, `ssh-ed25519`, `ssh-dss`, `ecdsa-sha2-nistp*` bodies.
- Hugging Face tokens (`hf_…`), OpenAI (`sk-…` / `sk-proj-…`), Anthropic
  (`sk-ant-…`), AWS access keys (`AKIA…` / `ASIA…` / `AIDA…`), GitHub
  (`gh*_…` / `github_pat_…`), Slack (`xox…`), and JWTs (`eyJ…`).

**Extend** with `redact` rules (regex source, matched globally); they run after
the built-ins. **Disable** the built-ins with `redactSecrets: false`.

Additional hardening:

- The HF token is passed to the CLI via the `HF_TOKEN` environment variable,
  never as a `--token` command-line argument (which would be visible in `ps`).
- The dataset is created/uploaded with `--private` by default (`private: true`).
- `repo` defaults to **your own** `<your-username>/dsh-agent-traces` (resolved
  from the authenticated account), so a misconfigured install can never push
  to someone else's repo.

Known limits: the `cwd` (local path) header field is **not** redacted by default
(it is usually useful context, not a secret) — add a `redact` rule if your
filesystem layout is sensitive.

## Local development

```bash
npm run build   # tsc → dist/
npm test        # STS mapping unit tests (node --experimental-strip-types)
npm run smoke -- .smoke/session-events.jsonl out.jsonl   # convert a raw session dump
```

To produce a raw dump from a session log (multi-frame zstd):
```bash
python3 -c "
import zstandard as z
dctx = z.ZstdDecompressor()
with dctx.stream_reader(open('<session>.jsonl.zstd','rb')) as r:
    open('session-events.jsonl','w').write(r.read().decode('utf-8'))
"
```

## Verified end-to-end

- STS conversion: tested against this repository's own live session —
  `huggingface-cli upload edbeeching/dsh-agent-traces …` created the private
  dataset and pushed
  [`session-1508fdfc…/session.jsonl`](https://huggingface.co/datasets/edbeeching/dsh-agent-traces/blob/main/session-1508fdfc-3b4b-4e77-beeb-028cf5e30a87/session.jsonl)
  (3000+ events → ~194 STS lines). Unauthenticated API access returns 401
  (private confirmed).
- Git install: `dsh plugin --profile demo add github:edbeeching/dsh-session-export-hub`
  installs the bundle and auto-appends it to `dsh.profile.bundles` (verified in a
  throwaway `$DSH_HOME`); `--dump-config` shows the `# == dsh-session-export-hub`
  layer and the module loads with `name/apply/inject` intact.

## Known limitations

- **Dataset only** for now: storage buckets need the `hf` CLI (`hf buckets
  sync`) and are not handled by this plugin yet.
- One growing `session.jsonl` per session, overwritten per push — no per-turn
  history files.
- No `session-telemetry/record` waterfall integration: this plugin reads
  `session.events` directly and applies only its own `redact` rules.
- Transport is a subprocess; a missing/renamed CLI surfaces as a logged push
  failure (the plugin never throws into the agent loop).
