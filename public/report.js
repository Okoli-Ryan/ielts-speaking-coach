/**
 * Builds the post-test report.
 *
 * The output is one Markdown file with a JSON appendix. Markdown so you can read it,
 * JSON so a language model reading it later has exact numbers rather than prose it
 * has to re-derive. Everything needed to form a coaching opinion is in the single
 * file - transcript, marks with evidence, objective metrics, the question paper, and
 * the trend across previous sittings - so it can be handed over on its own with no
 * other context.
 */

import { Store } from "./store.js";

const FILLERS = [
  "um", "uh", "er", "erm", "ah", "like", "you know", "i mean",
  "actually", "basically", "sort of", "kind of", "well",
];

const words = (s) => (s || "").toLowerCase().match(/\b[a-z']+\b/g) || [];

/**
 * How long a good answer runs, by part. Part 1 answers should be extended but not
 * rambling; Part 2 must fill the long turn; Part 3 needs a developed argument.
 * Defined once here and shared with the live answer timer.
 */
export const ANSWER_TARGETS = {
  1: { min: 20, max: 45, label: "20–40s" },
  2: { min: 90, max: 120, label: "90–120s" },
  3: { min: 40, max: 75, label: "40–60s" },
};

/** Objective measures the marking model cannot fudge, computed from the transcript. */
export function computeMetrics(transcript, answers = []) {
  const mine = transcript.filter((t) => t.role === "candidate" && t.text);
  const allWords = mine.flatMap((t) => words(t.text));
  const total = allWords.length;
  const unique = new Set(allWords).size;

  const text = mine.map((t) => t.text.toLowerCase()).join(" ");
  const fillerCounts = {};
  let fillerTotal = 0;
  for (const f of FILLERS) {
    const hits = (text.match(new RegExp(`\\b${f.replace(/ /g, "\\s+")}\\b`, "g")) || []).length;
    if (hits) {
      fillerCounts[f] = hits;
      fillerTotal += hits;
    }
  }

  const perAnswer = mine.map((t) => words(t.text).length);
  const durations = answers.map((a) => a.durationMs).filter(Boolean);
  const spokenMs = durations.reduce((n, d) => n + d, 0);

  const byPart = {};
  for (const t of mine) {
    const p = t.part || 0;
    byPart[p] = byPart[p] || { answers: 0, words: 0 };
    byPart[p].answers += 1;
    byPart[p].words += words(t.text).length;
  }

  // Sentence-ish segmentation is crude on speech, but the ratio of long to short
  // stretches is still a fair proxy for whether complex structures are attempted.
  const clauses = text.split(/[.!?]+|\band\b|\bbut\b|\bbecause\b|\bwhich\b|\bso\b/).filter((c) => c.trim());
  const avgClause = clauses.length ? total / clauses.length : 0;

  return {
    answers: mine.length,
    total_words: total,
    unique_words: unique,
    type_token_ratio: total ? Number((unique / total).toFixed(3)) : 0,
    words_per_answer_avg: perAnswer.length
      ? Math.round(perAnswer.reduce((a, b) => a + b, 0) / perAnswer.length)
      : 0,
    words_per_answer_min: perAnswer.length ? Math.min(...perAnswer) : 0,
    words_per_answer_max: perAnswer.length ? Math.max(...perAnswer) : 0,
    filler_total: fillerTotal,
    fillers_per_100_words: total ? Number(((fillerTotal / total) * 100).toFixed(1)) : 0,
    filler_breakdown: fillerCounts,
    speaking_seconds: Math.round(spokenMs / 1000),
    words_per_minute: spokenMs ? Math.round(total / (spokenMs / 60000)) : null,
    avg_words_between_connectives: Number(avgClause.toFixed(1)),
    by_part: byPart,
  };
}

const band = (n) => (n == null ? "–" : Number(n).toFixed(1));

function criterionRows(a) {
  return [
    ["Fluency & Coherence", a.fluency_coherence],
    ["Lexical Resource", a.lexical_resource],
    ["Grammatical Range & Accuracy", a.grammatical_range],
    ["Pronunciation", a.pronunciation],
  ];
}

/**
 * @param {object} session  the sitting being reported on
 * @param {Array}  answers  saved answers for that sitting (for durations)
 * @param {Array}  history  previous sittings, for the trend section
 */
export function buildReport(session, answers, history) {
  const a = session.assessment;
  const metrics = computeMetrics(session.transcript, answers);
  const when = new Date(session.startedAt);
  const runs = session.runs || [];

  const past = history
    .filter((s) => s.id !== session.id && s.assessment)
    .sort((x, y) => x.startedAt - y.startedAt);

  const md = [];
  md.push(`# IELTS Speaking practice report`);
  md.push(`*${when.toLocaleString()} · target band ${band(session.targetBand)} · parts ${(session.parts || []).join(", ")}*`);
  md.push("");

  // A short brief so the file works on its own when handed to an assistant.
  md.push(`## What this file is, and what to do with it`);
  md.push(
    `This is one sitting of an IELTS Speaking mock test, self-administered for practice. ` +
      `It contains the full transcript, the automated marking with its evidence, objective ` +
      `metrics computed from the transcript, the question paper used, and results from ` +
      `previous sittings.`
  );
  md.push("");
  md.push(`The reader is asked to give an independent second opinion, specifically:`);
  md.push(`1. Whether the band awarded per criterion is defensible against the transcript evidence, and where it looks generous or harsh.`);
  md.push(`2. Which single weakness is costing the most, judged against the target band of ${band(session.targetBand)}.`);
  md.push(`3. What has and has not improved across sittings, if history is present below.`);
  md.push(`4. A concrete practice plan for the next week — specific exercises, not general advice.`);
  md.push(`5. Anything the automated marking missed, over-weighted, or got wrong.`);
  md.push("");
  md.push(`Exact figures are in the JSON appendix at the end; prefer them over re-counting from prose.`);
  md.push("");

  if (!a) {
    md.push(`> This sitting was never marked, so there are no bands to review.`);
    md.push("");
  } else {
    md.push(`## Result`);
    md.push("");
    md.push(`| | Band |`);
    md.push(`|---|---|`);
    md.push(`| **Overall** | **${band(a.overall_band)}** |`);
    md.push(`| Target | ${band(a.target_band ?? session.targetBand)} |`);
    md.push(
      `| Gap | ${
        a.overall_band >= (a.target_band ?? session.targetBand)
          ? "at or above target"
          : `${(( a.target_band ?? session.targetBand) - a.overall_band).toFixed(1)} below target`
      } |`
    );
    md.push("");
    md.push(`**Examiner verdict.** ${a.verdict}`);
    md.push("");

    md.push(`## Criteria, with the evidence used`);
    md.push("");
    for (const [label, c] of criterionRows(a)) {
      md.push(`### ${label} — ${band(c.band)}`);
      md.push(`*Working:* ${c.what_is_working}`);
      md.push("");
      md.push(`*Gap to band ${band(a.target_band ?? session.targetBand)}:* ${c.gap_to_target}`);
      if (c.evidence?.length) {
        md.push("");
        md.push(`Evidence quoted by the marker:`);
        for (const e of c.evidence) md.push(`> ${e}`);
      }
      md.push("");
    }
  }

  md.push(`## Objective metrics`);
  md.push("");
  md.push(`These are counted from the transcript, independent of the marking model.`);
  md.push("");
  md.push(`| Measure | Value | Why it matters |`);
  md.push(`|---|---|---|`);
  md.push(`| Words spoken | ${metrics.total_words} | Volume of language produced |`);
  md.push(`| Answers given | ${metrics.answers} | |`);
  md.push(`| Words per answer (avg) | ${metrics.words_per_answer_avg} | Short answers cap Fluency & Coherence |`);
  md.push(`| Words per answer (min–max) | ${metrics.words_per_answer_min}–${metrics.words_per_answer_max} | Consistency of extension |`);
  md.push(`| Speaking rate | ${metrics.words_per_minute ?? "–"} wpm | 120–150 is a natural exam pace |`);
  md.push(`| Type-token ratio | ${metrics.type_token_ratio} | Lexical variety; low means repetition |`);
  md.push(`| Unique words | ${metrics.unique_words} | |`);
  md.push(`| Filler words | ${metrics.filler_total} (${metrics.fillers_per_100_words} per 100 words) | Hesitation markers |`);
  md.push(`| Words between connectives | ${metrics.avg_words_between_connectives} | Proxy for clause complexity |`);
  md.push("");
  if (Object.keys(metrics.filler_breakdown).length) {
    md.push(
      `Fillers used: ${Object.entries(metrics.filler_breakdown)
        .sort((x, y) => y[1] - x[1])
        .map(([f, n]) => `“${f}” ×${n}`)
        .join(", ")}.`
    );
    md.push("");
  }

  // Per-question timing. Length of answer is one of the clearest predictors of band:
  // a candidate who cannot fill the Part 2 long turn cannot score 7 on it.
  const timed = session.transcript
    .map((t, i) => ({ ...t, prompt: session.transcript[i - 1] }))
    .filter((t) => t.role === "candidate" && t.ms);

  if (timed.length) {
    md.push(`## Time spent on each question`);
    md.push("");
    md.push(
      `Targets: Part 1 roughly 20–40s, Part 2 a sustained 90–120s, Part 3 roughly 40–60s.`
    );
    md.push("");
    md.push(`| Part | Question | Time | Words | Repeats | Verdict |`);
    md.push(`|---|---|---|---|---|---|`);
    for (const t of timed) {
      const secs = Math.round(t.ms / 1000);
      const tgt = ANSWER_TARGETS[t.part] || ANSWER_TARGETS[1];
      const verdict = secs < tgt.min ? "**too short**" : secs > tgt.max ? "over" : "on target";
      const q = (t.prompt?.role === "examiner" ? t.prompt.text : "").slice(0, 60);
      md.push(
        `| ${t.part} | ${q.replace(/\|/g, "/")}${q.length >= 60 ? "…" : ""} | ${secs}s | ${
          words(t.text).length
        } | ${verdict} |`
      );
    }
    md.push("");
    const repeatTotal = timed.reduce((n, t) => n + (t.repeats || 0), 0);
    if (repeatTotal) {
      md.push(
        `The candidate asked the examiner to repeat a question **${repeatTotal} time${
          repeatTotal === 1 ? "" : "s"
        }**. Asking for repetition is allowed and not itself penalised, but needing it ` +
          `repeatedly points to a listening problem that will cost marks indirectly, through ` +
          `hesitation and off-target answers.`
      );
      md.push("");
    }
    const shortOnes = timed.filter(
      (t) => Math.round(t.ms / 1000) < (ANSWER_TARGETS[t.part] || ANSWER_TARGETS[1]).min
    ).length;
    if (shortOnes) {
      md.push(
        `**${shortOnes} of ${timed.length} answers were under the target length for their part.** ` +
          `Under-running is one of the most reliable causes of a capped Fluency & Coherence score.`
      );
      md.push("");
    }
  }

  if (past.length) {
    md.push(`## Progress across sittings`);
    md.push("");
    md.push(`| Date | Parts | Overall | F&C | LR | GRA | Pron | Words |`);
    md.push(`|---|---|---|---|---|---|---|---|`);
    for (const s of [...past, session]) {
      const sa = s.assessment;
      if (!sa) continue;
      const m = computeMetrics(s.transcript, []);
      md.push(
        `| ${new Date(s.startedAt).toLocaleDateString()} | ${(s.parts || []).join(",")} | ${band(
          sa.overall_band
        )} | ${band(sa.fluency_coherence?.band)} | ${band(sa.lexical_resource?.band)} | ${band(
          sa.grammatical_range?.band
        )} | ${band(sa.pronunciation?.band)} | ${m.total_words} |`
      );
    }
    md.push("");
  }

  if (runs.length > 1) {
    md.push(`## Marker disagreement`);
    md.push("");
    md.push(`The same transcript marked by more than one model. Wide disagreement means the mark is uncertain.`);
    md.push("");
    md.push(`| Model | Overall | F&C | LR | GRA | Pron |`);
    md.push(`|---|---|---|---|---|---|`);
    for (const r of runs) {
      md.push(
        `| ${r.meta.modelLabel || r.meta.model} | ${band(r.data.overall_band)} | ${band(
          r.data.fluency_coherence?.band
        )} | ${band(r.data.lexical_resource?.band)} | ${band(r.data.grammatical_range?.band)} | ${band(
          r.data.pronunciation?.band
        )} |`
      );
    }
    md.push("");
  }

  if (a?.error_log?.length) {
    md.push(`## Recurring errors flagged`);
    md.push("");
    md.push(`| Type | Said | Should be |`);
    md.push(`|---|---|---|`);
    for (const e of a.error_log) md.push(`| ${e.type} | ${e.error} | ${e.correction} |`);
    md.push("");
  }

  if (a?.upgrades?.length) {
    md.push(`## Suggested upgrades`);
    md.push("");
    for (const u of a.upgrades) {
      md.push(`- **Said:** ${u.original}`);
      md.push(`  **Upgraded:** ${u.upgraded}`);
      md.push(`  *${u.why_it_scores_higher}*`);
    }
    md.push("");
  }

  if (a?.drills?.length) {
    md.push(`## Drills the marker set`);
    md.push("");
    for (const d of a.drills) md.push(`- ${d}`);
    md.push("");
  }

  if (session.cueCard) {
    md.push(`## Part 2 task card`);
    md.push("");
    md.push(`**${session.cueCard.topic}**`);
    for (const b of session.cueCard.bullets || []) md.push(`- ${b}`);
    md.push("");
    md.push(`*${session.cueCard.explain || ""}*`);
    md.push("");
  }

  if (session.part2Notes) {
    md.push(`## Notes made during the Part 2 preparation minute`);
    md.push("");
    md.push("```");
    md.push(session.part2Notes);
    md.push("```");
    md.push("");
    md.push(
      `Worth reviewing against the answer that followed: whether the plan was used, and whether ` +
        `planning helped or ate into speaking time.`
    );
    md.push("");
  }

  md.push(`## Full transcript`);
  md.push("");
  if (session.rawTranscript) {
    md.push(
      `> Recognition errors were corrected before marking. Only the recogniser's mistakes ` +
        `were changed; the candidate's own grammar and word choice are untouched. The ` +
        `uncorrected original is in the JSON appendix.`
    );
    md.push("");
  }
  for (const t of session.transcript) {
    md.push(`**${t.role === "examiner" ? "Examiner" : "Candidate"}:** ${t.text}`);
    md.push("");
  }

  md.push(`## Machine-readable appendix`);
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(reportJson(session, metrics, past), null, 2));
  md.push("```");
  md.push("");

  return md.join("\n");
}

/** The same content as structured data, for exact parsing. */
export function reportJson(session, metrics, past = []) {
  return {
    schema: "ielts-speaking-coach/report@1",
    sitting: {
      id: session.id,
      started_at: new Date(session.startedAt).toISOString(),
      ended_at: session.endedAt ? new Date(session.endedAt).toISOString() : null,
      parts: session.parts || [],
      target_band: session.targetBand,
    },
    assessment: session.assessment || null,
    marker_runs: (session.runs || []).map((r) => ({
      model: r.meta.model,
      label: r.meta.modelLabel,
      latency_ms: r.meta.ms,
      output_tokens: r.meta.outputTokens,
      reasoning_tokens: r.meta.reasoningTokens,
      overall_band: r.data.overall_band,
      bands: {
        fluency_coherence: r.data.fluency_coherence?.band,
        lexical_resource: r.data.lexical_resource?.band,
        grammatical_range: r.data.grammatical_range?.band,
        pronunciation: r.data.pronunciation?.band,
      },
    })),
    metrics,
    question_paper: session.cueCard ? { part2: session.cueCard } : null,
    part2_preparation_notes: session.part2Notes || null,
    answer_timings: session.transcript
      .filter((t) => t.role === "candidate" && t.ms)
      .map((t) => ({ part: t.part, seconds: Math.round(t.ms / 1000), words: words(t.text).length, repeats: t.repeats || 0 })),
    exam_conditions: session.examConditions ?? null,
    transcript: session.transcript,
    transcript_uncorrected: session.rawTranscript || null,
    transcript_corrections: session.corrections || [],
    history: past.map((s) => ({
      started_at: new Date(s.startedAt).toISOString(),
      parts: s.parts || [],
      overall_band: s.assessment?.overall_band ?? null,
      bands: {
        fluency_coherence: s.assessment?.fluency_coherence?.band ?? null,
        lexical_resource: s.assessment?.lexical_resource?.band ?? null,
        grammatical_range: s.assessment?.grammatical_range?.band ?? null,
        pronunciation: s.assessment?.pronunciation?.band ?? null,
      },
      metrics: computeMetrics(s.transcript || [], []),
    })),
  };
}

/** Assembles a report for one sitting, pulling its answers and history from storage. */
export async function reportFor(session) {
  const [allAnswers, history] = await Promise.all([Store.listAnswers(), Store.listSessions()]);
  const answers = allAnswers.filter((x) => x.sessionId === session.id);
  return {
    markdown: buildReport(session, answers, history),
    filename: `ielts-report-${new Date(session.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`,
  };
}

/**
 * One file covering the whole practice history.
 *
 * Full reports are included only for the most recent few sittings; everything older
 * is summarised in the trend table and a metrics roll-up. A file that grows without
 * bound eventually becomes too large to hand to anyone, which defeats the purpose.
 */
export async function reportForAll({ fullDetailFor = 5 } = {}) {
  // A sitting where the candidate never spoke carries no information - usually a run
  // abandoned early or one where the microphone never opened.
  const history = (await Store.listSessions())
    .filter((s) => s.transcript?.some((t) => t.role === "candidate" && t.text?.trim()))
    .sort((a, b) => a.startedAt - b.startedAt);
  const allAnswers = await Store.listAnswers();
  const recent = history.slice(-fullDetailFor);
  const older = history.slice(0, Math.max(0, history.length - fullDetailFor));

  const out = [
    `# IELTS Speaking — practice history`,
    `*${history.length} sitting${history.length === 1 ? "" : "s"}, exported ${new Date().toLocaleString()}*`,
    "",
    `## What this file is, and what to do with it`,
    "",
    `A record of self-administered IELTS Speaking mock tests. The reader is asked to look ` +
      `across the whole history and answer: what is genuinely improving, what has been stuck ` +
      `for several sittings, whether the marks are internally consistent, and what to practise ` +
      `next — with specific exercises rather than general advice.`,
    "",
    `Full detail follows for the ${recent.length} most recent sitting${recent.length === 1 ? "" : "s"}.` +
      (older.length
        ? ` The ${older.length} earlier one${older.length === 1 ? " is" : "s are"} summarised in the table below.`
        : ""),
    "",
    `## Every sitting at a glance`,
    "",
    `| Date | Parts | Target | Overall | F&C | LR | GRA | Pron | Words | Fillers/100w | TTR |`,
    `|---|---|---|---|---|---|---|---|---|---|---|`,
  ];

  for (const s of history) {
    const m = computeMetrics(s.transcript || [], allAnswers.filter((x) => x.sessionId === s.id));
    const sa = s.assessment;
    out.push(
      `| ${new Date(s.startedAt).toLocaleDateString()} | ${(s.parts || []).join(",")} | ${band(
        s.targetBand
      )} | ${sa ? band(sa.overall_band) : "not marked"} | ${band(sa?.fluency_coherence?.band)} | ${band(
        sa?.lexical_resource?.band
      )} | ${band(sa?.grammatical_range?.band)} | ${band(sa?.pronunciation?.band)} | ${
        m.total_words
      } | ${m.fillers_per_100_words} | ${m.type_token_ratio} |`
    );
  }

  out.push("", "---", "");

  for (const s of recent) {
    out.push(buildReport(s, allAnswers.filter((x) => x.sessionId === s.id), history));
    out.push("\n---\n");
  }

  return {
    markdown: out.join("\n"),
    filename: `ielts-history-${new Date().toISOString().slice(0, 10)}.md`,
    sittings: history.length,
  };
}
