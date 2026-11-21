import { waitForEvenAppBridge, OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { aiConfigured, aiIntentOf, design as aiDesign, designFromCode, fetchSttToken, type Design } from './ai/textToCad'
import { startSttStream, type SttClient } from './asr/stt'
import {
  MODE_LABEL,
  applyCommand,
  initialState,
  swipeCommand,
  type Command,
  type Layout,
  type ViewState,
} from './controls/commands'
import { parseVoice } from './controls/voice'
import { GlassesDisplay, LAYOUTS, TILE_H, TILE_W, type FrameStats, type RenderedFrame, type TextContent } from './glasses/display'
import { compactSupported, encodeCanvasPng, encodeGray4Png } from './glasses/encode'
import { DownloadsNotSetUp, deleteDesign, deliverFile, downloadLink, fileNameFor, getDesign, listDesigns, saveDesign, scadBlob, stlBlob } from './library'
import { ACCEPT_ATTR, loadModel } from './model/loaders'
import type { LoadedModel } from './model/model'
import { makeSampleModel } from './model/sample'
import { Viewer } from './render/viewer'
import { attachBridgeStorage, getSettings, saveSettings, type Settings } from './settings'
import { setStorageBridge } from './storage'
import * as ui from './ui'

// ── State ────────────────────────────────────────────────────────────
const viewer = new Viewer()
let model: LoadedModel = makeSampleModel()
viewer.setModel(model)
let state: ViewState = initialState(model.flat)
let display: GlassesDisplay | null = null
let bridgeRef: EvenAppBridge | null = null

// ── Phone UI ─────────────────────────────────────────────────────────
ui.mountUi(
  {
    onFile: file => void openModel(() => file.arrayBuffer(), file.name),
    onUrl: url => void openModel(() => fetchBytes(url), decodeURIComponent(url.split('/').pop() || 'model')),
    onSample: () => setModel(makeSampleModel()),
    onCommand: cmd => run(cmd),
    onTypedCommand: text => void handleUtterance(text, 'typed'),
    onToggleMic: () => void toggleMic(),
    onDesign: (prompt, mode) => void runDesign(prompt, mode),
    onSaveSettings: s => void applySettings(s),
    onExport: kind => void exportModel(kind),
    onOpenSaved: id => void openSaved(id),
    onDeleteSaved: id => void removeSaved(id),
    onShowIntro: () => openCard('intro', introText()),
  },
  ACCEPT_ATTR,
)
ui.setModelInfo(model)
ui.setMicButton(false, false)
ui.fillSettings(getSettings())

async function applySettings(next: Settings) {
  const saved = await saveSettings(next)
  ui.fillSettings(saved, bridgeRef ? 'Saved on this phone' : 'Saved in this browser')
  syncAi()
  // Restart voice with the new provider/key/mode.
  if (bridgeRef && display) {
    stopVoice()
    startVoice(bridgeRef)
  }
  refresh()
}

// ── Messages (bottom line; clear themselves) ─────────────────────────
let message = ''
let messageTimer: number | null = null

function flash(text: string, ms = 4000) {
  message = text
  if (messageTimer !== null) clearTimeout(messageTimer)
  messageTimer = ms > 0
    ? window.setTimeout(() => {
        message = ''
        messageTimer = null
        updateText()
      }, ms)
    : null
  updateText()
}

// ── Cards (full-screen boxes on the glasses) ─────────────────────────
type CardKind = 'intro' | 'talk' | 'confirm' | 'note'
let cardKind: CardKind | null = null
let cardText: string | null = null
let noteTimer: number | null = null

function openCard(kind: CardKind, text: string) {
  if (noteTimer !== null) {
    clearTimeout(noteTimer)
    noteTimer = null
  }
  cardKind = kind
  cardText = text
  display?.showCard(text)
  drawMirror()
  // Phone-only preview has no glasses to tap: close informational cards by themselves.
  if (!display && kind !== 'talk' && kind !== 'confirm') noteTimer = window.setTimeout(closeCard, 6000)
}

function closeCard() {
  if (noteTimer !== null) {
    clearTimeout(noteTimer)
    noteTimer = null
  }
  if (cardKind === null) return
  cardKind = null
  cardText = null
  void display?.hideCard()
  refresh()
}

function noteCard(text: string, ms = 2200) {
  openCard('note', text)
  if (noteTimer !== null) clearTimeout(noteTimer)
  noteTimer = window.setTimeout(closeCard, ms)
}

function introText() {
  const voice = voiceConfigured() ? (holdMode() ? 'Hold: talk  ("rotate left", "design a …")' : 'Mic is always on  ("rotate left", "design a …")') : 'Hold: talk  (set up voice in phone Settings)'
  return `CONTROLS\nTap: next mode\nSwipe up / down: adjust\n${voice}\nDouble-tap: exit\n\nUnderstood?   Tap = Yes    Double-tap = Exit`
}

// ── AI design (text-to-CAD) ──────────────────────────────────────────
let currentDesign: Design | null = null
let currentSavedId: string | null = null
let working: string | null = null // non-null = gyroscope + this label
let gyroTimer: number | null = null

const syncAi = (status?: string, error = false) =>
  ui.setAiState({ configured: aiConfigured(), busy: working !== null, canModify: Boolean(currentDesign && model.source), status, error, code: model.source ?? null })
syncAi()

function startWorking(label: string) {
  working = label
  closeCard()
  refresh()
  // Phone mirror animates smoothly; the glasses get frames as fast as Bluetooth allows.
  if (gyroTimer === null) gyroTimer = window.setInterval(() => drawMirror(), 120)
}

function stopWorking() {
  working = null
  if (gyroTimer !== null) {
    clearInterval(gyroTimer)
    gyroTimer = null
  }
  message = ''
  refresh()
}

async function runDesign(prompt: string, mode: 'new' | 'modify') {
  if (working) return
  clearPending()
  if (!aiConfigured()) {
    syncAi()
    noteCard('AI design is not set up.\nAdd your Worker URL and token in the phone Settings.', 3500)
    return
  }
  const base = mode === 'modify' && model.source ? currentDesign : null
  const progress = (msg: string) => {
    syncAi(msg)
    flash(msg, 0)
  }
  startWorking(base ? 'Changing design…' : 'Designing…')
  ui.setBusy('Designing…')
  try {
    const result = await aiDesign(prompt, base, progress)
    currentDesign = result.design
    stopWorking()
    setModel(result.model)
    syncAi('Done')
    flash(`${base ? 'Updated' : 'Designed'}: ${result.design.summary}`, 5000)
    try {
      const meta = await saveDesign({ title: result.design.title, summary: result.design.summary, prompt, code: result.design.code })
      currentSavedId = meta.id
      await refreshSaved()
    } catch (err) {
      console.warn('Could not save design', err)
    }
  } catch (err) {
    stopWorking()
    const msg = (err as Error)?.message ?? String(err)
    console.error(err)
    syncAi(msg, true)
    flash(`AI: ${msg}`, 9000)
  } finally {
    ui.setBusy(null)
  }
}

// ── My designs ───────────────────────────────────────────────────────
async function refreshSaved() {
  ui.setSavedDesigns(await listDesigns(), currentSavedId)
}

async function openSaved(id: string) {
  if (working) return
  const d = await getDesign(id)
  if (!d) {
    flash('That design is no longer on this phone.')
    return refreshSaved()
  }
  startWorking('Opening…')
  ui.setBusy(`Opening ${d.title}…`)
  try {
    const result = await designFromCode(d.code, d.summary, d.prompt, d.title, msg => flash(msg, 0))
    currentDesign = result.design
    currentSavedId = id
    stopWorking()
    setModel(result.model)
    await refreshSaved()
  } catch (err) {
    stopWorking()
    flash(`Could not open: ${(err as Error)?.message ?? err}`, 8000)
  } finally {
    ui.setBusy(null)
  }
}

async function removeSaved(id: string) {
  await deleteDesign(id)
  if (currentSavedId === id) currentSavedId = null
  await refreshSaved()
}

async function exportModel(kind: 'stl' | 'scad') {
  const hasScad = Boolean(model.source)
  ui.setDownloadLink(null)
  try {
    const blob = kind === 'stl' ? await stlBlob(model, state.explode) : scadBlob(model.source ?? '')
    const name = fileNameFor(model, kind)
    // Inside the Even app, files can't be saved directly: use a temporary
    // download link from the user's Worker when it's set up.
    if (aiConfigured()) {
      try {
        ui.setExportState(hasScad, 'Preparing download link…')
        const { url, minutes } = await downloadLink(blob, name)
        ui.setDownloadLink(url, minutes)
        ui.setExportState(hasScad, '')
        return
      } catch (err) {
        if (!(err instanceof DownloadsNotSetUp)) throw err
        // Worker without download storage: fall back to the browser's own save.
      }
    }
    const how = await deliverFile(blob, name)
    ui.setExportState(hasScad, how === 'shared' ? 'Shared' : 'Downloaded (in the Even app, set up download links: see SETUP-AI.md)')
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return // share sheet cancelled
    ui.setExportState(hasScad, `Couldn't save: ${(err as Error)?.message ?? err}`)
  }
}

// ── Loading models ───────────────────────────────────────────────────
async function fetchBytes(url: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`)
  return res.arrayBuffer()
}

async function openModel(read: () => Promise<ArrayBuffer>, name: string) {
  ui.setBusy(`Loading ${name}…`)
  flash(`Loading ${name}…`, 0)
  try {
    const data = await read()
    // Let the busy overlay paint before the (possibly heavy) parse.
    await new Promise(r => setTimeout(r, 30))
    setModel(await loadModel(data, name))
    flash(`Loaded ${model.format} · ${model.parts.length} part${model.parts.length === 1 ? '' : 's'}`, 3000)
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    console.error(err)
    ui.setError(msg)
    flash(`Error: ${msg}`, 9000)
  } finally {
    ui.setBusy(null)
  }
}

function setModel(m: LoadedModel) {
  model = m
  viewer.setModel(m)
  const keep = { layout: state.layout, mode: state.mode }
  state = { ...initialState(m.flat), ...keep }
  ui.setModelInfo(m)
  ui.setExportState(Boolean(m.source), '')
  ui.setDownloadLink(null)
  if (!m.source) {
    currentDesign = null
    currentSavedId = null
  }
  syncAi()
  void refreshSaved()
  refresh()
}

// ── Commands (touchpad, voice, phone buttons all land here) ──────────
// Routine changes show up in the info column, so only notices are flashed.
const NOTICE_KINDS = new Set<Command['kind']>(['isolate', 'spin', 'reset', 'fit', 'layout', 'style'])

function run(cmd: Command) {
  const res = applyCommand(state, cmd, model.parts.map(p => p.name), model.flat)
  if (res.relayout) void display?.setLayout(state.layout)
  if (NOTICE_KINDS.has(cmd.kind) || /^(Only|Pick)/.test(res.message)) flash(res.message, 2500)
  refresh()
}

type SpokenResult = 'design' | 'commands' | 'answered' | 'none'

function runSpoken(text: string, source: 'voice' | 'typed'): SpokenResult {
  // While a spoken design waits for confirmation, "yes" / "no" answer it.
  if (pendingDesign && source === 'voice') {
    const t = text.toLowerCase().replace(/[^a-z\s]/g, ' ').trim()
    if (/^(yes|yeah|yep|go|go ahead|do it|confirm|ok|okay|send it|sure)\b/.test(t)) {
      confirmPending()
      return 'answered'
    }
    if (/^(no|nope|cancel|stop|never ?mind|forget it)\b/.test(t)) {
      cancelPending()
      return 'answered'
    }
  }
  const intent = aiIntentOf(text, Boolean(model.source))
  if (intent) {
    // Speech can be misheard or cut off: confirm before spending an AI request.
    // Typed requests are deliberate, so they run straight away.
    if (source === 'voice') askToConfirm(intent.prompt, intent.kind)
    else void runDesign(intent.prompt, intent.kind)
    return 'design'
  }
  const cmds = parseVoice(text)
  if (!cmds.length) return 'none'
  if (source === 'voice') state.spinning = false // any spoken command stops the turntable
  for (const c of cmds) run(c)
  return 'commands'
}

/** One complete utterance (a whole push-to-talk hold, a final segment, or typed text). */
function handleUtterance(text: string, source: 'voice' | 'typed') {
  const result = runSpoken(text, source)
  if (result === 'commands') {
    if (cardKind === 'talk') closeCard()
    flash(`"${text}"`, 2000)
  } else if (result === 'none') {
    if (source === 'typed') flash(`? "${text}"`, 3000)
    else noteCard(`Didn't understand:\n"${text}"\n\nTry "rotate left", "top view" or "design a …"`, 3500)
  } else if (result === 'answered' && cardKind === 'talk') {
    closeCard()
  }
}

