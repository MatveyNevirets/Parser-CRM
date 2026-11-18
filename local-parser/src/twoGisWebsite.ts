export interface WebsiteCheck {
  website: string | null
  websiteCheckStatus: 'present' | 'absent' | 'unknown'
}

/** Browser-side reader of the canonical 2GIS Contacts tab, not /tab/info. */
export function readTwoGisContacts(): WebsiteCheck {
  const unknown: WebsiteCheck = { website: null, websiteCheckStatus: 'unknown' }
  const visible = (element: Element) => element.getClientRects().length > 0
  const text = (element: Element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim()
  const heading = document.querySelector('h1')
  if (!heading) return unknown
  const canonical = (value: string) => {
    try {
      const url = new URL(value, location.href)
      return /^https?:$/.test(url.protocol) && /^(?:www\.)?2gis\.ru$/i.test(url.hostname)
        && /\/firm\/\d+\/?$/.test(url.pathname) ? `https://2gis.ru${url.pathname.replace(/\/$/, '')}` : null
    } catch { return null }
  }
  const pageUrl = canonical(location.href)
  const contactsTab = Array.from(document.querySelectorAll('a[href], [role="tab"]')).find((element) =>
    /^Контакты$/i.test(text(element)) && (element.getAttribute('href')
      ? canonical(element.getAttribute('href')!) === pageUrl && pageUrl !== null
      : element.getAttribute('aria-selected') === 'true'))
  const end = Array.from(document.querySelectorAll('button, [role="button"], a, span, div')).find((element) =>
    /^Нашли ошибку(?: в данных)?\??$/i.test(text(element))
    && Boolean(heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))
  let panel: Element = heading
  while (panel.parentElement && (!end || !panel.contains(end) || !contactsTab || !panel.contains(contactsTab))) panel = panel.parentElement
  const range = document.createRange()
  range.setStartBefore(heading)
  if (end && panel.contains(end)) range.setEndBefore(end)
  else range.setEndAfter(panel)
  const inside = (element: Element) => range.intersectsNode(element)
  // Only social platforms/messengers are exempt. Website builders and link
  // landing pages (Taplink, Tilda, etc.) are websites and must be rejected.
  const socials = ['vk.com', 'vk.ru', 'vkvideo.ru', 'instagram.com', 'facebook.com', 't.me', 'telegram.me',
    'telegram.org', 'wa.me', 'whatsapp.com', 'youtube.com', 'youtu.be', 'rutube.ru', 'ok.ru', 'odnoklassniki.ru',
    'tiktok.com', 'twitter.com', 'x.com', 'threads.net', 'threads.com', 'dzen.ru', 'pinterest.com',
    'discord.com', 'discord.gg', 'viber.com', 'max.ru', 'm.me', 'messenger.com', 'tenchat.ru']
  const isSocial = (host: string) => socials.some((domain) => host === domain || host.endsWith(`.${domain}`))
  const isDirectory = (url: URL) => /(^|\.)2gis\.(ru|com|kz|kg|uz|by|am|ae|az|ge|tj|mn)$/i.test(url.hostname)
  const isTracker = (url: URL) => /^(link|redirect)\.2gis\.(ru|com)$/i.test(url.hostname)
  const decode = (value: string) => { try { return decodeURIComponent(value) } catch { return value } }
  const resolveLink = (value: string): { kind: 'social' | 'internal' | 'website' | 'unresolved'; url: string | null } => {
    let current = value.trim()
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        if (!/^(?:[a-z][a-z\d+.-]*:|\/\/|\/|#|\?)/i.test(current)) {
          if (!/^[\p{L}\p{N}][\p{L}\p{N}.-]*\.(?:[\p{L}]{2,}|xn--[a-z\d-]+)(?:[/?#][^\s]*)?$/iu.test(current)) return { kind: 'unresolved', url: null }
          current = `https://${current}`
        }
        const url = new URL(current.startsWith('//') ? `https:${current}` : current, location.href)
        if (/^(tel|mailto|tg|whatsapp|viber):$/i.test(url.protocol)) return { kind: 'social', url: null }
        if (!/^https?:$/.test(url.protocol)) return { kind: 'unresolved', url: null }
        const target = ['url', 'target', 'to', 'redirect', 'href', 'u', 'q'].map((key) => url.searchParams.get(key)).find(Boolean)
          ?? (/^(?:https?%3A|https?:\/\/)/i.test(url.search.slice(1)) ? decode(url.search.slice(1)) : null)
        const socialRedirect = /^(?:l|lm)\.(?:instagram|facebook)\.com$/i.test(url.hostname)
          || isSocial(url.hostname) && /^\/(?:redirect|away|l\.php|redir|away\.php)(?:\/|$)/i.test(url.pathname)
        if (isTracker(url) || isDirectory(url) && target || socialRedirect) {
          // Real 2GIS links use ?http://company.ru, not just ?url=...
          if (!target) return { kind: 'unresolved', url: null }
          current = decode(target)
          if (!/^(?:https?:\/\/|\/\/|tg:|whatsapp:|viber:)/i.test(current)) return { kind: 'unresolved', url: null }
          continue
        }
        if (isSocial(url.hostname.toLowerCase())) return { kind: 'social', url: url.href }
        if (isDirectory(url) || (/^(?:www\.)?yandex\.(ru|com)$/i.test(url.hostname) && /^\/maps(?:\/|$)/i.test(url.pathname))) {
          return { kind: 'internal', url: null }
        }
        return { kind: 'website', url: url.href }
      } catch { return { kind: 'unresolved', url: null } }
    }
    return { kind: 'unresolved', url: null }
  }
  let unresolved = false
  let hasContact = false
  const controls = Array.from(panel.querySelectorAll<HTMLElement>(
    'a[href], [data-url], [data-href], [data-link], [data-website], [itemprop="url"], button, [role="button"], [data-testid*="website" i], [data-link-type*="website" i], [class*="website" i]',
  )).filter(inside)
  for (const element of controls) {
    const label = `${text(element)} ${element.getAttribute('aria-label') ?? ''} ${element.title} ${element.getAttribute('data-testid') ?? ''} ${element.getAttribute('data-link-type') ?? ''} ${element.getAttribute('class') ?? ''}`
    const siteControl = /сайт|website|\bsite\b/i.test(label) && !/добавить сайт|указать сайт|нет сайта|сайт не указан/i.test(label)
    let resolved = false
    const values = ['href', 'data-url', 'data-href', 'data-link', 'data-website', 'content'].map((attr) => element.getAttribute(attr)).filter((value): value is string => Boolean(value))
    for (const value of values) {
      const result = resolveLink(value)
      if (result.kind === 'website') return { website: result.url, websiteCheckStatus: 'present' }
      if (result.kind === 'social') { resolved = true; if (visible(element)) hasContact = true }
      if (result.kind === 'internal' && !siteControl) resolved = true
      if (result.kind === 'unresolved' && !/^(?:#|javascript:)/i.test(value)) unresolved = true
    }
    const domainText = text(element).replace(/^https?:\/\//i, '').replace(/\/$/, '')
    if (/^(?:www\.)?[\p{L}\p{N}](?:[\p{L}\p{N}.-]*\.)[\p{L}]{2,}(?:\/[^\s]*)?$/u.test(domainText)) {
      const result = resolveLink(`https://${domainText}`)
      if (result.kind === 'website') return { website: result.url, websiteCheckStatus: 'present' }
    }
    if (siteControl && !resolved) unresolved = true
    if (visible(element) && /^(?:ещ[её](?:\s*\d+)?|показать (?:все )?контакты|другие контакты|все ссылки)$/i.test(text(element))
      && element.getAttribute('aria-expanded') !== 'true') unresolved = true
  }
  const panelText = text(panel)
  hasContact ||= /показать телефон|показать номер|телефон не указан|нет телефона|сайт не указан|нет сайта/i.test(panelText)
  const loading = Array.from(panel.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-testid*="skeleton" i]')).some(visible)
  if (!pageUrl || !contactsTab || !end || !visible(heading) || !visible(end) || loading || unresolved || !hasContact
    || panel.querySelectorAll('h1').length !== 1) return unknown
  return { website: null, websiteCheckStatus: 'absent' }
}
