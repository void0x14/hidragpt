# HydraGPT — ChatGPT Desktop × Kahin/Camoufox

**Hedef:** `/usr/lib/chatgpt` — `chatgpt-bin 26.928.20755-1`, `openai-codex-electron` 26.928.20755, Chromium 154.0.8037.57 (CachyOS / X11).
**Paket:** `app.asar` orijinal `48975e18…38beb` (yedek `.bak-kahin`), yamalı `e98d82d3…4c3`.
**Durum:** kuruldu, canlı test edildi. Ekran görüntüleri `evidence/`.

Bu sürüm backend odaklıdır. ChatGPT'nin tarayıcı paneli, sekme çubuğu ve adres satırı aynı kalır. Yeni OS penceresi, yeni renderer, `WebContentsView` yok. Kahin içeriği mevcut panelin üstüne çizilir.

---

## 0. Kanıt defteri

| Ne | Araç | Sonuç |
| --- | --- | --- |
| Paket envanteri | REA `open_binary` + `inspect_artifact` | `ev_b2f22c01…ec33`, 63 398 giriş |
| Electron fuses | REA `inspect_electron_fuses` | `ev_fdb8c2cd…9108c`; integrity + OnlyLoadAppFromAsar açık |
| Renderer preload graph | REA CLI | `ev_a20fe423…bc4b`: 3 contextBridge API, 25 IPC, 16 literal kanal |
| Spawn | canlı MCP probe | `start` → 1 tab; `navigate` → 1 tab; `tab_new` → 2 tab (zombi) |
| Bellek | `ps` | `camoufox-bin` 489 MB, sidecar 5.8 MB |
| Canlı switch | uygulama + RPC | `browser.switch` → panelde Kahin sayfası; geri → native yeni sekme hatasız |
| State enjeksiyonu | canlı test | `browser-sidebar-state` native sekmeyi bozuyor (`Tab content couldn't render`); kapatıldı |

---

## 1. Spawn problemi (çözüldü)

**Kök neden:** Kahin, Camoufox'u `-profile -no-remote -headless` ile açar; Juggler `Browser.enable {attachToDefaultContext:true}` ilk `about:blank` hedefini bağlar. `kahin_mirage_tab_list` tek sekme döner. Zombi, ilk iş için `tab_new` çağrılınca doğar:

```
start    -> 1 tab  about:blank
navigate -> 1 tab  https://example.com   ✅
tab_new  -> 2 tabs about:blank + yeni    ❌ zombi
```

**Fix (`browser-pipe.js`):** `createTab` ilk çağrıda başlangıç sekmesini sahiplenir (`initialTabAdopted`), ikinci çağrıda yeni sekme açar; `ensureKahin` ilk iş için `tab_new` çağırmaz; her zaman `headless:true`.

**Test:** ilk `createTab` `{id:1}`, ikinci `{id:2}`, motorda `tab_new` toplam 1.

**Prior art:** puppeteer#2040 (`browser.pages()[0]`), Puppeteer `--no-startup-window`, playwright#12632 (`Browser.attachedToTarget` ilk sayfa), Electron `<webview>` `visibility:hidden` notu.

---

## 2. Backend switch (çalışıyor)

### 2.1 Seam
`early-bootstrap.js` sonuna 43 baytlık `;require(process.resourcesPath+"/kb")` enjekte edilir. `kb.js`, uygulamanın kendi `ipcMain.handle('codex_desktop:message-from-view')` çağrısını sarar:

```js
if (message.type === '__kahin_input')  return onKahinInput(event.sender, message.payload);
if (message.type === '__kahin_switch') return switchEngine(message.engine, event.sender);
if (message.type === 'browser-sidebar-command' && isKahinActive(event.sender))
  return onKahinCommand(event.sender, message);
return appHandler(event, message);   // native yol aynen
```

- `browser-sidebar-command` (`navigate`, `go-back`, `go-forward`, `reload`, `stop`, `capture-screenshot`) Kahin aktifken MCP'ye gider.
- Native'de uygulamanın handler'ı hiç değişmez.
- Programatik: `~/.kahin/chatgpt-bridge.sock` (`browser.switch`, `browser.action`, `browser.state`).

