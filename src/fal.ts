const FAL_QUEUE_BASE = 'https://queue.fal.run'
const MODEL = 'fal-ai/kling-video/v1.6/standard/text-to-video'

export interface FalSubmitResult {
  request_id: string
  status_url: string
  response_url: string
}

export interface FalStatusResult {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED'
}

export interface FalVideoResult {
  video: { url: string }
}

export async function submitVideoGeneration(prompt: string, apiKey: string): Promise<FalSubmitResult> {
  const res = await fetch(`${FAL_QUEUE_BASE}/${MODEL}`, {
    method: 'POST',
    headers: {
      authorization: `Key ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      duration: '5',
      aspect_ratio: '16:9',
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`fal.ai submit error ${res.status}: ${err}`)
  }

  const data = (await res.json()) as FalSubmitResult
  return data
}

export async function getFalStatus(statusUrl: string, apiKey: string): Promise<FalStatusResult> {
  const res = await fetch(statusUrl, {
    headers: { authorization: `Key ${apiKey}` },
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`fal.ai status error ${res.status}: ${err}`)
  }

  return res.json() as Promise<FalStatusResult>
}

export async function getFalResult(responseUrl: string, apiKey: string): Promise<string> {
  const res = await fetch(responseUrl, {
    headers: { authorization: `Key ${apiKey}` },
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`fal.ai result error ${res.status}: ${err}`)
  }

  const data = (await res.json()) as FalVideoResult
  return data.video.url
}
