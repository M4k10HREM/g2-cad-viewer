// G2 CAD Viewer — text-to-CAD proxy.
//
// Keeps the Claude API key server-side. The glasses app sends a plain-language
// request (plus the current OpenSCAD code when refining, or a compiler error
// when asking for a fix) and gets OpenSCAD code back, which it compiles to
// geometry on the phone with OpenSCAD-WASM.
import Anthropic from '@anthropic-ai/sdk'

export interface Env {
  ANTHROPIC_API_KEY: string
  APP_TOKEN: string
  ALLOWED_ORIGIN?: string
  /** Optional: enables ElevenLabs voice via short-lived single-use tokens. */
  ELEVENLABS_API_KEY?: string
  /** Optional KV namespace: temporary download links for exported models. */
  EXPORTS?: KVNamespace
}

// Exported files live in KV only briefly: Cloudflare deletes them automatically.
const EXPORT_TTL_SECONDS = 15 * 60
const EXPORT_MAX_BYTES = 20 * 1024 * 1024

interface GenerateRequest {
  /** What the user asked for, e.g. "a 60 mm L-bracket with two M5 holes". */
  prompt: string
  /** Current design when refining ("make it thicker"). */
  code?: string
  /** OpenSCAD compiler error to fix (sent with `code`). */
  error?: string
}

const MODEL = 'claude-opus-5-5'
const MAX_PROMPT = 2_000
const MAX_CODE = 40_000

