import type { Lead } from '../types'
import { normalizeDomain } from '../imports/normalize'

const socialDomains = ['vk.com', 'vk.ru', 'instagram.com', 'facebook.com', 't.me',
  'telegram.me', 'telegram.org', 'wa.me', 'whatsapp.com', 'taplink.cc', 'taplink.ru', 'taplink.ws']

export function hasLeadWebsite(lead: Pick<Lead, 'website' | 'website_status'>): boolean {
  const website = lead.website?.trim()
  if (website) {
    // Accept existing scheme-less domains and international domain names too.
    const domain = normalizeDomain(website)
    return domain !== null && !socialDomains.some((social) => domain === social || domain.endsWith(`.${social}`))
  }
  // Existing manually reviewed cards may have a site classification without a URL.
  return lead.website_status === 'hasWebsite' || lead.website_status === 'poorWebsite'
}
