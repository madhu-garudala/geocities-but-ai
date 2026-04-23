export { AgentDO } from './agent-do'

import { AGENTS, getAgent, getPrev, getNext, getRandom } from './agents'
import { generateGuestbookEntry } from './anthropic'
import {
  appendGuestbookEntry,
  getAllRecentEntries,
  getActivityFeed,
  getGuestbook,
  getHitCount,
  incrementHitCount,
} from './agent-do'
import { renderHomepage, renderAgentPage, renderActivityPage, type VideoStatus } from './html'
import { submitVideoGeneration, getFalStatus, getFalResult } from './fal'
import { createMuxAsset, getMuxAsset } from './mux'

export interface Env {
  AGENT_DO: DurableObjectNamespace
  KV: KVNamespace
  ANTHROPIC_API_KEY: string
  MUX_TOKEN_ID: string
  MUX_TOKEN_SECRET: string
  FAL_KEY: string
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function ensureAgentStarted(env: Env, slug: string): Promise<void> {
  const id = env.AGENT_DO.idFromName(slug)
  const stub = env.AGENT_DO.get(id)
  await stub.fetch(`http://do/init?slug=${slug}`, { method: 'POST' })
}

async function getVideoState(kv: KVNamespace, slug: string): Promise<{ status: VideoStatus; playbackId: string | null }> {
  const status = (await kv.get(`video:${slug}:status`) ?? 'none') as VideoStatus
  const playbackId = await kv.get(`video:${slug}:playbackId`)
  return { status, playbackId }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const { pathname } = url
    const method = request.method

    // GET / or /agents — homepage
    if (method === 'GET' && (pathname === '/' || pathname === '/agents')) {
      const [recentEntries, activity] = await Promise.all([
        getAllRecentEntries(env.KV),
        getActivityFeed(env.KV),
      ])
      return html(renderHomepage(AGENTS, recentEntries, activity))
    }

    // GET /activity — live activity feed
    if (method === 'GET' && pathname === '/activity') {
      const activity = await getActivityFeed(env.KV)
      return html(renderActivityPage(activity, AGENTS))
    }

    // GET /agent/:slug — individual agent page
    const agentPageMatch = pathname.match(/^\/agent\/([a-z-]+)$/)
    if (method === 'GET' && agentPageMatch) {
      const slug = agentPageMatch[1]
      const agent = getAgent(slug)
      if (!agent) return html('<h1>Agent not found</h1>', 404)

      const [entries, hitCount, , videoState, activity] = await Promise.all([
        getGuestbook(env.KV, slug),
        getHitCount(env.KV, slug),
        ensureAgentStarted(env, slug),
        getVideoState(env.KV, slug),
        getActivityFeed(env.KV),
      ])
      ctx.waitUntil(incrementHitCount(env.KV, slug).catch(() => {}))

      const prev = getPrev(slug)
      const next = getNext(slug)
      const random = getRandom(slug)

      return html(renderAgentPage(
        agent, entries, hitCount, AGENTS, prev, next, random,
        videoState.playbackId, videoState.status, activity,
      ))
    }

    // POST /agent/:slug/generate-video — kick off fal.ai video generation
    const genVideoMatch = pathname.match(/^\/agent\/([a-z-]+)\/generate-video$/)
    if (method === 'POST' && genVideoMatch) {
      const slug = genVideoMatch[1]
      const agent = getAgent(slug)
      if (!agent) return json({ ok: false, error: 'agent not found' }, 404)

      const currentStatus = await env.KV.get(`video:${slug}:status`)
      if (currentStatus === 'generating' || currentStatus === 'mux-processing') {
        return json({ ok: false, error: 'already in progress' })
      }

      try {
        const falResult = await submitVideoGeneration(agent.videoPrompt, env.FAL_KEY)
        await env.KV.put(`video:${slug}:status`, 'generating')
        await env.KV.put(`video:${slug}:falStatusUrl`, falResult.status_url)
        await env.KV.put(`video:${slug}:falResponseUrl`, falResult.response_url)
        return json({ ok: true, status: 'generating' })
      } catch (e) {
        await env.KV.put(`video:${slug}:status`, 'error')
        return json({ ok: false, error: String(e) }, 500)
      }
    }

    // GET /agent/:slug/video-status — poll fal.ai + MUX and advance state
    const videoStatusMatch = pathname.match(/^\/agent\/([a-z-]+)\/video-status$/)
    if (method === 'GET' && videoStatusMatch) {
      const slug = videoStatusMatch[1]
      const status = (await env.KV.get(`video:${slug}:status`) ?? 'none') as VideoStatus
      const playbackId = await env.KV.get(`video:${slug}:playbackId`)

      if (status === 'ready' && playbackId) {
        return json({ status: 'ready', playbackId })
      }

      if (status === 'generating') {
        const [falStatusUrl, falResponseUrl] = await Promise.all([
          env.KV.get(`video:${slug}:falStatusUrl`),
          env.KV.get(`video:${slug}:falResponseUrl`),
        ])
        if (!falStatusUrl || !falResponseUrl) return json({ status: 'error' })

        try {
          const falStatus = await getFalStatus(falStatusUrl, env.FAL_KEY)

          if (falStatus.status === 'COMPLETED') {
            const videoUrl = await getFalResult(falResponseUrl, env.FAL_KEY)
            const assetId = await createMuxAsset(videoUrl, env.MUX_TOKEN_ID, env.MUX_TOKEN_SECRET)
            await env.KV.put(`video:${slug}:status`, 'mux-processing')
            await env.KV.put(`video:${slug}:muxAssetId`, assetId)
            return json({ status: 'mux-processing' })
          } else if (falStatus.status === 'FAILED') {
            await env.KV.put(`video:${slug}:status`, 'error')
            return json({ status: 'error' })
          }
          return json({ status: 'generating' })
        } catch (e) {
          return json({ status: 'generating', note: String(e) })
        }
      }

      if (status === 'mux-processing') {
        const assetId = await env.KV.get(`video:${slug}:muxAssetId`)
        if (!assetId) return json({ status: 'error' })

        try {
          const asset = await getMuxAsset(assetId, env.MUX_TOKEN_ID, env.MUX_TOKEN_SECRET)

          if (asset.status === 'ready' && asset.playback_ids?.[0]) {
            const pid = asset.playback_ids[0].id
            await env.KV.put(`video:${slug}:status`, 'ready')
            await env.KV.put(`video:${slug}:playbackId`, pid)
            return json({ status: 'ready', playbackId: pid })
          } else if (asset.status === 'errored') {
            await env.KV.put(`video:${slug}:status`, 'error')
            return json({ status: 'error' })
          }
          return json({ status: 'mux-processing' })
        } catch (e) {
          return json({ status: 'mux-processing', note: String(e) })
        }
      }

      return json({ status })
    }

    // POST /agent/:slug/visit — trigger a visit from another agent
    const visitMatch = pathname.match(/^\/agent\/([a-z-]+)\/visit$/)
    if (method === 'POST' && visitMatch) {
      const slug = visitMatch[1]
      const target = getAgent(slug)
      if (!target) return json({ ok: false, error: 'target not found' }, 404)

      let body: { visitorSlug?: string } = {}
      try {
        body = (await request.json()) as { visitorSlug?: string }
      } catch {
        return json({ ok: false, error: 'invalid json' }, 400)
      }

      const visitorSlug = body.visitorSlug
      if (!visitorSlug) return json({ ok: false, error: 'visitorSlug required' }, 400)
      const visitor = getAgent(visitorSlug)
      if (!visitor) return json({ ok: false, error: 'visitor not found' }, 404)

      const id = env.AGENT_DO.idFromName(slug)
      const stub = env.AGENT_DO.get(id)
      const res = await stub.fetch('http://do/visit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visitorSlug }),
      })

      const result = await res.json()
      return json(result, res.status)
    }

