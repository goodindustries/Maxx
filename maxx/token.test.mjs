import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSetupToken } from "./token.mjs";

// A real setup-token (the one pasted this session), embedded in chatter the command prints.
const REAL = "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";

test("pulls the token out of surrounding human chatter", () => {
  const out = `Opening browser to authenticate…\nPaste this into MAXX:\n\n  ${REAL}\n\nDone. Keep it secret.\n`;
  assert.equal(extractSetupToken(out), REAL);
});

test("token alone on a line", () => {
  assert.equal(extractSetupToken(REAL + "\n"), REAL);
});

test("no token → null (so the caller skips, never posts garbage)", () => {
  assert.equal(extractSetupToken("Authentication cancelled.\n"), null);
  assert.equal(extractSetupToken(""), null);
  assert.equal(extractSetupToken(null), null);
});

test("does not mistake the CLI's refresh/login tokens for a setup-token", () => {
  // sk-ant-ort… is the rotating refresh token — must NOT be captured and posted
  assert.equal(extractSetupToken("sk-ant-ort01-abc123def456ghi789jkl012mno345pqr678stu"), null);
  // a short/truncated fragment is not a usable credential
  assert.equal(extractSetupToken("sk-ant-oat01-tooshort"), null);
});
