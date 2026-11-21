// DWG / DXF → three.js line geometry, one part per layer.
//
// Uses LibreDWG compiled to WASM (@mlightcad/libredwg-web, GPL-3.0). It's
// imported lazily so the ~10 MB module only loads when a drawing is opened.
//
// What renders: lines, arcs, circles, ellipses, (LW)polylines with bulges,
// splines, 3D faces, polyface meshes, solids/traces, and block references
// (INSERT, including dimension blocks) with nested transforms.
//
// What doesn't: 3DSOLID / REGION / BODY entities are ACIS solid-model blobs
// that LibreDWG can't tessellate. For true 3D solids, export STEP from your
// CAD tool — that path goes through OpenCascade and renders fully.
import * as THREE from 'three'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ent = any

const CURVE_SEGMENTS = 48
const MAX_DEPTH = 8

interface LayerAcc {
  lines: number[]
  tris: number[]
}

export async function loadDrawing(data: ArrayBuffer, isDxf: boolean): Promise<{ content: THREE.Group; notes: string[] }> {
  const { LibreDwg, Dwg_File_Type } = await import('@mlightcad/libredwg-web')
  const lib = await LibreDwg.create()
  const ptr = lib.dwg_read_data(data, isDxf ? Dwg_File_Type.DXF : Dwg_File_Type.DWG)
  if (ptr == null) throw new Error(`Could not read this ${isDxf ? 'DXF' : 'DWG'} file.`)
  const db: any = lib.convert(ptr)
  let meshNote: string | null = null
  let meshes: MeshEnt[] = []
  try {
    meshes = extractMeshes(lib, ptr, db)
  } catch (err) {
    console.warn('Polyface extraction failed', err)
    meshNote = 'Polyface meshes could not be read from this file.'
  }
  lib.dwg_free(ptr)

  const blocks = new Map<string, { base: THREE.Vector3; entities: Ent[] }>()
  const modelSpaceHandles = new Set<string>()
  const blockByHandle = new Map<string, Ent[]>()
  for (const b of db.tables?.BLOCK_RECORD?.entries ?? []) {
    const bp = b.basePoint ?? { x: 0, y: 0, z: 0 }
    const entities = b.entities ?? []
    blocks.set(String(b.name).toUpperCase(), { base: new THREE.Vector3(bp.x, bp.y, bp.z ?? 0), entities })
    blockByHandle.set(String(b.handle), entities)
    if (/^\*model_space$/i.test(b.name)) modelSpaceHandles.add(String(b.handle))
  }
  // LibreDWG's converter drops POLYLINE_PFACE / POLYLINE_MESH; put the ones we
  // extracted back where they belong (model space or their owning block).
  const topLevel: Ent[] = [...(db.entities ?? [])]
  for (const m of meshes) {
    if (modelSpaceHandles.has(m.owner) || !blockByHandle.has(m.owner)) topLevel.push(m)
    else blockByHandle.get(m.owner)!.push(m)
  }

  const layers = new Map<string, LayerAcc>()
  const skipped = new Map<string, number>()
  const acc = (layer: string) => {
    let a = layers.get(layer)
    if (!a) layers.set(layer, (a = { lines: [], tris: [] }))
    return a
  }

  const v = new THREE.Vector3()
  const pushPt = (out: number[], m: THREE.Matrix4, x: number, y: number, z: number) => {
    v.set(x, y, z).applyMatrix4(m)
    out.push(v.x, v.y, v.z)
  }
  const seg = (a: LayerAcc, m: THREE.Matrix4, p: P3, q: P3) => {
    pushPt(a.lines, m, p.x, p.y, p.z ?? 0)
    pushPt(a.lines, m, q.x, q.y, q.z ?? 0)
  }
  const polyline = (a: LayerAcc, m: THREE.Matrix4, pts: P3[], closed: boolean) => {
    for (let i = 0; i + 1 < pts.length; i++) seg(a, m, pts[i], pts[i + 1])
    if (closed && pts.length > 2) seg(a, m, pts[pts.length - 1], pts[0])
  }
  const tri = (a: LayerAcc, m: THREE.Matrix4, p: P3, q: P3, r: P3) => {
    pushPt(a.tris, m, p.x, p.y, p.z ?? 0)
    pushPt(a.tris, m, q.x, q.y, q.z ?? 0)
    pushPt(a.tris, m, r.x, r.y, r.z ?? 0)
  }

  const visit = (e: Ent, m: THREE.Matrix4, parentLayer: string | null, depth: number) => {
    if (!e || e.isVisible === false || e.isInPaperSpace) return
    let layer: string = e.layer ?? '0'
    if (layer === '0' && parentLayer) layer = parentLayer
    const a = () => acc(layer)

    switch (e.type) {
      case 'LINE':
        seg(a(), m, e.startPoint, e.endPoint)
        break
      case 'CIRCLE':
        polyline(a(), m, arcPoints(e.center, e.radius, 0, Math.PI * 2), true)
        break
      case 'ARC':
        polyline(a(), m, arcPoints(e.center, e.radius, e.startAngle, e.endAngle), false)
        break
      case 'ELLIPSE':
        polyline(a(), m, ellipsePoints(e), false)
        break
      case 'LWPOLYLINE': {
        const z = e.elevation ?? 0
        const pts = (e.vertices ?? []).map((p: Ent) => ({ x: p.x, y: p.y, z, bulge: p.bulge ?? 0 }))
        polyline(a(), m, expandBulges(pts, (e.flag & 1) === 1), false)
        break
      }
      case 'POLYLINE2D':
      case 'POLYLINE3D': {
        const verts: Ent[] = e.vertices ?? []
        if (e.flag & 64) {
          polyface(a(), m, verts)
        } else {
          const closed = (e.flag & 1) === 1
          const pts = verts.map(p => ({ x: p.x, y: p.y, z: p.z ?? e.elevation ?? 0, bulge: p.bulge ?? 0 }))
          polyline(a(), m, e.type === 'POLYLINE2D' ? expandBulges(pts, closed) : pts, e.type !== 'POLYLINE2D' && closed)
        }
        break
      }
      case 'PFACE_MESH':
        meshFaces(a(), m, e as MeshEnt)
        break
      case 'SPLINE':
        polyline(a(), m, splinePoints(e), (e.flag & 1) === 1)
        break
      case '3DFACE': {
        const c = [e.corner1, e.corner2, e.corner3, e.corner4 ?? e.corner3]
        tri(a(), m, c[0], c[1], c[2])
        if (!same(c[2], c[3])) tri(a(), m, c[0], c[2], c[3])
        polyline(a(), m, same(c[2], c[3]) ? c.slice(0, 3) : c, true)
        break
      }
      case 'SOLID':
      case 'TRACE': {
        // DXF SOLID corner order is zig-zag: 1-2-4-3 is the outline.
        const c = [e.corner1, e.corner2, e.corner4 ?? e.corner3, e.corner3]
        polyline(a(), m, c, true)
        break
      }
      case 'INSERT':
      case 'DIMENSION': {
        if (depth >= MAX_DEPTH) break
        const name = String(e.name ?? '').toUpperCase()
        const block = blocks.get(name)
        if (!block) break
        if (e.type === 'DIMENSION') {
          // Dimension geometry is pre-baked into an anonymous block in WCS.
          for (const child of block.entities) visit(child, m, layer, depth + 1)
          break
        }
        const cols = Math.max(1, e.columnCount ?? 1)
        const rows = Math.max(1, e.rowCount ?? 1)
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const ip = e.insertionPoint ?? { x: 0, y: 0, z: 0 }
            const local = new THREE.Matrix4()
              .makeTranslation(ip.x, ip.y, ip.z ?? 0)
              .multiply(new THREE.Matrix4().makeRotationZ(e.rotation ?? 0))
              .multiply(new THREE.Matrix4().makeTranslation(c * (e.columnSpacing ?? 0), r * (e.rowSpacing ?? 0), 0))
              .multiply(new THREE.Matrix4().makeScale(e.xScale || 1, e.yScale || 1, e.zScale || 1))
              .multiply(new THREE.Matrix4().makeTranslation(-block.base.x, -block.base.y, -block.base.z))
            const child = m.clone().multiply(local)
            for (const ce of block.entities) visit(ce, child, layer, depth + 1)
          }
        }
        break
      }
      case 'TEXT':
      case 'MTEXT':
      case 'ATTRIB':
      case 'ATTDEF':
      case 'POINT':
      case 'HATCH':
      case 'VIEWPORT':
        break // intentionally not drawn — clutter at 288×144
      default:
        skipped.set(e.type, (skipped.get(e.type) ?? 0) + 1)
    }
  }

  const identity = new THREE.Matrix4()
  for (const e of topLevel) visit(e, identity, null, 0)

  const content = new THREE.Group()
  content.name = 'drawing'
  for (const [name, a] of [...layers.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    if (!a.lines.length && !a.tris.length) continue
    const g = new THREE.Group()
    g.name = name
    if (a.tris.length) {
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.Float32BufferAttribute(a.tris, 3))
      geom.computeVertexNormals()
      const mesh = new THREE.Mesh(geom)
      mesh.userData.noEdges = true // the outline is already in the line set
      g.add(mesh)
    }
    if (a.lines.length) {
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.Float32BufferAttribute(a.lines, 3))
      g.add(new THREE.LineSegments(geom))
    }
    content.add(g)
  }

  const notes: string[] = meshNote ? [meshNote] : []
  const acis = (skipped.get('3DSOLID') ?? 0) + (skipped.get('REGION') ?? 0) + (skipped.get('BODY') ?? 0)
  if (acis) notes.push(`${acis} ACIS solid(s) can't be read from DWG — export STEP for full 3D.`)
  const other = [...skipped.entries()].filter(([t]) => !['3DSOLID', 'REGION', 'BODY'].includes(t))
  if (other.length) notes.push(`Skipped: ${other.map(([t, n]) => `${t}×${n}`).join(', ')}`)
  return { content, notes }
}

