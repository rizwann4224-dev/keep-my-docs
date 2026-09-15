# Apply the uploaded Study Desk upgrade safely

## Scope
Apply only the Study Desk changes supplied in the ZIP. Preserve all unrelated app behavior, Lovable Cloud integration, existing sign-in, routing, current notebook history behavior, and generated project files.

## Changes
- Add the supplied source-review editor, performance charts, performance calculations, export list formatting, AI stream validation, and Gemini-only provider support.
- Merge the uploaded updates to document extraction/OCR, uploads, Ask, Marking, Performance, exports, prompts, study processing, and the Study Desk screen.
- Apply the supplied examiner standards: evidence-based marks, valid alternative answers, no arbitrary severity deductions, syllabus-aware exam setting, and neutral exam-paper output.
- Use Gemini only for Study Desk AI and OCR, as selected; return clear quota/configuration errors rather than calling Groq or Lovable AI.
- Add the supplied regression fixtures and tests without removing the existing test suite.

## Safety boundaries
- Do not replace the generated cloud client, route tree, lockfiles, existing environment file, or package manager setup.
- Keep the current Lovable Cloud Google sign-in and preview session storage.
- Keep the current root error handling, metadata, fonts, and unrelated routes.
- Preserve newer behavior absent from the ZIP, including fresh visible Ask threads with retained History, marking cache/model metadata, and safer interrupted-job recovery, unless directly incompatible with the supplied upgrade.
- Keep the existing ICAP page reachable; apply only its requested Gemini-only transport change.

## Validation
- Run the existing tests plus the supplied regression and export checks.
- Confirm type safety, preview build health, and Study Desk rendering.
- Test the authenticated Study Desk request path when the available preview session permits it.