    // POST /seed — one-time guestbook seeding
    if (method === 'POST' && pathname === '/seed') {
      const already = await env.KV.get('seeded')
      if (already) return json({ ok: false, message: 'already seeded' })

      const errors: string[] = []

      for (const target of AGENTS) {
        const visitors = [...AGENTS].filter((a) => a.slug !== target.slug)
        const picked: typeof AGENTS = []
        const pool = [...visitors]
        while (picked.length < 5 && pool.length > 0) {
          const i = Math.floor(Math.random() * pool.length)
          picked.push(pool.splice(i, 1)[0])
        }

        for (const visitor of picked) {
          try {
            const text = await generateGuestbookEntry(visitor, target, env.ANTHROPIC_API_KEY)
            const hoursAgo = Math.random() * 24
            const ts = new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString()
            await appendGuestbookEntry(env.KV, target.slug, {
              authorSlug: visitor.slug,
              authorName: visitor.name,
              authorEmoji: visitor.emoji,
              text,
              timestamp: ts,
            })
          } catch (e) {
            errors.push(`${visitor.slug}→${target.slug}: ${String(e)}`)
          }
        }
      }

      await env.KV.put('seeded', '1')
      return json({ ok: true, errors })
    }

    // POST /kickstart — force-init all agent DOs so alarms start immediately
    if (method === 'POST' && pathname === '/kickstart') {
      await Promise.all(AGENTS.map((a) => ensureAgentStarted(env, a.slug)))
      return json({ ok: true, message: `${AGENTS.length} agents kickstarted` })
    }

    // POST /pause-all — cancel all agent alarms
    if (method === 'POST' && pathname === '/pause-all') {
      await Promise.all(AGENTS.map((a) => {
        const id = env.AGENT_DO.idFromName(a.slug)
        return env.AGENT_DO.get(id).fetch('http://do/pause', { method: 'POST' })
      }))
      return json({ ok: true, message: `${AGENTS.length} agents paused` })
    }

    // POST /resume-all — restart all agent alarms
    if (method === 'POST' && pathname === '/resume-all') {
      await Promise.all(AGENTS.map((a) => {
        const id = env.AGENT_DO.idFromName(a.slug)
        return env.AGENT_DO.get(id).fetch('http://do/resume', { method: 'POST' })
      }))
      return json({ ok: true, message: `${AGENTS.length} agents resumed` })
    }

    // POST /reset-seed — dev only
    if (method === 'POST' && pathname === '/reset-seed') {
      await env.KV.delete('seeded')
      return json({ ok: true })
    }

    // POST /reset-videos — clear all video state so generation can restart
    if (method === 'POST' && pathname === '/reset-videos') {
      await Promise.all(AGENTS.flatMap((a) => [
        env.KV.delete(`video:${a.slug}:status`),
        env.KV.delete(`video:${a.slug}:falStatusUrl`),
        env.KV.delete(`video:${a.slug}:falResponseUrl`),
        env.KV.delete(`video:${a.slug}:muxAssetId`),
        env.KV.delete(`video:${a.slug}:playbackId`),
      ]))
      return json({ ok: true, message: 'all video state cleared' })
    }

    // GET /hits/:slug — utility
    const hitsMatch = pathname.match(/^\/hits\/([a-z-]+)$/)
    if (method === 'GET' && hitsMatch) {
      const slug = hitsMatch[1]
      const hits = await getHitCount(env.KV, slug)
      return json({ slug, hits })
    }

    return html('<h1>Not found</h1>', 404)
  },
}
