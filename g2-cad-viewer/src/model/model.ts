import * as THREE from 'three'

// A model normalised for viewing: Y-up, centred on the origin, split into
// "parts" the user can step through, isolate and explode.
export interface Part {
  name: string
  object: THREE.Object3D
  basePosition: THREE.Vector3
  /** Local-space offset applied per unit of explode factor. */
  explodeVector: THREE.Vector3
}

export interface LoadedModel {
  name: string
  /** Short display name for the glasses (3–5 words). */
  title: string
  /** Source data was Z-up (CAD convention); rotated to Y-up for viewing. */
  zUp: boolean
  format: string
  root: THREE.Group
  parts: Part[]
  radius: number
  /** True for 2D drawings (all geometry in one plane) → default to plan view. */
  flat: boolean
  stats: { triangles: number; segments: number; notes: string[] }
  /** OpenSCAD source for AI-generated designs (used for refinement). */
  source?: string
}

export interface FinalizeOptions {
  name: string
  title?: string
  format: string
  zUp: boolean
  notes?: string[]
}

export function finalizeModel(content: THREE.Object3D, opts: FinalizeOptions): LoadedModel {
  const root = new THREE.Group()
  root.name = opts.name

  // Measure flatness in the source frame, before any axis swap.
  content.updateMatrixWorld(true)
  const srcBox = new THREE.Box3().setFromObject(content)
  if (srcBox.isEmpty()) throw new Error('The file contains no displayable geometry.')
  const srcSize = srcBox.getSize(new THREE.Vector3())
  const maxDim = Math.max(srcSize.x, srcSize.y, srcSize.z)
  const flat = (opts.zUp ? srcSize.z : srcSize.y) <= maxDim * 1e-4

  if (opts.zUp) content.rotation.x = -Math.PI / 2
  root.add(content)
  root.updateMatrixWorld(true)

  const box = new THREE.Box3().setFromObject(root)
  const center = box.getCenter(new THREE.Vector3())
  content.position.sub(center)
  root.updateMatrixWorld(true)

  const sphere = new THREE.Box3().setFromObject(root).getBoundingSphere(new THREE.Sphere())
  const radius = Math.max(sphere.radius, 1e-6)

  const parts = collectParts(content).map(object => makePart(object))

  let triangles = 0
  let segments = 0
  root.traverse(o => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
    if (!g) return
    const count = g.index ? g.index.count : g.attributes.position?.count ?? 0
    if ((o as THREE.Mesh).isMesh) triangles += count / 3
    else if ((o as THREE.LineSegments).isLineSegments) segments += count / 2
  })

  return {
    name: opts.name,
    title: opts.title ?? shortTitle(opts.name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ')),
    zUp: opts.zUp,
    format: opts.format,
    root,
    parts,
    radius,
    flat,
    stats: { triangles: Math.round(triangles), segments: Math.round(segments), notes: opts.notes ?? [] },
  }
}

function hasGeometry(o: THREE.Object3D): boolean {
  let found = false
  o.traverse(c => {
    if ((c as THREE.Mesh).isMesh || (c as THREE.LineSegments).isLineSegments || (c as THREE.Line).isLine) found = true
  })
  return found
}

// Walk down through single-child wrappers until we reach a level with
// several geometry-bearing children — that level is the assembly's part list.
function collectParts(content: THREE.Object3D): THREE.Object3D[] {
  let node = content
  for (let depth = 0; depth < 8; depth++) {
    const kids = node.children.filter(hasGeometry)
    if (kids.length >= 2) return kids
    if (kids.length === 1 && kids[0].children.length > 0) {
      node = kids[0]
      continue
    }
    return kids.length ? kids : [node]
  }
  return [node]
}

function makePart(object: THREE.Object3D): Part {
  const worldCenter = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3())
  const parent = object.parent!
  // Direction from model centre (origin) to the part centre, in the parent's
  // local frame so we can offset `object.position` directly.
  const a = parent.worldToLocal(new THREE.Vector3(0, 0, 0))
  const b = parent.worldToLocal(worldCenter.clone())
  return {
    name: partName(object),
    object,
    basePosition: object.position.clone(),
    explodeVector: b.sub(a),
  }
}

function partName(o: THREE.Object3D): string {
  let n: THREE.Object3D | null = o
  while (n) {
    if (n.name) return n.name
    n = n.children.length === 1 ? n.children[0] : null
  }
  return 'Part'
}

export function applyExplode(model: LoadedModel, factor: number) {
  for (const p of model.parts) {
    p.object.position.copy(p.basePosition).addScaledVector(p.explodeVector, factor)
  }
  model.root.updateMatrixWorld(true)
}

/** First few meaningful words, e.g. "A 30mm spoked wheel pivot with hub" → "30mm spoked wheel pivot". */
export function shortTitle(text: string, maxWords = 4, maxChars = 22): string {
  const words = text
    .replace(/[."']/g, '')
    .split(/\s+/)
    .filter(Boolean)
  while (words.length > 1 && /^(a|an|the)$/i.test(words[0])) words.shift()
  let out = ''
  for (const w of words.slice(0, maxWords)) {
    const next = out ? `${out} ${w}` : w
    if (next.length > maxChars) break
    out = next
  }
  out = out || words[0]?.slice(0, maxChars) || 'Model'
  // Don't end on a dangling joining word ("bracket with").
  return out.replace(/\s+(with|and|of|for|on|in|to|at)$/i, '')
}
