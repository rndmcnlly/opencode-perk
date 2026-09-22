---
name: openchamber-extension-visual-design
description: Use for visual redesign of this OpenCode plugin's OpenChamber extension panel, including cards, headers, output, responsive layout, and mock states.
---

# OpenChamber Extension Visual Design

1. Run `npm run dev:extension` in the background.
2. Open `http://localhost:4173/panel/?mock=1` with the browser tool.
3. Edit `openchamber-extension/panel/styles.css` for visuals, `main.ts` for structure/behavior, and `mock-host.ts` for states.
4. Refresh and inspect desktop plus mobile; exercise collapse, tabs, scrolling, and cancellation. Do not restart OpenChamber.
5. Finish with `npm run check` and stop the preview server.

The mock uses the production renderer. Prefer extending its fixtures over creating separate mock markup.
