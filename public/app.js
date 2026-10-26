import { Mic, Voice, speechSupported, secureContextOk, insecureContextReason } from "./audio.js";
import { Store, questionKey } from "./store.js";
import { reportFor, reportForAll, ANSWER_TARGETS } from "./report.js";

/* =====================================================================
   State
   ===================================================================== */

const state = {
  ws: null,
  connected: false,
  targetBand: 7,
  running: false,
  aborted: false,
  part: null,
  parts: [],
  cueCard: null,
  transcript: [], // { role: 'examiner'|'candidate', text, part, at }
  sessionId: null,
  sessionStartedAt: null,
  partDeadline: null,
  totalDeadline: null,
  mic: null,
  assessment: null,
  timing: null,
  model: null, // currently selected model id
  models: [],
  mode: "full", // chosen format, committed only when Begin is pressed
  paper: null, // the generated question set for this sitting
  bank: null, // question-bank stats from the server
  viewing: null, // id of a past exam loaded from history, if any
  rawTranscript: null, // the untouched original, kept whenever corrections are applied
  corrections: [], // what a correction pass changed, for the diff view
  report: null, // the generated coaching report for the current sitting
  examConditions: true, // hide the examiner's words, as on exam day
  liveWords: 0, // words captured in the current answer, for the exam-conditions counter
  part2Notes: "", // what was written on the notepad during the Part 2 prep minute
  audioTranscribed: false, // whether the recordings have been re-read by speech-to-text
  repeating: false, // the examiner is replaying a question right now
  repeatsThisAnswer: 0, // repeats requested for the current question
  runs: [], // every marking run on the current transcript, for model comparison
  pending: new Map(), // request id -> { resolve, reject, onDelta }
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (ms) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 4200);
}

/* =====================================================================
   WebSocket transport
   ===================================================================== */

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    state.connected = true;
    $("#conn-dot").classList.add("on");
  };

  ws.onclose = () => {
    state.connected = false;
    $("#conn-dot").classList.remove("on");
    // Anything still in flight died with the socket. Without this the caller waits
    // for a reply that can never arrive - a button stuck disabled, or a test frozen
    // mid-turn with no error shown.
    failPending("Connection to the server was lost. Try again.");
    setTimeout(connect, 2000); // the examiner should survive a dropped socket
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = state.pending.get(msg.id);

    switch (msg.type) {
      case "delta":
        p?.onDelta?.(msg.text);
        break;
      case "turn_end":
        state.pending.delete(msg.id);
        p?.resolve({ text: msg.text, partComplete: msg.partComplete, meta: msg.meta });
        break;
      case "cue_card":
        state.pending.delete(msg.id);
        p?.resolve(msg.card);
        break;
      case "question_set":
        state.pending.delete(msg.id);
        state.bank = msg.stats;
        p?.resolve({ set: msg.set, meta: msg.meta });
        break;
      case "question_used":
        state.pending.delete(msg.id);
        state.bank = msg.stats;
        p?.resolve(msg.stats);
        break;
      case "assessment":
      case "comparison":
      case "repair":
        state.pending.delete(msg.id);
        p?.resolve({ data: msg.data, meta: msg.meta });
        break;
      case "error":
        state.pending.delete(msg.id);
        p ? p.reject(new Error(msg.error)) : toast(msg.error, true);
        break;
      default:
        // A reply this router does not know would otherwise leave its caller waiting
        // forever. Fail it loudly instead - that is a bug, not a runtime condition.
        if (p) {
          state.pending.delete(msg.id);
          p.reject(new Error(`Unhandled server message: ${msg.type}`));
        }
    }
  };
}

/** Rejects every in-flight request, e.g. because the socket went away. */
function failPending(message) {
  for (const [id, p] of state.pending) {
    clearTimeout(p.timer);
    state.pending.delete(id);
    p.reject(new Error(message));
  }
}

// Marking and paper generation legitimately take a while at high effort; the ceiling
// is only here so a lost reply surfaces as an error instead of hanging forever.
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/** Every request carries the currently selected model, so switching is instant. */
function request(payload, onDelta) {
  return new Promise((resolve, reject) => {
    // readyState is the truth; `connected` can lag a socket that has just died.
    if (!state.connected || state.ws?.readyState !== WebSocket.OPEN) {
      return reject(new Error("Not connected to the server. Reconnecting - try again shortly."));
    }

    const id = uid();
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error("The server did not respond in time. Try again."));
    }, REQUEST_TIMEOUT_MS);

    state.pending.set(id, {
      onDelta,
      timer,
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });

    try {
      state.ws.send(JSON.stringify({ ...payload, id, model: state.model }));
    } catch (err) {
      clearTimeout(timer);
      state.pending.delete(id);
      reject(err);
    }
  });
}

/* =====================================================================
   Conversation rendering
   ===================================================================== */

