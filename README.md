# ChatGPT × Kahin

> **Made by [void0x14](https://github.com/void0x14).**
> If you use, fork, or build on this, keep the name. Say *"void0x14 made this"*.
> That is the only ask. — heh.

A Linux patch for the **ChatGPT Desktop / Codex** Electron app that adds a
**NATIVE ↔ KAHIN** switch to the existing in-app browser panel.

The native engine is the app's own `<webview>`. The Kahin engine is a
**Camoufox / Mirage** browser driven over MCP and rendered inside the same panel
through a canvas overlay. No second OS window, no second renderer, no custom
toolbar. The app's own tab strip, address bar, Back/Forward/Reload buttons and
shortcuts stay in charge.

## What works

- Switch button after **Help** in the title bar: blue `NATIVE`, red `KAHIN`.
  Click toggles the engine; a toast confirms it.
- The app's address bar shows the **Kahin URL** and the tab reads
  `Kahin · <page title>` while Kahin is active.
- Click, type, scroll, Enter and navigation are forwarded to Camoufox.
- The app's **Back / Forward / Reload** buttons drive Kahin.
- **Persistent profile** (`~/.kahin/camoufox-profile`) and a stable identity:
  cookies and logins survive app restarts.
- Frame transport is a pull model: one latest JPEG per window (≈64 KB), 5 fps,
  no frame bytes on the app's message bus. This is what keeps memory bounded.
- A first-class **Browser Use backend** (`browser-pipe.js`) exposes `Kahin` to
  the app's agent through `/tmp/codex-browser-use`, for programmatic control.

## Requirements

- Linux x64 (tested on CachyOS / X11), the ChatGPT Desktop AUR package
  `chatgpt-bin` (Electron build with `app.asar`).
- [Kahin](https://gitlab.com/void0x14/kahin-mcp) (`@kahinmcp/kahin`) with its
  Camoufox install.
- Node.js and `sudo` for installation.

macOS and Windows are **not** supported: the app is code-signed and its ASAR
integrity check is enforced there. This patch is for the Linux build.

## Install

The patcher does **not** repack the 510 MB archive. It writes a 43-byte
`require()` into `.vite/build/early-bootstrap.js`, replacing the source-map
comment slot, and copies the bridge into `resources/`.

```sh
# build a patched copy (keeps the original as the source)
node apply-patch.mjs --source /usr/lib/chatgpt/resources/app.asar.bak-kahin \
  --out ./build --force

# install (first time: keep a backup)
sudo cp /usr/lib/chatgpt/resources/app.asar /usr/lib/chatgpt/resources/app.asar.bak-kahin
sudo cp build/app.asar /usr/lib/chatgpt/resources/app.asar
sudo cp -r build/resources/* /usr/lib/chatgpt/resources/
sudo chown -R root:root /usr/lib/chatgpt/resources/kb.js /usr/lib/chatgpt/resources/kahin
```

Restart ChatGPT. Button is after **Help**.

After a ChatGPT app update, re-run the build from the fresh backup; the patcher
fails closed if the entry changed.

## Control

Local socket `~/.kahin/chatgpt-bridge.sock` (0600), newline JSON-RPC:

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"browser.state"}' | nc -U ~/.kahin/chatgpt-bridge.sock
printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"browser.switch","params":{"engine":"kahin"}}' | nc -U ~/.kahin/chatgpt-bridge.sock
printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"browser.action","params":{"target":"active","payload":{"action":"navigate","url":"https://example.com"}}}' | nc -U ~/.kahin/chatgpt-bridge.sock
```

The UI button calls `window.__kahinEngine.switch('kahin'|'native')`.

## Layout

```
kb.js                     injected entry (resources/kb.js)
kahin/boot.js             main bridge: switch, app protocol, frame pull, control socket
kahin/overlay.js          canvas surface in the existing renderer
kahin/ui.js               NATIVE/KAHIN button + address/tab feedback + nav forwarding
kahin/mcp-client.js       Kahin stdio MCP client
kahin/browser-pipe.js     first-class Browser Use backend
kahin/dom-shim.js         CDP DOM/Runtime shim for Mirage
kahin/control-mcp.mjs     MCP front-end for the control socket
apply-patch.mjs           43-byte ASAR patcher
REPORT.md                 reverse-engineering report
RUNTIME-EVIDENCE.md       live evidence
```

## Known limits

- The Kahin surface is a **canvas**, not a DOM page: text selection, copy,
  DevTools for the remote page and site annotations do not work. The page
  itself is interactive (click/type/scroll/nav).
- The app's absolute RSS in a long-lived, DevTools-heavy session stays high
  (~2.3 GB); the bridge retains only one ~64 KB frame and does not grow
  linearly. Engine memory is separate.
- Kahin's persistent-profile patch lives in the installed Kahin venv; an AUR
  update can overwrite it (backup: `mirage.py.bak-kahin-profile`).
- No OpenAI binaries are included. You must own the ChatGPT app.

## License

**AGPL-3.0-or-later**. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

> ChatGPT × Kahin — made by [void0x14](https://github.com/void0x14).
> Keep the attribution. Heh.
