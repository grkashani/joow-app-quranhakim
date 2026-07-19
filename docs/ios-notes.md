# JoowQuran — iOS / Capacitor configuration

**Verified environment (this machine, 2026-07-18):** Capacitor 8.4.2 (SPM-based, **no Podfile/`.xcworkspace`** — builds straight off `App.xcodeproj`), Xcode 26.4.1, iOS-15.0 deployment target, scheme **`App`**, bundle id **`com.joow.quran`**, booted sim iPhone 17. All paths below are under the project root:

`/Users/grkashani/projects/joow-sdk-ts/apps/joowquran/web`

---

## 0. One correction you should make first (load-bearing)

Your `capacitor.config.ts` sets `iosScheme: 'https'` with a comment claiming the iOS origin becomes `https://localhost`. **That is false on iOS.** WKWebView reserves `http`/`https` for remote URLs and will not hand them to Capacitor's custom `WKURLSchemeHandler`, so Capacitor **ignores the value and falls back to `capacitor://localhost`**. (Only `androidScheme: 'https'` actually yields `https://localhost` — that's an Android WebViewAssetLoader feature.) Confirmed against the Capacitor config docs and the iOS scheme discussions ([config docs](https://capacitorjs.com/docs/config), [Ionic forum](https://forum.ionicframework.com/t/how-to-change-the-iosscheme-to-https/220793)).

This does **not** break anything: `capacitor://localhost` is a *secure/potentially-trustworthy* context just like https, so `AudioContext`, WASM, and streaming from `https://quranner.com` are not treated as mixed content. But fix the comment so nobody reasons from a wrong premise. Suggested edit to `/…/web/capacitor.config.ts`:

```ts
server: {
  // Android: androidScheme 'https' -> origin https://localhost (real).
  // iOS:     iosScheme is forced back to 'capacitor' by WKWebView (http/https are
  //          reserved), so the iOS origin is capacitor://localhost — still a secure
  //          context, so streaming https://quranner.com is NOT mixed content.
  androidScheme: 'https',
  iosScheme: 'capacitor', // 'https' is silently ignored on iOS
},
```

---

## 1. App Transport Security (ATS) — nothing required

`quranner.com` serves valid TLS 1.2+ with a Let's Encrypt cert, and all app-origin references are `https://`. Remote audio (`<audio src>`, `fetch`) issued from `capacitor://localhost` goes through WKWebView's normal networking and satisfies **default ATS** (which requires TLS 1.2 + forward secrecy + SHA-256, all of which LE/your nginx provide). **Do not add any `NSAppTransportSecurity` block** — an unnecessary `NSAllowsArbitraryLoads` will get flagged in App Store review.

The current `Info.plist` at
`/…/web/ios/App/App/Info.plist`
correctly contains **no** ATS key. Leave it that way.

Only if you ever add a plain-`http` endpoint or a host with a weak cert would you need a scoped exception. Keep this on hand as a *fallback only* (do not add it now):

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSExceptionDomains</key>
  <dict>
    <key>quranner.com</key>
    <dict>
      <key>NSIncludesSubdomains</key><true/>
      <key>NSExceptionMinimumTLSVersion</key><string>TLSv1.2</string>
    </dict>
  </dict>
</dict>
```

---

## 2. WKWebView media autoplay / inline playback — nothing required

Capacitor's iOS bridge already configures the WKWebView for this. In its `WKWebViewConfiguration` setup it hardcodes:

- `allowsInlineMediaPlayback = true`
- `mediaTypesRequiringUserActionForPlayback = []` (no user-gesture gate)

(Confirmed: Capacitor sets `allowsInlineMediaPlayback` true by default — [capacitor#5453](https://github.com/ionic-team/capacitor/issues/5453), [discussion #3758](https://github.com/ionic-team/capacitor/discussions/3758).) There is **no Capacitor config key or Info.plist key** to toggle these — they're baked into the bridge.

Your playback in `/…/web/src/pages/Reader.jsx:51` is `el.play()` fired inside a tap handler, so it satisfies the user-gesture rule regardless. And `<audio>` (not `<video>`) is never subject to the inline/fullscreen rule anyway — audio always plays inline. So:

- **No Info.plist change, no Capacitor config change needed.**
- Adding `playsinline` to the `<audio>` element (Reader.jsx:199) is harmless but a no-op (that attribute governs `<video>`). Skip it.
- Background audio (screen locked) is a *separate* feature and is **not** enabled — that would require the `audio` UIBackgroundMode + an `AVAudioSession` category, which Capacitor does not set. Only add if you actually want lock-screen playback; for tap-to-play-while-foregrounded you need nothing.

---

## 3. On-device Whisper (transformers.js WASM) in WKWebView — works, with limits

Your fallback path in `/…/web/src/lib/transcribe.js` dynamically imports `@huggingface/transformers` (v4) and runs `Xenova/whisper-base` via onnxruntime-web. In WKWebView:

**It runs**, but with these constraints (verified against transformers.js / onnxruntime-web threading docs — [HF Transformers.js](https://huggingface.co/docs/transformers.js/en/index), [SitePoint WASM/WebGPU](https://www.sitepoint.com/webgpu-vs-webasm-transformers-js/)):

1. **Single-threaded only.** WASM multi-threading needs `SharedArrayBuffer`, which browsers gate behind cross-origin isolation headers `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`. Capacitor's iOS scheme handler does **not** emit those headers and gives no supported way to inject them, so `SharedArrayBuffer` is unavailable and onnxruntime-web falls back to **single-thread WASM** (roughly 3–4× slower). Functionally fine, just slower.
2. **SIMD requires iOS 16.4+.** Your deployment target is **15.0**. On iOS 15 devices there's no WASM SIMD, so ORT loads the non-SIMD build (slower again, but works). If on-device STT is important, consider bumping the target to `16.4`.
3. **WebGPU backend won't engage.** transformers.js v4 prefers WebGPU; WKWebView keeps WebGPU off by default, so it uses the WASM CPU backend. Expected.
4. **Memory-pressure jettison is the real risk.** whisper-base + the ONNX arena can spike the WebView content-process memory; iOS may kill the content process (white screen / reload) on low-RAM devices. `whisper-base` is the largest model I'd ship to a phone WebView — `whisper-tiny` is far safer on-device.
5. **Model + `ort-*.wasm` are fetched from a CDN → needs network, not offline.** `env.allowLocalModels = false` pulls model weights from the Hugging Face CDN, and onnxruntime-web fetches its `.wasm` from jsDelivr unless you set `env.backends.onnx.wasm.wasmPaths`. So this "on-device" fallback is **not** available offline as written. To make it work in the packaged app you'd bundle the model + wasm into `dist/` and point `wasmPaths`/`localModelPath` at them — that's a web-build change, out of scope for iOS config, but flag it: the primary transcript path is your server anyway, and this is a fallback.

**No Info.plist / entitlement / permission is required** for WASM inference — it's pure compute, no mic access (you transcribe an already-downloaded audio file, not live capture, so no `NSMicrophoneUsageDescription` needed).

---

## 4. App display name / bundle id

Current state (all consistent):

| Field | Value | Where |
|---|---|---|
| Display name | `JoowQuran` | `Info.plist` → `CFBundleDisplayName`; `capacitor.config.ts` → `appName` |
| Bundle id | `com.joow.quran` | pbxproj `PRODUCT_BUNDLE_IDENTIFIER`; `capacitor.config.ts` → `appId` |
| Marketing version | `1.0` | pbxproj `MARKETING_VERSION` |
| Build number | `1` | pbxproj `CURRENT_PROJECT_VERSION` |
| Min iOS | `15.0` | pbxproj `IPHONEOS_DEPLOYMENT_TARGET` |

Notes:
- `JoowQuran` renders fine on the Home Screen (9 chars). If you want the Arabic/Persian title (قرآن حکیم) shown on-device, add a localized display name rather than changing `CFBundleDisplayName` globally: create `/…/web/ios/App/App/fa.lproj/InfoPlist.strings` containing `CFBundleDisplayName = "قرآن حکیم";` (and set the device to Persian). The base `CFBundleDisplayName` stays `JoowQuran`.
- To change the display name properly, edit **`CFBundleDisplayName` in `Info.plist`** (the Capacitor-recommended field) — do **not** rely on `PRODUCT_NAME`, which also names the built binary. `capacitor.config.ts` `appName` only affects *future* `npx cap add`, not an existing project, so keep the two in sync manually.
- `com.joow.quran` is a valid reverse-DNS id; fine for App Store as long as you own/register it under your Apple Developer team.
- Minor cleanup (optional): `Info.plist` has the stale Capacitor default `UIRequiredDeviceCapabilities = [armv7]`. Modern devices are arm64-only; it's harmless but technically wrong. You can drop that array.
- For a real device / TestFlight build you'll need `DEVELOPMENT_TEAM` set and automatic signing; the simulator commands below deliberately bypass signing.

---

## 5. Build & run on the simulator

First, always sync the web build into the native shell (rebuild `dist/` in capacitor mode, then copy):

```bash
cd /Users/grkashani/projects/joow-sdk-ts/apps/joowquran/web
npm run build -- --mode capacitor   # produces dist/ with base '/'
npx cap sync ios                     # copies dist/ -> ios/App/App/public, updates plugins/SPM
```

### 5a. Direct `xcodebuild` (scheme App, no code signing)

SPM-based Capacitor 8 has **no `.xcworkspace`** — target the project directly:

```bash
cd /Users/grkashani/projects/joow-sdk-ts/apps/joowquran/web/ios/App

# Build for the simulator, signing disabled
xcodebuild \
  -project App.xcodeproj \
  -scheme App \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  CODE_SIGNING_ALLOWED=NO \
  build

# Install + launch the built .app on the booted sim
APP=$(xcodebuild -project App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator -showBuildSettings 2>/dev/null | awk '/ BUILT_PRODUCTS_DIR /{d=$3}/ FULL_PRODUCT_NAME /{n=$3}END{print d"/"n}')
xcrun simctl boot "iPhone 17" 2>/dev/null || true
open -a Simulator
xcrun simctl install booted "$APP"
xcrun simctl launch booted com.joow.quran
```

Notes:
- `CODE_SIGNING_ALLOWED=NO` is the correct flag for simulator builds (also disables entitlement signing). You do **not** need a team or provisioning profile for the simulator.
- `-destination 'platform=iOS Simulator,name=iPhone 17'` matches an available sim; swap the name or use `id=<UDID>` (e.g. `id=3AC01801-02F2-4E93-BFF8-065F36DD41B7`, the booted iPhone 17) if names are ambiguous.
- If the SPM graph needs resolving first: `xcodebuild -resolvePackageDependencies -project App.xcodeproj`.

### 5b. `npx cap run ios` (does sync + build + launch for you)

```bash
cd /Users/grkashani/projects/joow-sdk-ts/apps/joowquran/web
npx cap run ios                        # interactive: prompts for a target device/sim
# non-interactive against a specific sim by UDID:
npx cap run ios --target 3AC01801-02F2-4E93-BFF8-065F36DD41B7
# list valid targets:
npx cap run ios --list
```

`npx cap run ios` runs `cap sync` implicitly, builds the `App` scheme, and installs/launches on the chosen simulator (it uses `xcodebuild` + `ios-deploy`/`simctl` under the hood). For an already-open Xcode workflow use `npx cap open ios` and hit Run.

---

## Summary of changes actually needed

| Area | Action |
|---|---|
| ATS / Info.plist | **None.** Valid TLS on quranner.com satisfies default ATS. |
| Autoplay / inline audio | **None.** Capacitor defaults + tap-trigger already cover it. |
| Whisper WASM | **No native config.** Works single-threaded; to make it offline, self-host model + `ort` wasm in `dist/` (web change). Consider `whisper-tiny` and bumping min iOS to 16.4 for SIMD. |
| `capacitor.config.ts` | Fix the misleading `iosScheme: 'https'` comment (set to `'capacitor'`; behavior is identical, only the comment was wrong). |
| Info.plist cleanup | Optional: drop stale `UIRequiredDeviceCapabilities=[armv7]`; add `fa.lproj/InfoPlist.strings` if you want the Persian display name. |
| Build | Web `dist/` (capacitor mode) → `npx cap sync ios` → `xcodebuild … -scheme App CODE_SIGNING_ALLOWED=NO` or `npx cap run ios`. |

**Sources:** [Capacitor config docs](https://capacitorjs.com/docs/config), [Capacitor iOS configuration](https://capacitorjs.com/docs/ios/configuration), [iosScheme https discussion](https://forum.ionicframework.com/t/how-to-change-the-iosscheme-to-https/220793), [allowsInlineMediaPlayback in Capacitor #5453](https://github.com/ionic-team/capacitor/issues/5453) / [#3758](https://github.com/ionic-team/capacitor/discussions/3758), [transformers.js WASM/threads](https://huggingface.co/docs/transformers.js/en/index), [WebGPU vs WASM benchmarks](https://www.sitepoint.com/webgpu-vs-webasm-transformers-js/).