function addTurn(role, text, { interim = false } = {}) {
  const box = $("#conversation");
  box.querySelector(".empty-state")?.remove();
  const el = document.createElement("div");
  el.className = `turn ${role}${interim ? " interim" : ""}`;
  el.innerHTML = `<div class="who">${role === "examiner" ? "Examiner" : "You"}</div><div class="what"></div>`;
  el.querySelector(".what").textContent = text;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

/**
 * Under exam conditions the examiner's words are never shown, because on exam day
 * you only hear them once. Reading a question is materially easier than parsing it
 * aurally, so showing the text trains the wrong skill. The Part 2 task card is the
 * one exception - that really is handed to you in writing.
 */
function addExaminerTurn(text) {
  const el = addTurn("examiner", "");
  paintExaminerTurn(el, text, true);
  return el;
}

function paintExaminerTurn(el, text, done) {
  const what = el.querySelector(".what");
  // Never hide the text when there is no voice to hear it with, or the question
  // would vanish entirely.
  if (!state.examConditions || !Voice.enabled) {
    what.textContent = text;
    return;
  }
  what.innerHTML = done
    ? '<span class="spoken">🔊 spoken — hidden under exam conditions</span>'
    : '<span class="spoken">🔊 the examiner is speaking…</span>';
}

function setMic(live, status) {
  $("#mic-ring").classList.toggle("live", live);
  $("#mic-status").textContent = status;
  $("#btn-done").disabled = !live;

  // Only useful when the question was never shown. In practice mode the text is
  // already on screen, so the button would be noise.
  const repeat = $("#btn-repeat");
  repeat.hidden = !state.examConditions;
  repeat.disabled = !live || state.repeating;
}

/**
 * Replays the last thing the examiner said. Asking for repetition is normal in the
 * real test, so it is available rather than penalised - but the mic is paused while
 * the question plays, or the examiner's voice ends up recorded as the candidate's
 * answer, and the count is kept because needing several repeats is itself a
 * listening signal worth seeing in the report.
 */
async function repeatQuestion() {
  if (state.repeating || !state.mic) return;

  const last = [...state.transcript].reverse().find((t) => t.role === "examiner");
  if (!last?.text) return;

  state.repeating = true;
  state.repeatsThisAnswer += 1;
  $("#btn-repeat").disabled = true;
  const previousStatus = $("#mic-status").textContent;

  state.mic.pause();
  setMic(true, "Examiner is repeating…");

  try {
    await Voice.speak(last.text);
  } finally {
    state.mic?.resume();
    state.repeating = false;
    $("#btn-repeat").disabled = false;
    $("#mic-status").textContent = previousStatus;
  }
}

/* =====================================================================
   Timers
   ===================================================================== */

let timerHandle = null;

function startTimers() {
  clearInterval(timerHandle);
  timerHandle = setInterval(() => {
    const now = Date.now();
    const partLeft = state.partDeadline ? state.partDeadline - now : 0;
    const t = $("#part-timer");
    t.textContent = fmt(partLeft);
    t.classList.toggle("urgent", partLeft < 45000 && partLeft > 0);
    // Before the sitting starts the total clock has no meaningful value - showing
    // 00:00 would read as "out of time" when nothing has begun.
    $("#total-timer").textContent = state.totalDeadline
      ? `total ${fmt(state.totalDeadline - now)}`
      : "total --:--";

    if (state.partTotalMs) {
      const done = 1 - partLeft / state.partTotalMs;
      $("#part-progress").style.width = `${Math.min(100, Math.max(0, done * 100))}%`;
    }

    // The total clock was previously only displayed, never enforced: when it ran out
    // the test simply carried on. Now it ends the sitting, and if the flow does not
    // unwind promptly the test is closed out regardless.
    if (state.running && state.totalDeadline && now > state.totalDeadline) {
      if (!state.timeUpAt) {
        state.timeUpAt = now;
        state.aborted = true;
        Voice.stop();
        toast("Time is up. Ending the test.");
      } else if (now - state.timeUpAt > 6000) {
        endTest();
      }
    }
  }, 250);
}

function stopTimers() {
  clearInterval(timerHandle);
  $("#part-timer").textContent = "--:--";
  $("#total-timer").textContent = "total --:--";
  $("#part-progress").style.width = "0%";
}

/**
 * Shows "<label>… Ns" in an element while something slow runs, so a wait of five or
 * ten seconds never looks like the app has stopped. Returns a stop function.
 */
function countUp(selector, label) {
  const el = $(selector);
  const startedAt = Date.now();
  const paint = () => {
    const s = Math.round((Date.now() - startedAt) / 1000);
    el.textContent = s < 3 ? `${label}…` : `${label}… ${s}s`;
  };
  paint();
  const t = setInterval(paint, 1000);
  return () => {
    clearInterval(t);
    el.textContent = "";
  };
}

/**
 * Pushes the part and total deadlines back by however long the model kept us
 * waiting. The exam clocks should measure the exam, not the API.
 */
function creditThinkingTime(ms) {
  if (!ms || ms < 0) return;
  if (state.partDeadline) state.partDeadline += ms;
  if (state.totalDeadline) state.totalDeadline += ms;
  if (state.partTotalMs) state.partTotalMs += ms;
}

function setPart(part, phase = "") {
  state.part = part;
  const pill = $("#part-pill");
  pill.textContent = part ? state.timing[part].label : "Not started";
  pill.classList.toggle("live", Boolean(part));
  $("#phase-label").textContent = phase;
}

/* =====================================================================
   Candidate turn: mic + silence detection
   ===================================================================== */

function listenForAnswer({ maxMs, minMs = 1500 }) {
  return new Promise(async (resolve) => {
    const silenceMs = Number($("#silence-ms").value);
    let interimEl = null;
    let lastVoiceAt = Date.now();
    let settled = false;
    // Declared up front: finish() can run before these are assigned if the
    // microphone fails to open.
    let poll = null;
    let onKey = null;
    state.liveWords = 0;
    state.repeatsThisAnswer = 0;

    const finish = async (reason) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (onKey) document.removeEventListener("keydown", onKey);
      $("#btn-done").onclick = null;
      $("#btn-repeat").onclick = null;
      $("#btn-repeat").hidden = true;
      const result = await state.mic?.stop();
      state.mic = null;
      interimEl?.remove();
      $("#answer-timer").textContent = "";
      $("#answer-timer").className = "answer-timer";
      setMic(false, "Idle");
      resolve({ ...(result || { text: "", blob: null, durationMs: 0 }), reason, repeats: state.repeatsThisAnswer });
    };

    state.mic = new Mic({
      onPartial: (text) => {
        if (!text.trim()) return;
        lastVoiceAt = Date.now();
        if (!interimEl) interimEl = addTurn("candidate", "", { interim: true });
        // Under exam conditions you cannot read your own words back either - that
        // would let you self-correct visually, which you cannot do on the day. A
        // running word count still proves recognition is working.
        interimEl.querySelector(".what").textContent = state.examConditions
          ? `capturing… ${(state.liveWords + text.split(/\s+/).filter(Boolean).length)} words`
          : text;
        $("#conversation").scrollTop = $("#conversation").scrollHeight;
      },
      onFinal: (text) => {
        lastVoiceAt = Date.now();
        state.liveWords = text.split(/\s+/).filter(Boolean).length;
        if (interimEl) {
          interimEl.querySelector(".what").textContent = state.examConditions
            ? `capturing… ${state.liveWords} words`
            : text;
        }
      },
      onLevel: (v) => {
        $("#level-fill").style.width = `${v * 100}%`;
        if (v > 0.12) lastVoiceAt = Date.now();
      },
    });

    try {
      await state.mic.start();
    } catch (err) {
      toast(`Microphone unavailable: ${err.message}`, true);
      return finish("mic-error");
    }

    const startedAt = Date.now();
    setMic(true, "Listening…");

    poll = setInterval(() => {
      const now = Date.now();
      // Time spent listening to a repeat is not answering time.
      const elapsed = now - startedAt - (state.mic?.pausedMs || 0);
      if (state.repeating) {
        lastVoiceAt = now; // never time out mid-repeat
        return;
      }
      if (elapsed > maxMs) return finish("time");
      if (elapsed > minMs && now - lastVoiceAt > silenceMs) return finish("silence");
      if (state.partDeadline && now > state.partDeadline) return finish("part-over");
      // Only a running test can be aborted - state.aborted stays true after a
      // test ends, and must not cut short a standalone re-answer recording.
      if (state.running && state.aborted) return finish("aborted");

      // How long this answer has run. Part 1 wants 20-40s, Part 2 a sustained
      // 90-120s, Part 3 around 40-60s - so the colour tells you where you are.
      const timer = $("#answer-timer");
      timer.textContent = fmt(elapsed);
      const target = ANSWER_TARGETS[state.part] || ANSWER_TARGETS[1];
      timer.className =
        "answer-timer " +
        (elapsed < target.min * 1000 ? "short" : elapsed > target.max * 1000 ? "over" : "good");

      const quietFor = now - lastVoiceAt;
      setMic(true, quietFor > 900 ? `Listening… (${fmt(silenceMs - quietFor)} to hand back)` : "Listening…");
    }, 250);

    onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        finish("manual");
      } else if (e.code === "KeyR" && state.examConditions) {
        e.preventDefault();
        repeatQuestion();
      }
    };
    document.addEventListener("keydown", onKey);
    $("#btn-done").onclick = () => finish("manual");
    $("#btn-repeat").onclick = repeatQuestion;
  });
}

/* =====================================================================
   Examiner turn
   ===================================================================== */

async function examinerSpeaks() {
  const el = addTurn("examiner", "");
  const what = el.querySelector(".what");
  let acc = "";

  // A turn can take several seconds. Say so, and count, rather than showing a bare
  // spinner that gives no sign whether anything is happening.
  const waitStart = Date.now();
  what.innerHTML = '<span class="spinner"></span><span class="thinking">Examiner is thinking…</span>';
  setMic(false, "Examiner is thinking…");
  const ticker = setInterval(() => {
    if (acc) return; // first token has landed; the label is gone
    const s = Math.round((Date.now() - waitStart) / 1000);
    const label = what.querySelector(".thinking");
    if (label) {
      label.textContent =
        s < 8 ? "Examiner is thinking…" : `Examiner is thinking… ${s}s`;
    }
    setMic(false, `Examiner is thinking… ${s}s`);
  }, 1000);

  const remainingSeconds = state.partDeadline ? (state.partDeadline - Date.now()) / 1000 : 0;
  const elapsedSeconds = state.partTotalMs ? state.partTotalMs / 1000 - remainingSeconds : 0;

  const askedAt = Date.now();
  let text, partComplete;
  try {
    ({ text, partComplete } = await request(
    {
      type: "examiner_turn",
      part: state.part,
      targetBand: state.targetBand,
      cueCard: state.cueCard ? formatCue(state.cueCard) : null,
      plan: planFor(state.part),
      elapsedSeconds,
      remainingSeconds,
      history: state.transcript,
    },
    (chunk) => {
      acc += chunk;
      if (state.examConditions) {
        paintExaminerTurn(el, acc, false);
      } else {
        what.textContent = acc.replace("[[PART_COMPLETE]]", "");
      }
      $("#conversation").scrollTop = $("#conversation").scrollHeight;
    }
    ));
  } finally {
    clearInterval(ticker);
  }

  // Waiting on the model is not exam time. Give the clocks that time back, or a slow
  // turn silently eats the candidate's speaking minutes.
  creditThinkingTime(Date.now() - askedAt);

  paintExaminerTurn(el, text, true);
  state.transcript.push({ role: "examiner", text, part: state.part, at: Date.now() });

  setMic(false, "Examiner speaking…");
  await Voice.speak(text);
  return { text, partComplete };
}

function formatCue(c) {
  return `${c.topic} | You should say: ${c.bullets.join("; ")} | ${c.explain}`;
}

/* =====================================================================
   Saving answers
   ===================================================================== */

async function saveAnswer({ question, part, result }) {
  if (!result?.text && !result?.blob) return;
  await Store.saveAnswer({
    id: uid(),
    sessionId: state.sessionId,
    questionKey: questionKey(question),
    question,
    part,
    text: result.text,
    blob: result.blob,
    durationMs: result.durationMs,
    createdAt: Date.now(),
  });
}

