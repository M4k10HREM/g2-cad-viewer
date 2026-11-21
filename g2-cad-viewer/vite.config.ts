import { defineConfig, type Plugin } from 'vite'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const MODEL_EXT = /\.(glb|gltf|stl|obj|ply|3mf|fbx|step|stp|iges|igs|brep|dwg|dxf)$/i

// OpenCascade's Emscripten glue is CommonJS and fetches its .wasm by name,
// so we serve it from `public/wasm/`. (LibreDWG's ESM glue uses
// `new URL(..., import.meta.url)`, which Vite bundles on its own.)
// Both load lazily — only when a STEP/IGES or DWG/DXF file is opened.
const WASM_FILES: Array<[string, string]> = [
  ['node_modules/occt-import-js/dist/occt-import-js.wasm', 'occt-import-js.wasm'],
]

function cadAssets(): Plugin {
  const root = process.cwd()
  const modelsDir = resolve(root, 'public/models')
  const listModels = () =>
    existsSync(modelsDir) ? readdirSync(modelsDir).filter(f => MODEL_EXT.test(f)).sort() : []

  return {
    name: 'cad-assets',
    buildStart() {
      const out = resolve(root, 'public/wasm')
      mkdirSync(out, { recursive: true })
      for (const [from, to] of WASM_FILES) copyFileSync(resolve(root, from), resolve(out, to))
    },
    // Files dropped into public/models/ show up in the phone UI's model list.
    configureServer(server) {
      server.middlewares.use('/models/index.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(listModels()))
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'models/index.json', source: JSON.stringify(listModels()) })
    },
  }
}

export default defineConfig({
  // Relative base so assets resolve inside the packaged .ehpk as well as on the dev server.
  base: './',
  plugins: [cadAssets()],
  // Pre-bundling would move LibreDWG's glue away from its .wasm file.
  optimizeDeps: { exclude: ['@mlightcad/libredwg-web'] },
  server: { host: true, port: 5173 },
  build: { target: 'esnext', chunkSizeWarningLimit: 2000 },
})