interface P3 {
  x: number
  y: number
  z?: number
}

function same(p: P3, q: P3) {
  return Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.y - q.y) < 1e-9 && Math.abs((p.z ?? 0) - (q.z ?? 0)) < 1e-9
}

function arcPoints(c: P3, r: number, start: number, end: number): P3[] {
  let sweep = end - start
  if (sweep <= 0) sweep += Math.PI * 2
  const n = Math.max(4, Math.ceil((CURVE_SEGMENTS * sweep) / (Math.PI * 2)))
  const pts: P3[] = []
  for (let i = 0; i <= n; i++) {
    const t = start + (sweep * i) / n
    pts.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t), z: c.z ?? 0 })
  }
  return pts
}

function ellipsePoints(e: Ent): P3[] {
  const c = e.center
  const maj = e.majorAxisEndPoint
  const ratio = e.axisRatio ?? 1
  const minor = { x: -maj.y * ratio, y: maj.x * ratio } // normal assumed +Z
  let start = e.startAngle ?? 0
  let end = e.endAngle ?? Math.PI * 2
  let sweep = end - start
  if (sweep <= 0) sweep += Math.PI * 2
  const n = Math.max(8, Math.ceil((CURVE_SEGMENTS * sweep) / (Math.PI * 2)))
  const pts: P3[] = []
  for (let i = 0; i <= n; i++) {
    const t = start + (sweep * i) / n
    pts.push({
      x: c.x + maj.x * Math.cos(t) + minor.x * Math.sin(t),
      y: c.y + maj.y * Math.cos(t) + minor.y * Math.sin(t),
      z: c.z ?? 0,
    })
  }
  return pts
}

