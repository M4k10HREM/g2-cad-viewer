// A built-in sample assembly (angle bracket + gusset + 4 bolts) so the app
// shows something useful before any file is opened, and so parts/explode
// can be tried immediately. Units are millimetres, Y-up.
import * as THREE from 'three'
import { finalizeModel, type LoadedModel } from './model'

function plateWithHoles(w: number, h: number, t: number, holes: Array<[number, number, number]>): THREE.BufferGeometry {
  const shape = new THREE.Shape()
  shape.moveTo(-w / 2, -h / 2)
  shape.lineTo(w / 2, -h / 2)
  shape.lineTo(w / 2, h / 2)
  shape.lineTo(-w / 2, h / 2)
  shape.closePath()
  for (const [x, y, r] of holes) {
    const hole = new THREE.Path()
    hole.absarc(x, y, r, 0, Math.PI * 2, true)
    shape.holes.push(hole)
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 24 })
  g.translate(0, 0, -t / 2)
  return g
}

function bolt(name: string): THREE.Group {
  const g = new THREE.Group()
  g.name = name
  const head = new THREE.Mesh(new THREE.CylinderGeometry(6.5, 6.5, 5, 6))
  head.position.y = 2.5
  const shank = new THREE.Mesh(new THREE.CylinderGeometry(3.8, 3.8, 22, 20))
  shank.position.y = -11
  g.add(head, shank)
  return g
}

export function makeSampleModel(): LoadedModel {
  const T = 6
  const content = new THREE.Group()
  content.name = 'Bracket assembly'

  const base = new THREE.Mesh(
    plateWithHoles(80, 60, T, [
      [-28, -18, 4.5],
      [28, -18, 4.5],
      [-28, 18, 4.5],
      [28, 18, 4.5],
    ]),
  )
  base.name = 'Base plate'
  base.rotation.x = -Math.PI / 2 // lie flat in XZ
  base.position.y = T / 2

  const upright = new THREE.Mesh(plateWithHoles(80, 50, T, [[0, 8, 9]]))
  upright.name = 'Upright'
  upright.position.set(0, T + 25, -30 + T / 2)

  const gussetShape = new THREE.Shape()
  gussetShape.moveTo(0, 0)
  gussetShape.lineTo(36, 0)
  gussetShape.lineTo(0, 36)
  gussetShape.closePath()
  const gussetGeom = new THREE.ExtrudeGeometry(gussetShape, { depth: T, bevelEnabled: false })
  gussetGeom.translate(0, 0, -T / 2)
  const gusset = new THREE.Mesh(gussetGeom)
  gusset.name = 'Gusset'
  gusset.rotation.y = -Math.PI / 2
  gusset.position.set(0, T, -30 + T)

  content.add(base, upright, gusset)
  const boltXZ: Array<[number, number]> = [
    [-28, 18],
    [28, 18],
    [-28, -18],
    [28, -18],
  ]
  boltXZ.forEach(([x, z], i) => {
    const b = bolt(`Bolt M8 #${i + 1}`)
    b.position.set(x, T, z)
    content.add(b)
  })

  return finalizeModel(content, { name: 'Sample bracket', format: 'built-in', zUp: false })
}
