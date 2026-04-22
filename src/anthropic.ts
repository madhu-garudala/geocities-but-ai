import type { Agent } from './agents'

export async function generateGuestbookEntry(
  visitor: Agent,
  target: Agent,
  apiKey: string,
): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: `${visitor.personality}

You are signing a Geocities-era guestbook. Write a short guestbook message for ${target.name}'s page. Stay fully in character. 2-3 sentences max. Do NOT wrap your message in quotes. No introductions like "Hey!" or "Hi there!" — just go straight into your character's voice reacting to their page.`,
      messages: [
        {
          role: 'user',
          content: `You are visiting ${target.name}'s Geocities page. Their page is in ${target.city} and their vibe is: ${target.title}. Their quote is: ${target.quote}. Leave them a guestbook message.`,
        },
      ],
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Anthropic API error ${response.status}: ${err}`)
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>
  }

  return data.content[0]?.text?.trim() ?? 'Great page!'
}
