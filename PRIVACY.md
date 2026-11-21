# G2 CAD Viewer: Privacy Policy

*Effective 21 November 2026 · App ID `com.harleyredwards.cadviewer` · Developer: Harley Raven Edwards ([GitHub: M4k10HREM](https://github.com/M4k10HREM))*

G2 CAD Viewer is a free, open-source app for Even Realities G2 glasses. **The developer does not collect, receive, store, sell or share any of your data.** There are no accounts, no analytics, no advertising and no tracking. The source code is public: <https://github.com/M4k10HREM/g2-cad-viewer>.

## What stays on your phone

- **Model files you open** (STEP, DWG, DXF, STL, …) are read and drawn on your phone and shown on your glasses. They are never uploaded, except when you choose to export or design (see below).
- **Settings you enter** (your Worker address and app token, speech provider and key, preferences) and **your saved AI designs** ("My designs") are stored only in the Even Realities app's storage on your phone. You can clear them at any time in the app's Settings panel and in My designs.

## Permissions the app requests

| Permission | Why | When |
|---|---|---|
| **G2 microphone** (`g2-microphone`) | Voice commands and spoken design requests | Only while you hold the touchpad (default), or while the app is open if you choose "always listening". The microphone is closed whenever the app goes to the background. |
| **Network** (`network`) | Optional features below, only with services **you** set up | Only when you use AI design, voice, or export. |

## Optional features that send data, and to whom

All of these are **off until you set them up with your own accounts**. Data goes to services you choose, under those services' own privacy policies. It never goes to the developer.

| Feature | What is sent | Where (allowed network domains) |
|---|---|---|
| **AI design** | The text of your design request, and the current design's code when you ask for a change | **Your own Cloudflare Worker** (`*.workers.dev`), which forwards it to **Anthropic's Claude API** using your own API key. See [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy) and [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/). |
| **Voice** (ElevenLabs) | Microphone audio while you are talking | `api.elevenlabs.io`, using a short-lived token from your own Worker. See [ElevenLabs' privacy policy](https://elevenlabs.io/privacy). |
| **Voice** (Deepgram) | Microphone audio while you are talking | `api.deepgram.com`, using your own Deepgram key. See [Deepgram's privacy policy](https://deepgram.com/privacy). |
| **Download links** (STL / .scad export) | The exported file | **Your own Cloudflare Worker's** temporary storage. Deleted automatically after **15 minutes**. |

The backend in all cases is **your own** Cloudflare Worker, deployed from this project's public source (`g2-cad-ai-worker/`). The developer has no access to it.

## Children

The app is not directed at children under 13 and collects no personal information from anyone.

## Changes and contact

Changes to this policy are published in the [repository](https://github.com/M4k10HREM/g2-cad-viewer/blob/main/PRIVACY.md), where its full history is visible. For questions, open an issue: <https://github.com/M4k10HREM/g2-cad-viewer/issues>.