// ── Confirming spoken designs ────────────────────────────────────────
interface PendingDesign {
  prompt: string
  kind: 'new' | 'modify'
  timer: number
}
let pendingDesign: PendingDesign | null = null
const CONFIRM_TIMEOUT_MS = 20_000

function askToConfirm(prompt: string, kind: 'new' | 'modify') {
  clearPending()
  pendingDesign = { prompt, kind, timer: window.setTimeout(() => cancelPending('Design cancelled (no answer)'), CONFIRM_TIMEOUT_MS) }
  ui.setAiPrompt(prompt)
  syncAi(`Confirm on glasses: tap = yes, swipe = no (or press ${kind === 'modify' ? 'Modify current' : 'Design new'})`)
  openCard('confirm', `${kind === 'modify' ? 'Change the design?' : 'Design this?'}\n\n"${prompt}"\n\nTap = Yes        Swipe = No`)
}

function clearPending() {
  if (!pendingDesign) return
  clearTimeout(pendingDesign.timer)
  pendingDesign = null
}

function confirmPending() {
  if (!pendingDesign) return
  const { prompt, kind } = pendingDesign
  clearPending()
  closeCard()
  void runDesign(prompt, kind)
}

function cancelPending(msg = 'Design cancelled') {
  if (!pendingDesign) return
  clearPending()
  closeCard()
  syncAi(msg)
  flash(msg, 2500)
}

