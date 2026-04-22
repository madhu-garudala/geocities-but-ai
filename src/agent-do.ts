import { AGENTS, getAgent, getRandom } from './agents'
import { generateGuestbookEntry } from './anthropic'
import type { GuestbookEntry } from './html'

export interface Env {
  AGENT_DO: DurableObjectNamespace
  KV: KVNamespace
  ANTHROPIC_API_KEY: string
}

export interface ActivityEvent {
  visitorSlug: string
  visitorName: string
  visitorEmoji: string
  targetSlug: string
  targetName: string
  targetEmoji: string
  timestamp: string
}

const ALARM_INTERVAL_MS = 5 * 60 * 1000

export class AgentDO implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/init') {
      const slug = url.searchParams.get('slug')
      if (!slug) return new Response('missing slug', { status: 400 })

      await this.state.storage.put('slug', slug)

      const existing = await this.state.storage.getAlarm()
      if (existing === null) {
        await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS)
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
    }

    if (request.method === 'POST' && url.pathname === '/visit') {
      const body = (await request.json()) as { visitorSlug: string }
      const mySlug = await this.state.storage.get<string>('slug')
      if (!mySlug) return new Response('uninitialized', { status: 500 })

      const visitor = getAgent(body.visitorSlug)
      const target = getAgent(mySlug)
      if (!visitor || !target) return new Response('unknown agent', { status: 400 })

      const ts = new Date().toISOString()
      const text = await generateGuestbookEntry(visitor, target, this.env.ANTHROPIC_API_KEY)
      await appendGuestbookEntry(this.env.KV, mySlug, {
        authorSlug: visitor.slug,
        authorName: visitor.name,
        authorEmoji: visitor.emoji,
        text,
        timestamp: ts,
      })
      await appendActivity(this.env.KV, {
        visitorSlug: visitor.slug,
        visitorName: visitor.name,
        visitorEmoji: visitor.emoji,
        targetSlug: target.slug,
        targetName: target.name,
        targetEmoji: target.emoji,
        timestamp: ts,
      })

      return new Response(JSON.stringify({ ok: true, text }), { headers: { 'content-type': 'application/json' } })
    }

    return new Response('not found', { status: 404 })
  }

  async alarm(): Promise<void> {
    const mySlug = await this.state.storage.get<string>('slug')
    if (!mySlug) return

    const me = getAgent(mySlug)
    if (!me) return

    const target = getRandom(mySlug)
    const ts = new Date().toISOString()

    try {
      const text = await generateGuestbookEntry(me, target, this.env.ANTHROPIC_API_KEY)
      await appendGuestbookEntry(this.env.KV, target.slug, {
        authorSlug: me.slug,
        authorName: me.name,
        authorEmoji: me.emoji,
        text,
        timestamp: ts,
      })
      await appendActivity(this.env.KV, {
        visitorSlug: me.slug,
        visitorName: me.name,
        visitorEmoji: me.emoji,
        targetSlug: target.slug,
        targetName: target.name,
        targetEmoji: target.emoji,
        timestamp: ts,
      })
    } catch {
      // swallow errors — alarm must reschedule regardless
    }

    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS)
  }
}

export async function appendActivity(kv: KVNamespace, event: ActivityEvent): Promise<void> {
  const raw = await kv.get('activity:feed')
  const events: ActivityEvent[] = raw ? (JSON.parse(raw) as ActivityEvent[]) : []
  events.unshift(event)
  if (events.length > 20) events.length = 20
  await kv.put('activity:feed', JSON.stringify(events))
}

export async function getActivityFeed(kv: KVNamespace): Promise<ActivityEvent[]> {
  const raw = await kv.get('activity:feed')
  return raw ? (JSON.parse(raw) as ActivityEvent[]) : []
}

export async function appendGuestbookEntry(kv: KVNamespace, targetSlug: string, entry: GuestbookEntry): Promise<void> {
  const key = `guestbook:${targetSlug}`
  const raw = await kv.get(key)
  const entries: GuestbookEntry[] = raw ? (JSON.parse(raw) as GuestbookEntry[]) : []
  entries.unshift(entry)
  if (entries.length > 20) entries.length = 20
  await kv.put(key, JSON.stringify(entries))
}

export async function getGuestbook(kv: KVNamespace, slug: string): Promise<GuestbookEntry[]> {
  const raw = await kv.get(`guestbook:${slug}`)
  return raw ? (JSON.parse(raw) as GuestbookEntry[]) : []
}

export async function getHitCount(kv: KVNamespace, slug: string): Promise<number> {
  const raw = await kv.get(`hits:${slug}`)
  return raw ? parseInt(raw, 10) : 0
}

export async function incrementHitCount(kv: KVNamespace, slug: string): Promise<number> {
  const current = await getHitCount(kv, slug)
  const next = current + 1
  await kv.put(`hits:${slug}`, String(next))
  return next
}

export async function getAllRecentEntries(
  kv: KVNamespace,
): Promise<Array<GuestbookEntry & { targetSlug: string }>> {
  const results: Array<GuestbookEntry & { targetSlug: string }> = []
  for (const agent of AGENTS) {
    const entries = await getGuestbook(kv, agent.slug)
    for (const e of entries.slice(0, 2)) {
      results.push({ ...e, targetSlug: agent.slug })
    }
  }
  results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  return results.slice(0, 10)
}
