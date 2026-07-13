import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { STATUS_ITEMS, configure, patchConfig } from "../../plugins/maxx/skills/usage/scripts/setup.mjs";

const expected = `status_line = [${STATUS_ITEMS.map((item) => `"${item}"`).join(", ")}]`;
const SETUP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../plugins/maxx/skills/usage/scripts/setup.mjs");

test("adds a tui section without changing existing config", () => {
  const before = 'model = "gpt-5.6"\n';
  assert.equal(patchConfig(before), `${before}\n[tui]\n${expected}\n`);
});

test("replaces a multiline status line and preserves the rest of tui", () => {
  const before = '[tui]\nanimations = true\nstatus_line = [\n  "model",\n  "current-dir",\n]\ntheme = "dark"\n\n[features]\nhooks = true\n';
  const after = patchConfig(before);
  assert.match(after, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(after, /animations = true/);
  assert.match(after, /theme = "dark"/);
  assert.match(after, /\[features\]\nhooks = true/);
  assert.doesNotMatch(after, /current-dir/);
});

test("configuration is idempotent and keeps the first backup", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "maxx-setup-"));
  const target = path.join(dir, "config.toml");
  writeFileSync(target, '[tui]\nstatus_line = ["model"]\n');

  const first = configure({ configPath: target });
  assert.equal(first.changed, true);
  assert.equal(readFileSync(`${target}.bak-maxx`, "utf8"), '[tui]\nstatus_line = ["model"]\n');

  const second = configure({ configPath: target });
  assert.equal(second.changed, false);
  assert.equal(readFileSync(`${target}.bak-maxx`, "utf8"), '[tui]\nstatus_line = ["model"]\n');
});

test("dry run does not write", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "maxx-dry-"));
  const target = path.join(dir, "config.toml");
  writeFileSync(target, 'model = "gpt-5.6"\n');
  const result = configure({ configPath: target, dryRun: true });
  assert.equal(result.changed, true);
  assert.equal(readFileSync(target, "utf8"), 'model = "gpt-5.6"\n');
});

test("dry-run CLI never prints unrelated config secrets", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "maxx-secret-"));
  const target = path.join(dir, "config.toml");
  writeFileSync(target, '[mcp_servers.private]\nhttp_headers = { Authorization = "SENTINEL_SECRET" }\n');
  const result = spawnSync(process.execPath, [SETUP, "--dry-run", "--config", target], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[tui\]/);
  assert.match(result.stdout, /status_line/);
  assert.doesNotMatch(result.stdout, /SENTINEL_SECRET|http_headers|mcp_servers/);
  assert.equal(readFileSync(target, "utf8"), '[mcp_servers.private]\nhttp_headers = { Authorization = "SENTINEL_SECRET" }\n');
});
