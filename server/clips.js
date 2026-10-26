/**
 * Clip capture for the transcription evals. The page at /capture.html records you
 * reading a script aloud and posts two things here: the audio, and what the browser's
 * own speech recogniser heard while you spoke. Both are scored against the script, so
 * the audio and the browser transcript for a clip must always come from one take.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CLIPS_DIR = path.join(here, "..", "evals", "clips");
export const RECORDINGS_DIR = path.join(CLIPS_DIR, "recordings");

export function loadScripts() {
  return JSON.parse(fs.readFileSync(path.join(CLIPS_DIR, "scripts.json"), "utf8"));
}

export const clipsRouter = express.Router();

clipsRouter.get("/", (_req, res) => {
  res.json(
    loadScripts().map((s) => ({
      ...s,
      recorded: fs.existsSync(path.join(RECORDINGS_DIR, `${s.id}.webm`)),
    }))
  );
});

clipsRouter.post(
  "/:id",
  express.raw({ type: ["audio/*", "application/octet-stream"], limit: "20mb" }),
  async (req, res) => {
    // The id comes from the URL. It is only ever used if it equals a known script id,
    // so it can never carry a path; that is what makes the file writes below safe.
    const script = loadScripts().find((s) => s.id === req.params.id);
    if (!script) return res.status(404).json({ error: "Unknown clip." });
    if (!req.body?.length) return res.status(400).json({ error: "No audio received." });

    // Headers are latin-1 on the wire, so the browser sends its transcript URI-encoded.
    let browserText = "";
    try {
      browserText = decodeURIComponent(req.get("x-browser-transcript") || "");
    } catch {
      return res.status(400).json({ error: "Bad transcript header." });
    }

    // Write both to temporary names, then rename. A failure while writing leaves the
    // previous take intact, so audio and transcript never come from different takes.
    await fs.promises.mkdir(RECORDINGS_DIR, { recursive: true });
    const finals = { txt: `${script.id}.browser.txt`, audio: `${script.id}.webm` };
    await fs.promises.writeFile(path.join(RECORDINGS_DIR, `${finals.txt}.tmp`), browserText, "utf8");
    await fs.promises.writeFile(path.join(RECORDINGS_DIR, `${finals.audio}.tmp`), req.body);
    for (const name of Object.values(finals)) {
      await fs.promises.rename(path.join(RECORDINGS_DIR, `${name}.tmp`), path.join(RECORDINGS_DIR, name));
    }
    res.json({ saved: script.id, bytes: req.body.length, browserText });
  }
);
