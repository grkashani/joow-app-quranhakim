import { describe, it, expect, vi } from 'vitest'
import { createAnthropicTranslateAdapter } from './translate-anthropic.mjs'

const AN_RESPONSE = { content: [{ type: 'text', text: '  In the name of Allah  ' }] }
const okRes = (json) => ({ ok: true, json: async () => json })
const errRes = (status) => ({ ok: false, status, text: async () => 'nope' })

describe('AnthropicTranslateAdapter', () => {
  it('id is stable', () => {
    expect(createAnthropicTranslateAdapter({ apiKey: 'K' }).id()).toBe('anthropic')
  })

  it('posts the exact Messages request (endpoint, headers, prompt, model)', async () => {
    const fetchImpl = vi.fn(async () => okRes(AN_RESPONSE))
    const a = createAnthropicTranslateAdapter({ fetch: fetchImpl, apiKey: 'K', model: 'claude-haiku-4-5-20251001' })
    await a.translate('بسم الله', { src: 'ar', dst: 'en' })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.method).toBe('POST')
    expect(init.headers['x-api-key']).toBe('K')
    expect(init.headers['anthropic-version']).toBe('2023-06-01')
    expect(init.headers['content-type']).toBe('application/json')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('claude-haiku-4-5-20251001')
    expect(body.max_tokens).toBe(4096)
    const prompt = body.messages[0].content
    expect(body.messages[0].role).toBe('user')
    expect(prompt).toContain('from ar to en') // src + dst woven into the prompt
    expect(prompt).toContain('بسم الله') // the source text appended
    expect(prompt).toContain('Output ONLY the translation')
  })

  it('returns the trimmed text with providerMeta', async () => {
    const a = createAnthropicTranslateAdapter({ fetch: async () => okRes(AN_RESPONSE), apiKey: 'K', model: 'M' })
    const r = await a.translate('x', { src: 'ar', dst: 'en' })
    expect(r).toEqual({ text: 'In the name of Allah', providerMeta: { provider: 'anthropic', model: 'M' } })
  })

  it('returns null when no apiKey (translation disabled), without calling fetch', async () => {
    const fetchImpl = vi.fn(async () => okRes(AN_RESPONSE))
    const a = createAnthropicTranslateAdapter({ fetch: fetchImpl })
    expect(await a.translate('x', { src: 'ar', dst: 'en' })).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns null when the model yields no text (matches |\| null)', async () => {
    const a = createAnthropicTranslateAdapter({ fetch: async () => okRes({ content: [] }), apiKey: 'K' })
    expect(await a.translate('x', { src: 'ar', dst: 'en' })).toBeNull()
  })

  it('throws a status-carrying error on !ok (so the registry can fall back)', async () => {
    const a = createAnthropicTranslateAdapter({ fetch: async () => errRes(429), apiKey: 'K' })
    await expect(a.translate('x', { src: 'ar', dst: 'en' })).rejects.toMatchObject({ status: 429, message: 'translate 429' })
  })
})
