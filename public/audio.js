/**
 * Microphone: continuous speech recognition (live speech to text) plus a parallel
 * MediaRecorder that keeps the actual audio for playback and re-answer comparison.
 *
 * Speech recognition uses the Web Speech API, which needs Chrome or Edge.
 * The chat model used here takes text, not audio, so recognition happens in the
 * browser and only the transcript is sent over the socket.
 */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const speechSupported = Boolean(SR);

/**
 * Microphone access and speech recognition are gated behind a secure context.
 * `localhost` counts as secure; a plain-http LAN address such as
 * http://192.168.1.10:4001 does NOT - which is exactly what you get when opening
 * the app on a phone over the network. Without this check the failure surfaces as
 * "Cannot read properties of undefined", which explains nothing.
 */
export const secureContextOk =
  window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia);

export const insecureContextReason = window.isSecureContext
  ? null
  : `This page is on ${location.origin}, which browsers treat as insecure, so the microphone is blocked. Serve it over HTTPS, use a tunnel, or open it on localhost.`;

export class Mic {
  constructor({ onPartial, onFinal, onLevel, onEnd, lang = "en-GB" }) {
    this.onPartial = onPartial || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onEnd = onEnd || (() => {});
    this.lang = lang;
    this.listening = false;
    this.paused = false;
    this.pausedMs = 0; // time spent paused, excluded from the answer's duration
    this._pausedAt = null;
    this.chunks = [];
    this.finalText = "";
  }

  /**
   * Suspends capture without ending the answer - used while the examiner repeats a
   * question. Without this the repeated question is recorded into the candidate's
   * own audio and transcribed as if they had said it.
   */
  pause() {
    if (!this.listening || this.paused) return;
    this.paused = true;
    this._pausedAt = Date.now();
    try {
      if (this.recorder?.state === "recording") this.recorder.pause();
    } catch {
      /* ignore */
    }
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
  }

  resume() {
    if (!this.listening || !this.paused) return;
    this.pausedMs += Date.now() - this._pausedAt;
    this.paused = false;
    try {
      if (this.recorder?.state === "paused") this.recorder.resume();
    } catch {
      /* ignore */
    }
    try {
      this.rec?.start();
    } catch {
      /* already starting */
    }
  }

  async start() {
    if (this.listening) return;
    this.listening = true;
    this.chunks = [];
    this.finalText = "";
    this.paused = false;
    this.pausedMs = 0;
    this.startedAt = Date.now();

    if (!navigator.mediaDevices?.getUserMedia) {
      this.listening = false;
      throw new Error(
        insecureContextReason ||
          "This browser does not expose microphone access (navigator.mediaDevices is missing)."
      );
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    // stop() can arrive while the permission prompt is still open. Release the
    // microphone instead of starting a recorder nobody is left to stop.
    if (!this.listening) {
      this.stream.getTracks().forEach((t) => t.stop());
      return;
    }

    // --- recording ---
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    this.recorder = new MediaRecorder(this.stream, { mimeType: mime });
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start(250);

    // --- level meter ---
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    src.connect(this.analyser);
    this.buf = new Uint8Array(this.analyser.frequencyBinCount);
    this._meter();

    // --- speech recognition ---
    if (speechSupported) {
      this.rec = new SR();
      this.rec.continuous = true;
      this.rec.interimResults = true;
      this.rec.lang = this.lang;

      this.rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) {
            this.finalText += (this.finalText ? " " : "") + r[0].transcript.trim();
            this.onFinal(this.finalText);
          } else {
            interim += r[0].transcript;
          }
        }
        this.onPartial(interim);
      };

      this.rec.onerror = (e) => {
        // "no-speech" and "aborted" fire routinely; only surface real failures.
        if (!["no-speech", "aborted"].includes(e.error)) {
          console.warn("Speech recognition error:", e.error);
        }
      };

      // Chrome stops recognition after a silence. Restart while we are still listening.
      this.rec.onend = () => {
        if (this.listening && !this.paused) {
          try {
            this.rec.start();
          } catch {
            /* already starting */
          }
        }
      };

