import { useEffect, useRef, useState } from 'react'
import { readAudioFile, maxAudioBytes, type CallAudio } from '../lib/sales'
import { getErrorMessage } from '../lib/errors'

type RecordingState = 'idle' | 'permission' | 'recording' | 'finishing'

export function useCallRecorder(onAudio: (audio: CallAudio, limitReached: boolean) => void) {
  const [state, setState] = useState<RecordingState>('idle')
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState('')
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const active = useRef(false)
  const started = useRef(0)
  const duration = () => Math.round((performance.now() - started.current) / 1000)

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      const current = recorder.current
      if (current && current.state !== 'inactive') current.stop()
      stream.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])
  useEffect(() => {
    if (state !== 'recording') return
    const timer = window.setInterval(() => setSeconds(duration()), 250)
    return () => window.clearInterval(timer)
  }, [state])

  const stop = () => {
    if (recorder.current?.state !== 'recording') return
    setState('finishing')
    recorder.current.stop()
  }

  const start = async () => {
    setError('')
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Запись недоступна. Откройте CRM по HTTPS или на localhost в браузере с поддержкой микрофона.')
      return
    }
    setState('permission')
    try {
      const input = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!active.current) { input.getTracks().forEach((track) => track.stop()); return }
      stream.current = input
      const supported = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((value) => MediaRecorder.isTypeSupported(value))
      let current: MediaRecorder
      try { current = new MediaRecorder(input, { mimeType: supported, audioBitsPerSecond: 64_000 }) }
      catch { current = new MediaRecorder(input) }
      recorder.current = current
      const chunks: Blob[] = []
      let bytes = 0
      let limitReached = false
      const ended = () => input.getTracks().forEach((track) => track.stop())
      current.ondataavailable = (event) => {
        if (!event.data.size) return
        chunks.push(event.data)
        bytes += event.data.size
        if (bytes >= maxAudioBytes - 128 * 1024 && current.state === 'recording') {
          limitReached = true
          if (active.current) stop()
        }
      }
      current.onerror = () => {
        ended()
        if (active.current) setError('Запись прервалась из-за ошибки микрофона.')
      }
      current.onstop = async () => {
        const recordedSeconds = duration()
        ended()
        if (!active.current) return
        setState('finishing')
        try {
          const audio = await readAudioFile(new Blob(chunks, { type: current.mimeType }), recordedSeconds)
          if (active.current) onAudio(audio, limitReached)
        } catch (failure) {
          if (active.current) setError(getErrorMessage(failure))
        } finally {
          if (active.current) setState('idle')
        }
      }
      started.current = performance.now()
      current.start(1000)
      setSeconds(0)
      setState('recording')
    } catch (failure) {
      stream.current?.getTracks().forEach((track) => track.stop())
      if (!active.current) return
      const name = failure instanceof DOMException ? failure.name : ''
      setError(name === 'NotAllowedError' ? 'Доступ к микрофону запрещён. Разрешите его в настройках браузера.'
        : name === 'NotFoundError' ? 'Микрофон не найден.' : 'Не удалось начать запись. Проверьте микрофон.')
      setState('idle')
    }
  }

  return { state, seconds, error, start, stop }
}
