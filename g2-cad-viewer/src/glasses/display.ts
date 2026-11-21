// Glasses-side page management.
//
// Constraints that shape this file:
//   • Image containers are at most 288×144, max 4 per page. Bigger views are
//     tiled: "wide" = 2 tiles (576×144), "full" = 4 tiles (576×288).
//   • Each image push costs ~0.5–2 s over BLE, and bridge calls must be
//     serialised. So frames are "latest wins": while one frame is in flight,
//     newer requests collapse into a single follow-up render.
//   • Text updates are fast — the info column and message line give instant
//     feedback while the image catches up.
//   • Text containers have no background, so a "card" (controls help, talk
//     transcript, confirmation) is its own page: the page is rebuilt with one
//     bordered text box, then rebuilt back to the drawing afterwards.
import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { Layout } from '../controls/commands'

export const TILE_W = 288
export const TILE_H = 144

interface Tile {
  x: number
  y: number
  sx: number
  sy: number
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface LayoutSpec {
  w: number
  h: number
  tiles: Tile[]
  /** Info text (name, mode, telemetry). */
  info: Box | null
  /** Short-lived messages (errors, progress, "Loaded …"). */
  msg: Box | null
}

// single: info column on the left, drawing centred in the space to its right.
const SINGLE_X = 252
export const LAYOUTS: Record<Layout, LayoutSpec> = {
  single: {
    w: 288,
    h: 144,
    tiles: [{ x: SINGLE_X, y: 72, sx: 0, sy: 0 }],
    info: { x: 0, y: 4, w: 240, h: 170 },
    msg: { x: 0, y: 194, w: 576, h: 94 },
  },
  wide: {
    w: 576,
    h: 144,
    tiles: [
      { x: 0, y: 72, sx: 0, sy: 0 },
      { x: 288, y: 72, sx: 288, sy: 0 },
    ],
    info: { x: 0, y: 0, w: 576, h: 66 },
    msg: { x: 0, y: 222, w: 576, h: 66 },
  },
  full: {
    w: 576,
    h: 288,
    tiles: [
      { x: 0, y: 0, sx: 0, sy: 0 },
      { x: 288, y: 0, sx: 288, sy: 0 },
      { x: 0, y: 144, sx: 0, sy: 144 },
      { x: 288, y: 144, sx: 288, sy: 144 },
    ],
    info: null,
    msg: null,
  },
}

// Container ids / names (names ≤ 16 chars, unique per page).
const ID = { events: 1, info: 2, msg: 3, card: 4, tile0: 10 } as const
type TextSlot = 'info' | 'msg'

export interface RenderedFrame {
  tiles: Uint8Array[]
  renderMs: number
  encodeMs: number
}

export interface FrameStats {
  renderMs: number
  encodeMs: number
  sendMs: number
  bytes: number
  tiles: number
}

export interface TextContent {
  info: string
  msg: string
}

// Results that mean "this image can't be used" (vs. a transport failure like sendFailed).
const FORMAT_ERRORS = new Set(['imageException', 'imageSizeInvalid', 'imageToGray4Failed'])

const TIMEOUT_TEXT_MS = 4000
const TIMEOUT_IMAGE_MS = 12000

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms))])
}

const textBox = (b: Box, id: number, name: string, content: string, opts: Partial<{ border: number; pad: number }> = {}) =>
  new TextContainerProperty({
    xPosition: b.x, yPosition: b.y, width: b.w, height: b.h,
    borderWidth: opts.border ?? 0, borderColor: opts.border ? 10 : 0, paddingLength: opts.pad ?? 4,
    containerID: id, containerName: name, content: content || ' ', isEventCapture: 0,
  })

export class GlassesDisplay {
  private tail: Promise<unknown> = Promise.resolve()
  private layout: Layout = 'single'
  private created = false
  private text: TextContent = { info: '', msg: '' }
  private sentText: Partial<Record<TextSlot, string>> = {}
  private textQueued = false
  /** Non-null while a full-screen card is shown instead of the drawing. */
  private card: string | null = null
  private sentCard = ''
  private cardQueued = false

