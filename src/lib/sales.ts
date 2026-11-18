export const callOutcomes = {
  no_answer: 'Не дозвонился',
  rejected: 'Отказ',
  interested: 'Заинтересован',
  call_later: 'Договорились связаться позже',
  offer_sent: 'Отправлен оффер',
}

export type CallOutcome = keyof typeof callOutcomes

export interface LeadCall {
  id: string
  occurred_at: string
  outcome: CallOutcome | null
  went_well: string
  went_poorly: string
  notes: string
  audio_mime: AudioMime | null
  audio_duration_seconds: number | null
}

export const outreachLabels = {
  telegram_message: 'Сообщение в Telegram',
  telegram_offer: 'Оффер в Telegram',
}

export type OutreachKind = keyof typeof outreachLabels
export interface OutreachEvent { id: string; occurred_at: string; kind: OutreachKind }

export const audioExtensions = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
}
export type AudioMime = keyof typeof audioExtensions
export const maxAudioBytes = 8 * 1024 * 1024
export interface CallAudio { blob: Blob; mime: AudioMime; duration: number | null }

export function telegramPhone(value: string | null): string | null {
  const input = value?.normalize('NFKC').trim()
  if (!input || !/^\+?[\d() .\s-]+$/.test(input)) return null
  const digits = input.replace(/\D/g, '')
  if (input.startsWith('+') && !/^7\d{10}$/.test(digits)) return null
  const national = /^[78]\d{10}$/.test(digits) ? digits.slice(1) : digits
  return /^[3489]\d{9}$/.test(national) ? `+7${national}` : null
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function toLocalInput(value: string | null, includeSeconds = false): string {
  if (!value) return ''
  const date = new Date(value)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, includeSeconds ? 19 : 16)
}

export function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export async function readAudioFile(blob: Blob, duration?: number): Promise<CallAudio> {
  if (blob.size < 12 || blob.size > maxAudioBytes) throw new Error('Выберите аудиофайл размером до 8 МБ.')
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  const ascii = String.fromCharCode(...header)
  let mime: AudioMime
  if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) mime = 'audio/webm'
  else if (ascii.startsWith('OggS')) mime = 'audio/ogg'
  else if (ascii.slice(4, 8) === 'ftyp') mime = 'audio/mp4'
  else if (ascii.startsWith('RIFF') && ascii.slice(8) === 'WAVE') mime = 'audio/wav'
  else if (ascii.startsWith('ID3') || (header[0] === 255 && (header[1] & 224) === 224 && (header[1] & 6) !== 0)) mime = 'audio/mpeg'
  else throw new Error('Поддерживаются аудио WebM, Ogg, M4A, WAV и MP3.')
  const audio = blob.slice(0, blob.size, mime)
  return { blob: audio, mime, duration: duration ?? await readAudioDuration(audio) }
}

function readAudioDuration(blob: Blob): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const player = new Audio()
    const url = URL.createObjectURL(blob)
    const clean = () => {
      window.clearTimeout(timer)
      player.onloadedmetadata = player.ondurationchange = player.onerror = null
      player.removeAttribute('src')
      player.load()
      URL.revokeObjectURL(url)
    }
    const timer = window.setTimeout(() => { clean(); resolve(null) }, 2500)
    const finish = (seconds: number | null) => {
      clean()
      resolve(seconds !== null && seconds <= 86400 ? Math.round(seconds) : null)
    }
    player.onloadedmetadata = () => {
      if (Number.isFinite(player.duration)) finish(player.duration)
      else {
        // Some recordings (including WebM from MediaRecorder) have no duration header.
        player.ondurationchange = () => { if (Number.isFinite(player.duration)) finish(player.duration) }
        try { player.currentTime = 86400 } catch { finish(null) }
      }
    }
    player.onerror = () => { clean(); reject(new Error('Не удалось открыть аудио. Проверьте файл или выберите другой формат.')) }
    player.preload = 'metadata'
    player.src = url
  })
}

export function encodeAudio(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1])
    reader.onerror = () => reject(new Error('Не удалось прочитать аудиофайл.'))
    reader.readAsDataURL(blob)
  })
}

export function decodeAudio(data: string, mime: AudioMime): Blob {
  const binary = atob(data)
  return new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], { type: mime })
}
