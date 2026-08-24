Marking guidelines — topic-name not required when answer demonstrates knowledge

Policy summary
- At this examination level, marks must NOT be deducted solely because a student did not write the name of the topic.
- Examiners (or automated graders) should judge whether the student's answer demonstrates knowledge and understanding of the relevant topic.
- If the student's answer clearly matches the expected topic/content, award full marks even when the explicit topic name is omitted.
- Deductions for topic-name omission are only allowed if the answer does not show the expected knowledge or is off-topic.

How to apply (process)
1. Identify the expected topic(s) for the question.
2. Check the student's answer for conceptual correctness and evidence that the student understands the expected topic.
   - Use semantic/topic matching (by human judgement or automatic semantic similarity) rather than only looking for the explicit topic name.
3. If the answer semantically matches the expected topic and demonstrates the required elements, award full marks.
4. If the answer is partially correct, apply proportional deductions based on required elements missing — not for topic-name omission.
5. If automated scoring is used, tune the semantic similarity threshold using a validation set of real answers to avoid false positives/negatives.

Notes for automated graders
- Implementers should use a semantic similarity check (embeddings or a model) or robust keyword/topic-extraction rather than relying on the presence of a single string (topic name).
- Provide clear logs/justifications for any mark deduction so human reviewers can audit and correct edge cases.