async function persistSession() {
  if (!state.sessionId) return;
  await Store.saveSession({
    id: state.sessionId,
    startedAt: state.sessionStartedAt,
    // Re-marking a past exam must not rewrite when that exam actually ended.
    endedAt: state.viewing ? state.sessionEndedAt : Date.now(),
    parts: state.parts,
    targetBand: state.targetBand,
    transcript: state.transcript,
    cueCard: state.cueCard,
    assessment: state.assessment,
    runs: state.runs,
    rawTranscript: state.rawTranscript,
    corrections: state.corrections,
    part2Notes: state.part2Notes,
    audioTranscribed: state.audioTranscribed,
  });
}

/* =====================================================================
   Exam flow
   ===================================================================== */

async function runPart1or3(part) {
  setPart(part, part === 1 ? "Interview" : "Discussion");
  state.partTotalMs = state.timing[part].speakingSeconds * 1000;
  state.partDeadline = Date.now() + state.partTotalMs;

  while (!state.aborted && Date.now() < state.partDeadline) {
      const { text: question, partComplete } = await examinerSpeaks();
    if (partComplete || state.aborted) break;
    if (Date.now() >= state.partDeadline) break;

    const remaining = state.partDeadline - Date.now();
    const result = await listenForAnswer({ maxMs: Math.min(90000, remaining + 15000) });
    if (state.aborted) break;

    if (result.text) {
      state.transcript.push({ role: "candidate", text: result.text, part, at: Date.now(), ms: result.durationMs, repeats: result.repeats });
      await saveAnswer({ question, part, result });
    } else {
      // Silence is data too: the examiner should react to it, as a real one would.
      state.transcript.push({
        role: "candidate",
        text: "(no audible response)",
        part,
        at: Date.now(),
      });
    }
    renderTranscript();
  }
}

async function runPart2() {
  setPart(2, "Preparing your task card…");
  // No part clock yet - it starts when the preparation minute actually starts, below.
  state.partTotalMs = null;
  state.partDeadline = null;

  // Comes from the sitting's paper; the standalone request is the fallback for a
  // Part 2 run where paper generation failed.
  let card = state.paper?.part2;
  if (!card) {
    const stop = countUp("#prep-note", "Writing your task card");
    try {
      card = await request({ type: "cue_card" });
    } finally {
      stop();
    }
  }
  state.cueCard = card;
  renderCue(card);

  // Pencil and paper arrive with the card, not after the examiner stops talking.
  // You can start planning the moment you can read the topic, exactly as you would
  // when a real task card is put in front of you.
  const pad = $("#notepad");
  pad.value = "";
  $("#notepad-wrap").classList.remove("hidden");

  const intro = `Now, I'm going to give you a topic and I'd like you to talk about it for one to two minutes. Before you talk you'll have one minute to think about what you're going to say. Here is your topic. ${card.topic}`;
  addExaminerTurn(intro);
  state.transcript.push({ role: "examiner", text: `${intro} ${formatCue(card)}`, part: 2, at: Date.now() });

  setPart(2, "Listen — your preparation minute starts after this");
  setMic(false, "Examiner speaking…");
  $("#prep-note").textContent = "You can start making notes now.";

  // The minute begins when the examiner FINISHES, not when they start. Starting the
  // clock before this speech silently ate about twenty seconds of preparation.
  const spokenFrom = Date.now();
  await Voice.speak(intro);
  const introMs = Date.now() - spokenFrom;
  // The instructions are not preparation time, so hand that time back to the total.
  if (state.totalDeadline) state.totalDeadline += introMs;

  setPart(2, "Preparation — 1 minute");
  state.partTotalMs = state.timing[2].prepSeconds * 1000;
  state.partDeadline = Date.now() + state.partTotalMs;
  pad.focus();

  const prepEnd = state.partDeadline;
  while (Date.now() < prepEnd && !state.aborted) {
    $("#prep-note").textContent = `Preparation time: ${fmt(prepEnd - Date.now())} remaining`;
    await sleep(250);
  }
  state.part2Notes = pad.value.trim();
  if (state.aborted) return;

  $("#prep-note").textContent = "Speak now — 1 to 2 minutes.";
  const go = "All right? Remember you have one to two minutes for this, so don't worry if I stop you. I'll tell you when the time is up. Can you start speaking now, please?";
  addExaminerTurn(go);
  state.transcript.push({ role: "examiner", text: go, part: 2, at: Date.now() });
  await Voice.speak(go);

  // The long turn: 2 minutes, uninterrupted, with a longer silence tolerance
  // because a candidate pausing mid-answer must not lose their turn.
  // Notes stay visible while you speak, exactly as your paper does in the real test.
  setPart(2, "Long turn — speak for 1 to 2 minutes");
  state.partTotalMs = state.timing[2].speakingSeconds * 1000;
  state.partDeadline = Date.now() + state.partTotalMs;

  const result = await listenForAnswer({ maxMs: state.timing[2].speakingSeconds * 1000, minMs: 25000 });
  if (result.text) {
    state.transcript.push({ role: "candidate", text: result.text, part: 2, at: Date.now(), ms: result.durationMs, repeats: result.repeats });
    await saveAnswer({ question: card.topic, part: 2, result });
  }
  renderTranscript();

  if (state.aborted) return;
  const stop = "Thank you.";
  addExaminerTurn(stop);
  state.transcript.push({ role: "examiner", text: stop, part: 2, at: Date.now() });
  await Voice.speak(stop);
  $("#prep-note").textContent = "";
}

const MODE_INFO = {
  full: { name: "Full test", parts: [1, 2, 3] },
  1: { name: "Part 1 only", parts: [1] },
  2: { name: "Part 2 only", parts: [2] },
  3: { name: "Part 3 only", parts: [3] },
};

/** The pre-flight card: what is about to happen, and the single button that starts it. */
function renderPreflight() {
  const info = MODE_INFO[state.mode];
  const seconds = info.parts.reduce(
    (n, p) => n + state.timing[p].speakingSeconds + state.timing[p].prepSeconds,
    0
  );
  const mins = Math.round(seconds / 60);
  const modelLabel = state.models.find((m) => m.id === state.model)?.label || state.model;

  $("#preflight-summary").innerHTML = `
    <div><dt>Format</dt><dd>${esc(info.name)}</dd></div>
    <div><dt>Parts</dt><dd>${info.parts.join(", ")}</dd></div>
    <div><dt>Length</dt><dd>~${mins} min</dd></div>
    <div><dt>Target</dt><dd>Band ${state.targetBand.toFixed(1)}</dd></div>
    <div><dt>Examiner</dt><dd>${esc(modelLabel)}</dd></div>`;

  $("#cta-sub").textContent = `${info.name} · ~${mins} minutes`;

  $("#bank-note").textContent = state.bank
    ? `Your question bank holds ${state.bank.total} questions from past sittings. New ones are written to avoid repeating them.`
    : "";
}

/** The slice of the generated paper that belongs to a given part. */
function planFor(part) {
  if (!state.paper) return null;
  if (part === 1) return state.paper.part1;
  if (part === 3) return state.paper.part3;
  return null;
}

/** Every question id in the paper for the parts being sat, for the used-counter. */
function paperQuestionIds(parts) {
  if (!state.paper) return [];
  const ids = [];
  if (parts.includes(1)) state.paper.part1?.forEach((t) => t.questions.forEach((q) => ids.push(q.id)));
  if (parts.includes(2) && state.paper.part2?.id) ids.push(state.paper.part2.id);
  if (parts.includes(3)) state.paper.part3?.forEach((t) => t.questions.forEach((q) => ids.push(q.id)));
  return ids.filter(Boolean);
}

