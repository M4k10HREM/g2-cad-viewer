// OpenSCAD → STL, entirely on the phone (OpenSCAD compiled to WASM,
// openscad-wasm-prebuilt, GPL-2.0+). Lazy-loaded: the ~11 MB module only
// downloads the first time an AI design is compiled.

export class OpenScadError extends Error {
  constructor(message: string, readonly log: string) {
    super(message)
  }
}

/**
 * Compile OpenSCAD source to an ASCII STL string.
 * @param part when set, passes `-D show_part="<part>"` so only that part renders.
 */
export async function compileScad(code: string, part?: string): Promise<string> {
  const { createOpenSCAD } = await import('openscad-wasm-prebuilt')
  const log: string[] = []
  // A fresh instance per compile: an Emscripten main() can't be re-run safely
  // after it has exited (especially after an error).
  const openscad = await createOpenSCAD({ noInitialRun: true, print: s => log.push(s), printErr: s => log.push(s) })
  const fs = openscad.getInstance().FS
  fs.writeFile('/input.scad', code)
  const args = ['/input.scad', '--enable=manifold', '-o', '/out.stl']
  if (part) args.push('-D', `show_part="${part}"`)

  let exit: number
  try {
    exit = openscad.getInstance().callMain(args)
  } catch (err) {
    exit = typeof err === 'number' ? err : -1
  }
  const errors = log.filter(l => /ERROR|WARNING: (Ignoring unknown|Can't open)|Parser error/i.test(l))
  let stl = ''
  try {
    stl = fs.readFile('/out.stl', { encoding: 'utf8' })
  } catch {
    /* no output */
  }
  if (exit !== 0 || !stl || !/facet/.test(stl)) {
    const detail = errors.length ? errors.join('\n') : log.slice(-8).join('\n')
    const message = /Current top level object is empty|no top level geometry/i.test(log.join('\n'))
      ? 'The design produced no geometry.'
      : errors[0] ?? `OpenSCAD failed (exit ${exit}).`
    throw new OpenScadError(message, detail || message)
  }
  return stl
}

/** Part names declared through the `show_part == "<name>"` selector convention. */
export function partNames(code: string): string[] {
  const names = new Set<string>()
  for (const m of code.matchAll(/show_part\s*==\s*"([A-Za-z0-9_-]+)"/g)) if (m[1] !== 'all') names.add(m[1])
  return [...names].slice(0, 12)
}
