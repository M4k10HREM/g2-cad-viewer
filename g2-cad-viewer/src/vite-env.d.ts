/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STT_API_KEY?: string
  readonly VITE_STT_PROVIDER?: string
  readonly VITE_AI_URL?: string
  readonly VITE_AI_TOKEN?: string
}

declare module 'occt-import-js' {
  export interface OcctMesh {
    name?: string
    color?: [number, number, number]
    attributes: { position: { array: number[] }; normal?: { array: number[] } }
    index: { array: number[] }
  }
  export interface OcctNode {
    name?: string
    meshes: number[]
    children: OcctNode[]
  }
  export interface OcctResult {
    success: boolean
    root: OcctNode
    meshes: OcctMesh[]
  }
  export interface OcctParams {
    linearUnit?: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot'
    linearDeflectionType?: 'bounding_box_ratio' | 'absolute_value'
    linearDeflection?: number
    angularDeflection?: number
  }
  export interface Occt {
    ReadStepFile(content: Uint8Array, params: OcctParams | null): OcctResult
    ReadIgesFile(content: Uint8Array, params: OcctParams | null): OcctResult
    ReadBrepFile(content: Uint8Array, params: OcctParams | null): OcctResult
  }
  const occtimportjs: (opts?: { locateFile?: (file: string) => string }) => Promise<Occt>
  export default occtimportjs
}
