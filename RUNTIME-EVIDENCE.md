# Runtime evidence — 2026-10-30

Target: ChatGPT Desktop `26.928.20755` (AUR `chatgpt-bin`), Linux X11 (`DISPLAY=:0`).
Installed patch: `app.asar` SHA-256 `e98d82d3d02c094079fdb7b703513aa42fed01185606c8c0423e2c1d322714c3`
(backup: `/usr/lib/chatgpt/resources/app.asar.bak-kahin`).

## Boot / IPC

```
$ grep '\[kahin' /tmp/chatgpt-kahin18.log
[kahin:control] listening /home/void0x14/.kahin/chatgpt-bridge.sock

$ ls -l ~/.kahin/chatgpt-bridge.sock
srw------- 1 void0x14 void0x14 0 ... chatgpt-bridge.sock
```

`browser.state` (initial):

```json
{"engine":"native","windowId":1,"bounds":null,"nativeGuestId":null,"kahin":"stopped","socket":"/home/void0x14/.kahin/chatgpt-bridge.sock"}
```

## Panel + switch

```
ui.browserPanel {open:true}
-> {"sent":true,"open":true,"attempts":3,"rect":{"x":771,"y":144,"width":761,"height":768}}

browser.switch {engine:"kahin"}
-> {"engine":"kahin","windowId":1,"bounds":{"x":771,"y":144,"width":761,"height":768},"kahin":"running"}

browser.surface
-> {"url":"kahin://surface/index.html","title":"Kahin","loading":false,
    "attached":true,"bounds":{"x":771,"y":144,"width":761,"height":768},
    "visible":true,"children":1,
    "text":"KAHIN\nGo\nNative"}
```

Window OCR (X11 capture, tesseract):

```
Codex ... Example Domain ...
KAHIN  Go  Native
```

## Frames

```
browser.pump
-> {"stats":{"frames":261,"lastAt":...,"lastError":"empty frame: ... no screencast frame within 0.8s"},
    "screencastId":"7e9fdbccc9f54e0287c3033bd2064770","mcp":"running"}
```

Screencast is damage-driven; the `kahin_screenshot` fallback supplies the static-page frame.
Measured relay rate ~4 fps (MCP stdio JSON + base64). Direct CDP screencast is the upgrade path.

## Navigation and router

```
browser.action {target:"active", action:"navigate", url:"https://example.com"}
-> {"frameId":"mainframe-12","loaderId":"nav-25","wait_until":"domcontentloaded"}

browser.action {target:"active", action:"eval", expression:"location.href"}
-> {"result":{"type":"string","value":"https://example.com/"}}

browser.action {target:"native", action:"navigate", url:"https://example.com"}
-> {"ok":true,"url":"https://example.com/"}

browser.action {target:"native", action:"snapshot"}
-> url https://example.com/ ; nodes 1 ; first "Learn more"

browser.action {target:"kahin", action:"snapshot", maxNodes:50}
-> {"streamId":"mvuluf7j-...","cursor":0,"revision":0,
    "url":"https://example.com/","title":"Example Domain","readyState":"complete"}
```

Surface OCR after `example.com` navigation (canvas capture):

```
HIN
This domain is for use in documentation examples without needing permission...
```

## Switch back / state retention

```
browser.switch {engine:"native"}
-> surface: {"attached":false,"visible":false,"children":0}
   window OCR: no KAHIN toolbar

browser.switch {engine:"kahin"}
-> surface: {"attached":true,"visible":true,"children":1}
   canvas still shows example.com (Kahin page was never torn down)
```

## Popup / no new OS window

```
browser.popupTest {url:"https://example.org"}
-> {"before":2,"after":2,"newWindow":false}
```

Repeated with `about:blank` and with a synthetic real-click on an anchor: `before:2`, `after:2`,
`newWindow:false`, and no new X window (`xdotool search --onlyvisible` count unchanged).
`lastPopup` stayed `null`: Chromium blocks non-user-gesture `window.open` before Electron's
`setWindowOpenHandler`. The handler is registered on the surface view and returns
`{action:"deny"}` for every request; the deny path is therefore never bypassed.

## Failures found only at runtime

- installed wheel has `kahin_evaluate`, not `kahin_mirage_eval`
- installed wheel's `kahin_browser_start` schema has no `mode`
- `guestFor` first picked the 1x150 MCP-App sandbox webview
- `addChildView` alone left the view `visible:false`; `setVisible(true)` is required
- `fresh:true` screencast starves on static pages
- `toggle-browser-panel` is dropped before the renderer registers its listener
- machine-wide `/run/user/1000/kahin/browser.lock` allows only one Kahin MCP owner

## Browser Use backend pipe (agent path)

The app's browser-service discovers every `/tmp/codex-browser-use/*.sock`, connects,
and calls `getInfo`. The bridge now publishes `kahin-<pid>.sock` there:

```
[kahin:pipe] listening /tmp/codex-browser-use/kahin-933499.sock
```

Direct protocol test against that socket (same framed JSON-RPC the browser-service uses):

```
getInfo
-> {"name":"Kahin","version":"26.928.20755","type":"iab","discoveryScope":"global",
    "capabilities":{"browser":[],"tab":[]},
    "metadata":{"codexSessionId":"test-session","codexAppBuildFlavor":"prod",
                "codexAppSessionId":"b930d31f-..."}}

getTabs
-> [{"id":1,"active":true,"title":"","url":""}]

executeCdp Page.navigate https://example.com
-> {"frameId":"mainframe-12","loaderId":"nav-25"}

executeCdp Runtime.evaluate 6*7
-> {"result":{"type":"number","value":42}}

getCommittedTabUrl
-> "https://example.com"

createTab
-> 2

getTabs
-> [{"id":1,"active":false,"url":"https://example.com"},{"id":2,"active":true,"url":""}]
```

This is the same API surface `agent.browsers.list()` / `browser.tabs.*` / CDP uses;
no `browser.action` side-channel is involved. CDP event forwarding is the next gap.

## Backend completion (events + DOM/object shim)

After the first pipe test, the remaining gaps were closed and verified against the
same socket the browser-service consumes.

CDP events (translated to Chromium names, 400 ms poll on `kahin_event_history` seq):

```
Target.attachedToTarget
Page.frameStartedLoading
Page.frameNavigated      {frame:{id,url,loaderId,securityOrigin}}
Page.domContentEventFired
Page.loadEventFired
Runtime.executionContextCreated {context:{...}}
Network.loadingFinished
```

DOM/object shim (Mirage returns no objectId for returnByValue:false):

```
Runtime.evaluate document.body (returnByValue:false) -> {"objectId":"kh-node-1"}
Runtime.callFunctionOn -> "BODY:2"
DOM.getDocument depth:-1 -> 32 nodes; <a> backendNodeId 32
DOM.getBoxModel -> content [920,754.6 .. 1000,777.6]
DOM.resolveNode -> {"objectId":"kh-node-32"}
Runtime.callFunctionOn -> "Learn more|https://iana.org/help/example-domains"
Page.addScriptToEvaluateOnNewDocument -> navigate -> window.__khInjected == 41
Input.dispatchMouseEvent at box center -> location.href = iana.org
createTab -> tab2; tab1 example.com, tab2 example.org in getTabs
Page.captureScreenshot -> 81,864 base64 bytes
```

Files: `resources/kahin/browser-pipe.js`, `resources/kahin/dom-shim.js`.
Remaining unsupported: iframe/OOPIF, uploads/downloads, clipboard, AX tree,
history, and the flat Mirage `Network.*` shapes.
