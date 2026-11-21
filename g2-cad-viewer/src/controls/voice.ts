// Free-form speech → view commands.
//
// Works on any transcript text, so it's shared by the STT pipeline and the
// "type a command" box in the phone UI. Phrases are matched by keywords, so
// "could you rotate it left ninety degrees" and "rotate left 90" both work.
// One utterance may contain several commands ("top view and zoom in").
import type { Command, Layout, Mode, Style, ViewName } from './commands'

const NUMBER_WORDS: Record<string, number> = {
  five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, 'forty five': 45, 'forty-five': 45,
  forty: 40, sixty: 60, seventy: 70, ninety: 90, 'one eighty': 180, 'a hundred eighty': 180,
  'one hundred eighty': 180, 'a hundred and eighty': 180, half: 180,
}

function numberIn(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)/)
  if (m) return parseFloat(m[1])
  for (const [w, n] of Object.entries(NUMBER_WORDS).sort((a, b) => b[0].length - a[0].length)) {
    if (new RegExp(`\\b${w}\\b`).test(text)) return n
  }
  return null
}

const has = (t: string, ...words: string[]) => words.some(w => new RegExp(`\\b${w}\\b`).test(t))

export function parseVoice(raw: string): Command[] {
  const text = raw
    .toLowerCase()
    .replace(/[°]/g, ' degrees')
    .replace(/[^a-z0-9.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return []

  // Split compound utterances: "top view then zoom in", "rotate left and tilt up"
  const clauses = text.split(/\b(?:and then|then|and|also|after that)\b|[.]/).map(c => c.trim()).filter(Boolean)
  const out: Command[] = []
  for (const c of clauses) {
    const cmd = parseClause(c)
    if (cmd) out.push(cmd)
  }
  return out
}

function namedView(t: string): ViewName | null {
  return has(t, 'isometric', 'iso', 'three quarter', '3d view', 'default view')
    ? 'iso'
    : has(t, 'top', 'plan', 'above', 'overhead', 'birds eye')
      ? 'top'
      : has(t, 'bottom', 'underneath', 'below', 'under')
        ? 'bottom'
        : has(t, 'front', 'elevation')
          ? 'front'
          : has(t, 'back', 'rear', 'behind')
            ? 'back'
            : has(t, 'left')
              ? 'left'
              : has(t, 'right', 'side')
                ? 'right'
                : null
}

function parseClause(t: string): Command | null {
  const n = numberIn(t)

  // Explicit mode switching ("zoom mode", "switch to parts mode")
  if (has(t, 'mode')) {
    const modes: Record<string, Mode> = { rotate: 'rotate', tilt: 'tilt', zoom: 'zoom', view: 'view', views: 'view', part: 'part', parts: 'part', explode: 'explode' }
    for (const [w, m] of Object.entries(modes)) if (has(t, w)) return { kind: 'mode', mode: m }
  }

  // "rotate to top view", "show me the front view", "look from above"
  if (has(t, 'view', 'look', 'from')) {
    const v = namedView(t)
    if (v) return { kind: 'view', name: v }
  }

  // Turntable
  if (has(t, 'spin', 'turntable', 'auto rotate', 'autorotate') && !has(t, 'stop', 'off', 'pause')) return { kind: 'spin', on: true }
  if (has(t, 'stop', 'freeze', 'pause') && !has(t, 'listening')) return { kind: 'spin', on: false }

  // Reset / fit
  if (has(t, 'reset', 'start over', 'home')) return { kind: 'reset' }
  if (has(t, 'fit', 'zoom to fit', 'whole thing', 'center', 'centre')) return { kind: 'fit' }

  // Layout
  const layout: Layout | null = has(t, 'full screen', 'fullscreen', 'full', 'maximize', 'maximise', 'big')
    ? 'full'
    : has(t, 'wide', 'widescreen')
      ? 'wide'
      : has(t, 'small', 'normal size', 'minimize', 'minimise', 'compact', 'exit full')
        ? 'single'
        : null
  if (layout && !has(t, 'zoom')) return { kind: 'layout', layout }

  // Render style
  const style: Style | null = has(t, 'wireframe', 'wire frame', 'wire', 'x ray', 'xray', 'x-ray', 'see through', 'transparent')
    ? 'wire'
    : has(t, 'shaded', 'shade', 'solid', 'render')
      ? 'shaded'
      : has(t, 'hidden line', 'hidden', 'outline', 'edges', 'line drawing', 'sketch')
        ? 'hidden'
        : null
  if (style) return { kind: 'style', style }

  // Parts
  if (has(t, 'isolate', 'only this', 'just this', 'hide others', 'hide the rest')) return { kind: 'isolate', on: true }
  if (has(t, 'show all', 'show everything', 'unhide', 'all parts')) return { kind: 'partSelect', index: -1 }
  if (has(t, 'part', 'component', 'piece', 'layer')) {
    if (has(t, 'previous', 'prev', 'back', 'last')) return { kind: 'part', delta: -1 }
    if (has(t, 'next', 'forward')) return { kind: 'part', delta: 1 }
    if (n !== null) return { kind: 'partSelect', index: Math.max(0, Math.round(n) - 1) }
    return { kind: 'part', delta: 1 }
  }

  // Explode
  if (has(t, 'collapse', 'assemble', 'unexplode', 'un explode', 'put it back')) return { kind: 'explode', delta: -10 }
  if (has(t, 'explode', 'exploded', 'spread', 'pull apart', 'take apart')) {
    return { kind: 'explode', delta: has(t, 'less', 'reduce') ? -0.5 : 0.5 }
  }

  // Zoom
  if (has(t, 'zoom', 'closer', 'bigger', 'magnify', 'enlarge', 'further', 'farther', 'smaller', 'away')) {
    const out = has(t, 'out', 'further', 'farther', 'smaller', 'away', 'back')
    const factor = n && n > 1 && n <= 20 ? n : has(t, 'twice', 'double', 'lot') ? 2 : 1.5
    return { kind: 'zoom', factor: out ? 1 / factor : factor }
  }

  // Pan
  if (has(t, 'pan', 'move', 'shift', 'slide')) {
    const step = 0.25
    if (has(t, 'left')) return { kind: 'pan', dx: step, dy: 0 }
    if (has(t, 'right')) return { kind: 'pan', dx: -step, dy: 0 }
    if (has(t, 'up')) return { kind: 'pan', dx: 0, dy: -step }
    if (has(t, 'down')) return { kind: 'pan', dx: 0, dy: step }
  }

  // Rotation / tilt (explicit verbs win over view names)
  const deg = n ?? (has(t, 'little', 'bit', 'slightly') ? 15 : has(t, 'around', 'over') ? 180 : null)
  if (has(t, 'tilt', 'pitch') ||(has(t, 'rotate', 'turn', 'spin', 'flip') && has(t, 'up', 'down'))) {
    const d = deg ?? 15
    if (has(t, 'down')) return { kind: 'tilt', deg: -d }
    return { kind: 'tilt', deg: d }
  }
  if (has(t, 'rotate', 'turn', 'flip', 'twist', 'orbit')) {
    if (has(t, 'around', 'over') && n === null) return { kind: 'rotate', deg: 180 }
    const d = deg ?? 30
    return { kind: 'rotate', deg: has(t, 'left', 'counter', 'anticlockwise', 'counterclockwise') ? -d : d }
  }

  // Bare view names ("top", "isometric")
  const view = namedView(t)
  if (view) return { kind: 'view', name: view }

  return null
}