// ── Rendering ────────────────────────────────────────────────────────
function refresh() {
  ui.syncState(state)
  updateText()
  if (display) display.requestFrame()
  else drawMirror(true) // no glasses: still update the phone mirror
}

function updateText() {
  display?.setText(glassesText())
  drawMirror()
}

/** Phone mirror of the glasses. `rerender` draws a fresh frame; otherwise reuse the last one. */
function drawMirror(rerender = false) {
  const L = LAYOUTS[state.layout]
  const frame = working ? viewer.renderBusy(L.w, L.h, performance.now()) : rerender ? viewer.render(state, L.w, L.h) : viewer.canvas
  ui.drawMirror(state.layout, frame, glassesText(), cardText)
}

const tileCanvas = document.createElement('canvas')
tileCanvas.width = TILE_W
tileCanvas.height = TILE_H
const tileCtx = tileCanvas.getContext('2d', { willReadFrequently: true })!

// Compact encoding unless the user chose Standard, the WebView can't do it,
// or the Even app rejected a compact frame this session.
let compactRejected = false
const useCompact = () => getSettings().imageEncoding === 'compact' && compactSupported() && !compactRejected

async function renderTiles(layout: Layout): Promise<RenderedFrame> {
  const L = LAYOUTS[layout]
  const t0 = performance.now()
  const frame = working ? viewer.renderBusy(L.w, L.h, performance.now()) : viewer.render(state, L.w, L.h)
  ui.drawMirror(layout, frame, glassesText(), cardText)
  const t1 = performance.now()
  const compact = useCompact()
  const tiles: Uint8Array[] = []
  for (const t of L.tiles) {
    tileCtx.fillStyle = '#000'
    tileCtx.fillRect(0, 0, TILE_W, TILE_H)
    tileCtx.drawImage(frame, t.sx, t.sy, TILE_W, TILE_H, 0, 0, TILE_W, TILE_H)
    tiles.push(
      compact
        ? await encodeGray4Png(tileCtx.getImageData(0, 0, TILE_W, TILE_H).data, TILE_W, TILE_H)
        : await encodeCanvasPng(tileCanvas),
    )
  }
  return { tiles, renderMs: t1 - t0, encodeMs: performance.now() - t1 }
}

