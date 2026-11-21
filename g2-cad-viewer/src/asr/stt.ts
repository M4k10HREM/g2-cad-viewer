// Speech-to-text client for the G2 microphone.
//
// The G2 mic emits PCM s16le @ 16 kHz, mono via `bridge.audioControl(true)`.
// Each onEvenHubEvent callback with `audioEvent.audioPcm` delivers a chunk.
//
// ─────────────────────────────────────────────────────────────────────
// choose your own implementation here
// ─────────────────────────────────────────────────────────────────────
// A Deepgram streaming adapter is included. Each user picks the provider and
// enters their own key in the phone UI's Settings (stored on their phone
// only, see src/settings.ts). To use a different provider —
// AssemblyAI, Soniox, a self-hosted Whisper, … — add a branch below that
// returns an SttClient. main.ts feeds mic PCM into `sendPcm` and turns
// finalised text into view commands.
//
// Treat each snapshot as a full transcript state, not a delta:
//   - finalText: text the provider is confident about
//   - interimText: unstable tail that may still change
//   - finished: true on the terminal message
//
// Remember: app.json's `network` permission whitelist must contain your
// provider's host (it ships with api.deepgram.com).
//
// SECURITY: keys are never bundled into production builds. The key does
// travel from the user's phone to the provider, so each user should use
// their own key with a usage limit set at the provider.
// ─────────────────────────────────────────────────────────────────────

export interface SttSnapshot {
  finalText: string
  interimText: string
  finished: boolean
}

export interface SttClient {
  sendPcm(chunk: Uint8Array): void
  /** Push-to-talk release: send a short silence so the service finalises the last words now. */
  flush(): void
  close(): void
}

// 0.9 s of 16 kHz s16le silence, in 100 ms chunks.
const SILENCE_CHUNK = new Uint8Array(3200)
const SILENCE_CHUNKS = 9
// Audio spoken while the connection is still opening is queued (≈ several seconds).
const MAX_PENDING = 400

export interface SttOptions {
  /** ElevenLabs: fetches a single-use realtime token from the user's Worker. */
  getElevenLabsToken?: () => Promise<string>
}

export function startSttStream(
  provider: string,
  apiKey: string,
  onSnapshot: (snap: SttSnapshot) => void,
  onError?: (err: unknown) => void,
  opts: SttOptions = {},
): SttClient {
  if (!provider) throw new Error('Voice off — choose a speech provider in Settings')
  if (provider === 'elevenlabs') {
    if (!opts.getElevenLabsToken) throw new Error('Voice off — ElevenLabs needs your Worker URL and token in Settings')
    return startElevenLabs(opts.getElevenLabsToken, onSnapshot, onError)
  }
  if (!apiKey) throw new Error('Voice off — add your speech-to-text key in Settings')
  if (provider === 'deepgram') return startDeepgram(apiKey, onSnapshot, onError)
  throw new Error(`Unknown speech provider "${provider}" — implement it in src/asr/stt.ts.`)
}

// ── ElevenLabs Scribe realtime ───────────────────────────────────────
// Browser WebSockets can't send auth headers, so we connect with a
// single-use token (consumed on connect, 15-min validity) minted by the
// user's Worker. The server's VAD commits a segment after a pause, which
// arrives as `committed_transcript`. Sessions can end (time limit, silence),
// so we reconnect with a fresh token automatically.
const ELEVENLABS_WS = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime'
const ELEVENLABS_QUIET = new Set(['session_started', 'insufficient_audio_activity', 'warning'])

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