async function startTest(mode) {
  if (state.running) return;
  if (!state.connected) return toast("Still connecting to the server…", true);

  state.running = true;
  state.aborted = false;
  state.transcript = [];
  state.assessment = null;
  state.runs = []; // runs belong to a transcript, so a new test clears them
  state.viewing = null; // a new sitting is never a loaded past one
  state.rawTranscript = null;
  state.corrections = [];
  state.part2Notes = "";
  state.audioTranscribed = false;
  $("#notepad-wrap").classList.add("hidden");
  $("#viewing-banner").classList.add("hidden");
  $("#version-bar").classList.add("hidden");
  $("#report-card").classList.add("hidden");
  state.report = null;
  $("#changes-body").innerHTML = "";
  state.cueCard = null;
  state.sessionId = uid();
  state.sessionStartedAt = Date.now();
  state.parts = mode === "full" ? [1, 2, 3] : [Number(mode)];

  $("#conversation").innerHTML = "";
  $("#preflight").classList.add("hidden");
  $("#conversation").classList.remove("hidden");
  $("#cue-card").classList.add("hidden");
  $("#btn-stop").disabled = false;
  $("#btn-assess").disabled = true;
  $$(".mode").forEach((b) => (b.disabled = true));
  $("#feedback-body").innerHTML = '<p class="muted">No assessment for the current test yet.</p>';
  $("#runs-card").classList.add("hidden");

  const totalMs = state.parts.reduce(
    (sum, p) => sum + (state.timing[p].speakingSeconds + state.timing[p].prepSeconds) * 1000,
    0
  );
  // The exam clock starts when the exam does. It is deliberately not running while
  // the paper is being written, or a slow generation would eat the sitting.
  state.totalDeadline = null;
  state.timeUpAt = null;
  startTimers();

  try {
    // A fresh paper per sitting, written against the local bank so it never repeats.
    // This is the longest wait in the app, so it gets a counter and its own turn
    // in the conversation rather than a silent pause.
    const waiting = addTurn("examiner", "");
    waiting.querySelector(".what").innerHTML =
      '<span class="spinner"></span><span class="thinking">Writing your question paper…</span>';
    const paperStart = Date.now();
    const tick = setInterval(() => {
      const s = Math.round((Date.now() - paperStart) / 1000);
      const label = waiting.querySelector(".thinking");
      if (label) {
        label.textContent =
          s < 6
            ? "Writing your question paper…"
            : `Writing your question paper… ${s}s (a fresh one is written for every sitting)`;
      }
    }, 1000);

    let set;
    try {
      ({ set } = await request({
        type: "question_set",
        examId: state.sessionId,
        parts: state.parts,
        targetBand: state.targetBand,
      }));
    } finally {
      clearInterval(tick);
      waiting.remove();
    }

    state.paper = set;
    state.totalDeadline = Date.now() + totalMs; // the sitting starts now
    request({ type: "question_used", ids: paperQuestionIds(state.parts) }).catch(() => {});

    for (const part of state.parts) {
      if (state.aborted) break;
      if (part === 2) await runPart2();
      else await runPart1or3(part);
    }

    if (!state.aborted) {
      const close = "That is the end of the speaking test. Thank you.";
      addExaminerTurn(close);
      await Voice.speak(close);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    await endTest();
  }
}

async function endTest() {
  state.running = false;
  state.aborted = true;
  Voice.stop();
  if (state.mic) {
    await state.mic.stop().catch(() => {});
    state.mic = null;
  }
  stopTimers();
  setPart(null);
  setMic(false, "Idle");
  $("#btn-stop").disabled = true;
  $("#btn-assess").disabled = state.transcript.length === 0;
  $$(".mode").forEach((b) => (b.disabled = false));
  $("#prep-note").textContent = "";
  $("#notepad-wrap").classList.add("hidden");
  // The transcript stays on screen; the CTA returns underneath it for another sitting.
  $("#preflight").classList.remove("hidden");
  renderPreflight();
  await persistSession();
  renderTranscript();
  renderLibrary();
  renderComparePicker();
  renderHistory();
}

function renderCue(card) {
  $("#cue-topic").textContent = card.topic;
  $("#cue-bullets").innerHTML = card.bullets.map((b) => `<li>${esc(b)}</li>`).join("");
  $("#cue-explain").textContent = card.explain;
  $("#cue-card").classList.remove("hidden");
}

/* =====================================================================
   Transcript panel
   ===================================================================== */

function renderTranscript() {
  const body = $("#transcript-body");
  if (!state.transcript.length) {
    body.innerHTML = '<p class="muted">No transcript yet. Run a test on the Exam tab.</p>';
    $("#transcript-stats").innerHTML = "";
    return;
  }

  const mine = state.transcript.filter((t) => t.role === "candidate");
  const words = mine.reduce((n, t) => n + t.text.split(/\s+/).filter(Boolean).length, 0);
  const fillers = (mine.map((t) => t.text).join(" ").match(/\b(um|uh|er|erm|like|you know|actually|basically)\b/gi) || []).length;
  const durationMin = state.transcript.length
    ? (state.transcript.at(-1).at - state.transcript[0].at) / 60000
    : 0;
  // Below about half a minute the rate is noise, not a speaking pace - and a
  // malformed or imported session can make it absurd. Show a dash instead.
  const wpm = durationMin >= 0.5 && words ? Math.round(words / durationMin) : null;

  $("#transcript-stats").innerHTML = `
    <span><b>${words}</b> words spoken</span>
    <span><b>${mine.length}</b> answers</span>
    <span><b>${wpm ?? "–"}</b> words/min</span>
    <span><b>${fillers}</b> filler words</span>`;

  body.innerHTML = state.transcript
    .map((t) => {
      // Each answer carries how long it took, judged against what that part wants.
      let stamp = "";
      if (t.role === "candidate" && t.ms) {
        const secs = Math.round(t.ms / 1000);
        const target = ANSWER_TARGETS[t.part] || ANSWER_TARGETS[1];
        const cls = secs < target.min ? "short" : secs > target.max ? "over" : "good";
        const note =
          cls === "short"
            ? `short — aim for ${target.label}`
            : cls === "over"
              ? "over"
              : "on target";
        stamp = `<span class="stamp ${cls}">${fmt(t.ms)} · ${note}</span>`;
      }
      if (t.repeats) {
        stamp += `<span class="stamp repeat">↻ ${t.repeats} repeat${t.repeats > 1 ? "s" : ""}</span>`;
      }
      return `<div class="turn ${t.role}">
        <div class="who">${t.role === "examiner" ? "Examiner" : "You"}${stamp}</div>
        <div class="what">${esc(t.text)}</div></div>`;
    })
    .join("");
}

function transcriptText() {
  return state.transcript
    .map((t) => `${t.role === "examiner" ? "EXAMINER" : "CANDIDATE"}: ${t.text}`)
    .join("\n\n");
}

/* =====================================================================
   Transcript correction

   Two routes, deliberately separate:
     1. Re-transcribe the saved audio with a real speech-to-text model. Accurate,
        because it listens to what was actually said rather than guessing.
     2. Repair residual recogniser artefacts by inference, tightly constrained so
        that the candidate's own errors survive - they are what is being marked.
   The original is always kept, and which version gets marked is the user's choice.
   ===================================================================== */

/** Indexes of candidate turns, so corrections can be mapped back to the transcript. */
const candidateIndexes = () =>
  state.transcript.map((t, i) => (t.role === "candidate" ? i : -1)).filter((i) => i >= 0);

function markVersion() {
  const picked = document.querySelector('input[name="tver"]:checked')?.value;
  return picked === "raw" ? "raw" : "corrected";
}

/** The transcript actually sent for marking, honouring the version toggle. */
function transcriptForMarking() {
  if (!state.rawTranscript || markVersion() === "corrected") return state.transcript;
  return state.rawTranscript;
}

function showVersionBar() {
  $("#version-bar").classList.remove("hidden");
}

/** Snapshot the original once, before the first correction of a sitting. */
function keepOriginal() {
  if (!state.rawTranscript) {
    state.rawTranscript = state.transcript.map((t) => ({ ...t }));
  }
}

/**
 * @param {object} opts
 * @param {boolean} opts.silent  progress goes to the Feedback panel instead of the
 *                               Transcript button, for the automatic pre-marking pass
 */
async function reTranscribeFromAudio({ silent = false } = {}) {
  if (!state.transcript.length) {
    if (!silent) toast("Nothing to re-transcribe yet.", true);
    return;
  }

  const answers = await Store.listAnswers();
  const mine = answers.filter((a) => a.sessionId === state.sessionId && a.blob);
  if (!mine.length) {
    if (!silent) {
      toast("No saved audio for this exam. Recordings are needed to re-transcribe.", true);
    }
    return;
  }

  keepOriginal();
  const btn = $("#btn-retranscribe");
  btn.disabled = true;
  const progress = (msg) => {
    if (silent) {
      $("#feedback-body").innerHTML = `<p><span class="spinner"></span>${esc(msg)}</p>`;
    } else {
      btn.textContent = msg;
    }
  };

  // Oldest first, to line up with the order the answers were given.
  mine.sort((a, b) => a.createdAt - b.createdAt);
  const targets = candidateIndexes();
  const changes = [];
  let done = 0;

  for (const [n, answer] of mine.entries()) {
    progress(`Re-reading recording ${n + 1} of ${mine.length} with speech-to-text…`);
    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "audio/webm" },
        body: answer.blob,
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error);

      const idx = targets[n];
      if (idx != null && out.text && out.text !== state.transcript[idx].text) {
        changes.push({
          from: state.transcript[idx].text,
          to: out.text,
          reason: `Re-transcribed from your recording by ${out.model}.`,
          confidence: "high",
        });
        state.transcript[idx] = { ...state.transcript[idx], text: out.text };
      }
      // Keep the stored answer's text in step, so re-answer comparisons use it too.
      await Store.saveAnswer({ ...answer, text: out.text || answer.text });
      done++;
    } catch (err) {
      if (!silent) toast(`Answer ${n + 1}: ${err.message}`, true);
      else console.warn(`Answer ${n + 1}:`, err.message);
    }
  }

  btn.disabled = false;
  btn.textContent = "Re-transcribe audio";
  state.audioTranscribed = true;
  state.corrections = changes;
  showVersionBar();
  renderTranscript();
  renderChanges(changes, `Re-transcribed ${done} of ${mine.length} answers from audio.`);
  await persistSession();
  if (silent) return;
  toast(
    changes.length
      ? `${changes.length} answer${changes.length > 1 ? "s" : ""} updated from the recording.`
      : "Re-transcription matched the original."
  );
}

