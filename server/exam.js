/** Exam structure, timings and topic bank. Timings mirror the real test. */

export const PART_TIMING = {
  1: { label: "Part 1 - Interview", speakingSeconds: 5 * 60, prepSeconds: 0 },
  2: { label: "Part 2 - Long turn", speakingSeconds: 2 * 60, prepSeconds: 60 },
  3: { label: "Part 3 - Discussion", speakingSeconds: 5 * 60, prepSeconds: 0 },
};

/** Full test = 11-14 minutes, same as the real exam. */
export const FULL_TEST_SECONDS =
  PART_TIMING[1].speakingSeconds +
  PART_TIMING[2].prepSeconds +
  PART_TIMING[2].speakingSeconds +
  PART_TIMING[3].speakingSeconds;

/** Part 1 topic pool. The examiner picks from these to stay authentic. */
export const PART1_TOPICS = [
  "Work or studies",
  "Your home town",
  "Accommodation",
  "Free time and hobbies",
  "Food and cooking",
  "Weather and seasons",
  "Technology and phones",
  "Travel and transport",
  "Music",
  "Reading",
  "Shopping",
  "Friends and family",
  "Sleep and daily routine",
  "Photographs",
];

/** Broad themes for Part 2 cue-card generation, which Part 3 then abstracts from. */
export const PART2_THEMES = [
  "a person who influenced you",
  "a memorable place",
  "an object you value",
  "an event or celebration",
  "a skill you learned",
  "a decision you made",
  "a piece of media you enjoyed",
  "a change in your life",
  "a challenge you overcame",
  "a habit you would like to break",
];

export function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** Two or three Part 1 topics, always leading with work/study as the real test does. */
export function choosePart1Topics() {
  const rest = PART1_TOPICS.filter((t) => t !== "Work or studies");
  const shuffled = [...rest].sort(() => Math.random() - 0.5);
  return ["Work or studies", ...shuffled.slice(0, 2)];
}
