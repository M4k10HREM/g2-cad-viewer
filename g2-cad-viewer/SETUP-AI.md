# Setting up AI design (text-to-CAD)

How it works: you say or type "design a 60 mm L-bracket with two M5 holes". The app sends that to **your own Cloudflare Worker**. The Worker holds your Claude API key and asks Claude for OpenSCAD code. Your phone then compiles the code into a 3D model, and the model shows on the glasses. Your API key never sits inside the app.

Plan for about 20 minutes. Steps marked 🧑 need you, because they involve your accounts, payment or keys. Everything else is a command you copy.

---

## Part 1: Claude API key 🧑

1. Go to **https://console.anthropic.com** and sign up or log in.
2. Open **Billing** and add a payment method plus a small credit (US$5 is plenty for testing).
   *Cost guide:* expect roughly **5–15 US cents** per design or modification (Claude Opus 5.5, and its reasoning counts as output). Check the Console's usage page after your first few tries to get your real number.
3. 🧑 **Set a spending limit** under **Settings → Limits** (for example US$10/month). This is your safety net if someone ever copies the app's access token.
4. Open **API Keys → Create Key**. If it asks where the key will be used, choose **"Somewhere else" → "Default workspace" (a normal API key)**. *Not* "My own machine / ant CLI" (that's for running code on your PC), *not* "Organization / Admin" (that manages users and billing and won't work here), and *not* "CI pipeline" or "Cloud/Kubernetes" (those are for keyless federation). Name it `g2-cad-ai` and **copy the key** (it starts with `sk-ant-`). Keep it private. You paste it only into the terminal in Part 3.

## Part 2: Cloudflare account 🧑

1. Sign up for free at **https://dash.cloudflare.com/sign-up** and verify your email.
2. That's all. The free Workers plan covers this.

## Part 3: Deploy the Worker

Open a terminal in the worker folder:

```bash
cd g2-cad-ai-worker
```

**3.1 Log in to Cloudflare** 🧑 (a browser window opens; click **Allow**):

```bash
npx wrangler login
```

**3.2 Deploy:**

```bash
npx wrangler deploy
```

The first time, it may ask you to choose a **workers.dev subdomain** (any name, such as your org name). 🧑
When it finishes it prints your Worker URL, for example `https://g2-cad-ai.your-name.workers.dev`. **Copy this URL.**

> **If you see `This Worker does not exist on your account. [code: 10007]` right after `Uploaded g2-cad-ai`:** the upload worked, but a brand-new Cloudflare account takes a moment to catch up. Wait a minute and run `npx wrangler deploy` again. If it still fails, open **https://dash.cloudflare.com → Workers & Pages** once in your browser (that finishes the account's Workers setup and the workers.dev subdomain), then deploy again.

**3.3 Create an app access token.** This command prints a random string. **Copy it.**

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

**3.4 Store both secrets in Cloudflare.** Each command asks you to paste a value. 🧑

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```
Paste the `sk-ant-…` key from Part 1.

```bash
npx wrangler secret put APP_TOKEN
```
Paste the random string from 3.3.

**3.5 Check that it's alive** (replace the URL with yours). It should print `{"ok":true}`:

```bash
curl https://g2-cad-ai.your-name.workers.dev/health
```

## Part 3b (optional): ElevenLabs voice commands 🧑

ElevenLabs speech-to-text has a monthly free allowance. Your ElevenLabs key is stored on the Worker, just like the Claude key. The phone only ever gets single-use tokens that expire in 15 minutes.

1. At **https://elevenlabs.io**, sign in, then go to **Settings → API Keys → Create API key**. If it lets you limit permissions, allow **Speech to Text**. Copy the key.
2. In the `g2-cad-ai-worker` folder:

   ```bash
   npx wrangler secret put ELEVENLABS_API_KEY
   ```
   Paste the key.

3. Deploy the updated Worker code (it has a new voice-token route):

   ```bash
   npx wrangler deploy
   ```

4. Check: `curl https://g2-cad-ai.your-name.workers.dev/health` should now print `{"ok":true,"voice":"elevenlabs"}`.

## Part 3c (optional): Download links for STL / .scad exports 🧑

The Even app can't save files to your phone directly. With this set up, **Save as STL** gives you a link that you paste into your phone's browser to download the file.

**Storage use stays near zero.** Each exported file is kept in Cloudflare's KV store for **15 minutes** and then deleted by Cloudflare automatically, so nothing builds up. The free plan includes 1 GB of KV storage and 1,000 exports a day.

1. `wrangler.toml` already declares the storage (`[[kv_namespaces]]` with `binding = "EXPORTS"`). Just deploy from the `g2-cad-ai-worker` folder; Wrangler creates the KV namespace for you. If it asks whether to use an existing namespace or create a new one, either is fine.

   ```bash
   npx wrangler deploy
   ```

   *If your Wrangler version refuses a namespace without an `id`,* create it yourself with `npx wrangler kv namespace create EXPORTS`, then add the `id = "…"` line it prints under `binding = "EXPORTS"`.

2. Check: `/health` on your Worker should now include `"downloads":true`.

To use it, in the app press **Save as STL** (or **Save .scad code**), then **Copy link**, and paste the link into Chrome or Safari on your phone. The file downloads like any other. Exports are Z-up and assembled, ready for a slicer or CAD tool.

## Part 4: Open the app on your glasses 🧑

**One-time: turn on developer access in the Even app**
1. On your PC, sign in at **https://hub.evenrealities.com/login** with the **same account** you use in the Even Realities phone app. Signing in once marks your account as a developer; there's no separate toggle.
2. On the phone, **force-quit the Even Realities app and reopen it**.
3. Open the **Even Hub** tab. A developer section with a **Scan QR** button now appears at the **top right**.

