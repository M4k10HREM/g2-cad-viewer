// Per-user settings: AI Worker URL + token, speech-to-text provider + key.
//
// Each person enters their OWN values in the phone UI. They are stored only
// on that phone (Even app storage via the bridge, falling back to browser
// localStorage in a plain browser) and are never part of the app package.
//
// For your own development you may still put values in .env.local — but they
// are used ONLY by the dev server (`npm run dev`). Production builds
// (`npm run build` / `npm run pack`) strip them out entirely, so a shared
// .ehpk can never carry your keys.
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

export interface Settings {
  aiUrl: string
  aiToken: string
  sttProvider: '' | 'deepgram' | 'elevenlabs'
  sttKey: string
  /** 'hold' = push-to-talk (hold the touchpad); 'always' = mic always open. */
  micMode: 'hold' | 'always'
  /** Show the controls card each time the app opens. */
  showIntro: boolean
  /** How frames are encoded for the glasses (see glasses/encode.ts). */
  imageEncoding: 'compact' | 'standard'
}

const KEY = 'g2cad.settings.v1'

const EMPTY: Settings = { aiUrl: '', aiToken: '', sttProvider: '', sttKey: '', micMode: 'hold', showIntro: true, imageEncoding: 'compact' }

/** Dev-server-only defaults from .env.local. Dead code in production builds. */
function devDefaults(): Partial<Settings> {
  if (!import.meta.env.DEV) return {}
  const p = import.meta.env.VITE_STT_PROVIDER
  const provider = p === 'deepgram' || p === 'elevenlabs' ? p : ''
  return {
    aiUrl: import.meta.env.VITE_AI_URL ?? '',
    aiToken: import.meta.env.VITE_AI_TOKEN ?? '',
    sttProvider: provider,
    sttKey: import.meta.env.VITE_STT_API_KEY ?? '',
  }
}

function clean(raw: Partial<Settings> | null | undefined): Partial<Settings> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Partial<Settings> = {}
  if (typeof raw.aiUrl === 'string') out.aiUrl = normalizeWorkerUrl(raw.aiUrl)
  if (typeof raw.aiToken === 'string') out.aiToken = raw.aiToken.trim()
  if (raw.sttProvider === 'deepgram' || raw.sttProvider === 'elevenlabs' || raw.sttProvider === '') out.sttProvider = raw.sttProvider
  if (typeof raw.sttKey === 'string') out.sttKey = raw.sttKey.trim()
  if (raw.micMode === 'hold' || raw.micMode === 'always') out.micMode = raw.micMode
  if (typeof raw.showIntro === 'boolean') out.showIntro = raw.showIntro
  if (raw.imageEncoding === 'compact' || raw.imageEncoding === 'standard') out.imageEncoding = raw.imageEncoding
  return out
}

/**
 * Forgiving Worker URL: adds https:// when missing (otherwise the request goes
 * to the app's own server and 404s), and drops a pasted /health, /generate
 * or /stt-token suffix and trailing slashes.
 */
export function normalizeWorkerUrl(input: string): string {
  let u = input.trim().replace(/\s+/g, '')
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = `https://${u.replace(/^\/+/, '')}`
  return u.replace(/\/+(health|generate|stt-token)\/*$/i, '').replace(/\/+$/, '')
}

const nonEmpty =(s: Partial<Settings>) =>
  Object.fromEntries(Object.entries(s).filter(([, v]) => v !== '')) as Partial<Settings>

let current: Settings = { ...EMPTY, ...nonEmpty(devDefaults()), ...readBrowser() }
let bridgeRef: EvenAppBridge | null = null

function readBrowser(): Partial<Settings> {
  try {
    return clean(JSON.parse(window.localStorage.getItem(KEY) ?? 'null'))
  } catch {
    return {}
  }
}

export function getSettings(): Settings {
  return { ...current }
}

/** Once the glasses bridge is up, prefer the Even app's persistent storage. */
export async function attachBridgeStorage(bridge: EvenAppBridge): Promise<Settings> {
  bridgeRef = bridge
  try {
    const raw = await bridge.getLocalStorage(KEY)
    if (raw) current = { ...current, ...clean(JSON.parse(raw)) }
  } catch {
    /* keep what we have */
  }
  return getSettings()
}

export async function saveSettings(next: Settings): Promise<Settings> {
  current = { ...EMPTY, ...clean(next) }
  const json = JSON.stringify(current)
  try {
    window.localStorage.setItem(KEY, json)
  } catch {
    /* private mode etc. */
  }
  if (bridgeRef) {
    try {
      await bridgeRef.setLocalStorage(KEY, json)
    } catch (err) {
      console.warn('Could not save settings to Even app storage', err)
    }
  }
  return getSettings()
}
