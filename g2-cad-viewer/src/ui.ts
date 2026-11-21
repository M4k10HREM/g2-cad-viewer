// Phone-side companion UI: open models, mirror what the glasses show,
// on-screen controls, a typed-command box, and the voice transcript.
import type { Command, Layout, Mode, Style, ViewName, ViewState } from './controls/commands'
import { MODES, MODE_LABEL } from './controls/commands'
import type { TextContent } from './glasses/display'
import { LAYOUTS } from './glasses/display'
import type { LoadedModel } from './model/model'
import type { Settings } from './settings'
import type { SavedDesignMeta } from './library'

export interface UiHandlers {
  onFile(file: File): void
  onUrl(url: string): void
  onSample(): void
  onCommand(cmd: Command): void
  onTypedCommand(text: string): void
  onToggleMic(): void
  onDesign(prompt: string, mode: 'new' | 'modify'): void
  onSaveSettings(s: Settings): void
  onExport(kind: 'stl' | 'scad'): void
  onOpenSaved(id: string): void
  onDeleteSaved(id: string): void
  onShowIntro(): void
}

type Chip = 'ok' | 'warn' | 'error' | 'idle'
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!

let mirrorCtx: CanvasRenderingContext2D
let handlers: UiHandlers

export function mountUi(h: UiHandlers, accept: string) {
  handlers = h
  injectStyles()
  $('#app').innerHTML = `
    <main class="wrap">
      <header class="top">
        <h1>G2 CAD Viewer</h1>
        <div class="chips">
          <span id="chip-glasses" class="chip chip-idle">Glasses…</span>
          <span id="chip-voice" class="chip chip-idle">Voice off</span>
        </div>
      </header>

      <section class="card mirror-card">
        <canvas id="mirror" width="576" height="288" aria-label="Glasses display mirror"></canvas>
        <div id="busy" class="busy" hidden></div>
        <div id="link-stats" class="link-stats"></div>
      </section>

      <section class="card">
        <div class="row">
          <label class="btn primary file-btn">Open 3D / CAD file
            <input id="file" type="file" accept="${accept}" />
          </label>
          <button class="btn" id="sample">Sample part</button>
        </div>
        <div class="row" id="server-models-row" hidden>
          <select id="server-models"><option value="">Sample models…</option></select>
        </div>
        <div class="row">
          <input id="url" type="url" placeholder="…or paste a model URL" />
          <button class="btn" id="url-go">Load</button>
        </div>
        <p class="hint">STEP · IGES · DWG · DXF · GLB · STL · OBJ · PLY · 3MF · FBX</p>
        <div id="model-info" class="info"></div>
        <div class="row" style="margin-top:8px">
          <button class="btn" id="export-stl">Save as STL</button>
          <button class="btn" id="export-scad" hidden>Save .scad code</button>
          <span id="export-status" class="hint"></span>
        </div>
        <div id="dl-box" class="dl-box" hidden>
          <div class="hint">Download link, valid <span id="dl-min">15</span> minutes. Copy it, then paste it into your phone's browser (Chrome / Safari) to save the file.</div>
          <div class="row">
            <input id="dl-url" type="text" readonly />
            <button class="btn primary" id="dl-copy">Copy link</button>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>AI design <small>(text-to-CAD with Claude)</small></h2>
        <textarea id="ai-prompt" rows="2" placeholder='e.g. "a 60 mm L-bracket, 5 mm thick, with two M5 holes"'></textarea>
        <div class="row">
          <button class="btn primary" id="ai-new">Design new</button>
          <button class="btn" id="ai-modify" disabled>Modify current</button>
          <span id="ai-status" class="hint"></span>
        </div>
        <details id="ai-code-wrap" hidden><summary>OpenSCAD code</summary><pre id="ai-code"></pre></details>
        <p class="hint">Voice: "design a …", "create …" for a new part · "make it …", "add …", "change …" to modify it.</p>
      </section>

      <section class="card">
        <h2>My designs <small>(saved on this phone automatically)</small></h2>
        <ul id="designs" class="designs"><li class="hint">No saved designs yet. Every AI design lands here.</li></ul>
      </section>

      <section class="card">
        <h2>Controls</h2>
        <div class="grid">
          <button data-cmd='{"kind":"rotate","deg":-30}'>⟲ Left</button>
          <button data-cmd='{"kind":"tilt","deg":15}'>▲ Tilt up</button>
          <button data-cmd='{"kind":"rotate","deg":30}'>Right ⟳</button>
          <button data-cmd='{"kind":"zoom","factor":0.8}'>− Zoom</button>
          <button data-cmd='{"kind":"tilt","deg":-15}'>▼ Tilt down</button>
          <button data-cmd='{"kind":"zoom","factor":1.25}'>+ Zoom</button>
          <button data-cmd='{"kind":"pan","dx":0.2,"dy":0}'>◀ Pan</button>
          <button data-cmd='{"kind":"fit"}'>Fit</button>
          <button data-cmd='{"kind":"pan","dx":-0.2,"dy":0}'>Pan ▶</button>
        </div>
        <h3>Views</h3>
        <div class="seg" id="views">
          ${(['iso', 'front', 'right', 'top', 'back', 'left', 'bottom'] as ViewName[])
            .map(v => `<button data-cmd='{"kind":"view","name":"${v}"}' data-view="${v}">${v === 'iso' ? 'Iso' : v[0].toUpperCase() + v.slice(1)}</button>`)
            .join('')}
        </div>
        <h3>Style</h3>
        <div class="seg" id="styles">
          ${(['hidden', 'shaded', 'wire'] as Style[])
            .map(s => `<button data-cmd='{"kind":"style","style":"${s}"}' data-style="${s}">${{ hidden: 'Hidden line', shaded: 'Shaded', wire: 'Wireframe' }[s]}</button>`)
            .join('')}
        </div>
        <h3>Glasses layout</h3>
        <div class="seg" id="layouts">
          ${(['single', 'wide', 'full'] as Layout[])
            .map(l => `<button data-cmd='{"kind":"layout","layout":"${l}"}' data-layout="${l}">${{ single: '1 tile · fast', wide: '2 tiles · wide', full: '4 tiles · full' }[l]}</button>`)
            .join('')}
        </div>
        <h3>Touchpad mode <small>(tap on glasses cycles)</small></h3>
        <div class="seg" id="modes">
          ${MODES.map(m => `<button data-cmd='{"kind":"mode","mode":"${m}"}' data-mode="${m}">${MODE_LABEL[m]}</button>`).join('')}
        </div>
        <h3>Explode & turntable</h3>
        <div class="row">
          <button class="btn" data-cmd='{"kind":"explode","delta":-0.25}'>Collapse</button>
          <span id="explode-val" class="val">0%</span>
          <button class="btn" data-cmd='{"kind":"explode","delta":0.25}'>Explode</button>
          <button class="btn" id="spin" data-cmd='{"kind":"spin","on":true}'>Turntable</button>
          <button class="btn" data-cmd='{"kind":"reset"}'>Reset</button>
        </div>
      </section>

      <section class="card">
        <h2>Parts <small id="parts-count"></small></h2>
        <div class="row">
          <button class="btn" data-cmd='{"kind":"part","delta":-1}'>◀ Prev</button>
          <button class="btn" data-cmd='{"kind":"part","delta":1}'>Next ▶</button>
          <button class="btn" id="isolate" data-cmd='{"kind":"isolate","on":true}'>Isolate</button>
          <button class="btn" data-cmd='{"kind":"partSelect","index":-1}'>Show all</button>
        </div>
        <ol id="parts" class="parts"></ol>
      </section>

      <section class="card">
        <h2>Voice</h2>
        <div class="row">
          <button class="btn" id="mic">Mic</button>
          <input id="typed" type="text" placeholder='Try "top view and zoom in"' />
          <button class="btn" id="typed-go">Do it</button>
        </div>
        <div class="transcript"><span id="final"></span><span id="interim" class="interim"></span></div>
        <p class="hint">Say: rotate left 90 · tilt up · zoom in · front / top / iso view · wireframe · shaded ·
          next part · isolate · show all · explode · collapse · full screen · turntable · stop · reset</p>
      </section>

      <details class="card" id="settings">
        <summary><h2 style="display:inline">Settings: your keys</h2></summary>
        <p class="hint">Stored only on this phone, never inside the app package. Each user brings their own.</p>
        <h3>AI design (your Cloudflare Worker)</h3>
        <input id="set-ai-url" type="url" placeholder="https://g2-cad-ai.your-name.workers.dev" autocomplete="off" />
        <input id="set-ai-token" type="password" placeholder="App token (APP_TOKEN on your Worker)" autocomplete="off" />
        <h3>Voice (speech-to-text)</h3>
        <select id="set-stt-provider">
          <option value="">Off</option>
          <option value="elevenlabs">ElevenLabs (key stays on your Worker)</option>
          <option value="deepgram">Deepgram (key stored on this phone)</option>
        </select>
        <input id="set-stt-key" type="password" placeholder="Deepgram API key" autocomplete="off" />
        <select id="set-mic-mode">
          <option value="hold">Mic: hold the touchpad to talk (push-to-talk)</option>
          <option value="always">Mic: always listening</option>
        </select>
        <p class="hint" id="set-stt-hint"></p>
        <h3>Glasses</h3>
        <label class="check"><input type="checkbox" id="set-intro" /> Show the controls card when the app opens</label>
        <select id="set-encoding" style="margin-top:6px">
          <option value="compact">Image sending: Compact (16-shade, smaller, faster)</option>
          <option value="standard">Image sending: Standard (full-colour PNG)</option>
        </select>
        <div class="row" style="margin-top:8px">
          <button class="btn primary" id="set-save">Save</button>
          <button class="btn" id="show-intro">Show controls card now</button>
          <button class="btn" id="set-clear">Clear all</button>
          <span id="set-status" class="hint"></span>
        </div>
      </details>

      <footer>Glasses: tap = next mode · swipe = adjust · hold = talk · double-tap = exit</footer>
    </main>
  `
  mirrorCtx = $<HTMLCanvasElement>('#mirror').getContext('2d')!

  $<HTMLInputElement>('#file').addEventListener('change', e => {
    const f = (e.target as HTMLInputElement).files?.[0]
    if (f) handlers.onFile(f)
    ;(e.target as HTMLInputElement).value = ''
  })
  $('#sample').addEventListener('click', () => handlers.onSample())
  $('#url-go').addEventListener('click', () => {
    const u = $<HTMLInputElement>('#url').value.trim()
    if (u) handlers.onUrl(u)
  })
  $<HTMLSelectElement>('#server-models').addEventListener('change', e => {
    const v = (e.target as HTMLSelectElement).value
    if (v) handlers.onUrl(`${import.meta.env.BASE_URL}models/${encodeURIComponent(v)}`)
  })
  $('#mic').addEventListener('click', () => handlers.onToggleMic())
  const aiSubmit = (mode: 'new' | 'modify') => {
    const p = $<HTMLTextAreaElement>('#ai-prompt').value.trim()
    if (p) handlers.onDesign(p, mode)
  }
  const readSettings = (): Settings => ({
    aiUrl: $<HTMLInputElement>('#set-ai-url').value,
    aiToken: $<HTMLInputElement>('#set-ai-token').value,
    sttProvider: (['deepgram', 'elevenlabs'] as const).find(p => p === $<HTMLSelectElement>('#set-stt-provider').value) ?? '',
    sttKey: $<HTMLInputElement>('#set-stt-key').value,
    micMode: $<HTMLSelectElement>('#set-mic-mode').value === 'always' ? 'always' : 'hold',
    showIntro: $<HTMLInputElement>('#set-intro').checked,
    imageEncoding: $<HTMLSelectElement>('#set-encoding').value === 'standard' ? 'standard' : 'compact',
  })
  $('#show-intro').addEventListener('click', () => handlers.onShowIntro())
  $('#export-stl').addEventListener('click', () => handlers.onExport('stl'))
  $('#export-scad').addEventListener('click', () => handlers.onExport('scad'))
  $('#dl-copy').addEventListener('click', async () => {
    const input = $<HTMLInputElement>('#dl-url')
    let ok = false
    try {
      await navigator.clipboard.writeText(input.value)
      ok = true
    } catch {
      input.select()
      ok = document.execCommand?.('copy') ?? false
    }
    $('#dl-copy').textContent = ok ? 'Copied ✓' : 'Select & copy'
    setTimeout(() => ($('#dl-copy').textContent = 'Copy link'), 2500)
  })
  $<HTMLInputElement>('#dl-url').addEventListener('focus', e => (e.target as HTMLInputElement).select())
  $('#designs').addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-design]')
    if (!btn) return
    const id = btn.dataset.design!
    if (btn.dataset.act === 'open') handlers.onOpenSaved(id)
    else if (btn.dataset.act === 'delete' && confirm('Delete this saved design from the phone?')) handlers.onDeleteSaved(id)
  })
  $('#set-stt-provider').addEventListener('change', syncSttFields)
  $('#set-save').addEventListener('click', () => handlers.onSaveSettings(readSettings()))
  $('#set-clear').addEventListener('click', () => {
    if (!confirm('Remove all keys from this phone?')) return
    handlers.onSaveSettings({ aiUrl: '', aiToken: '', sttProvider: '', sttKey: '', micMode: 'hold', showIntro: true, imageEncoding: 'compact' })
  })
  $('#ai-new').addEventListener('click', () => aiSubmit('new'))
  $('#ai-modify').addEventListener('click', () => aiSubmit('modify'))
  const submitTyped = () => {
    const el = $<HTMLInputElement>('#typed')
    if (el.value.trim()) handlers.onTypedCommand(el.value.trim())
    el.value = ''
  }
  $('#typed-go').addEventListener('click', submitTyped)
  $<HTMLInputElement>('#typed').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitTyped()
  })
  document.body.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd]')
    if (btn) handlers.onCommand(JSON.parse(btn.dataset.cmd!))
  })
  $('#parts').addEventListener('click', e => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-index]')
    if (li) handlers.onCommand({ kind: 'partSelect', index: Number(li.dataset.index) })
  })

  void loadServerModels()
}