      this.rec.start();
    }
  }

  _meter() {
    if (!this.listening) return;
    if (this.paused) {
      this.onLevel(0);
      this.raf = requestAnimationFrame(() => this._meter());
      return;
    }
    this.analyser.getByteTimeDomainData(this.buf);
    let peak = 0;
    for (const v of this.buf) peak = Math.max(peak, Math.abs(v - 128));
    this.onLevel(Math.min(1, peak / 90));
    this.raf = requestAnimationFrame(() => this._meter());
  }

  /** Stops everything and resolves with the transcript plus the audio blob. */
  async stop() {
    if (!this.listening) return null;
    this.listening = false;
    cancelAnimationFrame(this.raf);

    // While paused the recogniser is already stopped, so no onend would arrive to wait for.
    if (this.rec && !this.paused) {
      // The recogniser delivers its last final result after stop() is called, so wait
      // for it to finish (briefly) before finalText is read, or the last phrase is lost.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 800);
        this.rec.onend = () => {
          clearTimeout(timer);
          resolve();
        };
        try {
          this.rec.stop();
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
      this.rec.onend = null;
    }

    const blob = await new Promise((resolve) => {
      if (!this.recorder || this.recorder.state === "inactive") return resolve(null);
      this.recorder.onstop = () =>
        resolve(new Blob(this.chunks, { type: this.recorder.mimeType }));
      this.recorder.stop();
    });

    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.onLevel(0);

    const result = {
      text: this.finalText.trim(),
      blob,
      durationMs: Date.now() - this.startedAt - this.pausedMs,
    };
    this.onEnd(result);
    return result;
  }
}

/**
 * Examiner voice. Picks the best available British English voice so the mock
 * sounds like the real thing.
 */
export const Voice = {
  enabled: true,
  _voice: null,

  pick() {
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return null;
    const prefer = [
      (v) => /en-GB/i.test(v.lang) && /google/i.test(v.name),
      (v) => /en-GB/i.test(v.lang) && /(natural|premium|enhanced)/i.test(v.name),
      (v) => /en-GB/i.test(v.lang),
      (v) => /en-/i.test(v.lang),
    ];
    for (const test of prefer) {
      const hit = voices.find(test);
      if (hit) return hit;
    }
    return voices[0];
  },

  init() {
    const set = () => (this._voice = this.pick());
    set();
    speechSynthesis.onvoiceschanged = set;
  },

  /**
   * Speaks text and resolves when finished, so the mic can open straight after.
   *
   * This MUST NOT be able to hang. Browser speech synthesis has two well-known
   * failure modes that otherwise freeze the whole exam: on a long utterance Chrome
   * stops partway and never fires `onend`, and a backgrounded tab can pause
   * synthesis indefinitely. So the text is split into short chunks, the engine is
   * nudged awake while it works, and every chunk has a watchdog that resolves it
   * even if no event ever arrives. A silent examiner is recoverable; a frozen
   * exam is not.
   */
  speak(text) {
    if (!this.enabled || !text.trim()) return Promise.resolve();
    speechSynthesis.cancel();
    this._cancelled = false;
    return chunk(text).reduce(
      (chain, part) => chain.then(() => (this._cancelled ? null : this._speakChunk(part))),
      Promise.resolve()
    );
  },

  _speakChunk(text) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearInterval(keepAlive);
        clearTimeout(watchdog);
        resolve();
      };

      const u = new SpeechSynthesisUtterance(text);
      u.voice = this._voice || this.pick();
      u.rate = 0.98;
      u.pitch = 1;
      u.onend = done;
      u.onerror = done;

      // Chrome pauses synthesis after roughly fifteen seconds; resuming keeps it
      // running, and a queue that has gone empty means we are done regardless.
      const keepAlive = setInterval(() => {
        if (speechSynthesis.speaking) speechSynthesis.resume();
        else if (!speechSynthesis.pending) done();
      }, 3000);

      // Roughly 2.2 words per second, plus a generous floor and tail.
      const words = text.split(/\s+/).filter(Boolean).length;
      const watchdog = setTimeout(done, Math.max(6000, (words / 2.2) * 1000 + 5000));

      speechSynthesis.speak(u);
    });
  },

  stop() {
    this._cancelled = true;
    speechSynthesis.cancel();
  },
};

/**
 * Splits speech into short utterances at sentence boundaries. Short utterances are
 * what keep the synthesiser reliable; they also let `stop()` take effect promptly.
 */
function chunk(text, max = 160) {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const out = [];
  let buf = "";
  for (const s of sentences) {
    if ((buf + s).length > max && buf) {
      out.push(buf.trim());
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
