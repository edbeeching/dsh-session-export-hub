import assert from "node:assert/strict";
// Test against the built artifact (dist/) because src/index.ts uses NodeNext
// "./sts.js" imports that only exist after `tsc` runs.
import { Config, DEFAULTS, type PluginConfig } from "../dist/index.js";

// 1. A minimal valid config normalizes: missing keys get schema defaults.
const minimal = Config({ repo: "owner/traces" }) as unknown as PluginConfig;
assert.equal(minimal.repo, "owner/traces");
assert.equal(minimal.private, true);
assert.equal(minimal.trigger, "turn");
assert.equal(minimal.harness, "deepseek-harness");
assert.equal(minimal.includeSystem, true);
assert.equal(minimal.includeFeedback, false);
assert.deepEqual(minimal.redact, []);

// 2. Every documented key round-trips.
const full = Config({
  repo: "org/deep-traces",
  private: false,
  harness: "my-harness",
  trigger: "manual",
  includeSystem: false,
  includeFeedback: true,
  cliPath: "hf",
  token: "hf_xyz",
  commitPrefix: "push",
  redact: [{ pattern: "hf_[A-Za-z0-9]{10,}", replace: "hf_***" }],
}) as unknown as PluginConfig;
assert.equal(full.repo, "org/deep-traces");
assert.equal(full.private, false);
assert.equal(full.trigger, "manual");
assert.equal(full.cliPath, "hf");
assert.equal(full.token, "hf_xyz");
assert.equal(full.redact[0].pattern, "hf_[A-Za-z0-9]{10,}");

// 3. DEFAULTS merge: apply() feeds { ...DEFAULTS, ...config } through Config.
const merged = Config({ ...DEFAULTS, repo: "other/one" }) as unknown as PluginConfig;
assert.equal(merged.repo, "other/one");
assert.equal(merged.private, DEFAULTS.private);

// 4. Invalid values throw with a readable message.
assert.throws(() => Config({ repo: "owner/traces", trigger: "bogus" }), /bogus|trigger/i);
assert.throws(() => Config({ repo: 42 }), /repo/i);
assert.throws(() => Config({ repo: "owner/traces", private: "yes" }), /private/i);
assert.throws(() => Config({ repo: "owner/traces", redact: [{ pattern: 7 }] }), /pattern/i);
assert.throws(() => Config({}), /repo/i); // repo is required

// 5. Optional redact keys normalize with defaults.
const partialRedact = Config({ repo: "a/b", redact: [{ pattern: "x" }] }) as unknown as PluginConfig;
assert.deepEqual(partialRedact.redact, [{ pattern: "x", replace: "" }]);

console.log("config.test.mts: all checks passed");
