# IELTS Speaking Coach

A mock IELTS Speaking examiner that talks to you, marks you against the four assessment
criteria, and shows you what a higher band would have sounded like — in your own words.

Powered by OpenAI (`gpt-6-astra`) over a WebSocket, with the microphone and all recordings
handled in the browser.

## Setup

```bash
npm install
cp .env.example .env    # then paste your key into .env
npm start
```

Open <http://localhost:5173> in **Chrome or Edge** (see the note on speech recognition below).

Get an API key at <https://platform.openai.com/api-keys>.

## How it works

| Piece | How it is done |
|---|---|
| Question papers | A fresh IELTS-standard paper generated per sitting, checked against your local bank so it never repeats |
| Examiner's questions | The selected model at low reasoning effort, streamed token-by-token over a WebSocket |
| Examiner's voice | Browser `speechSynthesis`, preferring a British English voice |
| Your speech → text | Browser Web Speech API, live and continuous |
| Turn-taking | Silence detection (configurable 1.5–4s) plus <kbd>Space</kbd> to hand back early |
| Recordings | `MediaRecorder` → IndexedDB, stored on your machine only |
| Marking | A second pass at high reasoning effort, returning a zod-validated object |
| Question bank | SQLite (`data/coach.db`) via Node's built-in `node:sqlite` — no dependency to install |

**On voice-to-voice.** This build keeps speech recognition and synthesis in the browser and sends
only text over the WebSocket. That is free, instant, keeps your audio on your own machine, and
guarantees a transcript to mark.

OpenAI does also offer a realtime speech-to-speech model (`gpt-realtime-2.1`) which would replace
the browser's recogniser and voice with a native audio socket. It would sound considerably more
natural and could hear things a transcript cannot — hesitation, intonation, actual pronunciation,
which is the one criterion this app has to infer rather than hear. The trade-offs are per-minute
audio billing, your audio leaving the machine, and a rewrite of the turn-taking layer. It is a
worthwhile upgrade, not a drop-in change.

## Evals

The three things that decide whether a mark can be trusted each have an eval. They live in
[`evals/`](evals) and call the same functions the app does ([`server/core.js`](server/core.js)).

```bash
npm test                                 # offline: the WER and normalisation maths
npm run eval                             # everything below
npm run eval -- repair                   # one of: repair | transcribe | marker
npm run eval -- repair --variant naive   # negative control, expected to FAIL
npm run eval -- repair --runs 3          # repeat each case to see run-to-run variance
```

| Eval | Asks | Needs |
|---|---|---|
| `repair` | Does the repair pass fix the recogniser's mis-hearings and leave the candidate's errors alone? | API key |
| `transcribe` | Browser recogniser vs `gpt-transcribe` on your own voice: word error rate, learner errors kept, fillers kept | API key and recordings |
| `marker` | Do weak, mid and strong answers rank correctly, and does repairing a garbled transcript avoid inflating the band? | API key |
| `disagreement` | Does comparing the browser and audio-model transcripts flag the places the audio model changed what was said? | Nothing (reads the saved `transcribe` result) |

**Hard** checks fail the run (exit code 1); **soft** checks print `warn`. Results are written to
`evals/results/`. These calls cost real money, mostly the `marker` eval, which makes six
high-effort marking calls.

**Recording clips for `transcribe`.** Start the app, open <http://localhost:5173/capture.html> in
Chrome or Edge and read each of the ten lines exactly as written, mistakes and "um"s included. The
page saves your audio and what the browser heard side by side. Audio stays in
`evals/clips/recordings/` and is git-ignored.

### Transcription options tried

One speaker, ten clips, one run each, scored by `npm run eval -- transcribe [--variant ...]`. The
browser recogniser scored 6.1% word error rate, 8/11 learner errors kept, 2/4 fillers kept.

| Option | Word error rate | Learner errors kept | Fillers kept |
|---|---|---|---|
| `gpt-transcribe`, shipped prompt | 6.5% | 8/11 | 0/4 |
| `gpt-transcribe` + verbatim-example prompt (`primed`) | 6.5% | 8/11 | 0/4 |
| `gpt-transcribe` + filler `keywords` | 6.5% | 8/11 | 0/4 |
| `gpt-transcribe` + prompt as context, `languages` (`context`) | 6.0% | 9/11 | 0/4 |
| `gpt-4o-transcribe` | 10.4% | 9/11 | 0/4 |
| `whisper-1` + verbatim-example prompt (`whisper`) | 5.6% | 9/11 | 3/4 |