function showLinkStats(s: FrameStats) {
  const kb = (s.bytes / 1024).toFixed(1)
  const enc = useCompact() ? 'compact' : 'standard'
  const total = (s.renderMs + s.encodeMs + s.sendMs) / 1000
  ui.setLinkStats(
    `Last frame to glasses: ${total.toFixed(1)} s  ·  draw ${Math.round(s.renderMs)} ms  ·  encode ${Math.round(s.encodeMs)} ms  ·  send ${(s.sendMs / 1000).toFixed(1)} s  ·  ${kb} KB ${enc}${s.tiles > 1 ? ` (${s.tiles} tiles)` : ''}`,
  )
}

// ── Glasses text ─────────────────────────────────────────────────────
function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

const STYLE_SHORT = { hidden: 'Hid. line', shaded: 'Shaded', wire: 'Wireframe' } as const

function glassesText(): TextContent {
  const s = state
  const part = s.partIndex >= 0 ? model.parts[s.partIndex] : null
  const title = working ?? truncate(model.title, 22)
  const modeLine = `▶ ${MODE_LABEL[s.mode]}${micOn ? '  ● REC' : s.spinning ? '  (spin)' : ''}`
  const viewLine = `${STYLE_SHORT[s.style]} ${s.view ? s.view.toUpperCase() : ''}${s.explode ? ` · Exp ${Math.round(s.explode * 100)}%` : ''}`.trim()
  const partLine = part ? truncate(`Part: ${part.name}${s.isolate ? ' (isolated)' : ''}`, 60) : ''
  const msg = [message, partLine].filter(Boolean).join('\n')

  if (s.layout === 'wide') {
    return {
      info: `${title}    ${modeLine}\nYaw ${Math.round(s.yaw)}°  Pitch ${Math.round(s.pitch)}°  Zoom ${s.zoom.toFixed(1)}x  ${viewLine}`,
      msg,
    }
  }
  return {
    info: `${title}\n${modeLine}\nYaw ${Math.round(s.yaw)}°\nPitch ${Math.round(s.pitch)}°\nZoom ${s.zoom.toFixed(1)}x\n${viewLine}`,
    msg,
  }
}

