# aMail style system

One dark theme, one cascade, no per-theme override files. Every stylesheet reads
the tokens in `tokens.css`; nothing else hard-codes colors.

| File | Owns |
| --- | --- |
| `tokens.css` | Color, type scale, spacing, radii, elevation, layout sizes, z-index layers, and the `.email-light` re-map for light surfaces |
| `base.css` | Reset, typography, focus, scrollbars, and primitives: buttons, icon buttons, tooltips, avatars, checkbox, toggle, form fields, status pills, toast, skeleton, scrims |
| `shell.css` | The app grid (`.mail-app`), top bar, sidebar (full, compact rail, mobile drawer), workspace, banners, and the list/reader split |
| `list.css` | Conversation list: toolbar, Fresh Drafts card, smart-view chips, rows (with container queries), density, empty state |
| `reader.css` | Reader pane: heading, message cards, email body, privacy notice, attachments |
| `compose.css` | Compose window, recipient chips, and the shared rich-text editor |
| `panels.css` | Quick settings drawer, profile menu, search options, and the modals (add account, unlock, shortcuts) |
| `index.css` | Import order |

## Layout rules

- `.mail-app` is a two-column, two-row CSS grid. `--sidebar-current` switches between `--sidebar-w` and `--sidebar-w-compact` when `.sidebar-compact` is set.
- `.mail-split` is one column by default. `.mail-app.reader-mounted` reserves a second column and `.mail-app.thread-open` eases it open to `var(--list-w) minmax(0, 1fr)`. Below 1000px the reader overlays the list. `prefers-reduced-motion` collapses those transitions.
- The 840px breakpoint turns the sidebar into a drawer. `App.jsx` uses the same number to decide whether the menu button toggles compact mode or the drawer, so change both together.
- `.mail-list-panel` is a container (`container-type: inline-size`); row layout switches at 640px and 400px of panel width via `grid-template-areas`, with no DOM changes.

## Light surfaces

`.email-light` re-maps the same token names to a light palette. Message cards and
the compose form carry that class, so shared components (buttons, chips, fields)
render correctly inside them without special cases.

## Conventions

- Add a token before adding a color. Category and provider colors are the only per-item colors, and they flow through `--chip-color`, `--category-color`, and `--provider-color`.
- Keep `!important` out; the cascade is flat enough not to need it.
- Prefer `min-width: 0` on flex/grid children over hiding overflow at the parent.
