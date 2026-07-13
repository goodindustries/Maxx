#!/usr/bin/env node
/** Configure Codex's native footer without disturbing unrelated TOML. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STATUS_ITEMS = [
  "model-with-reasoning",
  "context-remaining",
  "five-hour-limit",
  "weekly-limit",
  "used-tokens",
  "git-branch",
];

export function statusSnippet() {
  return `[tui]\nstatus_line = [${STATUS_ITEMS.map((item) => `"${item}"`).join(", ")}]\n`;
}

function assignmentEnd(lines, start) {
  let depth = 0;
  let opened = false;
  let quote = null;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    let escaped = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === "\\" && quote === '"') escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "#") break;
      else if (ch === "[") { depth++; opened = true; }
      else if (ch === "]") depth--;
    }
    if (!opened || depth <= 0) return i;
  }
  return lines.length - 1;
}

export function patchConfig(source) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = source.endsWith("\n");
  const lines = source ? source.split(/\r?\n/) : [];
  if (hadFinalNewline) lines.pop();
  const value = statusSnippet().trimEnd().split("\n").at(-1);

  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (!match) continue;
    if (sectionStart >= 0) { sectionEnd = i; break; }
    if (match[1].trim() === "tui") sectionStart = i;
  }

  if (sectionStart < 0) {
    if (lines.length && lines.at(-1).trim() !== "") lines.push("");
    lines.push("[tui]", value);
  } else {
    let assignment = -1;
    for (let i = sectionStart + 1; i < sectionEnd; i++) {
      if (/^\s*status_line\s*=/.test(lines[i])) { assignment = i; break; }
    }
    if (assignment >= 0) {
      const indent = lines[assignment].match(/^\s*/)?.[0] || "";
      const end = assignmentEnd(lines, assignment);
      lines.splice(assignment, end - assignment + 1, indent + value);
    } else {
      lines.splice(sectionEnd, 0, value);
    }
  }

  return lines.join(newline) + newline;
}

function parseArgs(argv) {
  const out = { dryRun: false, config: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run" || argv[i] === "--print") out.dryRun = true;
    else if (argv[i] === "--config") out.config = argv[++i];
  }
  return out;
}

export function configure({ configPath, dryRun = false } = {}) {
  const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
  const target = configPath || path.join(codexHome, "config.toml");
  const before = existsSync(target) ? readFileSync(target, "utf8") : "";
  const after = patchConfig(before);
  if (dryRun) return { target, before, after, changed: before !== after, backup: null };
  if (before === after) return { target, before, after, changed: false, backup: null };

  mkdirSync(path.dirname(target), { recursive: true });
  let backup = null;
  if (existsSync(target)) {
    backup = `${target}.bak-maxx`;
    try { copyFileSync(target, backup, constants.COPYFILE_EXCL); } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  writeFileSync(target, after);
  return { target, before, after, changed: true, backup };
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = configure({ configPath: args.config, dryRun: args.dryRun });
    if (args.dryRun) {
      process.stdout.write(`# maxx would set this Codex footer; unrelated config is omitted\n${statusSnippet()}`);
    } else if (result.changed) {
      process.stdout.write(`maxx configured Codex's native footer in ${result.target}.\n`);
      if (result.backup) process.stdout.write(`original backup: ${result.backup}\n`);
      process.stdout.write("Restart Codex or start a new task to see it.\n");
    } else {
      process.stdout.write(`maxx footer already configured in ${result.target}.\n`);
    }
  } catch (error) {
    process.stderr.write(`maxx setup: ${error.message}\n`);
    process.exitCode = 1;
  }
}