// Polyline vertices with bulge factors → straight segments + arc samples.
function expandBulges(verts: Array<P3 & { bulge: number }>, closed: boolean): P3[] {
  const out: P3[] = []
  const n = verts.length
  const count = closed ? n : n - 1
  for (let i = 0; i < count; i++) {
    const p = verts[i]
    const q = verts[(i + 1) % n]
    out.push(p)
    if (!p.bulge) continue
    const theta = 4 * Math.atan(p.bulge)
    const dx = q.x - p.x
    const dy = q.y - p.y
    const chord = Math.hypot(dx, dy)
    if (chord < 1e-12) continue
    const r = chord / (2 * Math.sin(theta / 2))
    const mx = (p.x + q.x) / 2
    const my = (p.y + q.y) / 2
    const h = r * Math.cos(theta / 2) // signed distance midpoint → centre
    const cx = mx - (h * dy) / chord
    const cy = my + (h * dx) / chord
    const a0 = Math.atan2(p.y - cy, p.x - cx)
    const steps = Math.max(2, Math.ceil((Math.abs(theta) / (Math.PI * 2)) * CURVE_SEGMENTS))
    for (let s = 1; s < steps; s++) {
      const t = a0 + (theta * s) / steps
      out.push({ x: cx + Math.abs(r) * Math.cos(t), y: cy + Math.abs(r) * Math.sin(t), z: p.z })
    }
  }
  if (n) out.push(closed ? verts[0] : verts[n - 1])
  return out
}

