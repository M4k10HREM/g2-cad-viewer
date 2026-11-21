// Off-screen three.js renderer tuned for the G2's 4-bit green display.
//
// The display is 16 shades on black, so the default style is a hidden-line
// drawing: bright feature edges over black-filled faces (which occlude the
// edges behind them). That reads far better at 288×144 than smooth shading.
// Orthographic camera — the usual choice for CAD, no perspective distortion.
import * as THREE from 'three'
import type { LoadedModel } from '../model/model'
import { applyExplode } from '../model/model'
import type { ViewState } from '../controls/commands'

const EDGE_ANGLE_DEG = 25
const MAX_EDGE_TRIANGLES = 600_000

const C_BRIGHT = 0xffffff
const C_DIM = 0x3a3a3a

export class Viewer {
  readonly canvas: HTMLCanvasElement
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10)
  private headlight = new THREE.DirectionalLight(0xffffff, 2.2)
  private model: LoadedModel | null = null
  private lastExplode = 0

  private mats = {
    line: new THREE.LineBasicMaterial({ color: C_BRIGHT }),
    lineDim: new THREE.LineBasicMaterial({ color: C_DIM }),
    lineNoDepth: new THREE.LineBasicMaterial({ color: C_BRIGHT, depthTest: false }),
    lineDimNoDepth: new THREE.LineBasicMaterial({ color: C_DIM, depthTest: false }),
    // Black fill that still writes depth → hides edges behind faces.
    occluder: new THREE.MeshBasicMaterial({ color: 0x000000, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide }),
    shaded: new THREE.MeshLambertMaterial({ color: 0x8c8c8c, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide }),
    shadedDim: new THREE.MeshLambertMaterial({ color: 0x2a2a2a, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide }),
    // Wireframe: faces draw nothing and occlude nothing, but stay "visible" so
    // their child edge lines still render.
    invisible: new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
  }

  constructor() {
    this.canvas = document.createElement('canvas')
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(1)
    this.renderer.setClearColor(0x000000, 1)
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x222222, 0.6))
    this.scene.add(this.camera)
    this.camera.add(this.headlight)
    this.headlight.position.set(0.4, 0.6, 1)
  }

  setModel(model: LoadedModel) {
    if (this.model) {
      this.scene.remove(this.model.root)
      disposeTree(this.model.root)
    }
    this.model = model
    this.lastExplode = 0
    prepareEdges(model.root)
    this.scene.add(model.root)
  }

  getModel() {
    return this.model
  }

  /** Render the full layout canvas (e.g. 288×144, 576×144, 576×288). */
  render(state: ViewState, width: number, height: number): HTMLCanvasElement {
    const m = this.model
    if (this.canvas.width !== width || this.canvas.height !== height) this.renderer.setSize(width, height, false)
    if (!m) {
      this.renderer.clear()
      return this.canvas
    }

    if (state.explode !== this.lastExplode) {
      applyExplode(m, state.explode)
      this.lastExplode = state.explode
    }
    this.applyStyle(state)

    // Camera basis from yaw/pitch (Y-up world).
    const yaw = THREE.MathUtils.degToRad(state.yaw)
    const pitch = THREE.MathUtils.degToRad(Math.max(-89.9, Math.min(89.9, state.pitch)))
    const dir = new THREE.Vector3(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw))
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw))
    const up = new THREE.Vector3().crossVectors(dir, right).normalize()

    // Fit tightly to the projected bounding box of what's in focus: the
    // isolated part, or the whole (possibly exploded) model.
    const isolated = state.isolate && state.partIndex >= 0 ? m.parts[state.partIndex]?.object : null
    const box = new THREE.Box3().setFromObject(isolated ?? m.root)
    const center = box.getCenter(new THREE.Vector3())
    const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-6)
    let halfW = 1e-6
    let halfH = 1e-6
    const p = new THREE.Vector3()
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center)
      halfW = Math.max(halfW, Math.abs(p.dot(right)))
      halfH = Math.max(halfH, Math.abs(p.dot(up)))
    }
    const aspect = width / height
    const target = center.clone().addScaledVector(right, -state.panX * r).addScaledVector(up, -state.panY * r)

    const cam = this.camera
    cam.position.copy(target).addScaledVector(dir, r * 4)
    cam.up.copy(up)
    cam.lookAt(target)
    halfH = (Math.max(halfH, halfW / aspect) * 1.08) / state.zoom
    cam.left = -halfH * aspect
    cam.right = halfH * aspect
    cam.top = halfH
    cam.bottom = -halfH
    cam.near = 0
    cam.far = r * 8
    cam.updateProjectionMatrix()

    // Curved surfaces have no sharp edges, so outline them from this view.
    m.root.updateMatrixWorld(true)
    updateSilhouettes(m.root, dir)

    this.renderer.render(this.scene, cam)
    return this.canvas
  }

  // ── "Working on it" gyroscope ──────────────────────────────────────
  private busy: { scene: THREE.Scene; cam: THREE.OrthographicCamera; rings: THREE.Object3D[] } | null = null

  /** Three nested gimbal rings spinning on different axes, drawn as crisp lines. */
  renderBusy(width: number, height: number, timeMs: number): HTMLCanvasElement {
    if (!this.busy) {
      const scene = new THREE.Scene()
      const mat = new THREE.LineBasicMaterial({ color: C_BRIGHT })
      const circle = (r: number) => {
        const pts = new THREE.EllipseCurve(0, 0, r, r, 0, Math.PI * 2).getPoints(96).map(p => new THREE.Vector3(p.x, p.y, 0))
        return new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), mat)
      }
      // Fixed frame: axle through the poles.
      const axle = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -1.35, 0), new THREE.Vector3(0, 1.35, 0)]),
        mat,
      )
      scene.add(axle)
      // Outer → middle → inner: each nested in the previous one, like a real gimbal.
      const outer = new THREE.Group()
      const middle = new THREE.Group()
      const inner = new THREE.Group()
      outer.add(circle(1.2), middle)
      middle.add(circle(0.9), inner)
      inner.add(circle(0.6))
      const hub = circle(0.08)
      inner.add(hub)
      scene.add(outer)
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10)
      cam.position.set(1.4, 0.8, 2)
      cam.lookAt(0, 0, 0)
      this.busy = { scene, cam, rings: [outer, middle, inner] }
    }
    const { scene, cam, rings } = this.busy
    const t = timeMs / 1000
    rings[0].rotation.y = t * 1.1
    rings[1].rotation.x = t * 1.7
    rings[2].rotation.y = t * 2.3
    rings[2].rotation.z = t * 0.6

    if (this.canvas.width !== width || this.canvas.height !== height) this.renderer.setSize(width, height, false)
    const aspect = width / height
    const half = 1.5
    cam.left = -half * aspect
    cam.right = half * aspect
    cam.top = half
    cam.bottom = -half
    cam.updateProjectionMatrix()
    this.renderer.render(scene, cam)
    return this.canvas
  }

  private applyStyle(state: ViewState) {
    const m = this.model!
    const selected = state.partIndex >= 0 ? m.parts[state.partIndex]?.object : null
    const selectedSet = new Set<THREE.Object3D>()
    selected?.traverse(o => selectedSet.add(o))

    for (const p of m.parts) p.object.visible = !(state.isolate && selected && p.object !== selected)

    const see = state.style === 'wire'
    m.root.traverse(o => {
      const dim = selected !== null && !selectedSet.has(o)
      if ((o as THREE.LineSegments).isLineSegments || (o as THREE.Line).isLine) {
        const line = o as THREE.Line
        line.material = see ? (dim ? this.mats.lineDimNoDepth : this.mats.lineNoDepth) : dim ? this.mats.lineDim : this.mats.line
      } else if ((o as THREE.Mesh).isMesh) {
        const mesh = o as THREE.Mesh
        mesh.material = see
          ? this.mats.invisible
          : state.style === 'shaded'
            ? dim
              ? this.mats.shadedDim
              : this.mats.shaded
            : this.mats.occluder
      }
    })
  }
}

