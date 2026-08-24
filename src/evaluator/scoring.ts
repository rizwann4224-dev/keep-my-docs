/**
 * Scoring logic: do not deduct marks solely for missing topic name if the answer
 * demonstrates knowledge of the expected topic.
 *
 * Integration notes:
 * - Replace `semanticSimilarity` with your embedding/similarity function.
 * - `expectedTopics` are canonical topic labels or short descriptions.
 */

export type EvalResult = {
  score: number; // between 0 and maxMarks
  maxMarks: number;
  reasons: string[]; // short explanation(s) for transparency/audit
};

/**
 * Placeholder semantic similarity function.
 * Replace with your actual model / embeddings similarity call.
 * Returns a number in [0,1].
 */
async function semanticSimilarity(a: string, b: string): Promise<number> {
  // TODO: integrate actual semantic model or embedding compare
  // e.g., compute embedding(a) and embedding(b) then cosine similarity
  // For now we use a simple keyword overlap fallback (synchronous).
  const ak = a.toLowerCase().split(/\W+/).filter(Boolean);
  const bk = b.toLowerCase().split(/\W+/).filter(Boolean);
  const setB = new Set(bk);
  const overlap = ak.filter((t) => setB.has(t)).length;
  const denom = Math.max(ak.length, bk.length, 1);
  return Math.min(1, overlap / denom);
}

/**
 * Evaluate an answer against expected topics and return a score.
 * Behavior:
 * - If answer semantic similarity to any expected topic >= topicMatchThreshold -> award full marks
 *   (unless other required elements are missing; adjust as needed).
 * - Do not deduct because the student omitted writing the topic name if they demonstrate knowledge.
 *
 * @param answer student's answer text
 * @param expectedTopics array of canonical topic descriptions or keywords
 * @param maxMarks total marks for the question
 * @param topicMatchThreshold threshold in [0,1] for considering the answer "on-topic" (default 0.75)
 */
export async function evaluateAnswer(
  answer: string,
  expectedTopics: string[],
  maxMarks = 5,
  topicMatchThreshold = 0.75
): Promise<EvalResult> {
  const reasons: string[] = [];
  if (!answer || !answer.trim()) {
    reasons.push("No answer provided");
    return { score: 0, maxMarks, reasons };
  }

  // Compute best semantic match against expected topics
  let bestSim = 0;
  let bestTopic = expectedTopics[0] ?? "unknown";
  for (const t of expectedTopics) {
    const sim = await semanticSimilarity(answer, t);
    if (sim > bestSim) {
      bestSim = sim;
      bestTopic = t;
    }
  }

  // If the answer is strongly on-topic, award full marks (subject to other checks)
  if (bestSim >= topicMatchThreshold) {
    reasons.push(
      `Answer matches expected topic "${bestTopic}" (similarity=${bestSim.toFixed(2)}): do NOT deduct for missing topic name`
    );
    return { score: maxMarks, maxMarks, reasons };
  }

  // Otherwise, we grade partially: use similarity as a proxy for proportion of marks
  const proportionalScore = Math.round(Math.max(0, bestSim) * maxMarks);
  reasons.push(
    `Answer matched best topic "${bestTopic}" with similarity=${bestSim.toFixed(2)}; awarding proportional marks`
  );
  return { score: proportionalScore, maxMarks, reasons };
}