function splinePoints(e: Ent): P3[] {
  const cps: P3[] = e.controlPoints ?? []
  const knots: number[] = e.knots ?? []
  const degree: number = e.degree ?? 3
  if (cps.length > degree && knots.length === cps.length + degree + 1) {
    const w: number[] = e.weights ?? []
    const out: P3[] = []
    const lo = knots[degree]
    const hi = knots[knots.length - degree - 1]
    const n = Math.max(16, cps.length * 8)
    for (let i = 0; i <= n; i++) out.push(deBoor(degree, knots, cps, w, lo + ((hi - lo) * i) / n))
    return out
  }
  return (e.fitPoints?.length ? e.fitPoints : cps) as P3[]
}

// Rational de Boor evaluation of a NURBS curve at parameter u.
function deBoor(p: number, U: number[], P: P3[], W: number[], u: number): P3 {
  let k = p
  while (k < P.length - 1 && u >= U[k + 1]) k++
  const d = []
  for (let j = 0; j <= p; j++) {
    const cp = P[j + k - p]
    const w = W[j + k - p] ?? 1
    d.push([cp.x * w, cp.y * w, (cp.z ?? 0) * w, w])
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = j + k - p
      const denom = U[i + p - r + 1] - U[i]
      const alpha = denom === 0 ? 0 : (u - U[i]) / denom
      for (let c = 0; c < 4; c++) d[j][c] = (1 - alpha) * d[j - 1][c] + alpha * d[j][c]
    }
  }
  const [x, y, z, w] = d[p]
  return { x: x / w, y: y / w, z: z / w }
}

// ── POLYLINE_PFACE / POLYLINE_MESH ───────────────────────────────────
// Common in 3D DWGs exported from Revit, SketchUp, Civil 3D, etc. Read
// straight from the raw LibreDWG object list: walk each polyline's owned
// VERTEX sub-entities.
interface MeshEnt {
  type: 'PFACE_MESH'
  layer: string
  owner: string
  points: P3[]
  /** 1-based vertex indices; negative = invisible edge. */
  faces: number[][]
}

const T_VERTEX_MESH = 12
const T_VERTEX_PFACE = 13
const T_VERTEX_PFACE_FACE = 14
const T_POLYLINE_PFACE = 29
const T_POLYLINE_MESH = 30

const hex = (v: unknown) => (typeof v === 'bigint' || typeof v === 'number' ? v.toString(16).toUpperCase() : '')

