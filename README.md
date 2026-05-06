# Tab Out

`Tab Out` is a local Chrome extension project that replaces the new tab page with a dashboard for open tabs.

This copy is maintained as a personal project based on the original [`zarazhangrui/tab-out`](https://github.com/zarazhangrui/tab-out) extension.

## Goal

1. Show open Chrome tabs in a clean dashboard grouped by domain.
2. Default to the current Chrome window while still allowing an all-window view.
3. Keep the extension lightweight and focused on low-risk open-tab cleanup.

## Current Features

- Current-window view by default.
- `Current window` / `All windows` segmented control with tab counts.
- Lightweight quick-shortcut strip with default Calendar/Mail links and local user-added links.
- Window-scoped `Pinned here` row for tabs that should not be batch-closed.
- `All windows` supports Domain and Windows views for site-based cleanup or project-window review.
- Open tab icons prefer Chrome's native tab favicon, then fall back to Google Workspace product icons and high-resolution domain favicons.
- Windows view supports window naming, manual window ordering, moving tabs between windows, closing tabs, and focusing tabs.
- Shopee CS tabs are grouped into one domain while keeping region and environment context in tab names, such as `ID UAT · Shopee CS`.
- Exact tab targeting by tab ID for focus, close, pin, and save-for-later actions.
- Single-tab close and save-for-later actions.
- Domain-level close actions skip `Pinned here` tabs. The global `Close all tabs` shortcut is intentionally hidden to avoid accidental clicks.
- Local `Saved for Later` list using `chrome.storage.local`; the sidebar only appears when there are active saved items.
- Pure extension runtime; no local server or npm build step.

## Product Changes from Upstream

This fork keeps the original lightweight new-tab dashboard idea, but changes the product direction from a broad tab cleanup page to a personal work-window organizer.

### Information Architecture

- **Default scope changed to current window.** The dashboard opens on `Current window` by default because daily cleanup usually happens inside the active project window.
- **All-window review is explicit.** `All windows` remains available, but it is treated as a secondary cross-project review mode instead of the default surface.
- **All windows now has two views.**
  - `Domain` keeps the original site-based grouping for bulk cleanup.
  - `Windows` groups tabs by Chrome window for project-based review, matching the habit of keeping one project across multiple domains in one browser window.

### Window Organization

- **Windows view adds project-window panels.** Each Chrome window is shown as a panel with an editable Tab Out window label, tab count, active-tab highlight, and tab list.
- **Manual window order is supported.** Dragging window panels saves the preferred row-first order in `chrome.storage.local` under `windowOrder`; dropping on the top or bottom half inserts before or after the target panel.
- **Window labels are Tab Out local state.** Chrome's extension window API does not expose Chrome's native user-facing window name, so this fork stores its own labels.
- **Window labels auto-save on blur.** After editing a window label, clicking elsewhere saves it by default; `Escape` cancels the edit.
- **Window labels are not pruned during render.** Rendering the Windows view is read-only for `windowOrder`, so labels are not cleared when a window temporarily has no real web tabs.
- **Window identity is session-scoped for now.** Saved order and labels are keyed by Chrome `windowId`, which is stable during a browser session but not guaranteed across restart.

### Tab Protection

- **`Pinned here` is a Tab Out protection state.** It is not Chrome's native pinned-tab feature and does not change the Chrome tab strip.
- **Pins are window-scoped tab instances.** Pins are keyed by `windowId + tabId`, not URL, so closing and reopening the same URL does not auto-pin it again.
- **Pinned tabs are protected from bulk cleanup.** Domain-level close and duplicate cleanup skip pinned tabs by default.
- **Stale pins are cleaned automatically.** When a pinned tab is closed, its pin record is removed on the next render.

### Tab Operations

- **High-frequency actions are prioritized.** Each tab row keeps pin and close visible; `Save for later` is still available but visually de-emphasized.
- **Global close-all is hidden.** The global close-all shortcut is intentionally removed from the main surface to avoid accidental destructive cleanup.
- **Exact tab targeting is used.** Focus, close, pin, and save actions use tab IDs where possible instead of URL-only matching.
- **Windows view supports direct arrangement.** Tabs can be dragged between window panels, focused by click, and closed from the Windows view.

### Shortcuts and Saved Items

- **Quick shortcuts are link-only.** Calendar, Mail, Translate, and personal shortcuts are lightweight links, not OAuth/API integrations.
- **User shortcuts can be added in the UI.** Personal shortcuts are stored locally in `chrome.storage.local`; advanced defaults can still be configured via `extension/config.local.js`.
- **Saved-for-later remains local and quiet.** Saved tabs stay in local storage; the sidebar is hidden when there are no active saved items so it does not take space from the tab dashboard.

### Visual and Recognition Improvements

- **Favicons prefer Chrome's native tab icon.** This keeps dashboard icons closer to the browser tab strip.
- **Google Workspace icons are product-aware.** Docs, Sheets, Slides, Forms, and Drawings are distinguished when URL structure identifies the app.
- **Shopee CS labels are region-aware.** `cs.shopee.*` and `cs.uat.shopee.*` URLs are grouped under one `Shopee CS` domain and normalized into compact tab labels like `ID Live · Shopee CS · Case 313433` and `SG Live · Shopee CS · Workstation`, making UAT/live and region differences visible without splitting the domain card.
- **UI keeps the original quiet style.** New controls reuse the warm, minimal card/chip language instead of adding a separate heavy tool UI.

### Privacy and Permissions

- **Bookmark access was removed.** The extension intentionally does not request bookmark permission.
- **No Google OAuth or mailbox/calendar API reads.** Google entry points are shortcuts only; the extension does not read Gmail messages, unread counts, calendar events, or document content.
- **No analytics or telemetry.** Current customizations stay local to Chrome extension APIs and `chrome.storage.local`.

## Current Structure

```text
tab-out/
├── README.md
├── AGENTS.md
├── LICENSE
├── .gitignore
└── extension/
    ├── app.js
    ├── background.js
    ├── index.html
    ├── manifest.json
    └── style.css
```

## Recommended Reading Order

1. `README.md`
2. `AGENTS.md`
3. `extension/manifest.json`
4. `extension/index.html`
5. `extension/app.js`
6. `extension/style.css`

## Install Locally

Clone or download this repository, then load the unpacked extension from the repo's `extension/` folder.

```bash
git clone https://github.com/JalenLyu/Jalen.git
cd Jalen
```

Chrome steps:

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this repository's `extension/` folder.
5. Open a new tab.

After code changes, reload `Tab Out` from `chrome://extensions`.

### Codex-Assisted Install

For non-technical users, the simplest path is to paste the GitHub repository link into Codex and ask:

```text
Install this Chrome extension locally and load its extension/ folder as an unpacked extension in Chrome.
```

Codex can clone or download the repository and guide the Chrome setup. Chrome still requires Developer mode and `Load unpacked`; for a true one-click install, publish the extension through the Chrome Web Store.

## Development Notes

- Do not use `file://extension/index.html` as the final preview. That page cannot access Chrome extension APIs.
- Meaningful behavior must be verified through the loaded Chrome extension page.
- The extension relies on `tabs`, `activeTab`, and `storage` permissions.
- It intentionally does not request bookmark access.
- The quick-shortcut strip is link-only. It does not request Google OAuth, Google API host permissions, Gmail unread counts, message titles, senders, snippets, calendar events, or bodies.
- `Pinned here` is Tab Out local state, not Chrome's native pinned-tab feature. Pins are tied to the current tab instance and are automatically removed when that tab closes, so reopening the same URL later does not pin it again.
- Tab rows keep only two always-visible actions: pin and close. Hover or focus the pin area to reveal the inline save action in the same button row.
- Saved tabs stay local in `chrome.storage.local`.
- The UI intentionally stays close to the original quiet, warm dashboard style.

## Quick Shortcuts

The shortcut strip is intentionally link-only. The default Google shortcuts are:

- `Calendar` opens Google Calendar week view.
- `Mail` opens Gmail inbox.
- `Translate` opens Google Translate.

To add personal shortcuts from the new tab page, click the small `+` button in the shortcut strip. Added links are stored locally in `chrome.storage.local` and can be removed from the strip. Default and `config.local.js` shortcuts are edited in code/config instead.

For batch or advanced local setup without committing personal links, create `extension/config.local.js`:

```js
const LOCAL_SHORTCUT_GROUPS_APPEND = [
  {
    label: 'Work',
    links: [
      { label: 'Docs', url: 'https://docs.google.com/' },
      { label: 'Drive', url: 'https://drive.google.com/' },
    ],
  },
];
```

To fully replace the default Calendar/Mail links, define `LOCAL_SHORTCUT_GROUPS` instead. `extension/config.local.js` is gitignored.

## Git Remote Policy

This project is a personal fork/customization workspace. Do not push changes to the original author's repository.

Recommended remote setup:

```bash
# Keep the original project as read-only upstream reference
git remote -v

# Add your own GitHub repository as origin after creating it on GitHub
git remote add origin git@github.com:<your-github-username>/tab-out.git
git push -u origin main
```

## Common Commands

```bash
# JavaScript syntax check
node --check extension/app.js

# Whitespace and patch hygiene
git diff --check

# Review current changes
git status --short
git diff --stat
```

## Upstream

Original project:

```bash
https://github.com/zarazhangrui/tab-out
```

The local repo keeps that GitHub URL as `upstream` for fetch/reference only. Its push URL is disabled.

## License

MIT. See `LICENSE`.