### 2.2 Görünüm (ek renderer yok)
- `overlay.js` mevcut ChatGPT renderer'ına `executeJavaScript` ile enjekte edilir.
- Webview **gizlenmez** (ne `visibility` ne `opacity`): uygulama webview görünürlüğünü izliyor ve gizlenince sayfa bileşenini bozuyor. Canvas opak ve z-index üstte; webview altta canlı kalır.
- Canvas panelin `<webview>` dikdörtgenine oturur; 250 ms'de bir güncellenir. Resize'da kaybolmaz (`ensureRoot` + rect yeniden ölçümü).
- Kareler **pull** modeliyle gelir: pump her pencere için tek bir `{seq,data,mimeType,width,height}` tutar; overlay `electronBridge.getFastModeRolloutMetrics({__kahin_frame_request:true})` ile 5 fps'te çeker. Frame baytları `message-for-view`'a girmez (8.5 GB'lık retention'ın kaynağı buydu).
- Girdi canvas'tan `__kahin_input` olarak main'e, oradan Kahin MCP'ye gider.

### 2.3 Native state koruması
Uygulamanın `browser-sidebar-state` mesajı native sayfa denetleyicisini tetikliyor. HydraGPT URL'sini göndermek gizli webview'ı aynı URL'ye yönlendiriyor; geri dönüşte sayfa bileşeni bozuluyor. Bu yüzden:

