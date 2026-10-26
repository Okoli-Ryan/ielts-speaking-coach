/**
 * Local question bank, stored in SQLite via Node's built-in `node:sqlite`.
 *
 * Chosen over a JSON file because this grows without bound as you practise and the
 * useful queries are relational: "what have I not been asked lately", "which topics
 * am I over-drilling". It is one file on disk (data/coach.db), no dependency, and
 * you can open it with any SQLite browser.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, "..", "data");
const DB_PATH = path.join(DATA_DIR, "coach.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS questions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    part        INTEGER NOT NULL,
    topic       TEXT    NOT NULL,
    text        TEXT    NOT NULL,
    payload     TEXT,               -- JSON: cue card bullets etc, Part 2 only
    created_at  INTEGER NOT NULL,
    times_used  INTEGER NOT NULL DEFAULT 0,
    last_used   INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_questions_part ON questions(part);
  CREATE INDEX IF NOT EXISTS idx_questions_last_used ON questions(last_used);

  CREATE TABLE IF NOT EXISTS exams (
    id          TEXT PRIMARY KEY,
    started_at  INTEGER NOT NULL,
    parts       TEXT    NOT NULL,
    target_band REAL    NOT NULL,
    model       TEXT,
    set_json    TEXT    NOT NULL    -- the full generated question set
  );
`);

const stmt = {
  insertQuestion: db.prepare(
    `INSERT INTO questions (part, topic, text, payload, created_at) VALUES (?, ?, ?, ?, ?)`
  ),
  markUsed: db.prepare(
    `UPDATE questions SET times_used = times_used + 1, last_used = ? WHERE id = ?`
  ),
  recentByPart: db.prepare(
    `SELECT text FROM questions WHERE part = ? ORDER BY COALESCE(last_used, created_at) DESC LIMIT ?`
  ),
  recentTopics: db.prepare(
    `SELECT DISTINCT topic FROM questions WHERE part = ? ORDER BY COALESCE(last_used, created_at) DESC LIMIT ?`
  ),
  insertExam: db.prepare(
    `INSERT OR REPLACE INTO exams (id, started_at, parts, target_band, model, set_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ),
  stats: db.prepare(
    `SELECT part, COUNT(*) AS total, SUM(times_used) AS asked FROM questions GROUP BY part`
  ),
  mostAsked: db.prepare(
    `SELECT topic, SUM(times_used) AS asked FROM questions
     GROUP BY topic HAVING asked > 0 ORDER BY asked DESC LIMIT 8`
  ),
};

/** Text of questions recently seen for a part, so the generator can avoid repeats. */
export function recentQuestions(part, limit = 40) {
  return stmt.recentByPart.all(part, limit).map((r) => r.text);
}

/** Topics recently seen, so a new set explores different ground. */
export function recentTopics(part, limit = 12) {
  return stmt.recentTopics.all(part, limit).map((r) => r.topic);
}

/** Persists a generated set and returns it with database ids attached. */
export function saveQuestionSet(set) {
  const now = Date.now();
  const withIds = { ...set };

  const save = (part, topic, text, payload = null) => {
    const info = stmt.insertQuestion.run(part, topic, text, payload && JSON.stringify(payload), now);
    return Number(info.lastInsertRowid);
  };

  if (set.part1) {
    withIds.part1 = set.part1.map((t) => ({
      ...t,
      questions: t.questions.map((q) => ({ text: q, id: save(1, t.topic, q) })),
    }));
  }

  if (set.part2) {
    withIds.part2 = {
      ...set.part2,
      id: save(2, set.part2.theme, set.part2.topic, {
        bullets: set.part2.bullets,
        explain: set.part2.explain,
      }),
    };
  }

  if (set.part3) {
    withIds.part3 = set.part3.map((t) => ({
      ...t,
      questions: t.questions.map((q) => ({ text: q, id: save(3, t.theme, q) })),
    }));
  }

  return withIds;
}

/** Called when a question is actually put to the candidate, not merely generated. */
export function markUsed(id) {
  if (id) stmt.markUsed.run(Date.now(), id);
}

export function saveExam({ id, startedAt, parts, targetBand, model, set }) {
  stmt.insertExam.run(id, startedAt, JSON.stringify(parts), targetBand, model, JSON.stringify(set));
}

/** Small summary for the UI, so the bank's growth is visible. */
export function bankStats() {
  const byPart = stmt.stats.all();
  return {
    total: byPart.reduce((n, r) => n + r.total, 0),
    asked: byPart.reduce((n, r) => n + (r.asked || 0), 0),
    byPart,
    mostAsked: stmt.mostAsked.all(),
  };
}
