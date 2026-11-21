// "My designs": every AI design is saved on the phone (OpenSCAD source + its
// prompt), so it can be reopened later without another AI request — the phone
// simply recompiles the code. Also: export the current model as STL, or an AI
// design's .scad source.
import * as THREE from 'three'
import { applyExplode, type LoadedModel } from './model/model'
import { getSettings } from './settings'
import { getItem, setItem } from './storage'

export interface SavedDesignMeta {
  id: string
  title: string
  summary: string
  prompt: string
  savedAt: number
}
export interface SavedDesign extends SavedDesignMeta {
  code: string
}

const INDEX_KEY = 'g2cad.designs.v1'
const itemKey = (id: string) => `g2cad.design.${id}`
const MAX_DESIGNS = 40

export async function listDesigns(): Promise<SavedDesignMeta[]> {
  try {
    const list = JSON.parse((await getItem(INDEX_KEY)) || '[]')
    return Array.isArray(list) ? (list as SavedDesignMeta[]) : []
  } catch {
    return []
  }
}

export async function saveDesign(d: Omit<SavedDesign, 'id' | 'savedAt'>): Promise<SavedDesignMeta> {
  const meta: SavedDesignMeta = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: d.title,
    summary: d.summary,
    prompt: d.prompt,
    savedAt: Date.now(),
  }
  await setItem(itemKey(meta.id), d.code)
  const list = [meta, ...(await listDesigns())]
  for (const old of list.splice(MAX_DESIGNS)) await setItem(itemKey(old.id), '')
  await setItem(INDEX_KEY, JSON.stringify(list))
  return meta
}

export async function getDesign(id: string): Promise<SavedDesign | null> {
  const meta = (await listDesigns()).find(d => d.id === id)
  if (!meta) return null
  const code = await getItem(itemKey(id))
  return code ? { ...meta, code } : null
}

export async function deleteDesign(id: string): Promise<void> {
  await setItem(itemKey(id), '')
  await setItem(INDEX_KEY, JSON.stringify((await listDesigns()).filter(d => d.id !== id)))
}

// ── Export ───────────────────────────────────────────────────────────
const safeName = (s: string) => s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'model'

/** Binary STL of the model, assembled (explode undone) and back in its original axes. */
export async function stlBlob(model: LoadedModel, currentExplode: number): Promise<Blob> {
  const { STLExporter } = await import('three/addons/exporters/STLExporter.js')
  if (currentExplode) applyExplode(model, 0)
  const wrapper = new THREE.Group()
  const parent = model.root.parent
  wrapper.add(model.root)
  // The viewer works Y-up; STL users (slicers, CAD) expect Z-up. This restores
  // Z-up CAD files exactly and stands Y-up formats (GLB/OBJ) upright too.
  wrapper.rotation.x = Math.PI / 2
  wrapper.updateMatrixWorld(true)
  // Export only meshes (feature/silhouette lines are display aids).
  const result = new STLExporter().parse(wrapper, { binary: true }) as DataView
  wrapper.remove(model.root)
  parent?.add(model.root)
  if (currentExplode) applyExplode(model, currentExplode)
  const bytes = new Uint8Array(result.byteLength)
  bytes.set(new Uint8Array(result.buffer, result.byteOffset, result.byteLength))
  return new Blob([bytes], { type: 'model/stl' })
}

export function scadBlob(code: string): Blob {
  return new Blob([code], { type: 'text/plain' })
}

export function fileNameFor(model: LoadedModel, ext: string) {
  return `${safeName(model.title)}.${ext}`
}

export class DownloadsNotSetUp extends Error {}

/**
 * Upload to the user's Worker and get a temporary download link (15 minutes;
 * Cloudflare deletes the file automatically). The Even app's WebView can't
 * save files itself, but the phone's normal browser can open this link.
 */
export async function downloadLink(blob: Blob, filename: string): Promise<{ url: string; minutes: number }> {
  const { aiUrl, aiToken } = getSettings()
  const res = await fetch(`${aiUrl}/export?name=${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${aiToken}`, 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  })
  const data = (await res.json().catch(() => ({}))) as { url?: string; expiresInMinutes?: number; error?: string }
  if (res.status === 501 || res.status === 404) throw new DownloadsNotSetUp(data.error ?? 'Downloads are not set up on your Worker.')
  if (!res.ok || !data.url) throw new Error(data.error ?? `Export failed (${res.status})`)
  return { url: data.url, minutes: data.expiresInMinutes ?? 15 }
}

/**
 * Hand a file to the phone: the share sheet when available (Save to Files,
 * Drive, email, …), otherwise a normal browser download.
 */
export async function deliverFile(blob: Blob, filename: string): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' })
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean }
  if (nav.canShare?.({ files: [file] }) && nav.share) {
    await nav.share({ files: [file], title: filename })
    return 'shared'
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 15_000)
  return 'downloaded'
}