// ── Voice ────────────────────────────────────────────────────────────
// Two mic modes (Settings):
//  • hold (default): push-to-talk. Long-press the touchpad → mic opens, a
//    speech session starts and a card shows the live transcript; release →
//    a short silence is sent so the service finalises the words, and the
//    whole hold is handled as ONE request once the transcript settles.
//  • always: one session, mic open the whole time; each finished sentence
//    is handled as it arrives.
// Spoken AI designs wait for a confirmation (tap = yes, swipe = no).
let stt: SttClient | null = null
let micOn = false
let consumed = 0 // always mode: chars of finalText already handled
let lastReleaseAt = 0

// Push-to-talk session state
let talkFinal = ''
let talkInterim = ''
let talkReleased = false
let settleTimer: number | null = null
const SETTLE_AFTER_RELEASE_MS = 1500
const SETTLE_AFTER_FINAL_MS = 700

const voiceConfigured = () => Boolean(getSettings().sttProvider)
const holdMode = () => getSettings().micMode !== 'always'

function closeSession() {
  stt?.close()
  stt = null
}

function stopVoice() {
  if (settleTimer !== null) clearTimeout(settleTimer)
  settleTimer = null
  closeSession()
  if (micOn && bridgeRef) void bridgeRef.audioControl(false)
  micOn = false
  ui.setMicButton(false, voiceConfigured())
}