- **`browser-sidebar-state` Kahin için gönderilmiyor** (ne Kahin ne native switch'te). Denendi; native sekme `Tab content couldn't render` veriyor.
- Renderer'da `<webview>.loadURL` Kahin aktifken Kahin'e yönlendirilir; detach'ta geri alınır.
- Main'de `guest.loadURL` guard'ı aynı işi yedekler.
- Sonuç: native sekme about:blank/özgün halinde kalır, geri dönüş temiz.

### 2.4 UI geri bildirimi ve kalıcılık
- Adres çubuğu HydraGPT URL'sini, aktif sekme `HydraGPT · <title>` gösterir; değerler **DOM'a** yazılır (`browser-sidebar-state` yok).
- Uygulamanın kendi Back/Forward/Reload düğmeleri Kahin aktifken enable edilir; tıklamalar `__kahin_input` ile Kahin'e gider.
- Camoufox profili `~/.kahin/camoufox-profile` kalıcı ve `hydragpt` kimliği sabit. Cookie testi app restart sonrası `kahin_persist=1` döndü.
- Canvas tıklama/yazma/Enter, DDG aramasında `q=kahin+test` üretti.

---

## 3. Agent backend (birinci sınıf tarayıcı)

`browser-pipe.js`, ChatGPT browser-service'in `/tmp/codex-browser-use` keşfini kullanır:

- Soket: `kahin-<pid>.sock`, 0600, 4-byte native-endian + JSON-RPC.
- `getInfo` → `{name:"Kahin", type:"iab", discoveryScope:"global"}` (global seçimi oturum filtresini atlar).
- `getTabs/createTab/attach/executeCdp/getCommittedTabUrl/...` → Kahin MCP.
- `dom-shim.js`: Mirage'ın objectId dönmeyen `Runtime.evaluate`'i için sayfa-içi `__kh` kayıt defteri ve `Runtime.callFunctionOn`/`DOM.*`.
- `kahin_event_history` 400 ms'de bir `onCDPEvent` olarak yayınlanır.
- `createTab` zombi düzeltmesini içerir.

Ajan `agent.browsers.list()` içinde `Kahin`'i görür; native `Codex In-app Browser` ile yan yana.

---

## 4. Bellek

| Bileşen | Ölçü |
| --- | --- |
| Camoufox | 489 MB (taze) / ~1.4 GB (profil + sayfa); app RSS'inden ayrı |
| sidecar | 5.8 MB |
| Köprü | ~1 MB (Node modülleri) |
| Yeni renderer | 0 (canvas mevcut renderer'da) |
| Kare | tek 63 657 B JPEG (`latest`); kuyruk yok |

`WebContentsView`/surface kaldırıldı (~80–150 MB tasarruf). Screencast 3–5 fps; 10+ fps için doğrudan CDP `Page.startScreencast` soketi gerekir. Asm/C notu: sıcak yol Chromium IPC + canvas decode; taşıma değişikliği gerekir, dil değişikliği değil.

---

## 5. Dosyalar

```
hydragpt/
├── REPORT.md
├── apply-patch.mjs
├── evidence/
│   ├── kahin-panel.png        Kahin sayfası panelde
│   ├── kahin-resized.png      resize sonrası hâlâ görünür
│   ├── native-newtab.png      switch back: native yeni sekme, hatasız
│   └── native-before-switch.png
├── build/{app.asar,resources/}
└── resources/
    ├── kb.js
    └── kahin/{boot.js,browser-pipe.js,dom-shim.js,mcp-client.js,overlay.js,control-mcp.mjs}
```

Kurulum (yapıldı):
```sh
sudo cp /usr/lib/chatgpt/resources/app.asar.bak-kahin /usr/lib/chatgpt/resources/app.asar.bak-kahin.orig
sudo cp build/app.asar /usr/lib/chatgpt/resources/app.asar
sudo cp -r build/resources/* /usr/lib/chatgpt/resources/
sudo chown -R root:root /usr/lib/chatgpt/resources/kb.js /usr/lib/chatgpt/resources/kahin
```

### Kontrol
```sh
# state
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"browser.state"}' | nc -U ~/.kahin/chatgpt-bridge.sock
# switch
printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"browser.switch","params":{"engine":"kahin"}}' | nc -U ~/.kahin/chatgpt-bridge.sock
# UI butonu (sonra)
window.__kahinEngine.switch('kahin')
```

### Doğrulama
- `node --check`: 8/8.
- Yamalı asar: offset 9 077 908, yalnız 43 bayt; `@electron/asar list` 21 206 giriş.
- Canlı: `browser.switch kahin` → panelde example.com; native webview `about:blank` (sızıntı yok); `browser.switch native` → native yeni sekme, `Tab content couldn't render` yok.
- Resize: canvas hâlâ görünür (evidence/kahin-resized.png).
- Frame pull: `frameSeq` 131, `latest` 50 298 B JPEG; canvas 870x768 meanRGB 234.4; screenshot `evidence/kahin-fixed.png`.
- 60 s bellek: app 2527.0 → 2315.5 MB, engine 1170.8 → 1074.0 MB (delta negatif, sızıntı yok).
- Switch back: `err=0`, native URL `about:blank`, overlay `display:none`, buton `NATIVE` mavi.
- UI: input `https://example.com/`, tab `HydraGPT · Example Domain`; `evidence/final-usable.png`.
- Kalıcılık: cookie restart sonrası `kahin_persist=1`; profil `~/.kahin/camoufox-profile`.
- Navigasyon: app Back `example.org -> example.com`, Reload; canvas DDG `q=kahin+test`.
- Bellek 90 s: app 2377.5 -> 2357.4 MB (dalgalanma, lineer büyüme yok); frame 63 657 B; ~4.8 fps.

---

## 6. Sınırlar

- **Chrome metni artık çalışıyor**: adres çubuğu HydraGPT URL'sini, sekme `HydraGPT · <title>` gösteriyor; Back/Forward/Reload uygulamanın düğmelerinden HydraGPT'ye gidiyor.
- **Canvas bir DOM tarayıcı değil**: metin seçimi/copy/DevTools/annotation yok.
- **Profil patch'i venv içinde**: AUR Kahin güncellemesi üzerine yazabilir (yedek `.bak-kahin-profile`).
- **Test artefaktı:** test oturumları kullanıcının Google sekmesini `about:blank` ile değiştirdi; o sekmenin geçmişi kayboldu.
- **Screencast 3–5 fps**; video değil.
- **Kahin sayfasında** uygulamanın annotation/comment overlay'i çalışmaz.
- **Agent backend** `type:"iab"` + boş capability listeleri; çekirdek tab/CDP çalışır.
- **macOS/Windows** aynı bayt yaması çalışmaz (imza/integrity).
- **AUR güncellemesi** entry sonu değişirse `apply-patch.mjs` fail-closed.
- Eski `resources/kahin/surface*` dosyaları kaldı (3 KB, referans yok).