const SYSTEM = `You are a mechanical CAD engineer who writes OpenSCAD code for parts that will be viewed on smart glasses and may be 3D printed.

Output format — exactly this, nothing else:
TITLE: <3 to 5 words naming the part, e.g. "Spoked wheel pivot">
SUMMARY: <one short sentence, max 12 words, describing the part>
\`\`\`openscad
<code>
\`\`\`

Code rules:
- Units are millimetres. Z is up. Put the part on the XY plane (z >= 0), roughly centred on the origin.
- Plain OpenSCAD only: no include/use of external libraries (no MCAD, BOSL, etc.), no import(), no text() fonts.
- Start with named parameters at the top (e.g. length = 60; thickness = 5;) so later edits are easy.
- Split the design into 1–8 physical parts. Each part is a module named part_<name> (lowercase letters, digits, underscore). Add this selector so parts can be rendered one at a time:

show_part = "all";
module part_base() { ... }
module part_bolt_1() { ... }
if (show_part == "all" || show_part == "base") part_base();
if (show_part == "all" || show_part == "bolt_1") part_bolt_1();

- Position each part in its assembled location inside its module.
- Use $fn between 24 and 64 for round features. Keep geometry modest (no huge loops, no minkowski on complex shapes) so it compiles in a few seconds in a browser.
- Use standard engineering sizes when the user names them (M3/M4/M5/M6/M8 clearance holes: 3.4/4.5/5.5/6.6/9 mm).
- If the request is ambiguous, choose sensible defaults instead of asking questions.
- When given existing code and a change request, keep everything else the same and return the complete updated code.
- When given a compiler error, fix it and return the complete corrected code.`

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Expose-Headers': 'Content-Disposition',
      'Access-Control-Max-Age': '86400',
    }
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, voice: env.ELEVENLABS_API_KEY ? 'elevenlabs' : null, downloads: Boolean(env.EXPORTS) })
    }

    // Download link: GET /dl/<id>/<file name>. No token needed: the random id is
    // the secret, and the file expires 15 minutes after it was exported.
    if (req.method === 'GET' && url.pathname.startsWith('/dl/')) {
      const [, , id = '', rawName = 'model'] = url.pathname.split('/')
      if (!env.EXPORTS || !/^[a-f0-9-]{36}$/.test(id)) return downloadPage('Download link not found.', 404)
      const { value, metadata } = await env.EXPORTS.getWithMetadata<{ name: string; type: string }>(id, 'arrayBuffer')
      if (!value) return downloadPage('This download link has expired (links last 15 minutes). Export the model again from the app.', 410)
      const name = (metadata?.name || decodeURIComponent(rawName)).replace(/[^\w.\- ]+/g, '_')
      return new Response(value, {
        headers: {
          'Content-Type': metadata?.type || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${name}"`,
          'Cache-Control': 'no-store',
        },
      })
    }

    const routes = ['/generate', '/stt-token', '/export']
    if (req.method !== 'POST' || !routes.includes(url.pathname)) {
      return json({ error: 'Not found' }, 404)
    }

    if (!env.APP_TOKEN || req.headers.get('Authorization') !== `Bearer ${env.APP_TOKEN}`) {
      return json({ error: 'Unauthorized' }, 401)
    }

    // Export: the app uploads a file and gets back a short-lived download link
    // the phone's browser can open (the Even app's WebView can't save files).
    if (url.pathname === '/export') {
      if (!env.EXPORTS) {
        return json({ error: 'Downloads are not set up on your Worker (no EXPORTS storage). See SETUP-AI.md.' }, 501)
      }
      const name = (url.searchParams.get('name') || 'model.stl').replace(/[^\w.\- ]+/g, '_').slice(0, 80)
      const type = req.headers.get('Content-Type') || 'application/octet-stream'
      const body = await req.arrayBuffer()
      if (!body.byteLength) return json({ error: 'Empty file' }, 400)
      if (body.byteLength > EXPORT_MAX_BYTES) return json({ error: 'File is larger than 20 MB.' }, 413)
      const id = crypto.randomUUID()
      await env.EXPORTS.put(id, body, { expirationTtl: EXPORT_TTL_SECONDS, metadata: { name, type } })
      return json({ url: `${url.origin}/dl/${id}/${encodeURIComponent(name)}`, expiresInMinutes: EXPORT_TTL_SECONDS / 60 })
    }

    // ElevenLabs realtime speech-to-text: the phone gets a single-use token
    // (valid 15 min, consumed on connect) — the ElevenLabs key never leaves here.
    if (url.pathname === '/stt-token') {
      if (!env.ELEVENLABS_API_KEY) return json({ error: 'Worker has no ELEVENLABS_API_KEY secret.' }, 501)
      const res = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
        method: 'POST',
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
      })
      const data = (await res.json().catch(() => ({}))) as { token?: string; detail?: unknown }
      if (!res.ok || !data.token) {
        const why = res.status === 401 ? 'invalid ELEVENLABS_API_KEY' : `ElevenLabs error ${res.status}`
        return json({ error: why }, 502)
      }
      return json({ token: data.token })
    }

    let body: GenerateRequest
    try {
      body = (await req.json()) as GenerateRequest
    } catch {
      return json({ error: 'Body must be JSON' }, 400)
    }
    const prompt = String(body.prompt ?? '').trim().slice(0, MAX_PROMPT)
    const code = body.code ? String(body.code).slice(0, MAX_CODE) : ''
    const error = body.error ? String(body.error).slice(0, 4_000) : ''
    if (!prompt && !error) return json({ error: 'prompt is required' }, 400)

    let userText: string
    if (code && error) {
      userText = `This OpenSCAD code failed to compile.\n\nCompiler output:\n${error}\n\nCode:\n\`\`\`openscad\n${code}\n\`\`\`\n\nOriginal request: ${prompt || '(not given)'}\nReturn the complete corrected code.`
    } else if (code) {
      userText = `Current design:\n\`\`\`openscad\n${code}\n\`\`\`\n\nChange request: ${prompt}`
    } else {
      userText = `Design this part: ${prompt}`
    }

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
    try {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userText }],
      })

      if (response.stop_reason === 'refusal') {
        return json({ error: 'The request was declined. Try describing the part differently.' }, 422)
      }
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n')
      const match = text.match(/```(?:openscad|scad)?\s*\n([\s\S]*?)```/)
      if (!match) return json({ error: 'No OpenSCAD code in the response.' }, 502)
      const summary = text.match(/SUMMARY:\s*(.+)/)?.[1]?.trim() ?? prompt.slice(0, 80)
      const title = text.match(/TITLE:\s*(.+)/)?.[1]?.trim().replace(/^["']|["']$/g, '').slice(0, 40)
      if (response.stop_reason === 'max_tokens') {
        return json({ error: 'The design was too large to generate. Try a simpler request.' }, 502)
      }
      return json({ code: match[1].trim(), summary, title, model: response.model })
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) return json({ error: 'Worker has an invalid ANTHROPIC_API_KEY.' }, 500)
      if (err instanceof Anthropic.RateLimitError) return json({ error: 'Rate limited — wait a moment and retry.' }, 429)
      if (err instanceof Anthropic.APIError) return json({ error: `Claude API error ${err.status}: ${err.message}` }, 502)
      return json({ error: `Worker error: ${(err as Error)?.message ?? String(err)}` }, 500)
    }
  },
}

function downloadPage(message: string, status: number): Response {
  const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>G2 CAD Viewer</title>
<body style="font:16px system-ui;background:#232323;color:#e5e5e5;padding:24px"><h1 style="font-size:18px">G2 CAD Viewer</h1><p>${message}</p></body>`
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}