async function repairMishearings() {
  const targets = candidateIndexes();
  if (!targets.length) return toast("Nothing to repair yet.", true);

  keepOriginal();
  const btn = $("#btn-repair");
  btn.disabled = true;
  btn.textContent = "Checking…";

  try {
    const { data } = await request({
      type: "repair",
      turns: targets.map((i) => state.transcript[i].text),
    });

    const changes = [];
    for (const turn of data.turns) {
      const idx = targets[turn.index];
      if (idx == null || !turn.changed) continue;
      if (turn.corrected && turn.corrected !== state.transcript[idx].text) {
        changes.push(...(turn.changes || []));
        state.transcript[idx] = { ...state.transcript[idx], text: turn.corrected };
      }
    }

    state.corrections = changes;
    showVersionBar();
    renderTranscript();
    renderChanges(changes, data.summary);
    await persistSession();
    toast(changes.length ? `${changes.length} likely mis-hearing(s) fixed.` : "No mis-hearings found.");
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Fix mis-hearings";
  }
}

function renderChanges(changes, summary) {
  const box = $("#changes-body");
  if (!changes?.length) {
    box.innerHTML = `<div class="changes"><p class="muted">${esc(
      summary || "Nothing was changed."
    )}</p></div>`;
    return;
  }
  box.innerHTML = `<div class="changes">
    <h3>What was changed</h3>
    ${summary ? `<p class="muted" style="font-size:13px">${esc(summary)}</p>` : ""}
    ${changes
      .map(
        (c) => `<div class="change">
          <div class="from">${esc(c.from)}</div>
          <div class="to">${esc(c.to)}</div>
          <div class="why">${esc(c.reason)}${
            c.confidence ? ` <span class="pill">${esc(c.confidence)} confidence</span>` : ""
          }</div>
        </div>`
      )
      .join("")}
  </div>`;
}

/* =====================================================================
   Assessment panel
   ===================================================================== */

async function runAssessment() {
  if (!state.transcript.length) return;
  switchTab("feedback");
  const label = state.models.find((m) => m.id === state.model)?.label || state.model;

  // The browser recogniser is the weak link: it mishears accented English badly, and
  // a garbled transcript drags down Pronunciation, Lexical Resource and Grammar for
  // reasons that have nothing to do with the candidate. So the audio is re-read by a
  // real speech-to-text model BEFORE marking, whenever recordings exist and this has
  // not already been done for the sitting.
  if ($("#auto-transcribe").checked && !state.audioTranscribed) {
    const answers = (await Store.listAnswers()).filter(
      (a) => a.sessionId === state.sessionId && a.blob
    );
    if (answers.length) {
      $("#feedback-body").innerHTML =
        `<p><span class="spinner"></span>Re-reading your recordings with a speech-to-text model before marking, so the mark is not based on what the browser mis-heard…</p>`;
      try {
        await reTranscribeFromAudio({ silent: true });
        state.audioTranscribed = true;
      } catch (err) {
        toast(`Re-transcription skipped: ${err.message}`, true);
      }
    }
  }

  $("#feedback-body").innerHTML =
    `<p><span class="spinner"></span>Marking your test with ${esc(label)} at high reasoning effort. This takes 20–40 seconds…</p>`;

  try {
    const { data, meta } = await request({
      type: "assess",
      transcript: transcriptForMarking(),
      targetBand: state.targetBand,
      part: state.parts.join(", "),
    });

    state.assessment = data;
    // Keep one run per model so the same transcript can be compared across models.
    state.runs = state.runs.filter((r) => r.meta.model !== meta.model);
    state.runs.push({ data, meta, at: Date.now() });
    state.runs.sort((a, b) => a.meta.model.localeCompare(b.meta.model));

    renderAssessment(data, meta);
    renderRuns();
    await persistSession();
    await buildReportCard();
  } catch (err) {
    $("#feedback-body").innerHTML = `<p class="muted">Assessment failed: ${esc(err.message)}</p>`;
    toast(err.message, true);
  }
}

/** Saves a text file to disk. */
function download(filename, text, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Builds the exportable coaching report for the current sitting. Runs automatically
 * after every marking, so the file is ready without being asked for.
 */
async function buildReportCard() {
  const session = {
    id: state.sessionId,
    startedAt: state.sessionStartedAt,
    endedAt: state.viewing ? state.sessionEndedAt : Date.now(),
    parts: state.parts,
    targetBand: state.targetBand,
    transcript: state.transcript,
    rawTranscript: state.rawTranscript,
    corrections: state.corrections,
    cueCard: state.cueCard,
    assessment: state.assessment,
    runs: state.runs,
    part2Notes: state.part2Notes,
  };

  const { markdown, filename } = await reportFor(session);
  state.report = { markdown, filename };

  $("#report-card").classList.remove("hidden");
  $("#report-text").textContent = markdown;

  const blurb =
    `A full write-up of this sitting: transcript, marks with the evidence behind them, ` +
    `objective metrics, the task card, and your results from previous sittings. ` +
    `Written to be handed to a person or an AI assistant for a second opinion and a ` +
    `practice plan — it explains what it is and what to do with it, so it needs no other ` +
    `context. <strong>${(markdown.length / 1024).toFixed(1)} KB.</strong>`;
  $("#report-blurb").innerHTML = `${blurb} <span id="save-state">Saving to disk…</span>`;

  // Written to the server as well as offered as a download, so the report exists as
  // a file without anyone having to remember to save it.
  try {
    const res = await fetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, markdown }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error);
    $("#save-state").innerHTML = `Saved to <code>${esc(out.saved)}</code> (also <code>data/reports/latest.md</code>).`;
  } catch (err) {
    $("#save-state").innerHTML =
      `<span style="color:var(--warn)">Not saved to disk: ${esc(err.message)}. Use Download instead.</span>`;
  }
}

