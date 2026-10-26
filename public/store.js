/**
 * IndexedDB store. Holds audio blobs, transcripts and assessments locally in the
 * browser - nothing but text is ever sent to the API, and recordings never leave
 * this machine.
 */

const DB_NAME = "ielts-coach";
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("answers")) {
        // One row per answered question, so a question can be re-answered and compared.
        const s = db.createObjectStore("answers", { keyPath: "id" });
        s.createIndex("byQuestion", "questionKey", { unique: false });
        s.createIndex("bySession", "sessionId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result.__value ?? result);
    t.onerror = () => reject(t.error);
  });
}

function reqValue(request) {
  const box = {};
  request.onsuccess = () => (box.__value = request.result);
  return box;
}

/** A stable key so the same question groups its attempts together. */
export function questionKey(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

export const Store = {
  async saveSession(session) {
    return tx("sessions", "readwrite", (s) => reqValue(s.put(session)));
  },

  async listSessions() {
    const all = await tx("sessions", "readonly", (s) => reqValue(s.getAll()));
    return (all || []).sort((a, b) => b.startedAt - a.startedAt);
  },

  async getSession(id) {
    return tx("sessions", "readonly", (s) => reqValue(s.get(id)));
  },

  async deleteSession(id) {
    await tx("sessions", "readwrite", (s) => reqValue(s.delete(id)));
    const answers = await this.listAnswers();
    await Promise.all(
      answers.filter((a) => a.sessionId === id).map((a) => this.deleteAnswer(a.id))
    );
  },

  /** answer = { id, sessionId, questionKey, question, part, text, blob, durationMs, createdAt } */
  async saveAnswer(answer) {
    return tx("answers", "readwrite", (s) => reqValue(s.put(answer)));
  },

  async listAnswers() {
    const all = await tx("answers", "readonly", (s) => reqValue(s.getAll()));
    return (all || []).sort((a, b) => b.createdAt - a.createdAt);
  },

  async attemptsFor(key) {
    const all = await this.listAnswers();
    return all.filter((a) => a.questionKey === key).sort((a, b) => a.createdAt - b.createdAt);
  },

  async deleteAnswer(id) {
    return tx("answers", "readwrite", (s) => reqValue(s.delete(id)));
  },

  /** Distinct questions with attempt counts, for the re-answer picker. */
  async questionIndex() {
    const all = await this.listAnswers();
    const map = new Map();
    for (const a of all) {
      const row = map.get(a.questionKey) || {
        key: a.questionKey,
        question: a.question,
        part: a.part,
        attempts: 0,
        lastAt: 0,
      };
      row.attempts += 1;
      row.lastAt = Math.max(row.lastAt, a.createdAt);
      map.set(a.questionKey, row);
    }
    return [...map.values()].sort((a, b) => b.lastAt - a.lastAt);
  },

  async estimateUsage() {
    if (!navigator.storage?.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  },
};