/** Called once the glasses are connected, and again after Settings change. */
function startVoice(bridge: EvenAppBridge) {
  if (!voiceConfigured()) {
    ui.setChip('voice', 'idle', 'Voice off')
    ui.setMicButton(false, false)
    return
  }
  ui.setMicButton(false, true)
  if (holdMode()) ui.setChip('voice', 'idle', 'Hold touchpad to talk')
  else void startListening(bridge)
}

async function startListening(bridge: EvenAppBridge) {
  if (!stt && !openSession()) return
  await setMic(bridge, true)
}

function openSession(): boolean {
  const s = getSettings()
  consumed = 0
  try {
    stt = startSttStream(
      s.sttProvider,
      s.sttKey,
      ({ finalText, interimText }) => onTranscript(finalText, interimText),
      err => {
        ui.setChip('voice', 'error', truncate(`Voice: ${(err as Error)?.message ?? err}`, 40))
        console.error('STT error:', err)
      },
      { getElevenLabsToken: fetchSttToken },
    )
  } catch (err) {
    ui.setChip('voice', 'idle', 'Voice off')
    console.info((err as Error).message)
    stt = null
    return false
  }
  return true
}

function onTranscript(finalText: string, interimText: string) {
  ui.setTranscript(finalText, interimText)
  if (holdMode()) {
    if (finalText !== talkFinal && talkReleased) scheduleSettle(SETTLE_AFTER_FINAL_MS)
    talkFinal = finalText
    talkInterim = interimText.trim()
    if (cardKind === 'talk') openCard('talk', talkCardText())
    return
  }
  // Always-listening: handle each finished sentence as it arrives.
  if (finalText.length > consumed) {
    const fresh = finalText.slice(consumed).trim()
    consumed = finalText.length
    if (fresh) handleUtterance(fresh, 'voice')
  }
}

function talkCardText() {
  const heard = [talkFinal, talkInterim].filter(Boolean).join(' ')
  const head = micOn ? 'Listening…   (let go to send)' : 'Got it…'
  return `${head}\n\n${heard || '…'}`
}

async function setMic(bridge: EvenAppBridge, on: boolean) {
  micOn = on
  await bridge.audioControl(on)
  ui.setMicButton(on, true)
  ui.setChip('voice', on ? 'ok' : 'idle', on ? 'Listening' : holdMode() ? 'Hold touchpad to talk' : 'Mic paused')
  updateText()
}

/** Long press began (or phone Mic button pressed): open mic + talk card. */
async function beginTalk(bridge: EvenAppBridge) {
  if (!voiceConfigured()) {
    noteCard('Voice is off.\nChoose a speech provider in the phone Settings.', 3000)
    return
  }
  if (working) return
  clearPending()
  if (settleTimer !== null) clearTimeout(settleTimer)
  settleTimer = null
  closeSession() // a fresh session per hold, so the transcript starts empty
  talkFinal = ''
  talkInterim = ''
  talkReleased = false
  micOn = true // so the card says "Listening…" straight away
  openCard('talk', talkCardText())
  await startListening(bridge)
  if (!stt) {
    micOn = false
    noteCard('Voice could not start.\nCheck the speech settings on the phone.', 3000)
  }
}

