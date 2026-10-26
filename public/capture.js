/**
 * Records the eval clips. Uses the app's own `Mic`, so the browser transcript saved
 * here comes from the same recogniser settings the real exam uses.
 */
import { Mic, speechSupported, secureContextOk, insecureContextReason } from "/audio.js";

const list = document.getElementById("list");
const msg = document.getElementById("msg");

let mic = null;
let activeId = null;
let starting = false; // true while the microphone permission prompt is open
let stopping = false; // true while a take is being finalised and saved

if (!secureContextOk) msg.textContent = insecureContextReason;
else if (!speechSupported) msg.textContent = "This browser has no speech recogniser; use Chrome or Edge.";

// Without a recogniser there is no browser transcript to compare, so recording is off.
const canRecord = secureContextOk && speechSupported;

async function load() {
  try {
    const clips = await (await fetch("/api/clips")).json();
    list.replaceChildren(...clips.map(render));
  } catch (err) {
    msg.textContent = `Could not load the lines to read: ${err.message}. Is the server still running?`;
  }
}

function render(clip) {
  const li = document.createElement("li");
  li.id = clip.id;
  li.className = [clip.recorded ? "done" : "", clip.id === activeId ? "active" : ""].join(" ");

  const focus = Object.assign(document.createElement("div"), {
    className: "focus",
    textContent: `${clip.id} · ${clip.focus}${clip.recorded ? " · recorded" : ""}`,
  });
  const script = Object.assign(document.createElement("div"), {
    className: "script",
    textContent: clip.text,
  });
  const btn = Object.assign(document.createElement("button"), {
    textContent: clip.id === activeId ? "Stop and save" : clip.recorded ? "Re-record" : "Record",
    className: clip.id === activeId ? "stop" : "primary",
  });
  // Stop is unavailable until the mic is live, and every button waits while a take saves.
  btn.disabled = !canRecord || stopping || (clip.id === activeId ? starting : activeId !== null);
  btn.onclick = () => (clip.id === activeId ? finish(clip) : begin(clip));

  li.append(focus, script, btn);
  return li;
}

async function begin(clip) {
  // Claim the slot before the permission prompt, so a second click cannot start a
  // second recorder while the first is still waiting for the microphone.
  activeId = clip.id;
  starting = true;
  mic = new Mic({ lang: "en-GB" });
  await load();
  try {
    await mic.start();
  } catch (err) {
    msg.textContent = err.message;
    mic = null;
    activeId = null;
    return load();
  } finally {
    starting = false;
  }
  await load();
  msg.textContent = "Recording. Read the line, then press Stop.";
}

async function finish(clip) {
  if (!mic || stopping) return;
  stopping = true;
  const recorder = mic;
  await load();
  const result = await recorder.stop();
  mic = null;
  activeId = null;
  stopping = false;

  if (!result?.blob) {
    msg.textContent = "Nothing was recorded.";
    return load();
  }
  // An empty browser transcript would be scored as a total failure of the recogniser.
  // It is more likely the mic or the recogniser did not start, so ask for another take.
  if (!result.text) {
    msg.textContent = "The browser heard nothing, so this take was not saved. Check the microphone and try again.";
    return load();
  }

  try {
    const res = await fetch(`/api/clips/${clip.id}`, {
      method: "POST",
      headers: {
        "content-type": result.blob.type || "audio/webm",
        "x-browser-transcript": encodeURIComponent(result.text),
      },
      body: result.blob,
    });
    const body = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
    msg.textContent = res.ok ? `Saved ${clip.id}. Browser heard: "${body.browserText}"` : `Not saved: ${body.error}`;
  } catch (err) {
    msg.textContent = `Not saved: ${err.message}`;
  }
  await load();
}

load();
