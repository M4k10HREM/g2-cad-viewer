// Small key/value store: the Even app's storage when the glasses bridge is up
// (the only storage that reliably survives app restarts in the Even WebView),
// browser localStorage otherwise / as a mirror.
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

let bridge: EvenAppBridge | null = null

export function setStorageBridge(b: EvenAppBridge) {
  bridge = b
}

export async function getItem(key: string): Promise<string> {
  if (bridge) {
    try {
      const v = await bridge.getLocalStorage(key)
      if (v) return v
    } catch {
      /* fall through */
    }
  }
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

export async function setItem(key: string, value: string): Promise<void> {
  try {
    if (value) window.localStorage.setItem(key, value)
    else window.localStorage.removeItem(key)
  } catch {
    /* private mode etc. */
  }
  if (bridge) {
    try {
      await bridge.setLocalStorage(key, value)
    } catch (err) {
      console.warn('Even app storage write failed', err)
    }
  }
}
