import { AuthApiError, PostgrestError } from '@supabase/supabase-js'

export function getErrorMessage(error: unknown): string {
  if (error instanceof AuthApiError) {
    if (error.code === 'invalid_credentials') return 'Неверный email или пароль.'
    if (error.code === 'email_not_confirmed') return 'Email не подтверждён. Владелец проекта может подтвердить аккаунт в Authentication → Users.'
    return `Ошибка входа: ${error.message}`
  }
  if (error instanceof PostgrestError) {
    if (['P0001', '22023', '23505'].includes(error.code)) return error.message
    if (error.code === '42501') return 'Нет доступа к команде. Войдите заново.'
    if (error.code === 'PGRST202') {
      return `Запрошенная функция отсутствует в Supabase. Проверьте миграции подключённого проекта. ${error.message}`
    }
    if (error.code === '42P01' || error.code.startsWith('PGRST')) {
      return 'Проверьте настройку проекта: выполните SQL из папки supabase/migrations и используйте URL и публичный ключ этого проекта.'
    }
    return `Ошибка базы данных (${error.code}): ${error.message}`
  }
  if (!(error instanceof Error) && error && typeof error === 'object') {
    const value = error as Record<string, unknown>
    const code = typeof value.code === 'string' ? value.code : ''
    const message = typeof value.message === 'string' ? value.message : ''
    const details = typeof value.details === 'string' && value.details ? ` ${value.details}` : ''
    const hint = typeof value.hint === 'string' && value.hint ? ` ${value.hint}` : ''
    if (code === 'PGRST202') {
      return `Запрошенная функция отсутствует в Supabase. Проверьте миграции подключённого проекта. ${message}${details}${hint}`
    }
    if (code === '42501') return 'Нет доступа к команде. Войдите заново.'
    if (['P0001', '22023', '23505'].includes(code)) return message
    if (message) return code ? `Ошибка базы данных (${code}): ${message}${details}${hint}` : message
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.message.includes('Failed to fetch')) {
      return 'Нет связи с Supabase. Проверьте интернет и доступность проекта.'
    }
    return error.message
  }
  return 'Произошла неизвестная ошибка.'
}

export async function withTimeout<T>(promise: PromiseLike<T>, ms = 20_000): Promise<T> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), ms)
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_, reject) => controller.signal.addEventListener('abort', () =>
        reject(new Error('Сервер не ответил вовремя. Проверьте интернет и повторите действие.')),
      )),
    ])
  } finally {
    window.clearTimeout(timer)
  }
}
