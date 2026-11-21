// View state + the command set shared by touchpad, voice, and the phone UI.

export type Mode = 'rotate' | 'tilt' | 'zoom' | 'view' | 'part' | 'explode'
export type Style = 'hidden' | 'shaded' | 'wire'
export type Layout = 'single' | 'wide' | 'full'
export type ViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso'

export const MODES: Mode[] = ['rotate', 'tilt', 'zoom', 'view', 'part', 'explode']
export const MODE_LABEL: Record<Mode, string> = {
  rotate: 'Rotate',
  tilt: 'Tilt',
  zoom: 'Zoom',
  view: 'Views',
  part: 'Parts',
  explode: 'Explode',
}
export const VIEW_ORDER: ViewName[] = ['iso', 'front', 'right', 'back', 'left', 'top', 'bottom']
export const VIEWS: Record<ViewName, { yaw: number; pitch: number }> = {
  front: { yaw: 0, pitch: 0 },
  back: { yaw: 180, pitch: 0 },
  right: { yaw: 90, pitch: 0 },
  left: { yaw: -90, pitch: 0 },
  top: { yaw: 0, pitch: 90 },
  bottom: { yaw: 0, pitch: -90 },
  iso: { yaw: 45, pitch: 35.26 },
}

export interface ViewState {
  yaw: number
  pitch: number
  zoom: number
  panX: number
  panY: number
  style: Style
  mode: Mode
  layout: Layout
  view: ViewName | null
  /** -1 = no part highlighted. */
  partIndex: number
  isolate: boolean
  explode: number
  spinning: boolean
}

export function initialState(flat = false): ViewState {
  const v = flat ? VIEWS.top : VIEWS.iso
  return {
    yaw: v.yaw,
    pitch: v.pitch,
    zoom: 1,
    panX: 0,
    panY: 0,
    style: flat ? 'wire' : 'hidden',
    mode: 'rotate',
    layout: 'single',
    view: flat ? 'top' : 'iso',
    partIndex: -1,
    isolate: false,
    explode: 0,
    spinning: false,
  }
}

export type Command =
  | { kind: 'rotate'; deg: number }
  | { kind: 'tilt'; deg: number }
  | { kind: 'zoom'; factor: number }
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'view'; name: ViewName }
  | { kind: 'style'; style: Style }
  | { kind: 'layout'; layout: Layout }
  | { kind: 'part'; delta: number }
  | { kind: 'partSelect'; index: number }
  | { kind: 'isolate'; on: boolean }
  | { kind: 'explode'; delta: number }
  | { kind: 'spin'; on: boolean }
  | { kind: 'mode'; mode: Mode }
  | { kind: 'nextMode' }
  | { kind: 'reset' }
  | { kind: 'fit' }

/** What a swipe does in the current mode. `dir` = +1 (swipe up) / -1 (swipe down). */
export function swipeCommand(mode: Mode, dir: 1 | -1, state: ViewState): Command {
  switch (mode) {
    case 'rotate':
      return { kind: 'rotate', deg: 30 * dir }
    case 'tilt':
      return { kind: 'tilt', deg: 15 * dir }
    case 'zoom':
      return { kind: 'zoom', factor: dir > 0 ? 1.25 : 1 / 1.25 }
    case 'view': {
      const i = state.view ? VIEW_ORDER.indexOf(state.view) : -1
      const n = VIEW_ORDER.length
      return { kind: 'view', name: VIEW_ORDER[(i + dir + n) % n] }
    }
    case 'part':
      return { kind: 'part', delta: dir }
    case 'explode':
      return { kind: 'explode', delta: 0.25 * dir }
  }
}

export interface ApplyResult {
  /** Short human description for the glasses footer. */
  message: string
  /** Layout changed → page must be rebuilt. */
  relayout?: boolean
  /** Model transforms changed (explode). */
  geometry?: boolean
}

const norm = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180

export function applyCommand(s: ViewState, cmd: Command, partNames: string[], flat: boolean): ApplyResult {
  switch (cmd.kind) {
    case 'rotate':
      s.yaw = norm(s.yaw + cmd.deg)
      s.view = null
      return { message: `Rotate ${cmd.deg > 0 ? 'right' : 'left'} ${Math.abs(cmd.deg)}°` }
    case 'tilt':
      s.pitch = Math.max(-90, Math.min(90, s.pitch + cmd.deg))
      s.view = null
      return { message: `Tilt ${cmd.deg > 0 ? 'up' : 'down'} ${Math.abs(cmd.deg)}°` }
    case 'zoom':
      s.zoom = Math.max(0.2, Math.min(40, s.zoom * cmd.factor))
      return { message: `Zoom ${s.zoom.toFixed(2)}×` }
    case 'pan':
      s.panX += cmd.dx / s.zoom
      s.panY += cmd.dy / s.zoom
      return { message: 'Pan' }
    case 'view': {
      const v = VIEWS[cmd.name]
      s.yaw = v.yaw
      s.pitch = v.pitch
      s.view = cmd.name
      return { message: `${cmd.name[0].toUpperCase()}${cmd.name.slice(1)} view` }
    }
    case 'style':
      s.style = cmd.style
      return { message: { hidden: 'Hidden-line', shaded: 'Shaded', wire: 'Wireframe' }[cmd.style] }
    case 'layout':
      if (s.layout === cmd.layout) return { message: `Layout: ${cmd.layout}` }
      s.layout = cmd.layout
      return { message: `Layout: ${cmd.layout}`, relayout: true }
    case 'part': {
      const n = partNames.length
      if (n < 2) return { message: 'Only one part' }
      // Cycle: none → 0 → 1 … → n-1 → none
      let i = s.partIndex + cmd.delta
      if (i < -1) i = n - 1
      if (i >= n) i = -1
      s.partIndex = i
      if (i === -1) s.isolate = false
      return { message: i === -1 ? 'All parts' : `${i + 1}/${n} ${partNames[i]}` }
    }
    case 'partSelect':
      s.partIndex = cmd.index
      if (cmd.index === -1) s.isolate = false
      return { message: cmd.index === -1 ? 'All parts' : partNames[cmd.index] ?? 'Part' }
    case 'isolate':
      if (cmd.on && s.partIndex < 0) return { message: 'Pick a part first' }
      s.isolate = cmd.on
      return { message: cmd.on ? `Isolated ${partNames[s.partIndex]}` : 'Show all' }
    case 'explode':
      s.explode = Math.max(0, Math.min(3, s.explode + cmd.delta))
      return { message: `Explode ${Math.round(s.explode * 100)}%`, geometry: true }
    case 'spin':
      s.spinning = cmd.on
      return { message: cmd.on ? 'Turntable on' : 'Turntable off' }
    case 'mode':
      s.mode = cmd.mode
      return { message: `Mode: ${MODE_LABEL[cmd.mode]}` }
    case 'nextMode': {
      s.mode = MODES[(MODES.indexOf(s.mode) + 1) % MODES.length]
      return { message: `Mode: ${MODE_LABEL[s.mode]}` }
    }
    case 'fit':
      s.zoom = 1
      s.panX = 0
      s.panY = 0
      return { message: 'Fit to view' }
    case 'reset': {
      const keep = { layout: s.layout, mode: s.mode }
      Object.assign(s, initialState(flat), keep)
      return { message: 'Reset view', geometry: true }
    }
  }
}
