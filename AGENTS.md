# AGENTS.md

## Operating Principles

- Prefer small, reviewable diffs. Avoid sweeping refactors unless explicitly requested.
- Before editing, identify the file(s) to change and state the plan in 3-6 bullets.
- Never invent APIs, configs, or file paths. Search the project first if unsure.
- Keep changes consistent with the existing vanilla HTML/CSS/JavaScript architecture.

## Project Context

- This is a Chrome Manifest V3 extension that overrides the new tab page with `extension/index.html`.
- The extension runtime depends on Chrome extension APIs including `chrome.tabs`, `chrome.windows`, and `chrome.storage`.
- The extension intentionally does not request `chrome.bookmarks`; do not re-add bookmark access unless explicitly requested.
- The quick-shortcut strip is link-only by default. Do not add Google OAuth, Google API host permissions, Gmail unread counts, calendar event reads, or message metadata unless explicitly requested.
- Do not treat `file://extension/index.html` as a valid runtime preview; it cannot access Chrome extension APIs.
- Test meaningful UI behavior through a loaded unpacked extension in Chrome, then reload the extension from `chrome://extensions` after code changes.

## Safety and Secrets

- Never paste secrets, tokens, private keys, or `.env` values into code or logs.
- If a task requires secrets, ask for them via environment variables.
- Do not add analytics, telemetry, or new network calls unless explicitly requested.
- Do not modify external systems such as Confluence or Google Sheets unless explicitly requested.

## Code Quality Bar

- Add or update tests for behavior changes when the project has tests.
- This project currently has no build pipeline; run the fastest static checks before claiming completion.
- Prefer explicit error handling around Chrome extension APIs.
- Add comments only when the intent is non-obvious.

## Build and Run Etiquette

- When commands are needed, explain the exact command and why it is being run.
- Use `node --check extension/app.js` after JavaScript edits.
- Use `git diff --check` before finishing to catch whitespace issues.
- For UI changes, verify in the real Chrome extension page rather than only local HTML preview.

## Browser and Internal Access

- Use Chrome DevTools or the visible Chrome window to inspect the loaded extension when needed.
- Use `computer-use` only when the task must operate the user's visible browser window or Chrome DevTools cannot access the needed page.
- Avoid closing user tabs during verification unless the user explicitly asks.

## Output Formatting

- For code changes: include a short summary and the files changed.
- For debugging: include hypotheses, experiments run, and the minimal fix.

## Collaboration Defaults

- Default explanation language: Chinese.
- Keep explanations concise and operational.
- Ask before deleting local files.