function startElevenLabs(
  getToken: () => Promise<string>,
  onSnapshot: (s: SttSnapshot) => void,
  onError?: (e: unknown) => void,
): SttClient {
  let ws: WebSocket | null = null
  let closed = false
  let failures = 0
  let finalText = ''
  const pending: string[] = []

  const retry = () => {
    if (closed) return
    failures++
    if (failures > 6) {
      onError?.(new Error('ElevenLabs: could not keep a connection — check your Worker and ElevenLabs key'))
      return
    }
    setTimeout(() => void connect(), Math.min(500 * 2 ** failures, 15_000))
  }

  const connect = async () => {
    if (closed) return
    let token: string
    try {
      token = await getToken()
    } catch (err) {
      onError?.(err)
      retry()
      return
    }
    const params = new URLSearchParams({
      model_id: 'scribe_v2_realtime',
      audio_format: 'pcm_16000',
      commit_strategy: 'vad',
      token,
    })
    const sock = new WebSocket(`${ELEVENLABS_WS}?${params}`)
    ws = sock
    sock.onopen = () => {
      failures = 0
      for (const m of pending.splice(0)) sock.send(m)
    }
    sock.onmessage = ev => {
      let msg: { message_type?: string; text?: string; error?: string }
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      const type = msg.message_type ?? ''
      if (type === 'partial_transcript') {
        onSnapshot({ finalText, interimText: msg.text ? ` ${msg.text}` : '', finished: false })
      } else if (type === 'committed_transcript') {
        const t = (msg.text ?? '').trim()
        if (t) finalText += (finalText ? ' ' : '') + t
        onSnapshot({ finalText, interimText: '', finished: false })
      } else if (type && !ELEVENLABS_QUIET.has(type) && !type.startsWith('committed_transcript_')) {
        onError?.(new Error(`ElevenLabs ${type}${msg.error ? `: ${msg.error}` : ''}`))
      }
    }
    sock.onclose = () => {
      if (ws === sock) ws = null
      retry()
    }
  }

  void connect()

  return {
    sendPcm(chunk) {
      const msg = JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: toBase64(chunk), commit: false, sample_rate: 16000 })
      if (ws?.readyState === WebSocket.OPEN) ws.send(msg)
      else if (pending.length < MAX_PENDING) pending.push(msg)
    },
    flush() {
      for (let i = 0; i < SILENCE_CHUNKS; i++) this.sendPcm(SILENCE_CHUNK)
    },
    close() {
      closed = true
      ws?.close(1000)
      onSnapshot({ finalText, interimText: '', finished: true })
    },
  }
}

// Vocabulary hints so short CAD commands are recognised reliably.
const KEYTERMS = [
  'rotate', 'tilt', 'zoom in', 'zoom out', 'isometric', 'wireframe', 'shaded', 'hidden line',
  'explode', 'collapse', 'isolate', 'next part', 'previous part', 'full screen', 'turntable',
]

function startDeepgram(apiKey: string, onSnapshot: (s: SttSnapshot) => void, onError?: (e: unknown) => void): SttClient {
  const params = new URLSearchParams({
    model: 'nova-3',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    endpointing: '600',
  })
  for (const k of KEYTERMS) params.append('keyterm', k)
  const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', apiKey])
  ws.binaryType = 'arraybuffer'

  let finalText = ''
  let closed = false
  const pending: Uint8Array[] = []

  const keepAlive = window.setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }))
  }, 8000)

  ws.onopen = () => {
    for (const c of pending.splice(0)) ws.send(c)
  }
  ws.onmessage = ev => {
    try {
      const msg = JSON.parse(String(ev.data))
      if (msg.type !== 'Results') return
      const text: string = msg.channel?.alternatives?.[0]?.transcript ?? ''
      if (msg.is_final) {
        if (text) finalText += (finalText ? ' ' : '') + text
        onSnapshot({ finalText, interimText: '', finished: false })
      } else {
        onSnapshot({ finalText, interimText: text ? ` ${text}` : '', finished: false })
      }
    } catch (err) {
      onError?.(err)
    }
  }
  ws.onerror = () => onError?.(new Error('Deepgram connection error (check key / network whitelist)'))
  ws.onclose = ev => {
    window.clearInterval(keepAlive)
    if (!closed && ev.code !== 1000) onError?.(new Error(`Deepgram closed: ${ev.code} ${ev.reason}`))
    onSnapshot({ finalText, interimText: '', finished: true })
  }

  return {
    sendPcm(chunk) {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk)
      else if (ws.readyState === WebSocket.CONNECTING && pending.length < MAX_PENDING) pending.push(chunk)
    },
    flush() {
      for (let i = 0; i < SILENCE_CHUNKS; i++) this.sendPcm(SILENCE_CHUNK)
    },
    close() {
      closed = true
      window.clearInterval(keepAlive)
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }))
      setTimeout(() => ws.close(1000), 500)
    },
  }
}
