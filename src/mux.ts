const MUX_BASE = 'https://api.mux.com'

function muxAuth(tokenId: string, tokenSecret: string): string {
  return 'Basic ' + btoa(`${tokenId}:${tokenSecret}`)
}

export interface MuxAsset {
  id: string
  status: 'preparing' | 'ready' | 'errored'
  playback_ids?: Array<{ id: string; policy: string }>
}

export async function createMuxAsset(videoUrl: string, tokenId: string, tokenSecret: string): Promise<string> {
  const res = await fetch(`${MUX_BASE}/video/v1/assets`, {
    method: 'POST',
    headers: {
      authorization: muxAuth(tokenId, tokenSecret),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      input: [{ url: videoUrl }],
      playback_policy: ['public'],
      video_quality: 'basic',
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`MUX create asset error ${res.status}: ${err}`)
  }

  const data = (await res.json()) as { data: MuxAsset }
  return data.data.id
}

export async function getMuxAsset(assetId: string, tokenId: string, tokenSecret: string): Promise<MuxAsset> {
  const res = await fetch(`${MUX_BASE}/video/v1/assets/${assetId}`, {
    headers: { authorization: muxAuth(tokenId, tokenSecret) },
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`MUX get asset error ${res.status}: ${err}`)
  }

  const data = (await res.json()) as { data: MuxAsset }
  return data.data
}
