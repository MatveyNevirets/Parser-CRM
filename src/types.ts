export const leadStatuses = ['newLead', 'inProgress', 'waiting', 'offer', 'rejected'] as const
export const leadPriorities = ['low', 'normal', 'high'] as const
export const websiteStatuses = ['unknown', 'hasWebsite', 'poorWebsite', 'noWebsite'] as const

export type LeadStatus = (typeof leadStatuses)[number]
export type LeadPriority = (typeof leadPriorities)[number]
export type WebsiteStatus = (typeof websiteStatuses)[number]

export interface Lead {
  id: string
  workspace_id: string
  company_name: string
  niche: string
  priority: LeadPriority
  status: LeadStatus
  website_status: WebsiteStatus
  phone: string | null
  website: string | null
  source_url?: string | null
  import_source?: string | null
  city?: string | null
  address?: string | null
  yandex_maps_url: string | null
  notes: string | null
  next_action_at: string | null
  created_at: string
  updated_at: string
  version: number
  is_deleted: boolean
  archived_at: string | null
  manually_queued_for_calls: boolean
  excluded_from_automatic_calls: boolean
}

export function isCallLead(lead: Lead): boolean {
  return !lead.archived_at && (lead.manually_queued_for_calls
    || (lead.status === 'waiting' && !lead.excluded_from_automatic_calls))
}

export type LeadDraft = Pick<Lead,
  'company_name' | 'niche' | 'priority' | 'status' | 'website_status' |
  'phone' | 'website' | 'yandex_maps_url' | 'notes' | 'next_action_at'
>

export interface Workspace {
  id: string
  name: string
  invite_code: string
  owner_id: string
}

export const statusLabels: Record<LeadStatus, string> = {
  newLead: 'Новый', inProgress: 'В работе', waiting: 'Отложен',
  offer: 'Оффер', rejected: 'Отказ',
}
export const priorityLabels: Record<LeadPriority, string> = {
  low: 'Низкий', normal: 'Обычный', high: 'Высокий',
}
export const websiteStatusLabels: Record<WebsiteStatus, string> = {
  unknown: 'Не проверен', hasWebsite: 'Есть сайт',
  poorWebsite: 'Слабый сайт', noWebsite: 'Нет сайта',
}
