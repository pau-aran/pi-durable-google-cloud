# Third-party code

## p2

The browser client in `src/client/` is a port of the chat of **p2**, the web UI in the Pi harness repository
([`earendil-works/pi`](https://github.com/earendil-works/pi), `apps/p2`, commit `e98e593`). The files below are copied
or adapted from it. Paths in the right column are relative to `apps/p2`.

| File | p2 source |
| --- | --- |
| `index.html` | `src/hosts/web.ts` (the page template) |
| `src/client/main.tsx` | `src/hosts/web/main.tsx`, `src/web/AppLayout.tsx`, `src/web/app-boundary.tsx` |
| `src/client/style.css` | `src/web/style.css` |
| `src/client/elanor.css` | `src/web/elanor.css` |
| `src/client/theme.ts` | `src/web/theme.ts` |
| `src/client/ThemeButton.tsx` | `src/web/ThemeButton.tsx` |
| `src/client/TopBar.tsx` | `plugins/chat/web.tsx` (`TopBar`) |
| `src/client/icons.tsx` | `src/web/icons.tsx` |
| `src/client/PiLogo.tsx` | `src/web/PiLogo.tsx` |
| `src/client/ChatPage.tsx` | `plugins/chat/web.tsx` (`SessionChat`, `Dock`, `Main`), `src/runtime/web.tsx` (`useOffline`), `src/runtime/connection-state.ts`, `src/web/ErrorToast.tsx` |
| `src/client/Composer.tsx` | `plugins/chat/web.tsx` (`Composer`, `keepComposerFocus`) |
| `src/client/Home.tsx` | `plugins/chat/web.tsx` (`NewSession`) |
| `src/client/composer.css` | `src/web/style.css` |
| `src/client/reconnect.ts` | `src/web/reconnect.ts` |
| `src/client/transcript.ts` | `src/web/transcript.ts` |
| `src/client/Chat.tsx` | `src/web/Chat.tsx` |
| `src/client/transcript.css` | `src/web/style.css` |
| `src/client/Markdown.tsx` | `src/web/Markdown.tsx` |
| `src/client/ElanorMarkdown.tsx` | `src/web/ElanorMarkdown.tsx` |
| `src/client/elanor-markdown.css` | `src/web/elanor-markdown.css` |
| `src/client/Code.tsx` | `src/web/Code.tsx` |
| `src/client/Time.tsx` | `src/web/Time.tsx` |
| `src/client/activity/model.ts` | `src/web/activity/model.ts` |
| `src/client/activity/ActivityRow.tsx` | `src/web/activity/ActivityRow.tsx`, `src/web/activity/ActivitySheet.tsx` (`useElapsed`) |
| `src/client/activity/StepList.tsx` | `src/web/activity/ActivitySheet.tsx` (`StepList`) |
| `src/client/activity/Detail.tsx` | `src/web/activity/Detail.tsx` |
| `src/client/activity/Label.tsx` | `src/web/activity/Label.tsx` |
| `src/client/activity/icons.tsx` | `src/web/activity/icons.tsx` |
| `src/client/activity/activity.css` | `src/web/activity/activity.css` |
| `src/client/elanor-extra/ticker.tsx` | `src/web/elanor-extra/ticker.tsx` (p2's copy of Elanor's Ticker) |
| `src/client/elanor-extra/drum.ts` | `src/web/elanor-extra/drum.ts` |
| `src/client/elanor-extra/elanor-extra.css` | `src/web/elanor-extra/elanor-extra.css` |
| `test/transcript.test.ts` | cases from `test/p2/failed-turns.test.ts`, `test/p2/ui-transcript-stability.test.ts` |
| `test/activity.test.ts` | cases from `test/p2/activity-model.test.ts` |
| `test/reconnect.test.ts` | cases from `test/p2/web-reconnect.test.ts` |

`src/client/use-follow.ts` and `src/client/state.ts` are new; `use-follow.ts` follows the rules of p2's
`src/web/use-chat-scroll.ts` without its code.

p2 is under the MIT License:

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## npm packages in the client bundle

`pnpm build` puts these packages into `dist/`. Each package's licence text is in its directory under `node_modules`.

| Package | Version | Licence |
| --- | --- | --- |
| `@earendil-works/elanor-react` | 0.1.0 | MIT |
| `@earendil-works/elanor-icons-react` | 0.1.0 | Apache-2.0 |
| `@earendil-works/design-tokens` | 0.1.0 | ISC |
| `@earendil-works/elanor-fonts` (Mallos Serif, Commit Mono) | 0.1.0 | OFL-1.1 |
| `@earendil-works/chord`, `pi-ai`, `pi-durable`, `pi-schema`, `pi-telemetry` | 1.5.2 | MIT |
| `react`, `react-dom` | 19.3.0 | MIT |
| `scheduler` | 0.28.0 | MIT |
| `marked` | 18.0.14 | MIT |
| `lowlight` | 3.3.0 | MIT |
| `highlight.js` | 11.11.2 | BSD-3-Clause |
| `devlop` | 1.1.0 | MIT |
| `@base-ui/react` | 1.8.0 | MIT |
| `@base-ui/utils` | 0.4.0 | MIT |
| `@floating-ui/core`, `@floating-ui/dom` | 1.8.0 | MIT |
| `@floating-ui/react-dom` | 2.1.9 | MIT |
| `@floating-ui/utils` | 0.2.12 | MIT |
| `reselect` | 5.3.0 | MIT |
| `use-sync-external-store` | 1.7.0 | MIT |
| `partial-json` | 0.1.7 | MIT |
