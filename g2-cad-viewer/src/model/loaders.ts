// Turns a file from the phone into a normalised LoadedModel.
// Every format loader is imported lazily, so opening an STL never downloads
// the OpenCascade or LibreDWG WASM.
import * as THREE from 'three'
import { finalizeModel, type LoadedModel } from './model'

export const SUPPORTED_EXTENSIONS = [
  'step', 'stp', 'iges', 'igs', 'brep', // CAD solids (OpenCascade)
  'dwg', 'dxf', // AutoCAD drawings (LibreDWG)
  'glb', 'gltf', 'stl', 'obj', 'ply', '3mf', 'fbx', // meshes
] as const

export const ACCEPT_ATTR = SUPPORTED_EXTENSIONS.map(e => `.${e}`).join(',')

export function extensionOf(name: string): string {
  return name.split('?')[0].split('.').pop()?.toLowerCase() ?? ''
}

export async function loadModel(data: ArrayBuffer, fileName: string): Promise<LoadedModel> {
  const ext = extensionOf(fileName)
  const name = fileName.split(/[\\/]/).pop() ?? fileName
  const format = ext.toUpperCase()

  switch (ext) {
    case 'step':
    case 'stp':
    case 'iges':
    case 'igs':
    case 'brep': {
      const content = await loadOcct(data, ext)
      return finalizeModel(content, { name, format, zUp: true })
    }
    case 'dwg':
    case 'dxf': {
      const { loadDrawing } = await import('./dwg')
      const { content, notes } = await loadDrawing(data, ext === 'dxf')
      return finalizeModel(content, { name, format, zUp: true, notes })
    }
    case 'glb':
    case 'gltf': {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
      const gltf = await new GLTFLoader().parseAsync(data, '')
      const notes = ext === 'gltf' ? ['.gltf with external .bin/textures will fail — prefer .glb.'] : []
      return finalizeModel(gltf.scene, { name, format, zUp: false, notes })
    }
    case 'stl': {
      const { STLLoader } = await import('three/addons/loaders/STLLoader.js')
      const geom = new STLLoader().parse(data)
      if (!geom.attributes.normal) geom.computeVertexNormals()
      const mesh = new THREE.Mesh(geom)
      mesh.name = name
      return finalizeModel(mesh, { name, format, zUp: true })
    }
    case 'obj': {
      const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js')
      const group = new OBJLoader().parse(new TextDecoder().decode(data))
      return finalizeModel(group, { name, format, zUp: false })
    }
    case 'ply': {
      const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js')
      const geom = new PLYLoader().parse(data)
      if (!geom.attributes.normal) geom.computeVertexNormals()
      const mesh = new THREE.Mesh(geom)
      mesh.name = name
      return finalizeModel(mesh, { name, format, zUp: false })
    }
    case '3mf': {
      const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js')
      const group = new ThreeMFLoader().parse(data)
      return finalizeModel(group, { name, format, zUp: true })
    }
    case 'fbx': {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js')
      const group = new FBXLoader().parse(data, '')
      return finalizeModel(group, { name, format, zUp: false })
    }
    default:
      throw new Error(`Unsupported file type ".${ext}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`)
  }
}

let occtPromise: Promise<import('occt-import-js').Occt> | null = null

async function loadOcct(data: ArrayBuffer, ext: string): Promise<THREE.Group> {
  if (!occtPromise) {
    occtPromise = import('occt-import-js').then(m =>
      m.default({ locateFile: file => `${import.meta.env.BASE_URL}wasm/${file}` }),
    )
  }
  const occt = await occtPromise
  const bytes = new Uint8Array(data)
  const params = {
    linearUnit: 'millimeter' as const,
    linearDeflectionType: 'bounding_box_ratio' as const,
    linearDeflection: 0.002,
    angularDeflection: 0.5,
  }
  const result =
    ext === 'iges' || ext === 'igs'
      ? occt.ReadIgesFile(bytes, params)
      : ext === 'brep'
        ? occt.ReadBrepFile(bytes, params)
        : occt.ReadStepFile(bytes, params)
  if (!result.success) throw new Error('OpenCascade could not import this file.')

  const meshes = result.meshes.map((m, i) => {
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3))
    if (m.attributes.normal) geom.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3))
    else geom.computeVertexNormals()
    geom.setIndex(m.index.array)
    const mesh = new THREE.Mesh(geom)
    mesh.name = m.name || `Body ${i + 1}`
    return mesh
  })

  const build = (node: import('occt-import-js').OcctNode): THREE.Group => {
    const g = new THREE.Group()
    g.name = node.name ?? ''
    for (const idx of node.meshes) if (meshes[idx]) g.add(meshes[idx].parent ? meshes[idx].clone() : meshes[idx])
    for (const child of node.children) g.add(build(child))
    return g
  }
  return build(result.root)
}