// Adds line children to every mesh, so lines follow the part when it is
// exploded, highlighted or isolated:
//  • feature edges: sharp creases (> EDGE_ANGLE_DEG), fixed;
//  • silhouette: the outline of smooth curved surfaces (spheres, cylinder
//    sides, fillets), recomputed for each view in updateSilhouettes().
function prepareEdges(root: THREE.Object3D) {
  const meshes: THREE.Mesh[] = []
  root.traverse(o => {
    if ((o as THREE.Mesh).isMesh && !o.userData.edgesBuilt) meshes.push(o as THREE.Mesh)
  })
  let budget = MAX_EDGE_TRIANGLES
  for (const mesh of meshes) {
    const g = mesh.geometry as THREE.BufferGeometry
    const tris = (g.index ? g.index.count : g.attributes.position.count) / 3
    if (tris > budget) continue
    budget -= tris
    mesh.userData.edgesBuilt = true
    if (!mesh.userData.noEdges) mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, EDGE_ANGLE_DEG)))
    const sil = buildSilhouetteData(g)
    if (sil.count) {
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sil.count * 6), 3).setUsage(THREE.DynamicDrawUsage))
      geom.setDrawRange(0, 0)
      const line = new THREE.LineSegments(geom)
      line.frustumCulled = false
      line.userData.silhouette = sil
      mesh.add(line)
    }
  }
}

interface SilhouetteData {
  count: number
  /** Edge endpoints, 6 floats per edge (mesh-local). */
  pos: Float32Array
  /** The two adjacent face normals, 6 floats per edge (mesh-local). */
  nrm: Float32Array
}