/** Side-by-side table of every model that has marked this transcript. */
function renderRuns() {
  const card = $("#runs-card");
  if (state.runs.length < 1) return card.classList.add("hidden");
  card.classList.remove("hidden");

  const spread =
    state.runs.length > 1
      ? Math.max(...state.runs.map((r) => r.data.overall_band)) -
        Math.min(...state.runs.map((r) => r.data.overall_band))
      : 0;

  $("#runs-table").innerHTML = `
    <table>
      <thead><tr>
        <th>Model</th><th>Overall</th><th>F&amp;C</th><th>LR</th><th>GRA</th><th>Pron</th>
        <th>Time</th><th>Output tokens</th>
      </tr></thead>
      <tbody>
        ${state.runs
          .map(
            (r, i) => `<tr class="run-row" data-run="${i}" style="cursor:pointer">
              <td><strong>${esc(r.meta.modelLabel || r.meta.model)}</strong></td>
              <td><strong>${r.data.overall_band.toFixed(1)}</strong></td>
              <td>${r.data.fluency_coherence.band.toFixed(1)}</td>
              <td>${r.data.lexical_resource.band.toFixed(1)}</td>
              <td>${r.data.grammatical_range.band.toFixed(1)}</td>
              <td>${r.data.pronunciation.band.toFixed(1)}</td>
              <td>${(r.meta.ms / 1000).toFixed(1)}s</td>
              <td>${r.meta.outputTokens ?? "–"}${
                r.meta.reasoningTokens ? ` <span class="muted">(${r.meta.reasoningTokens} reasoning)</span>` : ""
              }</td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>
    ${
      state.runs.length > 1
        ? `<p class="muted" style="font-size:13px;margin-top:10px">
             Models disagree by <strong>${spread.toFixed(1)}</strong> of a band on this transcript.
             ${spread >= 1 ? "That is a wide spread — read both sets of evidence before trusting either." : "Close agreement, which is a good sign that the mark is real."}
           </p>`
        : '<p class="muted" style="font-size:13px;margin-top:10px">Switch model in the header and press <strong>Re-mark</strong> to compare.</p>'
    }`;

  $$(".run-row").forEach((row) => {
    row.onclick = () => {
      const r = state.runs[Number(row.dataset.run)];
      renderAssessment(r.data, r.meta);
      $("#feedback-body").scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });
}

function critCard(label, c, target) {
  const hit = c.band >= target;
  return `<div class="crit">
    <div class="crit-head">
      <span class="name">${label}</span>
      <span class="band ${hit ? "hit" : "miss"}">${c.band.toFixed(1)}</span>
    </div>
    <div>${(c.evidence || []).map((e) => `<blockquote>${esc(e)}</blockquote>`).join("")}</div>
    <p style="font-size:13px;margin:8px 0 0">${esc(c.what_is_working)}</p>
    <div class="gap"><strong>To reach ${target}:</strong> ${esc(c.gap_to_target)}</div>
  </div>`;
}

function renderAssessment(a, meta) {
  const hit = a.overall_band >= a.target_band;
  $("#feedback-body").innerHTML = `
    <div class="score-hero">
      <div>
        <div class="big-band ${hit ? "hit" : "miss"}">${a.overall_band.toFixed(1)}</div>
        <div class="muted" style="font-size:12px">overall &middot; target ${a.target_band.toFixed(1)}</div>
      </div>
      <div class="hero-meta">
        <strong>${hit ? "At or above your target." : `${(a.target_band - a.overall_band).toFixed(1)} bands below target.`}</strong>
        <p class="verdict">${esc(a.verdict)}</p>
      </div>
    </div>

    <div class="crit-grid">
      ${critCard("Fluency &amp; Coherence", a.fluency_coherence, a.target_band)}
      ${critCard("Lexical Resource", a.lexical_resource, a.target_band)}
      ${critCard("Grammatical Range &amp; Accuracy", a.grammatical_range, a.target_band)}
      ${critCard("Pronunciation", a.pronunciation, a.target_band)}
    </div>

    <div class="section">
      <h3>Your sentences, rewritten at band ${a.target_band.toFixed(1)}</h3>
      ${a.upgrades
        .map(
          (u) => `<div class="upgrade">
            <div class="from">You said: ${esc(u.original)}</div>
            <div class="to">Band ${a.target_band.toFixed(1)}: ${esc(u.upgraded)}</div>
            <div class="why">${esc(u.why_it_scores_higher)}</div>
          </div>`
        )
        .join("")}
    </div>

    ${
      a.error_log?.length
        ? `<div class="section"><h3>Recurring errors</h3>
      <table><thead><tr><th>Type</th><th>You said</th><th>Correct</th></tr></thead><tbody>
      ${a.error_log
        .map(
          (e) =>
            `<tr><td>${esc(e.type)}</td><td>${esc(e.error)}</td><td>${esc(e.correction)}</td></tr>`
        )
        .join("")}
      </tbody></table></div>`
        : ""
    }

    ${
      a.vocabulary_to_steal?.length
        ? `<div class="section"><h3>Vocabulary to steal</h3>
      <table><thead><tr><th>Item</th><th>Use it for</th><th>Example</th></tr></thead><tbody>
      ${a.vocabulary_to_steal
        .map(
          (v) =>
            `<tr><td><strong>${esc(v.item)}</strong></td><td>${esc(v.use_it_for)}</td><td>${esc(v.example)}</td></tr>`
        )
        .join("")}
      </tbody></table></div>`
        : ""
    }

    <div class="section">
      <h3>Do these before your next attempt</h3>
      <ul class="drills">${a.drills.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
    </div>

    <div class="section">
      <h3>Session stats</h3>
      <div class="transcript-stats">
        <span><b>${a.stats.estimated_words_spoken}</b> words</span>
        <span>Fillers noted: ${a.stats.filler_words_noted.join(", ") || "none"}</span>
      </div>
      <p class="muted" style="font-size:13px">${esc(a.stats.longest_uninterrupted_answer_note)}</p>
    </div>

    <p class="muted" style="font-size:12px;border-top:1px solid var(--line);padding-top:12px">
      Practice estimate produced by <strong>${esc(meta?.modelLabel || meta?.model || "the selected model")}</strong>
      against a paraphrased rubric${
        meta ? ` in ${(meta.ms / 1000).toFixed(1)}s` : ""
      }. Not an official IELTS score.
    </p>`;
}

/* =====================================================================
   History: past exams
   ===================================================================== */

const wordsIn = (transcript) =>
  transcript
    .filter((t) => t.role === "candidate")
    .reduce((n, t) => n + t.text.split(/\s+/).filter(Boolean).length, 0);

async function renderHistory() {
  // Only sittings where the candidate actually spoke - an abandoned run with no
  // answers is noise in the list.
  const sessions = (await Store.listSessions()).filter((s) =>
    s.transcript?.some((t) => t.role === "candidate" && t.text?.trim())
  );
  const body = $("#history-body");
  $("#history-count").textContent = sessions.length
    ? `${sessions.length} sitting${sessions.length > 1 ? "s" : ""}`
    : "";

  if (!sessions.length) {
    body.innerHTML =
      '<p class="muted">No past exams yet. Finish a test and it will appear here.</p>';
    return;
  }

  body.innerHTML = sessions
    .map((s) => {
      const band = s.assessment?.overall_band;
      const hit = band != null && band >= (s.assessment?.target_band ?? s.targetBand);
      const models = (s.runs || []).map((r) => r.meta.modelLabel || r.meta.model);
      const mins = s.endedAt && s.startedAt ? Math.round((s.endedAt - s.startedAt) / 60000) : null;

      return `<div class="hist" data-id="${esc(s.id)}">
        <div class="hist-band ${band == null ? "unmarked" : hit ? "hit" : "miss"}">
          ${band == null ? "–" : band.toFixed(1)}
        </div>
        <div class="hist-main">
          <div class="hist-title">
            ${new Date(s.startedAt).toLocaleString([], {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </div>
          <div class="meta">
            <span>Part${s.parts?.length > 1 ? "s" : ""} ${(s.parts || []).join(", ")}</span>
            <span>Target ${Number(s.targetBand).toFixed(1)}</span>
            <span>${wordsIn(s.transcript)} words</span>
            ${mins != null ? `<span>${mins} min</span>` : ""}
            ${
              band == null
                ? '<span class="pill">not marked</span>'
                : models.length
                  ? `<span>${esc(models.join(", "))}</span>`
                  : ""
            }
          </div>
        </div>
        <div class="rec-actions">
          <button class="btn ghost" data-open="${esc(s.id)}">Open</button>
          <button class="btn ghost" data-delsession="${esc(s.id)}">Delete</button>
        </div>
      </div>`;
    })
    .join("");

  body.querySelectorAll("[data-open]").forEach((b) => {
    b.onclick = () => openSession(b.dataset.open);
  });

  body.querySelectorAll("[data-delsession]").forEach((b) => {
    b.onclick = async () => {
      // Removes the sitting and the answers recorded during it.
      await Store.deleteSession(b.dataset.delsession);
      if (state.sessionId === b.dataset.delsession) exitViewing();
      renderHistory();
      renderLibrary();
      renderComparePicker();
      toast("Exam deleted.");
    };
  });
}

/**
 * Loads a past sitting into the current view. The transcript, feedback and model-run
 * table all render through the normal path, so a loaded exam can be re-marked with a
 * different model exactly like a fresh one.
 */
async function openSession(id) {
  if (state.running) return toast("Finish the current test first.", true);

  const s = await Store.getSession(id);
  if (!s) return toast("That exam is no longer stored.", true);

  state.viewing = id;
  state.sessionId = s.id;
  state.sessionStartedAt = s.startedAt;
  state.sessionEndedAt = s.endedAt;
  state.transcript = s.transcript || [];
  state.parts = s.parts || [];
  state.cueCard = s.cueCard || null;
  state.assessment = s.assessment || null;
  state.runs = s.runs || [];
  state.targetBand = Number(s.targetBand);
  state.rawTranscript = s.rawTranscript || null;
  state.corrections = s.corrections || [];
  state.part2Notes = s.part2Notes || "";
  state.audioTranscribed = Boolean(s.audioTranscribed);

  $("#version-bar").classList.toggle("hidden", !state.rawTranscript);
  renderChanges(state.corrections, null);

  const band = $("#target-band");
  band.value = state.targetBand;
  $("#target-band-out").textContent = state.targetBand.toFixed(1);

  renderTranscript();
  renderRuns();
  if (state.assessment) {
    const last = state.runs.at(-1);
    renderAssessment(state.assessment, last?.meta);
    await buildReportCard(); // a past sitting is exportable too
  } else {
    $("#feedback-body").innerHTML =
      '<p class="muted">This exam was never marked. Press <strong>Mark this test</strong> on the Exam tab, or re-mark it from here.</p>';
  }

  $("#btn-assess").disabled = false;
  $("#viewing-banner").classList.remove("hidden");
  $("#viewing-text").innerHTML = `Viewing a past exam from <strong>${new Date(
    s.startedAt
  ).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</strong>. Marking it now adds a run to this sitting.`;

  switchTab("transcript");
}

/** Drops back out of a loaded past exam without touching what is stored. */
function exitViewing() {
  state.viewing = null;
  state.transcript = [];
  state.assessment = null;
  state.runs = [];
  state.cueCard = null;
  state.sessionId = null;
  $("#viewing-banner").classList.add("hidden");
  $("#runs-card").classList.add("hidden");
  $("#report-card").classList.add("hidden");
  state.report = null;
  $("#btn-assess").disabled = true;
  $("#feedback-body").innerHTML =
    '<p class="muted">No assessment yet. Finish a test, then press <strong>Mark this test</strong>.</p>';
  renderTranscript();
  switchTab("exam");
}

/* =====================================================================
   Recordings library
   ===================================================================== */

async function renderLibrary() {
  const answers = await Store.listAnswers();
  const body = $("#library-body");

  const est = await Store.estimateUsage();
  $("#storage-note").textContent = est
    ? `${(est.usage / 1048576).toFixed(1)} MB used locally`
    : "";

  if (!answers.length) {
    body.innerHTML = '<p class="muted">Nothing saved yet.</p>';
    return;
  }

  body.innerHTML = answers
    .map(
      (a) => `<div class="rec" data-id="${a.id}">
      <div>
        <div class="q">${esc(a.question)}</div>
        <div class="meta">
          <span>Part ${a.part}</span>
          <span>${new Date(a.createdAt).toLocaleString()}</span>
          <span>${Math.round(a.durationMs / 1000)}s</span>
          <span>${a.text.split(/\s+/).filter(Boolean).length} words</span>
        </div>
      </div>
      <div class="rec-actions">
        ${a.blob ? `<audio controls preload="none" src="${URL.createObjectURL(a.blob)}"></audio>` : '<span class="muted">no audio</span>'}
        <button class="btn ghost" data-view="${a.id}">Text</button>
        <button class="btn ghost" data-del="${a.id}">Delete</button>
      </div>
    </div>`
    )
    .join("");

  body.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      await Store.deleteAnswer(b.dataset.del);
      renderLibrary();
      renderComparePicker();
      toast("Recording deleted.");
    };
  });

  body.querySelectorAll("[data-view]").forEach((b) => {
    b.onclick = () => {
      const a = answers.find((x) => x.id === b.dataset.view);
      const row = body.querySelector(`.rec[data-id="${a.id}"]`);
      let p = row.querySelector(".answer-text");
      if (p) return p.remove();
      p = document.createElement("div");
      p.className = "answer-text muted";
      p.style.cssText = "grid-column:1/-1;font-size:13px;white-space:pre-wrap;padding-top:8px";
      p.textContent = a.text || "(no transcript captured)";
      row.appendChild(p);
    };
  });
}

/* =====================================================================
   Re-answer and compare
   ===================================================================== */

async function renderComparePicker() {
  const rows = await Store.questionIndex();
  const box = $("#compare-picker");
  if (!rows.length) {
    box.innerHTML = '<p class="muted">Answer some questions first.</p>';
    return;
  }

  box.innerHTML = rows
    .map(
      (r) => `<div class="q-row">
      <div>
        <div>${esc(r.question)}</div>
        <div class="muted" style="font-size:12px">Part ${r.part} &middot; last attempt ${new Date(r.lastAt).toLocaleDateString()}</div>
      </div>
      <span class="attempts-badge">${r.attempts} attempt${r.attempts > 1 ? "s" : ""}</span>
      <button class="btn ghost" data-retry="${esc(r.key)}">Re-answer</button>
    </div>`
    )
    .join("");

  box.querySelectorAll("[data-retry]").forEach((b) => {
    b.onclick = () => reAnswer(b.dataset.retry);
  });
}

async function reAnswer(key) {
  const attempts = await Store.attemptsFor(key);
  if (!attempts.length) return;
  const question = attempts[0].question;
  const part = attempts[0].part;

  $("#compare-result").innerHTML = "";
  $("#compare-stage").innerHTML = `
    <div class="card" style="background:var(--panel-2);margin:16px 0">
      <h3>Attempt ${attempts.length + 1}</h3>
      <p style="font-size:16px;font-weight:500">${esc(question)}</p>
      <p class="muted" id="retry-status">The question will be read aloud, then your mic opens.</p>
      <button class="btn primary" id="btn-retry-go" style="max-width:220px">Start recording</button>
    </div>`;

  $("#btn-retry-go").onclick = async () => {
    $("#btn-retry-go").disabled = true;
    const status = $("#retry-status");

    status.textContent = "Examiner speaking…";
    await Voice.speak(question);

    status.innerHTML = '<span class="spinner"></span>Recording — pause when you are finished.';
    state.partDeadline = null;
    const result = await listenForAnswer({
      maxMs: part === 2 ? 120000 : 90000,
      minMs: part === 2 ? 25000 : 2000,
    });

    if (!result.text) {
      status.textContent = "Nothing captured. Try again.";
      $("#btn-retry-go").disabled = false;
      return;
    }

    await Store.saveAnswer({
      id: uid(),
      sessionId: state.sessionId || "standalone",
      questionKey: key,
      question,
      part,
      text: result.text,
      blob: result.blob,
      durationMs: result.durationMs,
      createdAt: Date.now(),
    });

    status.innerHTML = '<span class="spinner"></span>Comparing your two best attempts…';
    const all = await Store.attemptsFor(key);
    const first = all[0];
    const latest = all.at(-1);

    try {
      const { data, meta } = await request({
        type: "compare",
        question,
        attemptA: { text: first.text, date: new Date(first.createdAt).toLocaleDateString() },
        attemptB: { text: latest.text, date: new Date(latest.createdAt).toLocaleDateString() },
        targetBand: state.targetBand,
      });
      status.textContent = `Compared by ${meta?.modelLabel || meta?.model} in ${(meta?.ms / 1000).toFixed(1)}s.`;
      renderComparison(data, first, latest);
    } catch (err) {
      status.textContent = `Comparison failed: ${err.message}`;
    }

    $("#btn-retry-go").disabled = false;
    renderLibrary();
    renderComparePicker();
  };
}

function renderComparison(c, first, latest) {
  const dir = c.delta > 0 ? "up" : c.delta < 0 ? "down" : "flat";
  const sign = c.delta > 0 ? "+" : "";
  const list = (title, items) =>
    items?.length
      ? `<div class="section"><h3>${title}</h3><ul class="drills">${items
          .map((i) => `<li>${esc(i)}</li>`)
          .join("")}</ul></div>`
      : "";

  $("#compare-result").innerHTML = `
    <div class="card" style="margin-top:16px">
      <div class="delta-hero">
        <div>
          <div class="delta-num ${dir}">${sign}${c.delta.toFixed(1)}</div>
          <div class="muted" style="font-size:12px">band change</div>
        </div>
        <div class="attempt-bands">
          <div>First<b>${c.attempt_1_band.toFixed(1)}</b></div>
          <div>Latest<b>${c.attempt_2_band.toFixed(1)}</b></div>
        </div>
        <div style="flex:1;min-width:220px">
          <span class="pill">${c.genuinely_improved ? "Genuine improvement" : "Not a real improvement yet"}</span>
          <p style="margin:8px 0 0">${esc(c.verdict)}</p>
        </div>
      </div>

      ${list("What improved", c.what_improved)}
      ${list("What went backwards", c.what_regressed)}
      ${
        c.superficial_changes?.length
          ? `<div class="section"><h3>Careful — an examiner would penalise this</h3>
             <div class="pill-list">${c.superficial_changes.map((s) => `<span class="pill">${esc(s)}</span>`).join("")}</div></div>`
          : ""
      }
      ${list(`Still missing for band ${state.targetBand}`, c.still_missing_for_target)}

      <div class="section">
        <h3>Focus for your next attempt</h3>
        <p>${esc(c.next_attempt_focus)}</p>
      </div>

      <div class="section">
        <h3>Listen back</h3>
        <div class="rec">
          <div><div class="q">First attempt</div><div class="meta">${new Date(first.createdAt).toLocaleString()}</div></div>
          <div>${first.blob ? `<audio controls preload="none" src="${URL.createObjectURL(first.blob)}"></audio>` : '<span class="muted">no audio</span>'}</div>
        </div>
        <div class="rec">
          <div><div class="q">Latest attempt</div><div class="meta">${new Date(latest.createdAt).toLocaleString()}</div></div>
          <div>${latest.blob ? `<audio controls preload="none" src="${URL.createObjectURL(latest.blob)}"></audio>` : '<span class="muted">no audio</span>'}</div>
        </div>
      </div>
    </div>`;
}

/* =====================================================================
   Tabs and wiring
   ===================================================================== */

function switchTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
  if (name === "library") renderLibrary();
  if (name === "compare") renderComparePicker();
  if (name === "history") renderHistory();
}

async function init() {
  Voice.init();
  connect();

  const cfg = await fetch("/api/config").then((r) => r.json());
  state.timing = cfg.timing;
  state.models = cfg.models;
  state.bank = cfg.bank;

  // Remember the last model across reloads, but never trust a stale id.
  let saved = null;
  try {
    saved = localStorage.getItem("ielts-model");
  } catch {
    /* private mode */
  }
  // Never start on a model this key cannot reach, saved or otherwise.
  const usable = cfg.models.filter((m) => m.available);
  const fallback = usable.some((m) => m.id === cfg.defaultModel)
    ? cfg.defaultModel
    : usable[0]?.id || cfg.defaultModel;
  state.model = usable.some((m) => m.id === saved) ? saved : fallback;

  const select = $("#model-select");
  select.innerHTML = cfg.models
    .map(
      (m) =>
        `<option value="${esc(m.id)}" title="${esc(m.note)}"${m.available ? "" : " disabled"}>${esc(
          m.label
        )}${m.available ? "" : " — no access"}</option>`
    )
    .join("");
  select.value = state.model;
  select.onchange = () => {
    state.model = select.value;
    try {
      localStorage.setItem("ielts-model", state.model);
    } catch {
      /* private mode */
    }
    const m = cfg.models.find((x) => x.id === state.model);
    toast(`Model: ${m.label}. ${m.note}`);
    renderPreflight();
  };

  $("#btn-remark").onclick = runAssessment;
  $("#btn-exit-viewing").onclick = exitViewing;

  $("#btn-report-download").onclick = () => {
    if (!state.report) return;
    download(state.report.filename, state.report.markdown);
    toast("Report downloaded.");
  };

  $("#btn-report-copy").onclick = async () => {
    if (!state.report) return;
    await navigator.clipboard.writeText(state.report.markdown);
    toast("Report copied — paste it into a chat for a second opinion.");
  };

  $("#btn-export-all").onclick = async () => {
    const btn = $("#btn-export-all");
    btn.disabled = true;
    try {
      const { markdown, filename, sittings } = await reportForAll();
      if (!sittings) return toast("No sittings to export yet.", true);
      download(filename, markdown);
      // Saved server-side too, so the history file is on disk without a download.
      fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, markdown }),
      }).catch(() => {});
      toast(`${sittings} sitting${sittings === 1 ? "" : "s"} exported, and saved to data/reports/.`);
    } finally {
      btn.disabled = false;
    }
  };

  const hint = [];
  if (!secureContextOk) {
    hint.push(
      `<strong>Microphone blocked on this address.</strong> ${esc(
        insecureContextReason || ""
      )} See "Using it on your phone" in the README.`
    );
  }
  if (!speechSupported)
    hint.push(
      "<strong>Speech recognition is unavailable in this browser.</strong> Use Chrome or Edge for live speech to text. Recording still works."
    );
  if (!cfg.hasKey) hint.push("<strong>No OPENAI_API_KEY set.</strong> Add one to .env and restart.");
  hint.push(
    "Model is switchable in the header and applies to your next request, mid-test included. Recordings stay in this browser."
  );
  $("#support-hint").innerHTML = hint.join("<br><br>");

  $$(".tab").forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));

  // Choosing a format only arms the test; nothing starts until Begin is pressed.
  $$(".mode").forEach((b) => {
    b.onclick = () => {
      if (state.running) return;
      state.mode = b.dataset.mode;
      $$(".mode").forEach((x) => x.classList.toggle("selected", x === b));
      renderPreflight();
    };
  });

  $("#btn-begin").onclick = async () => {
    const btn = $("#btn-begin");
    btn.disabled = true;
    btn.classList.add("loading");
    btn.querySelector(".cta-label").textContent = "Writing your question paper…";
    $("#cta-sub").textContent = "A new paper is generated for every sitting";
    try {
      await startTest(state.mode);
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
      btn.querySelector(".cta-label").textContent = "Begin test";
      renderPreflight();
    }
  };
  $("#btn-stop").onclick = () => {
    state.aborted = true;
    toast("Ending test…");
  };
  $("#btn-assess").onclick = runAssessment;

  const band = $("#target-band");
  band.oninput = () => {
    state.targetBand = Number(band.value);
    $("#target-band-out").textContent = state.targetBand.toFixed(1);
  };
  band.oninput = (() => {
    const base = band.oninput;
    return () => {
      base();
      renderPreflight();
    };
  })();
  band.dispatchEvent(new Event("input"));
  renderPreflight();

  // On by default: the drill should match the exam unless you deliberately relax it.
  const exam = $("#exam-conditions");
  let savedExam = null;
  try {
    savedExam = localStorage.getItem("ielts-exam-conditions");
  } catch {
    /* private mode */
  }
  state.examConditions = savedExam === null ? true : savedExam === "true";
  exam.checked = state.examConditions;

  const paintExamNote = () => {
    $("#exam-conditions-note").innerHTML = state.examConditions
      ? "The examiner's questions are spoken only, as on exam day. The Part 2 task card still appears — that one really is handed to you in writing. Full text is on the Transcript tab afterwards."
      : "<strong>Practice mode.</strong> Questions are shown as text. Easier than the real test, where you hear each question once.";
  };

  exam.onchange = () => {
    state.examConditions = exam.checked;
    try {
      localStorage.setItem("ielts-exam-conditions", String(state.examConditions));
    } catch {
      /* private mode */
    }
    paintExamNote();
    toast(
      state.examConditions
        ? "Exam conditions on — you will hear the questions, not read them."
        : "Practice mode — questions shown as text."
    );
  };
  paintExamNote();

  $("#voice-toggle").onchange = (e) => {
    Voice.enabled = e.target.checked;
    if (!e.target.checked) {
      Voice.stop();
      if (state.examConditions) {
        toast("Voice off, so questions will be shown as text — nothing to hear otherwise.");
      }
    }
  };

  $("#btn-retranscribe").onclick = reTranscribeFromAudio;
  $("#btn-repair").onclick = repairMishearings;

  // Switching version re-renders, so what you see is what will be marked.
  $$('input[name="tver"]').forEach((r) => {
    r.onchange = () => {
      const showRaw = markVersion() === "raw";
      const shown = showRaw ? state.rawTranscript : state.transcript;
      $("#transcript-body").innerHTML = shown
        .map(
          (t) => `<div class="turn ${t.role}">
            <div class="who">${t.role === "examiner" ? "Examiner" : "You"}</div>
            <div class="what">${esc(t.text)}</div></div>`
        )
        .join("");
      toast(showRaw ? "Marking will use your original transcript." : "Marking will use the corrected transcript.");
    };
  });

  $("#btn-view-changes").onclick = () => {
    const box = $("#changes-body");
    box.classList.toggle("hidden");
    $("#btn-view-changes").textContent = box.classList.contains("hidden")
      ? "Show changes"
      : "Hide changes";
  };

  $("#btn-copy-transcript").onclick = async () => {
    await navigator.clipboard.writeText(transcriptText());
    toast("Transcript copied.");
  };

  $("#btn-download-transcript").onclick = () => {
    const blob = new Blob([transcriptText()], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ielts-transcript-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
  };

  renderLibrary();
  renderComparePicker();
  renderHistory();
}

init();
