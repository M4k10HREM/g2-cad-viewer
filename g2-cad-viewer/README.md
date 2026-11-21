# G2 CAD Viewer

View and explore 3D CAD models and drawings on Even Realities G2 glasses. The phone opens the file and renders it with three.js. The glasses show a hidden-line view that you control with the touchpad or your voice.

Built from the `image` + `asr` Even Hub templates.

## Supported files

| Format | Engine | Notes |
|---|---|---|
| **STEP / STP, IGES / IGS, BREP** | OpenCascade (`occt-import-js`, WASM, LGPL) | Full solid models and assemblies. **Best choice for real CAD parts.** |
| **DWG, DXF** | LibreDWG (`@mlightcad/libredwg-web`, WASM, **GPL-3.0**) | Lines, arcs, circles, polylines (with bulges), splines, ellipses, blocks/INSERTs, dimensions, 3D faces, polyface and polygon meshes. One part per layer. |
| GLB / glTF, STL, OBJ, PLY, 3MF, FBX | three.js loaders | Meshes. Use `.glb` rather than `.gltf`, because external `.bin` files can't be resolved. |

**DWG limitation:** AutoCAD 3D solids (`3DSOLID`, `REGION`, `BODY`) are stored as ACIS data, which no browser library can read. The app shows how many it skipped. Export **STEP** from your CAD tool to get the full 3D model.

The WASM decoders load lazily, so the 7–10 MB modules download only when you open a file of that type.

## Controls

**Glasses touchpad**
- **Tap**: cycle the mode (Rotate → Tilt → Zoom → Views → Parts → Explode)
- **Swipe up / down**: adjust in the current mode
- **Hold (long press)**: talk. The mic opens while you hold and closes when you let go (push-to-talk). Choose "always listening" in Settings if you prefer.
- **Double-tap**: exit

While you hold, a card shows the live transcript. Everything you say in one hold is treated as one request. Spoken AI design requests ("design a…", "make it…") then ask for confirmation: **tap = yes**, **swipe = no**, or say "yes" / "no". Typed requests from the phone run straight away.

When the app opens, a controls card lists the gestures (tap = got it, double-tap = exit). You can turn it off, or show it again, in Settings.

**My designs:** every AI design is saved on the phone automatically. Reopen one from the list (no new AI request; the phone recompiles it), or delete it. **Save as STL** exports the current model, and **Save .scad code** exports an AI design's source, through the phone's share sheet or as a download.

**Voice** (needs STT, see below). Examples: "rotate left 90", "turn it around", "tilt up", "zoom in", "top view", "isometric", "wireframe", "shaded", "hidden line", "next part", "part 3", "isolate", "show all", "explode", "collapse", "full screen", "wide", "turntable", "stop", "reset", "pan left". You can chain commands: "top view and zoom in".

**Phone**: buttons for everything, plus a text box that accepts the same voice phrases. Useful for testing without STT.

## Glasses layouts

Image containers are limited to 288×144, and each frame takes about 0.5–2 s over Bluetooth. So:
- `single` (default): one 288×144 tile with info panels. Fastest.
- `wide`: two tiles, 576×144.
- `full`: four tiles, full 576×288 with no text. Sharpest, about 4× slower to refresh.

Frames are "latest wins": if you swipe several times while a frame is still sending, the app renders only the newest state. Text panels update immediately.

## Setup

```bash
npm install
npm run dev          # http://localhost:5173 — phone UI also works in a desktop browser
npm run simulate     # Even Hub glasses simulator
npx @evenrealities/evenhub-cli qr --url http://<your-ip>:5173   # open on real glasses
npm run pack         # build .ehpk
```

**Dev shortcuts:** put model files in `public/models/` and they appear in the "Models on dev server" list. URL params `?model=models/part.stp&layout=full` load a model and layout at startup.

### Voice (optional)

Open **Settings: your keys** at the bottom of the phone UI and choose a provider: **ElevenLabs** (its key lives on your Worker; see SETUP-AI.md Part 3b) or **Deepgram** (paste a key). Press Save. To use another provider, implement it in `src/asr/stt.ts` and add its host to the `network` whitelist in `app.json`.

**Keys are per user and per phone.** They are stored in the Even app's storage and are never part of the app package. `.env.local` values (see `.env.example`) apply only to `npm run dev` and are stripped from production builds, so a shared `.ehpk` carries no keys.

### AI design: text-to-CAD (optional)

Say or type "design a 60 mm L-bracket with two M5 holes", then "make it thicker". Claude writes OpenSCAD code through your own Cloudflare Worker (`../g2-cad-ai-worker`, which keeps your API key server-side). The phone compiles the code with OpenSCAD-WASM, one mesh per part, and the result opens like any other model. If the code doesn't compile, the app asks Claude for one automatic fix. **Setup steps: [SETUP-AI.md](SETUP-AI.md).**

## Code map

- `src/main.ts`: wiring (bridge, events, commands, voice, frame pipeline)
- `src/model/loaders.ts`: picks a format loader; `model.ts` normalises the model (Y-up, centred, parts, explode)
- `src/model/dwg.ts`: DWG/DXF to line and mesh geometry, including a raw pass for polyface meshes that LibreDWG's converter drops
- `src/render/viewer.ts`: off-screen orthographic renderer with hidden-line, shaded and wireframe styles and a tight auto-fit
- `src/glasses/display.ts`: page layouts, tiling, serialised BLE queue, frame coalescing
- `src/controls/commands.ts` / `voice.ts`: view state, the command set, and the speech parser
- `src/ai/textToCad.ts`: Worker client, per-part compile, auto-repair, voice intent ("design…" / "make it…")
- `src/ai/openscad.ts`: OpenSCAD-WASM wrapper (STL out, readable compile errors)
- `src/ui.ts`: phone companion UI and the glasses mirror preview

## Licensing note

LibreDWG is GPL-3.0 and OpenSCAD-WASM is GPL-2.0+, so a distributed build of this app falls under GPL-3.0 terms. The Worker (`../g2-cad-ai-worker`) contains no GPL code.
