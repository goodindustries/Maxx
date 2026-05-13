import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DB_PATH = join(ROOT, "data", "runs.db");
mkdirSync(join(ROOT, "data"), { recursive: true });

const db = new DatabaseSync(DB_PATH);

// Migrate: add topic column if not present
try { db.exec("ALTER TABLE runs ADD COLUMN topic TEXT"); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at           TEXT    DEFAULT (datetime('now')),

    -- inputs
    raw_prompt           TEXT    NOT NULL,
    cleaned_prompt       TEXT,

    -- outputs from the downstream LLM (same model for both paths)
    raw_output           TEXT,
    maxx_output          TEXT,

    -- Promptfoo scores
    raw_score            REAL,
    maxx_score           REAL,
    delta                REAL,

    -- provenance
    downstream_provider  TEXT,
    optimizer_model      TEXT,
    promptfoo_eval_id    TEXT,

    -- Maxx metadata (useful for debugging the optimizer)
    ics_score            INTEGER,
    intent               TEXT,
    topic                TEXT
  )
`);

const INSERT = db.prepare(`
  INSERT INTO runs (
    raw_prompt, cleaned_prompt,
    raw_output, maxx_output,
    raw_score, maxx_score, delta,
    downstream_provider, optimizer_model, promptfoo_eval_id,
    ics_score, intent, topic
  ) VALUES (
    $rawPrompt, $cleanedPrompt,
    $rawOutput, $maxxOutput,
    $rawScore, $maxxScore, $delta,
    $downstreamProvider, $optimizerModel, $promptfooEvalId,
    $icsScore, $intent, $topic
  )
`);

const SELECT_MANY = db.prepare(
  "SELECT * FROM runs ORDER BY id DESC LIMIT $limit"
);

const SELECT_ONE = db.prepare(
  "SELECT * FROM runs WHERE id = $id"
);

const STATS = db.prepare(`
  SELECT
    COUNT(*)                                                        AS total,
    ROUND(AVG(delta), 3)                                           AS avg_delta,
    SUM(CASE WHEN delta > 0.05  THEN 1 ELSE 0 END)                AS wins,
    SUM(CASE WHEN delta < -0.05 THEN 1 ELSE 0 END)                AS losses,
    SUM(CASE WHEN ABS(delta) <= 0.05 THEN 1 ELSE 0 END)           AS ties,
    ROUND(AVG(raw_score),  3)                                      AS avg_raw_score,
    ROUND(AVG(maxx_score), 3)                                      AS avg_maxx_score
  FROM runs
  WHERE raw_score IS NOT NULL
`);

export function saveRun(data) {
  const result = INSERT.run({
    $rawPrompt:          data.rawPrompt          ?? null,
    $cleanedPrompt:      data.cleanedPrompt       ?? null,
    $rawOutput:          data.rawOutput           ?? null,
    $maxxOutput:         data.maxxOutput          ?? null,
    $rawScore:           data.rawScore            ?? null,
    $maxxScore:          data.maxxScore           ?? null,
    $delta:              data.delta               ?? null,
    $downstreamProvider: data.downstreamProvider  ?? null,
    $optimizerModel:     data.optimizerModel      ?? null,
    $promptfooEvalId:    data.promptfooEvalId      ?? null,
    $icsScore:           data.icsScore            ?? null,
    $intent:             data.intent              ?? null,
    $topic:              data.topic               ?? null,
  });
  return Number(result.lastInsertRowid);
}

export function getRuns(limit = 50) {
  return SELECT_MANY.all({ $limit: limit });
}

export function getRun(id) {
  const row = SELECT_ONE.get({ $id: id });
  return row ?? null;
}

export function getStats() {
  return STATS.get({});
}

export function getTopicStats() {
  return db.prepare(`
    SELECT
      topic,
      COUNT(*)                                               AS total,
      ROUND(AVG(delta), 3)                                  AS avg_delta,
      ROUND(AVG(raw_score), 3)                              AS avg_raw,
      ROUND(AVG(maxx_score), 3)                             AS avg_maxx,
      SUM(CASE WHEN delta >  0.05 THEN 1 ELSE 0 END)        AS wins,
      SUM(CASE WHEN delta < -0.05 THEN 1 ELSE 0 END)        AS losses,
      SUM(CASE WHEN ABS(delta) <= 0.05 THEN 1 ELSE 0 END)   AS ties
    FROM runs
    WHERE raw_score IS NOT NULL AND topic IS NOT NULL
    GROUP BY topic
    ORDER BY avg_delta DESC
  `).all({});
}

export function getIntentStats() {
  return db.prepare(`
    SELECT
      intent,
      topic,
      COUNT(*)                                               AS total,
      ROUND(AVG(delta), 3)                                  AS avg_delta,
      SUM(CASE WHEN delta >  0.05 THEN 1 ELSE 0 END)        AS wins,
      SUM(CASE WHEN delta < -0.05 THEN 1 ELSE 0 END)        AS losses
    FROM runs
    WHERE raw_score IS NOT NULL AND intent IS NOT NULL
    GROUP BY intent, topic
    ORDER BY avg_delta DESC
  `).all({});
}

export function getTopRuns(limit = 10, order = "DESC") {
  return db.prepare(`
    SELECT id, topic, intent, raw_prompt, cleaned_prompt, raw_score, maxx_score, delta
    FROM runs
    WHERE raw_score IS NOT NULL
    ORDER BY delta ${order === "ASC" ? "ASC" : "DESC"}
    LIMIT $limit
  `).all({ $limit: limit });
}
