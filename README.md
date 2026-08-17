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

> ⚠️ Traces contain prompts, tool arguments, command output, file contents,
> local paths, and possibly secrets — the HF docs' redaction warning applies.
> The dataset is created **private** by default. Mount `redact` rules to scrub
> text before upload (see below).

## Config

| key | default | meaning |
|---|---|---|
| `repo` | `edbeeching/dsh-agent-traces` | Hub dataset id (`owner/name`), created private if missing |
| `private` | `true` | create/upload with private visibility |
| `harness` | `deepseek-harness` | STS `harness` field (renderer/icon on the Hub) |
| `trigger` | `turn` | `turn` = push after every turn/end (+ final push on dispose) · `dispose` = push when a session closes · `manual` = only via `/share` |
| `includeSystem` | `true` | emit the system prompt as a `system` message |
| `includeFeedback` | `false` | emit `feedback/record` events as `system` messages |
| `cliPath` | `huggingface-cli` | CLI binary for uploads (`hf` also works) |
| `token` | `HF_TOKEN` env, else cached `~/.cache/huggingface/token` | access token |
| `commitPrefix` | `dsh trace` | prefix for the upload commit message |
| `redact` | `[]` | `[{ pattern, replace }]` regex rules applied to every shipped text |

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

### Configuration

The layer inserts the row with code defaults; override per profile by adding a
row with the same id to the profile's `cordis.patch.yml` (a later layer's
`config` replaces the whole value, not just changed keys):

```yaml
- patch:
    - id: session-export-hub
      config:
        repo: edbeeching/dsh-agent-traces
        trigger: turn
        redact:
          - pattern: 'hf_[A-Za-z0-9]{10,}'
            replace: 'hf_***'
```

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
