# Export all Study Desk activity

## What will change
- Add one downloadable Markdown archive that contains every saved notebook question, student answer, model answer/marking report, learning note, and saved performance breakdown.
- Keep the archive readable for people and easy to upload to an AI assistant for explanation; include a short instruction at the top asking the reader to explain the contents.
- Exclude source documents, extracted source text, and uploaded files entirely.
- Add an export action to the notebook overview, with progress/error feedback and account-scoped reads.
- Restore the missing Gemini key-rotation helper imports that currently prevent the app from building.

## Technical details
- Use the authenticated browser client and existing row-level access controls; page through all saved activity rather than the history screen's 50-item limit.
- Include local performance-breakdown fallback data where available, and clearly note if account-saved performance rows cannot be read.
- Generate a single `.md` file locally in the browser; no server function, schema migration, or source-document query is needed.
- Add focused tests for completeness and source exclusion in the archive formatter.