**Each time you test:**
1. On your PC, in `g2-cad-viewer`, run `npm run dev` and note the port it prints (for example 5174).
2. Show a QR code for `http://<laptop-IP>:<port>`. Either run `npx @evenrealities/evenhub-cli qr --url http://<laptop-IP>:<port>` (if PowerShell garbles the drawing, widen the window or use Windows Terminal), or use the `dev-qr.png` image in this folder.
3. In the Even app: **Even Hub → Scan QR** (top right). Scan the code. The CAD Viewer opens in the Even app and connects to your glasses.
4. Your phone must be able to reach the laptop. Use the same Wi-Fi with the laptop's `192.168.x.x` address, or keep Tailscale on and use the `100.x.x.x` address.

## Part 5: Enter your keys in the app 🧑

Keys are **entered inside the app, per phone**. They are never built into the app package, so you can share the app and nobody gets your keys. Enter them in the copy that's open **inside the Even app**. Values typed into the phone's normal browser are stored separately and don't carry over.

1. With the app open in the Even app (Part 4), scroll to the bottom.
2. Scroll to the bottom and open **Settings: your keys**.
3. Fill in:
   - **Worker URL**: `https://g2-cad-ai.your-name.workers.dev`
   - **App token**: the random string from step 3.3
   - (Optional) **Voice**: choose *ElevenLabs (key stays on your Worker)* (needs Part 3b), or *Deepgram* and paste a Deepgram key
4. Press **Save**. You'll see "Saved on this phone". The values live in the Even app's storage on that phone only.

`app.json` already allows any `*.workers.dev` address, so you don't need to edit it. The app accepts only `*.workers.dev` addresses (no custom domains). **Check on real glasses:** if AI design works in the phone browser but the Even app blocks it, the Even app may not honour the wildcard. In that case add your exact URL to `app.json`'s `whitelist` as well (your URL isn't secret; the token is).

*Developer shortcut:* you can also put values in `.env.local` (see `.env.example`). Those are used **only** by `npm run dev` and are stripped from `npm run build` / `npm run pack`.

## Part 6: Try it

- **Phone:** in the **AI design** box, type `a 60 mm L-bracket, 5 mm thick, with two M5 holes` and press **Design new**. The first design takes about 20–40 s (Claude writes the code, then the phone downloads the OpenSCAD engine once). Later designs are faster.
- Then type `make it 8 mm thick and add a third hole` and press **Modify current**.
- **Voice** (once the speech key is set): **hold the touchpad**, say *"design a phone stand"*, and let go. The glasses show your request; **tap to send** or **swipe to cancel** (or say "yes" / "no"). Then hold again for *"make it taller"*. View commands like *"rotate left"* run as soon as you let go. To keep the mic open instead, choose *Mic: always listening* in Settings.
- **Glasses:** the footer shows progress ("Asking Claude…", "Compiling part 2/3…"). The result opens as a normal model, so Parts, Explode and Rotate all work. Each part Claude defines is a separate part.

---

## If something goes wrong

| Message | Fix |
|---|---|
| `AI design is off — add your Worker URL and token in Settings` | Fill in **Settings: your keys** and press Save. |
| `Unauthorized` | The token in Settings doesn't match the Worker's `APP_TOKEN`. Run `npx wrangler secret put APP_TOKEN` again and re-enter it in Settings. |
| `Worker has an invalid ANTHROPIC_API_KEY` | Run `npx wrangler secret put ANTHROPIC_API_KEY` again with a fresh key. |
| `Rate limited` / `Claude API error 402/403` | Check billing credit and limits in the Claude Console. |
| Voice chip shows `Worker has no ELEVENLABS_API_KEY secret` | Do Part 3b, including the `npx wrangler deploy`. |
| Voice chip shows `invalid ELEVENLABS_API_KEY` | Run `npx wrangler secret put ELEVENLABS_API_KEY` again with a fresh key. |
| Voice chip shows `ElevenLabs quota_exceeded` | Your ElevenLabs monthly allowance is used up; it resets monthly, or upgrade. |
| "Downloaded" but no file appears | Set up download links (Part 3c). The Even app keeps direct downloads to itself. |
| `Downloads are not set up on your Worker` | Do Part 3c, including `npx wrangler deploy`. |
| Link says it has expired | Links last 15 minutes. Press **Save as STL** again for a fresh one. |
| No **Scan QR** button in the Even app | Sign in once at hub.evenrealities.com with the same account, then force-quit and reopen the Even app. |
| Works on the phone browser, but not in the Even app on the glasses | Add your exact Worker URL to `app.json`'s `whitelist` (next to `https://*.workers.dev`) and re-pack. |

To see live Worker logs, run this in the worker folder:

```bash
npx wrangler tail
```

## Security notes

- The **Claude key** lives only in Cloudflare's secret store, never in the app.
- The **app token and the speech key** are entered per phone in Settings and stored only there. **They are never part of the app package.** I verified this: a production build made with test keys in `.env.local` contained none of them. Sharing the `.ehpk` shares no keys.
- **Other G2 users** set up their own Claude key, Cloudflare Worker and token (Parts 1–3) and enter them in their own Settings. Their usage is billed to them, not you.
- Still set the **spending limit**. Anyone holding your phone with the app open could read the Settings fields. If you suspect misuse, run `npx wrangler secret put APP_TOKEN` with a new value and update it in Settings.
- Designs are sent to Anthropic's API for processing. Don't describe confidential designs you aren't allowed to share.

## Licences

The app now bundles OpenSCAD (GPL-2.0+) alongside LibreDWG (GPL-3.0), so a distributed build of the app is GPL-3.0. That's compatible with CADAM's GPL license if you ever borrow ideas or code from it. The Worker is separate and has no GPL code.