// Smooth interior edges (shared by exactly two faces meeting at less than the
// crease angle) are the only candidates; sharp ones are already feature edges.
function buildSilhouetteData(g: THREE.BufferGeometry): SilhouetteData {
  const P = g.attributes.position
  const index = g.index
  const triCount = Math.floor((index ? index.count : P.count) / 3)
  const vi = (k: number) => (index ? index.getX(k) : k)

  // Weld duplicate vertices (STL/OBJ meshes repeat them per face).
  let span = 1e-9
  g.computeBoundingBox()
  const bb = g.boundingBox!
  span = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z, span)
  const q = 1e6 / span
  const ids = new Map<string, number>()
  const weld = new Int32Array(P.count)
  const pts: number[] = []
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i)
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`
    let id = ids.get(key)
    if (id === undefined) {
      id = pts.length / 3
      ids.set(key, id)
      pts.push(x, y, z)
    }
    weld[i] = id
  }
  const nV = pts.length / 3

  // Face normals.
  const fn = new Float32Array(triCount * 3)
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const tri: Int32Array = new Int32Array(triCount * 3)
  for (let t = 0; t < triCount; t++) {
    const i0 = weld[vi(3 * t)], i1 = weld[vi(3 * t + 1)], i2 = weld[vi(3 * t + 2)]
    tri[3 * t] = i0; tri[3 * t + 1] = i1; tri[3 * t + 2] = i2
    a.fromArray(pts, i0 * 3); b.fromArray(pts, i1 * 3); c.fromArray(pts, i2 * 3)
    const n = b.sub(a).cross(c.sub(a))
    const len = n.length()
    if (len > 0) n.divideScalar(len)
    fn[3 * t] = n.x; fn[3 * t + 1] = n.y; fn[3 * t + 2] = n.z
  }

  // Edge → faces.
  const first = new Map<number, number>()
  const second = new Map<number, number>()
  const many = new Set<number>()
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const u = tri[3 * t + e], v = tri[3 * t + ((e + 1) % 3)]
      if (u === v) continue
      const key = u < v ? u * nV + v : v * nV + u
      if (!first.has(key)) first.set(key, t)
      else if (!second.has(key)) second.set(key, t)
      else many.add(key)
    }
  }

  const cosCrease = Math.cos(THREE.MathUtils.degToRad(EDGE_ANGLE_DEG))
  const pos: number[] = []
  const nrm: number[] = []
  for (const [key, t2] of second) {
    if (many.has(key)) continue
    const t1 = first.get(key)!
    const d = fn[3 * t1] * fn[3 * t2] + fn[3 * t1 + 1] * fn[3 * t2 + 1] + fn[3 * t1 + 2] * fn[3 * t2 + 2]
    if (d < cosCrease) continue // sharp: already a feature edge
    const u = Math.floor(key / nV), v = key - u * nV
    pos.push(pts[3 * u], pts[3 * u + 1], pts[3 * u + 2], pts[3 * v], pts[3 * v + 1], pts[3 * v + 2])
    nrm.push(fn[3 * t1], fn[3 * t1 + 1], fn[3 * t1 + 2], fn[3 * t2], fn[3 * t2 + 1], fn[3 * t2 + 2])
  }
  return { count: pos.length / 6, pos: new Float32Array(pos), nrm: new Float32Array(nrm) }
}

// For an orthographic view every point sees the same direction, so an edge is
// on the silhouette when one adjacent face points toward the viewer and the
// other away.
const _inv = new THREE.Matrix4()
const _v = new THREE.Vector3()
function updateSilhouettes(root: THREE.Object3D, viewDir: THREE.Vector3) {
  root.traverse(o => {
    const sil = o.userData.silhouette as SilhouetteData | undefined
    if (!sil) return
    const line = o as THREE.LineSegments
    const mesh = line.parent!
    // Normals transform with the inverse-transpose; n_local · (M⁻¹ v) keeps the sign.
    _inv.copy(mesh.matrixWorld).invert()
    _v.copy(viewDir).transformDirection(_inv)
    const vx = _v.x, vy = _v.y, vz = _v.z
    const out = (line.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array
    const { pos, nrm, count } = sil
    let n = 0
    for (let e = 0; e < count; e++) {
      const k = 6 * e
      const d1 = nrm[k] * vx + nrm[k + 1] * vy + nrm[k + 2] * vz
      const d2 = nrm[k + 3] * vx + nrm[k + 4] * vy + nrm[k + 5] * vz
      if ((d1 > 0) === (d2 > 0)) continue
      out.set(pos.subarray(k, k + 6), n * 6)
      n++
    }
    line.geometry.setDrawRange(0, n * 2)
    line.geometry.attributes.position.needsUpdate = true
  })
}

function disposeTree(root: THREE.Object3D) {
  root.traverse(o => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
    g?.dispose()
  })
}