  private frameDirty = false
  private pumping = false
  /** Called before each frame; returns image bytes for every tile of the layout. */
  renderTiles: (layout: Layout) => Promise<RenderedFrame> = async () => ({ tiles: [], renderMs: 0, encodeMs: 0 })
  onFrameSent: () => void = () => {}
  /** Timing of each frame that reached the glasses (for the phone's link readout). */
  onFrameStats: (s: FrameStats) => void = () => {}
  /** A tile was rejected by the Even app because of its format. */
  onImageRejected: (result: string) => void = () => {}
  /** Frames reach the glasses again after one or more send failures. */
  onRecovered: () => void = () => {}
  private sendFailures = 0
  onError: (msg: string) => void = () => {}

  constructor(private bridge: EvenAppBridge) {}

  /** Serialise every bridge call — concurrent BLE calls can drop the link. */
  private enqueue<T>(label: string, fn: () => Promise<T>, ms: number): Promise<T | undefined> {
    const run = this.tail.then(() => withTimeout(fn(), ms, label))
    this.tail = run.catch(() => undefined)
    return run.catch(err => {
      console.warn(err)
      this.onError(String((err as Error)?.message ?? err))
      return undefined
    })
  }

  private eventLayer() {
    // Full-screen event-capture layer behind everything (images can't capture input).
    return new TextContainerProperty({
      xPosition: 0, yPosition: 0, width: 576, height: 288,
      borderWidth: 0, borderColor: 0, paddingLength: 0,
      containerID: ID.events, containerName: 'events', content: ' ', isEventCapture: 1,
    })
  }

  private buildPage() {
    const textObject: TextContainerProperty[] = [this.eventLayer()]
    this.sentText = {}
    if (this.card !== null) {
      this.sentCard = this.card || ' '
      textObject.push(textBox({ x: 24, y: 16, w: 528, h: 256 }, ID.card, 'card', this.sentCard, { border: 2, pad: 12 }))
      return { containerTotalNum: textObject.length, textObject, imageObject: [] as ImageContainerProperty[] }
    }
    const L = LAYOUTS[this.layout]
    if (L.info) {
      this.sentText.info = this.text.info || ' '
      textObject.push(textBox(L.info, ID.info, 'info', this.sentText.info))
    }
    if (L.msg) {
      this.sentText.msg = this.text.msg || ' '
      textObject.push(textBox(L.msg, ID.msg, 'msg', this.sentText.msg))
    }
    const imageObject = L.tiles.map(
      (t, i) =>
        new ImageContainerProperty({
          xPosition: t.x, yPosition: t.y, width: TILE_W, height: TILE_H,
          containerID: ID.tile0 + i, containerName: `tile${i}`,
        }),
    )
    return { containerTotalNum: textObject.length + imageObject.length, textObject, imageObject }
  }