async function loadServerModels() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}models/index.json`)
    if (!res.ok) return
    const list: string[] = await res.json()
    if (!list.length) return
    const sel = $<HTMLSelectElement>('#server-models')
    for (const name of list) sel.add(new Option(name, name))
    $('#server-models-row').hidden = false
  } catch {
    /* no dev model list — fine */
  }
}

export function setChip(which: 'glasses' | 'voice', kind: Chip, text: string) {
  const el = $(`#chip-${which}`)
  el.className = `chip chip-${kind}`
  el.textContent = text
}

export function setBusy(text: string | null) {
  const el = $('#busy')
  el.hidden = !text
  el.textContent = text ?? ''
}

export function setModelInfo(m: LoadedModel) {
  const s = m.stats
  const bits = [m.format]
  if (s.triangles) bits.push(`${s.triangles.toLocaleString()} triangles`)
  if (s.segments) bits.push(`${s.segments.toLocaleString()} line segments`)
  bits.push(`${m.parts.length} part${m.parts.length === 1 ? '' : 's'}`)
  $('#model-info').innerHTML = `<strong>${escapeHtml(m.name)}</strong><br>${bits.join(' · ')}${s.notes
    .map(n => `<div class="note">${escapeHtml(n)}</div>`)
    .join('')}`
  $('#parts-count').textContent = `(${m.parts.length})`
  $('#parts').innerHTML = m.parts.map((p, i) => `<li data-index="${i}">${escapeHtml(p.name)}</li>`).join('')
}