function extractMeshes(lib: any, data: number, db: any): MeshEnt[] {
  const layerByHandle = new Map<string, string>()
  for (const l of db.tables?.LAYER?.entries ?? []) layerByHandle.set(String(l.handle), l.name)
  const out: MeshEnt[] = []
  const n: number = lib.dwg_get_num_objects(data)
  for (let i = 0; i < n; i++) {
    const obj = lib.dwg_get_object(data, i)
    const type = lib.dwg_object_get_fixedtype(obj)
    if (type !== T_POLYLINE_PFACE && type !== T_POLYLINE_MESH) continue
    const ent = lib.dwg_object_to_entity(obj)
    const tio = lib.dwg_object_to_entity_tio(obj)
    if (!ent || !tio) continue
    if (lib.dwg_object_entity_get_invisible?.(ent)) continue
    const owner = hex(lib.dwg_object_entity_get_ownerhandle_object(ent)?.absolute_ref)
    const layerRef = lib.dwg_object_entity_get_layer_object_ref(ent)
    const layer = layerByHandle.get(hex(layerRef?.handleref?.value)) ?? '0'

    const points: P3[] = []
    const faces: number[][] = []
    let v = lib.get_first_owned_subentity(obj)
    let guard = 0
    while (v && guard++ < 2_000_000) {
      const vt = lib.dwg_object_get_fixedtype(v)
      const vtio = lib.dwg_object_to_entity_tio(v)
      if (vtio && (vt === T_VERTEX_PFACE || vt === T_VERTEX_MESH)) {
        const p = lib.dwg_dynapi_entity_data(vtio, 'point')
        if (p) points.push({ x: p.x, y: p.y, z: p.z ?? 0 })
      } else if (vtio && vt === T_VERTEX_PFACE_FACE) {
        // `vertind` is a fixed BS[4] array the JS binding doesn't marshal —
        // read the four int16s straight out of WASM memory.
        const at = vtio + lib.dwg_dynapi_entity_field_offset(vtio, 'vertind')
        const view = new DataView(lib.HEAPU8.buffer)
        const face = [0, 1, 2, 3].map(j => view.getInt16(at + j * 2, true)).filter(k => k)
        if (face.length >= 3) faces.push(face)
      }
      v = lib.get_next_owned_subentity(obj, v)
    }

    if (type === T_POLYLINE_MESH) {
      // M×N grid of vertices → quads. Flag bit 1 closes M, bit 32 closes N.
      const M = lib.dwg_dynapi_entity_data(tio, 'num_m_verts') ?? 0
      const N = lib.dwg_dynapi_entity_data(tio, 'num_n_verts') ?? 0
      const flag = lib.dwg_dynapi_entity_data(tio, 'flag') ?? 0
      if (M * N !== points.length) continue
      const mEnd = flag & 1 ? M : M - 1
      const nEnd = flag & 32 ? N : N - 1
      for (let a = 0; a < mEnd; a++) {
        for (let b = 0; b < nEnd; b++) {
          const i0 = a * N + b
          const i1 = a * N + ((b + 1) % N)
          const i2 = ((a + 1) % M) * N + ((b + 1) % N)
          const i3 = ((a + 1) % M) * N + b
          faces.push([i0 + 1, i1 + 1, i2 + 1, i3 + 1])
        }
      }
    }
    if (points.length && faces.length) out.push({ type: 'PFACE_MESH', layer, owner, points, faces })
  }
  return out
}

function meshFaces(a: LayerAcc, m: THREE.Matrix4, e: MeshEnt) {
  const v = new THREE.Vector3()
  const push = (out: number[], p: P3) => {
    v.set(p.x, p.y, p.z ?? 0).applyMatrix4(m)
    out.push(v.x, v.y, v.z)
  }
  for (const face of e.faces) {
    const idx = face.map(i => Math.abs(i) - 1)
    if (idx.some(i => !e.points[i])) continue
    for (let t = 1; t + 1 < idx.length; t++) {
      push(a.tris, e.points[idx[0]])
      push(a.tris, e.points[idx[t]])
      push(a.tris, e.points[idx[t + 1]])
    }
    for (let s = 0; s < face.length; s++) {
      if (face[s] < 0) continue
      push(a.lines, e.points[idx[s]])
      push(a.lines, e.points[idx[(s + 1) % idx.length]])
    }
  }
}

// Polyface mesh: vertex records (flag 64|128) then face records (flag 128)
// whose 1-based indices point into the vertex list. Negative = hidden edge.
function polyface(a: LayerAcc, m: THREE.Matrix4, verts: Ent[]) {
  const pts: P3[] = []
  const faces: number[][] = []
  for (const vx of verts) {
    const f = vx.flag ?? 0
    if (f & 128 && !(f & 64)) {
      faces.push([vx.polyfaceIndex0, vx.polyfaceIndex1, vx.polyfaceIndex2, vx.polyfaceIndex3].filter(i => i))
    } else {
      pts.push(vx)
    }
  }
  const v = new THREE.Vector3()
  const push = (out: number[], p: P3) => {
    v.set(p.x, p.y, p.z ?? 0).applyMatrix4(m)
    out.push(v.x, v.y, v.z)
  }
  for (const face of faces) {
    const idx = face.map(i => Math.abs(i) - 1)
    if (idx.some(i => !pts[i])) continue
    for (let t = 1; t + 1 < idx.length; t++) {
      push(a.tris, pts[idx[0]])
      push(a.tris, pts[idx[t]])
      push(a.tris, pts[idx[t + 1]])
    }
    for (let s = 0; s < face.length; s++) {
      if (face[s] < 0) continue
      push(a.lines, pts[idx[s]])
      push(a.lines, pts[idx[(s + 1) % idx.length]])
    }
  }
}
