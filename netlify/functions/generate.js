const ALLOWED_MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS_CAP = 4000

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return json({ error: 'Server not configured' }, 500)

  let body
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  // Lock down model, cap tokens, force streaming so we never trip the timeout
  body.model = ALLOWED_MODEL
  body.max_tokens = Math.min(body.max_tokens || MAX_TOKENS_CAP, MAX_TOKENS_CAP)
  body.stream = true

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })

    if (!upstream.ok) {
      const errText = await upstream.text()
      return new Response(errText, {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Stream the SSE response straight through to the browser
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    })
  } catch (e) {
    return json({ error: 'Upstream error', detail: e.message }, 502)
  }
}

export const config = { path: '/api/generate' }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}