export function setError(msg: string) {
  $('#model-info').innerHTML = `<div class="note err">${escapeHtml(msg)}</div>`
}

export function syncState(s: ViewState) {
  const mark = (sel: string, attr: string, value: string | null) =>
    document.querySelectorAll<HTMLElement>(`${sel} [data-${attr}]`).forEach(b => b.classList.toggle('on', b.dataset[attr] === value))
  mark('#views', 'view', s.view)
  mark('#styles', 'style', s.style)
  mark('#layouts', 'layout', s.layout)
  mark('#modes', 'mode', s.mode as Mode)
  $('#explode-val').textContent = `${Math.round(s.explode * 100)}%`
  const spin = $('#spin')
  spin.classList.toggle('on', s.spinning)
  spin.dataset.cmd = JSON.stringify({ kind: 'spin', on: !s.spinning })
  const iso = $('#isolate')
  iso.classList.toggle('on', s.isolate)
  iso.dataset.cmd = JSON.stringify({ kind: 'isolate', on: !s.isolate })
  document.querySelectorAll<HTMLElement>('#parts li').forEach(li => li.classList.toggle('on', Number(li.dataset.index) === s.partIndex))
}

export function setSavedDesigns(list: SavedDesignMeta[], currentId?: string | null) {
  const el = $('#designs')
  if (!list.length) {
    el.innerHTML = '<li class="hint">No saved designs yet. Every AI design lands here.</li>'
    return
  }
  el.innerHTML = list
    .map(d => {
      const when = new Date(d.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      return `<li class="${d.id === currentId ? 'on' : ''}">
        <div><strong>${escapeHtml(d.title)}</strong><br><span class="hint">${escapeHtml(d.summary)} · ${when}</span></div>
        <div class="row">
          <button class="btn" data-design="${d.id}" data-act="open">Open</button>
          <button class="btn" data-design="${d.id}" data-act="delete">Delete</button>
        </div>
      </li>`
    })
    .join('')
}

export function setDownloadLink(url: string | null, minutes = 15) {
  $('#dl-box').hidden = !url
  $<HTMLInputElement>('#dl-url').value = url ?? ''
  $('#dl-min').textContent = String(minutes)
}

export function setLinkStats(text: string) {
  $('#link-stats').textContent = text
}

export function setExportState(hasScad: boolean, status?: string) {
  $('#export-scad').hidden = !hasScad
  if (status !== undefined) $('#export-status').textContent = status
}

/** Put a spoken design request into the AI box so it can also be sent from the phone. */
export function setAiPrompt(text: string) {
  $<HTMLTextAreaElement>('#ai-prompt').value = text
}

function syncSttFields() {
  const p = $<HTMLSelectElement>('#set-stt-provider').value
  $('#set-stt-key').hidden = p !== 'deepgram'
  $('#set-mic-mode').hidden = p === ''
  $('#set-stt-hint').textContent =
    p === 'elevenlabs'
      ? 'Uses the Worker URL + token above. Add ELEVENLABS_API_KEY as a secret on your Worker (see SETUP-AI.md).'
      : ''
}

export function fillSettings(s: Settings, status?: string) {
  $<HTMLInputElement>('#set-ai-url').value = s.aiUrl
  $<HTMLInputElement>('#set-ai-token').value = s.aiToken
  $<HTMLSelectElement>('#set-stt-provider').value = s.sttProvider
  $<HTMLInputElement>('#set-stt-key').value = s.sttKey
  $<HTMLSelectElement>('#set-mic-mode').value = s.micMode
  $<HTMLInputElement>('#set-intro').checked = s.showIntro
  $<HTMLSelectElement>('#set-encoding').value = s.imageEncoding
  syncSttFields()
  $('#set-status').textContent = status ?? ''
  // Open the panel on first run so new users see where to put their keys.
  if (!s.aiUrl && !s.sttKey && status === undefined) $<HTMLDetailsElement>('#settings').open = true
}

export function setAiState(opts: { configured: boolean; busy: boolean; canModify: boolean; status?: string; error?: boolean; code?: string | null }) {
  $<HTMLButtonElement>('#ai-new').disabled = !opts.configured || opts.busy
  $<HTMLButtonElement>('#ai-modify').disabled = !opts.configured || opts.busy || !opts.canModify
  const st = $('#ai-status')
  st.textContent = opts.configured ? opts.status ?? '' : 'Off: add your Worker URL + token in Settings (bottom)'
  st.classList.toggle('err', Boolean(opts.error))
  if (opts.code !== undefined) {
    $('#ai-code-wrap').hidden = !opts.code
    $('#ai-code').textContent = opts.code ?? ''
  }
}

export function setTranscript(finalText: string, interimText: string) {
  $('#final').textContent = finalText.slice(-400)
  $('#interim').textContent = interimText
}

export function setMicButton(on: boolean, available: boolean) {
  const b = $<HTMLButtonElement>('#mic')
  b.disabled = !available
  b.textContent = on ? '● Mic on' : 'Mic off'
  b.classList.toggle('on', on)
}

// Draw a faithful preview of the glasses screen: text slots + the rendered
// frame quantised to 16 green levels, exactly where the tiles sit.
export function drawMirror(layout: Layout, frame: HTMLCanvasElement | null, text: TextContent, card: string | null = null) {
  const ctx = mirrorCtx
  const L = LAYOUTS[layout]
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, 576, 288)
  ctx.font = '20px -apple-system, system-ui, sans-serif'
  ctx.textBaseline = 'top'

  // Word-wrapped text block, roughly like the glasses' LVGL text containers.
  const wrapBlock = (s: string, x: number, y: number, w: number, h: number) => {
    const lines: string[] = []
    for (const para of s.split('\n')) {
      let line = ''
      for (const word of para.split(' ')) {
        const tryLine = line ? `${line} ${word}` : word
        if (ctx.measureText(tryLine).width > w && line) {
          lines.push(line)
          line = word
        } else line = tryLine
      }
      lines.push(line)
    }
    ctx.fillStyle = '#3CFA44'
    lines.slice(0, Math.floor(h / 27)).forEach((ln, i) => ctx.fillText(ln, x, y + i * 27))
  }

  if (card !== null) {
    ctx.strokeStyle = '#3CFA44'
    ctx.lineWidth = 2
    ctx.strokeRect(25, 17, 526, 254)
    wrapBlock(card, 38, 30, 500, 230)
    return
  }
  if (!frame) return

  const x0 = Math.min(...L.tiles.map(t => t.x))
  const y0 = Math.min(...L.tiles.map(t => t.y))
  ctx.drawImage(frame, x0, y0, L.w, L.h)
  const img = ctx.getImageData(x0, y0, L.w, L.h)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    const level = Math.round((lum / 255) * 15) / 15
    d[i] = level * 60
    d[i + 1] = level * 250
    d[i + 2] = level * 68
    d[i + 3] = 255
  }
  ctx.putImageData(img, x0, y0)

  if (L.info) wrapBlock(text.info, L.info.x + 4, L.info.y + 4, L.info.w - 8, L.info.h - 8)
  if (L.msg) wrapBlock(text.msg, L.msg.x + 4, L.msg.y + 4, L.msg.w - 8, L.msg.h - 8)
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function injectStyles() {
  const css = `
    :root { color-scheme: dark; }
    html, body { margin: 0; min-height: 100%; background: #232323; color: #E5E5E5;
      font: 15px/1.4 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', system-ui, sans-serif;
      touch-action: manipulation; -webkit-text-size-adjust: 100%; overscroll-behavior: none; }
    #app { display: block; }
    .wrap { max-width: 680px; margin: 0 auto; padding: 16px; box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; }
    .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    h1 { font-size: 18px; margin: 0; font-weight: 600; }
    h2 { font-size: 15px; margin: 0 0 8px; font-weight: 600; }
    h3 { font-size: 12px; margin: 12px 0 6px; color: #A7A7A7; font-weight: 500; text-transform: uppercase; letter-spacing: .05em; }
    small { color: #7B7B7B; font-weight: 400; text-transform: none; letter-spacing: 0; }
    .chips { display: flex; gap: 6px; }
    .chip { font-size: 11px; padding: 3px 9px; border-radius: 999px; border: 1px solid #3E3E3E; text-transform: uppercase; letter-spacing: .04em; }
    .chip-idle { color: #A7A7A7; }
    .chip-ok { color: #3CFA44; border-color: #3CFA44; background: rgba(60,250,68,.08); }
    .chip-warn { color: #FFC233; border-color: #FFC233; }
    .chip-error { color: #FF453A; border-color: #FF453A; background: rgba(255,69,58,.08); }
    .card { background: #2E2E2E; border: 1px solid #3E3E3E; border-radius: 12px; padding: 12px; position: relative; }
    .mirror-card { padding: 8px; background: #000; }
    #mirror { width: 100%; height: auto; display: block; image-rendering: pixelated; border-radius: 6px; }
    .busy { position: absolute; inset: 8px; display: grid; place-items: center; background: rgba(0,0,0,.7); color: #3CFA44; border-radius: 6px; font-size: 14px; }
    .busy[hidden] { display: none; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
    .row:last-child { margin-bottom: 0; }
    .btn, .grid button, .seg button { background: #3E3E3E; color: #E5E5E5; border: 1px solid #4A4A4A; border-radius: 8px;
      padding: 9px 12px; font: inherit; font-size: 14px; cursor: pointer; }
    .btn:active, .grid button:active, .seg button:active { background: #4A4A4A; }
    .btn.primary { background: #3CFA44; color: #111; border-color: #3CFA44; font-weight: 600; }
    .on { border-color: #3CFA44 !important; color: #3CFA44 !important; background: rgba(60,250,68,.1) !important; }
    .file-btn { position: relative; overflow: hidden; }
    .file-btn input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
    textarea { width: 100%; box-sizing: border-box; resize: vertical; margin-bottom: 8px; background: #232323; color: #E5E5E5;
      border: 1px solid #4A4A4A; border-radius: 8px; padding: 9px 10px; font: inherit; font-size: 14px; }
    pre#ai-code { max-height: 260px; overflow: auto; background: #1b1b1b; border-radius: 8px; padding: 10px; font-size: 12px; white-space: pre; }
    .hint.err { color: #FF453A; }
    .dl-box { margin-top: 8px; border: 1px solid #3CFA44; border-radius: 8px; padding: 8px 10px; background: rgba(60,250,68,.05); }
    .dl-box input { flex: 1; min-width: 0; }
    .link-stats { font-size: 12px; color: #7B7B7B; padding: 6px 4px 0; font-variant-numeric: tabular-nums; }
    .designs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; max-height: 340px; overflow: auto; }
    .designs li { border: 1px solid #3E3E3E; border-radius: 8px; padding: 8px 10px; display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
    .designs li .row { margin: 0; }
    .check { display: flex; align-items: center; gap: 8px; font-size: 14px; }
    .check input { width: auto; margin: 0; }
    #settings input, #settings select { width: 100%; box-sizing: border-box; margin-bottom: 6px; }
    #settings summary { cursor: pointer; }
    input[type=password] { background: #232323; color: #E5E5E5; border: 1px solid #4A4A4A; border-radius: 8px; padding: 9px 10px; font: inherit; font-size: 14px; }
    input[type=url], input[type=text], select { flex: 1; min-width: 0; background: #232323; color: #E5E5E5; border: 1px solid #4A4A4A;
      border-radius: 8px; padding: 9px 10px; font: inherit; font-size: 14px; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .seg { display: flex; flex-wrap: wrap; gap: 6px; }
    .seg button { padding: 7px 10px; font-size: 13px; }
    .val { min-width: 44px; text-align: center; color: #A7A7A7; }
    .hint { font-size: 12px; color: #7B7B7B; margin: 6px 0 0; }
    .info { font-size: 13px; color: #C8C8C8; margin-top: 6px; }
    .note { color: #FFC233; font-size: 12px; margin-top: 4px; }
    .note.err { color: #FF453A; }
    .parts { margin: 8px 0 0; padding-left: 26px; max-height: 200px; overflow: auto; font-size: 13px; }
    .parts li { padding: 4px 6px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
    .transcript { background: #232323; border: 1px solid #3E3E3E; border-radius: 8px; padding: 10px; min-height: 48px;
      font-size: 15px; white-space: pre-wrap; word-break: break-word; }
    .interim { color: #919191; }
    footer { font-size: 12px; color: #7B7B7B; text-align: center; padding-bottom: 12px; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
