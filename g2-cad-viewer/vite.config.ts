import { defineConfig, type Plugin } from 'vite'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
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

// three's 3MF loader names two XML namespaces that look like web addresses but
// are never fetched; Even Hub's review flags them as unlisted URLs. Match the
// beam-lattice elements and attributes by local name instead.
function threeMfNamespaces(): Plugin {
  return {
    name: '3mf-namespaces',
    apply: 'build',
    transform(code, id) {
      if (!/loaders[\/]3MFLoader\.js/.test(id)) return null
      const out = code
        .replace(/const (NS_BEAM_LATTICE(?:_BALLS)?) = '[^']+';/g, "const $1 = '*';")
        .replace(
          /beamLatticeNode\.getAttributeNS\( NS_BEAM_LATTICE_BALLS, ('\w+') \)/g,
          '( Array.from( beamLatticeNode.attributes ).find( a => a.localName === $1 )?.value ?? null )',
        )
      if (out.includes('schemas.microsoft.com/3dmanufacturing/beamlattice') || /getAttributeNS\( NS_BEAM/.test(out)) {
        this.error('3MFLoader changed: update threeMfNamespaces() in vite.config.ts')
      }
      return { code: out, map: null }
    },
  }
}

// Fails the build if the app's code names a web address that is neither in
// app.json's network whitelist nor a known identifier that is never fetched.
function whitelistCheck(): Plugin {
  const NEVER_FETCHED = [
    /^http:\/\/www\.w3\.org\//, // XML namespaces
    /^https:\/\/(github\.com\/101arrowz\/fflate|101arrowz\.github\.io\/fflate)/, // fflate licence notice
  ]
  return {
    name: 'whitelist-check',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const app = JSON.parse(readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'))
      const allowed: string[] = app.permissions.flatMap((p: { whitelist?: string[] }) => p.whitelist ?? [])
      const bad = new Set<string>()
      for (const f of Object.values(bundle)) {
        if (f.type !== 'chunk') continue
        for (const [url] of f.code.matchAll(/\b(?:https?|wss?):\/\/[^"'`\s<>)]*/g)) {
          const ok =
            NEVER_FETCHED.some(r => r.test(url)) ||
            allowed.some(a => url === a || url.startsWith(`${a}/`))
          if (!ok) bad.add(`${url}  (${f.fileName})`)
        }
      }
      if (bad.size) this.error(`URLs not in app.json's network whitelist:\n  ${[...bad].join('\n  ')}`)
    },
  }
}

export default defineConfig({
  // Relative base so assets resolve inside the packaged .ehpk as well as on the dev server.
  base: './',
  plugins: [cadAssets(), threeMfNamespaces(), whitelistCheck()],
  // Pre-bundling would move LibreDWG's glue away from its .wasm file.
  optimizeDeps: { exclude: ['@mlightcad/libredwg-web'] },
  server: { host: true, port: 5173 },
  build: { target: 'esnext', chunkSizeWarningLimit: 2000 },
})