`whisper-1` follows a hesitation-style prompt best, but OpenAI lists it as deprecated, and it
mishears words the others get right. No option kept every learner error, so the app also compares
the browser and audio transcripts and tells the marker where they disagree (`public/align.js`).
Errors that both transcripts lost cannot be seen this way; the `disagreement` eval counts them.

## Exam conditions

**On by default.** On exam day only the Part 2 task card is written down — Parts 1 and 3 are
purely spoken, and you hear each question once. So by default the examiner's words are never
shown on screen: you get the audio, and a marker that a question was spoken. The Part 2 task
card still appears, because that really is handed to you in writing, and a notepad appears with
it, because you really are given pencil and paper.

The preparation minute starts when the examiner **finishes** speaking, not when they start, so
you always get the full sixty seconds. You can begin writing as soon as the card appears.

Your own words are hidden as you speak too — a live word count confirms the microphone is
working without letting you proofread yourself, which you cannot do in the exam.

The full text of everything is on the **Transcript** tab once the sitting ends, and the notes
you made go into the coaching report.

Untick **Exam conditions** for practice mode, where questions appear as text. Useful when you
are learning a topic rather than rehearsing. The setting is remembered. Turning the examiner's
voice off automatically shows the text again — otherwise there would be nothing to hear and
nothing to read.


### Asking for a repeat

Because the question is only spoken, a **Repeat question** button appears while you answer
(shortcut: <kbd>R</kbd>). It replays exactly what the examiner said — it does not re-ask or
reword, so you hear the same question again.

The microphone is paused while it replays. Without that the examiner's voice would be recorded
into your own answer and transcribed as if you had said it. The paused time is excluded from
your answer duration, so using a repeat never makes an answer look longer than you spoke.

Repeats are counted and shown in the transcript and the report. Asking is allowed in the real
test and is not penalised in itself, but needing several is a listening signal worth seeing —
it costs marks indirectly, through hesitation and off-target answers.

## The five tabs

- **Exam** — pick a format on the right, then press **Begin test**. Choosing a format only arms
  the test; nothing starts until you press the CTA. Timings mirror the real exam:
  Part 1 five minutes, Part 2 one minute preparation then two minutes speaking, Part 3 five
  minutes. The examiner never corrects you during the test, exactly like the real thing.
- **Transcript** — the full conversation, plus words spoken, words per minute, and filler count.
  Copy or download it, and fix recognition errors (see below).
- **Feedback** — a band for each of the four criteria with quoted evidence, what is specifically
  missing for your target band, your own sentences rewritten at that band, a recurring-error
  table, vocabulary matched to the topics that came up, and drills.
- **History** — every past sitting, newest first, with its band, parts, length and the models
  that marked it. Open one to load its transcript and feedback back into the app; you can then
  re-mark an old exam with a different model and the run joins that sitting's comparison table.
  Deleting a sitting also deletes the recordings made during it.
- **Recordings** — every answer, with audio playback.
- **Re-answer** — pick a question you have answered before, record a new attempt, and get a
  direct comparison: what improved, what went backwards, and which "improvements" were
  superficial enough that an examiner would penalise them.

## Dynamic question papers

Every sitting gets a newly written paper, not a fixed script: three Part 1 topics with four
questions each (work or studies always first, as in the real test), a Part 2 cue card in the
standard format, and two Part 3 themes abstracted from it with questions that escalate to
something a strong candidate has to work at.

Every question is written to `data/coach.db`. The next paper is generated with your recent
topics and questions supplied as an exclusion list, so the bank makes each sitting *more*
varied as it grows rather than looping. The pre-flight card tells you how many questions it
holds.

It is a plain SQLite file — inspect it with any SQLite browser, or:

```bash
node -e "const{bankStats}=await import('./server/db.js');console.log(bankStats())" --input-type=module
```

Delete `data/coach.db` to start the bank over.

## Fixing transcription errors

The browser's recogniser mishears things. Two ways to fix that, on the Transcript tab:

**Re-transcribe audio** sends your saved recordings to a real speech-to-text model
(`gpt-transcribe`) and replaces each answer with what the audio actually contains. This is the
accurate route, because it listens rather than guesses. It needs recordings, so it only works
on sittings where audio was captured.

**Fix mis-hearings** infers corrections from context, for residual garble or when audio is
gone. Cheaper and faster, but it is guessing.

### The rule both of them follow

**Only the recogniser's mistakes get fixed. Yours never do.** This matters more than it sounds:
if a correction pass "helpfully" turned *"I am work as a developer"* into *"I am working as a
developer"*, your Grammatical Range score would rise on an error you actually made, and the mark
would be worthless. So the repair prompt is constrained hard — it fixes acoustic confusions
(*receipt* → *recipe*, *college* → *colleague*) and leaves every grammar error, wrong tense,
missing article, false start and filler word exactly as spoken.

