# Clearer generated answers

## What will change
- Improve the model’s answer-writing rules so each response starts with the direct answer, then uses short descriptive headings, concise paragraphs, bullets, numbered steps, or tables only where they improve understanding.
- Prevent clutter: avoid repeated conclusions, oversized sections, dense text blocks, excessive headings, and unnecessary source repetition.
- Improve the on-screen formatting of generated answers with stronger heading hierarchy, more whitespace, clearer lists, readable tables, and distinct quotations/code while preserving the existing design.
- Apply the same readable structure to answers shown in Ask and marking-related areas through the shared answer renderer.

## Guardrails
- Do not change marking calculations, evidence rules, retrieval, models, uploads, history, or exports.
- Keep the existing direct-answer-first behavior and source citations.

## Verification
- Add focused tests for the answer-structure instructions.
- Run the relevant prompt tests and check the app build result.