/** Long press released: stop the mic, let the last words arrive, then handle the request. */
async function endTalk(bridge: EvenAppBridge) {
  if (!micOn) return
  talkReleased = true
  await setMic(bridge, false)
  stt?.flush()
  if (cardKind === 'talk') openCard('talk', talkCardText())
  scheduleSettle(SETTLE_AFTER_RELEASE_MS)
}

function scheduleSettle(ms: number) {
  if (settleTimer !== null) clearTimeout(settleTimer)
  settleTimer = window.setTimeout(settleTalk, ms)
}

function settleTalk() {
  settleTimer = null
  closeSession()
  const text = (talkFinal || talkInterim).trim()
  talkFinal = ''
  talkInterim = ''
  if (!text) {
    if (cardKind === 'talk') noteCard("Didn't hear anything.", 1800)
    return
  }
  handleUtterance(text, 'voice')
}

/** Phone Mic button: same as holding / releasing the touchpad (or toggles always-on mic). */
async function toggleMic() {
  if (!bridgeRef || !voiceConfigured()) return
  if (holdMode()) {
    if (micOn) await endTalk(bridgeRef)
    else await beginTalk(bridgeRef)
    return
  }
  if (micOn) await setMic(bridgeRef, false)
  else await startListening(bridgeRef)
}

// ── Glasses input ────────────────────────────────────────────────────
// Reads the event type out of one envelope. CLICK_EVENT is 0 and protobuf
// drops zero-value fields, so a tap arrives with eventType undefined — the
// default must be resolved inside the envelope check (see template notes).
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