It also preserves grammatical form when fixing a word: *"many receipt"* becomes *"many recipe"*,
not *"many recipes"*, because the wrong singular after "many" is your error, not the microphone's.

Your original transcript is always kept. A bar appears letting you choose which version gets
marked, and **Show changes** lists every edit with the reason and a confidence level. The
transcription model is *asked* to stay verbatim rather than tidy speech into fluent prose, because
that tidying inflates scores silently. **Asking is not the same as getting it.** On ten clips read
aloud by one speaker, `gpt-transcribe` kept none of the four scripted fillers and tidied three of
eleven planted learner errors, and a prompt written as a verbatim example changed nothing. The
browser recogniser did no better on learner errors (it dropped a whole sentence instead). See
[`evals/results/`](evals/results) and re-run `npm run eval -- transcribe` on your own voice.

Override the model with `TRANSCRIBE_MODEL` in `.env` if you want a cheaper one
(`gpt-4o-mini-transcribe`).

## Timing each answer

A live timer runs while you speak, colour-coded against what the part actually needs:
Part 1 roughly 20–40s, Part 2 a sustained 90–120s, Part 3 roughly 40–60s. It turns green when
you are in range and amber when you overrun.

Every answer keeps its duration. The Transcript tab stamps each one ("00:09 · short — aim for
20–40s"), and the report gets a per-question table with a count of how many answers under-ran.
Under-running is one of the most reliable causes of a capped Fluency & Coherence score, and it
is invisible without timing.

## Transcription before marking

**On by default.** Before a test is marked, your recordings are re-read by `gpt-transcribe` and
the transcript is replaced with what the audio actually contains. The browser recogniser is only
good enough to drive turn-taking; it mishears accented English badly, and a garbled transcript
drags down Pronunciation, Lexical Resource and Grammar for reasons that have nothing to do with
you. Marking the raw browser output produces a mark you cannot trust.

It runs once per sitting — re-marking with another model reuses the corrected transcript rather
than paying to transcribe again. Untick **Transcribe audio before marking** to skip it. If a
recording fails to transcribe the marking still proceeds, using what is already there.

## The coaching report

A report is written automatically every time a test is marked, and appears at the top of the
**Feedback** tab. Download it as Markdown or copy it to the clipboard.

It is one self-contained file designed to be handed to a person or an AI assistant for a second
opinion, so it opens by explaining what it is and what is being asked of the reader — no other
context needed. It contains:

- the result, and each criterion with the exact quotes the marker used as evidence
- **objective metrics counted from the transcript, independent of the marking model** — words
  per answer, speaking rate, type-token ratio (lexical variety), fillers per 100 words, and
  average words between connectives as a proxy for clause complexity
- your bands from previous sittings, so a trend is visible
- marker disagreement, when more than one model has marked the transcript
- the recurring errors, upgrades and drills the marker produced
- the Part 2 task card and the full transcript
- a JSON appendix carrying every figure exactly, so a reader works from real numbers rather
  than re-counting from prose

The metrics matter because they are the part the marking model cannot talk itself out of. If it
awards band 7 for Lexical Resource while the type-token ratio is 0.4 and "very" appears nine
times, that contradiction is visible in the file.

Every report is also **written to disk automatically** as it is generated, into `data/reports/`,
with the newest always copied to `data/reports/latest.md`. Nothing needs to be downloaded for
the file to exist — useful if you want an assistant to read your latest result without you
having to hand it over. `GET /api/reports` lists what has been saved.

**Export all as one report** on the History tab covers your whole practice history: a table of
every sitting with bands and metrics, then full detail for the five most recent. Older sittings
stay in the table only, so the file does not grow beyond something you can actually hand over.

## Comparing models

The header has a model picker, and the choice applies to your very next request — you can even
switch mid-test. Models your API key cannot reach are detected at startup and greyed out.

The point is the **Feedback** tab: mark a transcript, switch model, press **Re-mark**, and you
get a table of every model that has marked that same transcript — the four criteria, the
overall band, latency, and output tokens including reasoning tokens. It tells you how far the
models disagree, which is the fastest way to tell whether a mark is real or an artifact of one
model's temperament.

Candidates are listed in [`server/models.js`](server/models.js); add or remove them there.

## Waiting, and the clocks

Two things take real time: writing the paper at the start (roughly 5s for a single part,
15–20s for a full test) and each examiner turn (2–10s). Both show a live counter rather than
a silent pause, so you can tell the difference between thinking and hung.

The exam clocks measure the exam, not the API. The total clock does not start until your paper
is ready, and any time spent waiting on the model is credited back to both the part and total
timers — otherwise a slow turn would quietly eat your speaking minutes. When the total clock
does run out, the sitting ends and closes itself out.

## Adjusting the target band

Drag the **Target band** slider in the header (5.0–9.0). It changes three things at once: how
hard the examiner pushes you, what the marker measures your gap against, and the level your
sentences get rewritten to. It can be changed at any time, including after a test but before
marking.

## Tuning the prompts

Everything the model is told lives in [`server/prompts.js`](server/prompts.js):

- `BAND_RUBRIC` — the per-band criteria for all four assessment areas
- `examinerSystemPrompt()` — examiner behaviour and pacing
- `assessorSystemPrompt()` — the marking procedure and severity
- `comparisonSystemPrompt()` — the re-answer comparison

Output shapes are in [`server/schemas.js`](server/schemas.js); exam timings and the topic bank
are in [`server/exam.js`](server/exam.js).

If you find the marking too generous or too harsh, edit step 4 of the marking procedure in
`assessorSystemPrompt()` — that is the single line that sets severity.

## Where your data lives

Nothing is lost when you restart the server.

| Data | Where | Notes |
|---|---|---|
| Question bank, exam papers | `data/coach.db` (SQLite) | On disk. Delete the file to reset the bank. |
| Transcripts, assessments, model runs | Browser IndexedDB | Browse and reopen them on the **History** tab. |
| Audio recordings | Browser IndexedDB | Never sent anywhere; the server does not see them. |

The browser-side data is per-browser and per-origin, so it is tied to the port you run on, and
clearing site data for `localhost` removes it. The SQLite bank is unaffected by any of that.

If you back up `data/coach.db`, copy `coach.db-wal` and `coach.db-shm` alongside it — SQLite
runs in WAL mode here, and a copy of the main file alone can miss recent writes.

## Using it on your phone

The server already listens on all interfaces, so on the same Wi-Fi the page loads at
`http://<your-computer-ip>:<port>` once Windows Firewall allows the port inbound.

**But the page loading is not enough.** Microphone access and speech recognition are only
available in a *secure context* — HTTPS, or `localhost`. A plain-http LAN address like
`http://192.168.1.10:4001` is not one, so the mic is blocked no matter how well the page
renders. The app detects this and says so on the Exam tab rather than failing cryptically.

Three ways round it, easiest first:

**1. A tunnel** — gives you a real HTTPS URL with no certificate fuss:

```bash
npx cloudflared tunnel --url http://localhost:4001
```

Open the printed `https://…trycloudflare.com` address on the phone. Note this exposes your app
to anyone with the link while it runs; it has no authentication.

**2. Allow the origin on Android Chrome** — no tunnel, stays on your LAN. On the phone open
`chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add `http://<your-ip>:<port>`,
set the flag to Enabled, and relaunch Chrome.

**3. Real HTTPS locally** with [mkcert](https://github.com/FiloSottile/mkcert), generating a
certificate and installing its CA on the phone. Most work, no external exposure.

Whichever you choose, the firewall still needs the port open. In an **Administrator** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "IELTS coach 4001" -Direction Inbound -LocalPort 4001 -Protocol TCP -Action Allow -Profile Private
```

Keep it to the `Private` profile so it is not exposed on public networks, and remove the rule
when you are done:

```powershell
Remove-NetFirewallRule -DisplayName "IELTS coach 4001"
```

Two more things to expect on a phone. Recordings and history live in that phone's browser
storage, so they are separate from the ones on your computer — the question bank in
`data/coach.db` is shared, since it lives on the server. And iOS support for the Web Speech API
is inconsistent; if recognition is missing the app will tell you, and you can still record and
use **Re-transcribe audio** to get a transcript afterwards.

## Browser support

Speech recognition needs Chrome or Edge (`webkitSpeechRecognition`). In Firefox or Safari the
examiner still speaks and your audio is still recorded, but nothing will be transcribed, so
there is nothing to mark. The app tells you this on the Exam tab if it detects the gap.

## Notes on the marking

The band criteria in `prompts.js` are a paraphrase of the four public IELTS Speaking assessment
areas, written as instructions for a marking model — not the official descriptor text.
Pronunciation is inferred from transcript evidence rather than heard, so treat it as the softest
of the four scores. This is practice feedback, not an official IELTS result.