  async init(layout: Layout, text: TextContent, card: string | null = null): Promise<boolean> {
    this.layout = layout
    this.text = { ...text }
    this.card = card
    const page = this.buildPage()
    const result = await this.enqueue('createStartUpPage', () => this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page)), 8000)
    this.created = result === 0
    if (!this.created) this.onError(`createStartUpPageContainer failed: ${String(result)}`)
    return this.created
  }

  private async rebuild() {
    const page = this.buildPage()
    await this.enqueue('rebuildPage', () => this.bridge.rebuildPageContainer(new RebuildPageContainer(page)), 8000)
  }

  async setLayout(layout: Layout) {
    if (layout === this.layout) return
    this.layout = layout
    if (this.card !== null) return // applied when the card closes
    await this.rebuild()
    this.requestFrame() // new image containers start empty
  }

  getLayout() {
    return this.layout
  }

  // ── Cards ──────────────────────────────────────────────────────────
  isCardOpen() {
    return this.card !== null
  }

  /** Show (or update) a full-screen card. Updating an open card is a fast text update. */
  showCard(content: string) {
    const wasOpen = this.card !== null
    this.card = content
    if (!wasOpen) {
      void this.rebuild()
      return
    }
    if (this.cardQueued) return
    this.cardQueued = true
    queueMicrotask(() => {
      this.cardQueued = false
      const c = this.card
      if (c === null || c === this.sentCard) return
      this.sentCard = c
      this.enqueue('text:card', () => this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID: ID.card, containerName: 'card', contentOffset: 0, contentLength: 0, content: c || ' ' }),
      ), TIMEOUT_TEXT_MS)
    })
  }

  /** Close the card and bring the drawing back. */
  async hideCard() {
    if (this.card === null) return
    this.card = null
    await this.rebuild()
    this.requestFrame()
  }

  getCard() {
    return this.card
  }

  // ── Text ───────────────────────────────────────────────────────────
  /** Update the info column / message line; coalesced and sent only if changed. */
  setText(patch: Partial<TextContent>) {
    Object.assign(this.text, patch)
    if (this.textQueued) return
    this.textQueued = true
    queueMicrotask(() => {
      this.textQueued = false
      if (this.card !== null) return // sent with the page when the card closes
      const L = LAYOUTS[this.layout]
      const slots: TextSlot[] = [...(L.info ? (['info'] as const) : []), ...(L.msg ? (['msg'] as const) : [])]
      for (const slot of slots) {
        const content = this.text[slot] || ' '
        if (this.sentText[slot] === content) continue
        this.sentText[slot] = content
        this.enqueue(`text:${slot}`, () => this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: ID[slot], containerName: slot, contentOffset: 0, contentLength: 0, content }),
        ), TIMEOUT_TEXT_MS)
      }
    })
  }

  getText(): TextContent {
    return { ...this.text }
  }

  // ── Frames ─────────────────────────────────────────────────────────
  /** Ask for a new frame. Multiple requests while busy collapse into one. */
  requestFrame() {
    this.frameDirty = true
    if (!this.pumping) void this.pump()
  }

  isBusy() {
    return this.pumping
  }

  private async pump() {
    this.pumping = true
    try {
      while (this.frameDirty && this.created) {
        this.frameDirty = false
        if (this.card !== null) break // no image containers while a card is up
        const layout = this.layout
        const frame = await this.renderTiles(layout)
        const tiles = frame.tiles
        let sendMs = 0
        let complete = true
        for (let i = 0; i < tiles.length; i++) {
          if (this.layout !== layout || this.card !== null) {
            complete = false
            break // page rebuilt mid-frame
          }
          const t0 = performance.now()
          const res = await this.enqueue(`image:tile${i}`, () => this.bridge.updateImageRawData(
            new ImageRawDataUpdate({ containerID: ID.tile0 + i, containerName: `tile${i}`, imageData: tiles[i] }),
          ), TIMEOUT_IMAGE_MS)
          sendMs += performance.now() - t0
          const result = res === undefined ? 'timeout' : String(res)
          if (result !== 'success') {
            complete = false
            if (FORMAT_ERRORS.has(result)) {
              // The Even app couldn't use this image format.
              this.onError(`Image: ${result}`)
              this.onImageRejected(result)
            } else {
              // Bluetooth hiccup (glasses asleep, out of range, taken off…):
              // retry quietly with a growing pause; the latest view is resent.
              this.sendFailures++
              this.onError(this.sendFailures >= 3 ? 'Glasses not reachable — retrying' : `Image: ${result}`)
              const wait = Math.min(1000 * 2 ** (this.sendFailures - 1), 15_000)
              setTimeout(() => this.requestFrame(), wait)
            }
            break
          }
        }
        if (complete && tiles.length) {
          if (this.sendFailures) {
            this.sendFailures = 0
            this.onRecovered()
          }
          this.onFrameStats({
            renderMs: frame.renderMs,
            encodeMs: frame.encodeMs,
            sendMs,
            bytes: tiles.reduce((n, t) => n + t.length, 0),
            tiles: tiles.length,
          })
        }
        if (!this.frameDirty) this.onFrameSent()
      }
    } finally {
      this.pumping = false
    }
  }
}