// Touchpad gestures (G2 temples or R1 ring): press, double press, swipe
// up/down, and long press (start + release, SDK 0.0.16).
function handleInput(bridge: EvenAppBridge, sysType: OsEventTypeList | null, textType: OsEventTypeList | null) {
  const is = (t: OsEventTypeList) => sysType === t || textType === t

  // Root-level exit: always honoured, whatever is on screen.
  if (is(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    void bridge.shutDownPageContainer(1)
    return
  }
  // Push-to-talk: hold to open the mic, release to send.
  if (is(OsEventTypeList.LONG_PRESS_EVENT)) {
    if (holdMode()) void beginTalk(bridge)
    return
  }
  if (is(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) {
    lastReleaseAt = Date.now()
    if (holdMode()) void endTalk(bridge)
    return
  }
  const swipe = textType === OsEventTypeList.SCROLL_TOP_EVENT ? 1 : textType === OsEventTypeList.SCROLL_BOTTOM_EVENT ? -1 : 0
  if (swipe) {
    if (cardKind === 'confirm') return cancelPending()
    if (cardKind === 'intro' || cardKind === 'note') return closeCard()
    if (cardKind === 'talk' || working) return
    state.spinning = false
    run(swipeCommand(state.mode, swipe as 1 | -1, state))
    return
  }
  if (is(OsEventTypeList.CLICK_EVENT)) {
    // Some firmware may also report a tap when a long press ends; ignore it.
    if (Date.now() - lastReleaseAt < 700) return
    if (cardKind === 'confirm') return confirmPending()
    if (cardKind === 'intro' || cardKind === 'note') return closeCard()
    if (cardKind === 'talk' || working) return
    run({ kind: 'nextMode' })
  }
}

// ── Glasses bridge ───────────────────────────────────────────────────
async function connectGlasses() {
  ui.setChip('glasses', 'idle', 'Connecting…')
  const bridge = await waitForEvenAppBridge()
  bridgeRef = bridge
  // Dev only (stripped from production): fake glasses input from the browser
  // console, since the simulator can't send a long press.
  if (import.meta.env.DEV) {
    ;(window as unknown as Record<string, unknown>).g2debug = {
      press: (t: OsEventTypeList) => handleInput(bridge, t, null),
      swipe: () => handleInput(bridge, null, OsEventTypeList.SCROLL_TOP_EVENT),
      say: (text: string) => handleUtterance(text, 'voice'),
      // Simulate a released push-to-talk receiving transcript pieces.
      talk: (finalText: string, interimText = '') => {
        talkReleased = true
        if (cardKind !== 'talk') openCard('talk', talkCardText())
        onTranscript(finalText, interimText)
        if (settleTimer === null) scheduleSettle(SETTLE_AFTER_RELEASE_MS)
      },
      E: OsEventTypeList,
    }
  }

  // Per-user settings and saved designs live in the Even app's storage.
  setStorageBridge(bridge)
  ui.fillSettings(await attachBridgeStorage(bridge))
  syncAi()
  void refreshSaved()

  const d = new GlassesDisplay(bridge)
  d.renderTiles = renderTiles
  d.onError = msg => ui.setChip('glasses', 'warn', truncate(msg, 28))
  d.onFrameStats = showLinkStats
  d.onImageRejected = result => {
    // If the Even app can't take the compact format, fall back for this session.
    if (useCompact()) {
      compactRejected = true
      ui.setLinkStats(`Compact image was rejected (${result}); switched to Standard.`)
      d.requestFrame()
    }
  }
  d.onFrameSent = () => {
    if (working) {
      d.requestFrame() // keep the gyroscope turning
    } else if (state.spinning) {
      // Turntable: advance one step each time the previous frame has landed.
      state.yaw = ((state.yaw + 30 + 180) % 360) - 180
      state.view = null
      ui.syncState(state)
      updateText()
      d.requestFrame()
    }
  }
  const intro = getSettings().showIntro ? introText() : null
  const ok = await d.init(state.layout, glassesText(), intro)
  if (!ok) {
    // Happens in a plain browser (no Even app host) — the phone UI still works.
    ui.setChip('glasses', 'warn', 'No glasses (preview)')
    return
  }
  display = d
  if (intro) {
    cardKind = 'intro'
    cardText = intro
    drawMirror()
  }
  ui.setChip('glasses', 'ok', 'Glasses')
  d.requestFrame()

  const unsubscribe = bridge.onEvenHubEvent(event => {
    const pcm = event.audioEvent?.audioPcm
    if (pcm) {
      stt?.sendPcm(pcm)
      return
    }
    const sysType = eventTypeOf(event.sysEvent)
    const textType = eventTypeOf(event.textEvent)
    handleInput(bridge, sysType, textType)
    if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      d.requestFrame()
      return
    }
    if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      cleanup()
    }
  })

  let cleanedUp = false
  function cleanup() {
    if (cleanedUp) return
    cleanedUp = true
    if (micOn) void bridge.audioControl(false)
    closeSession()
    unsubscribe()
  }
  window.addEventListener('beforeunload', cleanup)

  // Glasses mic needs the startup page to exist first.
  startVoice(bridge)
}

// Dev conveniences: ?layout=single|wide|full  ?model=models/part.stp
const params = new URLSearchParams(location.search)
const startLayout = params.get('layout')
if (startLayout === 'single' || startLayout === 'wide' || startLayout === 'full') state.layout = startLayout
const startModel = params.get('model')
if (startModel) void openModel(() => fetchBytes(startModel), decodeURIComponent(startModel.split('/').pop() || 'model'))

// First paint on the phone mirror, then connect. Outside the Even app /
// simulator the bridge never appears — the phone UI still works as a preview.
refresh()
void refreshSaved()
const noBridge = setTimeout(() => ui.setChip('glasses', 'warn', 'No glasses (preview)'), 4000)
connectGlasses()
  .catch(err => {
    console.error(err)
    ui.setChip('glasses', 'error', 'Bridge error')
  })
  .finally(() => clearTimeout(noBridge))
