// Text-to-CAD: request → (Cloudflare Worker → Claude) → OpenSCAD code →
// (OpenSCAD-WASM on the phone) → STL per part → LoadedModel.
import * as THREE from 'three'
import { finalizeModel, shortTitle, type LoadedModel } from '../model/model'
import { getSettings } from '../settings'
import { OpenScadError, compileScad, partNames } from './openscad'

export const aiConfigured = () => {
  const s = getSettings()
  return Boolean(s.aiUrl && s.aiToken)
}

export interface Design {
  code: string
  summary: string
  prompt: string
  title: string
}

type Progress = (msg: string) => void

async function callWorker(body: { prompt: string; code?: string; error?: string }): Promise<{ code: string; summary: string; title?: string }> {
  if (!aiConfigured()) throw new Error('AI design is off — add your Worker URL and token in Settings')
  const { aiUrl, aiToken } = getSettings()
  const res = await fetch(`${aiUrl}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aiToken}` },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as { code?: string; summary?: string; title?: string; error?: string }
  if (!res.ok || !data.code) {
    throw new Error(data.error ?? `AI service error ${res.status} — check the Worker URL in Settings (${aiUrl})`)
  }
  return { code: data.code, summary: data.summary ?? body.prompt, title: data.title }
}

/** Single-use ElevenLabs realtime token, minted by the user's Worker. */
export async function fetchSttToken(): Promise<string> {
  const { aiUrl, aiToken } = getSettings()
  if (!aiUrl || !aiToken) throw new Error('ElevenLabs voice needs your Worker URL and token in Settings')
  const res = await fetch(`${aiUrl}/stt-token`, { method: 'POST', headers: { Authorization: `Bearer ${aiToken}` } })
  const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string }
  if (!res.ok || !data.token) throw new Error(data.error ?? `Voice token error ${res.status} — check the Worker URL in Settings`)
  return data.token
}

/** Compile every part (or the whole file) into one Z-up group. */
async function buildGeometry(code: string, progress: Progress): Promise<THREE.Group> {
  const { STLLoader } = await import('three/addons/loaders/STLLoader.js')
  const loader = new STLLoader()
  const group = new THREE.Group()
  const parts = partNames(code)
  const toMesh = (stl: string, name: string) => {
    const geom = loader.parse(stl)
    geom.computeVertexNormals()
    const mesh = new THREE.Mesh(geom)
    mesh.name = name
    return mesh
  }
  if (parts.length >= 2) {
    for (let i = 0; i < parts.length; i++) {
      progress(`Compiling part ${i + 1}/${parts.length}: ${parts[i]}`)
      try {
        group.add(toMesh(await compileScad(code, parts[i]), parts[i].replace(/_/g, ' ')))
      } catch (err) {
        // A part that renders nothing on its own (e.g. a pure cut-out) is skipped.
        if (!(err instanceof OpenScadError && /no geometry/.test(err.message))) throw err
      }
    }
    if (group.children.length) return group
  }
  progress('Compiling…')
  group.add(toMesh(await compileScad(code), 'Part'))
  return group
}

/**
 * Create a new design, or modify `current` when given. One automatic repair
 * round-trip if the generated code doesn't compile.
 */
export async function design(prompt: string, current: Design | null, progress: Progress): Promise<{ model: LoadedModel; design: Design }> {
  progress(current ? 'Asking Claude to modify the design…' : 'Asking Claude to design it…')
  let { code, summary, title } = await callWorker({ prompt, code: current?.code })

  let group: THREE.Group
  try {
    group = await buildGeometry(code, progress)
  } catch (err) {
    if (!(err instanceof OpenScadError)) throw err
    progress('Fixing a compile error…')
    const fixed = await callWorker({ prompt, code, error: err.log })
    code = fixed.code
    summary = fixed.summary || summary
    title = fixed.title || title
    group = await buildGeometry(code, progress)
  }

  return finish(group, code, summary, prompt, title)
}

function finish(group: THREE.Group, code: string, summary: string, prompt: string, title?: string) {
  const model = finalizeModel(group, { name: summary, title: title || shortTitle(summary), format: 'AI', zUp: true, notes: [`Prompt: ${prompt}`] })
  model.source = code
  return { model, design: { code, summary, prompt, title: model.title } }
}

/** Reopen a saved design: compile its code on the phone, no AI request. */
export async function designFromCode(code: string, summary: string, prompt: string, title: string, progress: Progress) {
  const group = await buildGeometry(code, progress)
  return finish(group, code, summary, prompt, title)
}

// ── Voice intent ─────────────────────────────────────────────────────
export type AiIntent = { kind: 'new' | 'modify'; prompt: string }

/** "design a …", "create …" → new; "make it …", "add …", "change …" → modify. */
export function aiIntentOf(text: string, hasAiModel: boolean): AiIntent | null {
  const t = text.trim().replace(/^(?:ok(?:ay)?|hey|please|can you|could you)\s*,?\s*/i, '')
  if (/^(?:design|create|generate|build|model|draw|make me|make a|make an)\b/i.test(t)) return { kind: 'new', prompt: t }
  if (/^(?:modify|change|make it|make the|add|remove|delete|update|edit|increase|decrease|widen|lengthen|shorten|thicken)\b/i.test(t)) {
    return hasAiModel ? { kind: 'modify', prompt: t } : { kind: 'new', prompt: t }
  }
  return null
}
