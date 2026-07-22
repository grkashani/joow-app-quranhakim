import { describe, it, expect, vi } from 'vitest'
import { createOpenAiTranslateAdapter } from './translate-openai.mjs'

const OK = { choices: [{ message: { content: 'In the name of God' } }] }
const okRes = (json) => ({ ok: true, json: async () => json })
const errRes = (status) => ({ ok: false, status, text: async () => 'nope' })

describe('OpenAiTranslateAdapter', () => {
  it('id is stable', () => {
    expect(createOpenAiTranslateAdapter().id()).toBe('openai-compat')
  })

  it('posts the exact chat-completions request (URL, Bearer, body model + messages)', async () => {
    const fetchImpl = vi.fn(async () => okRes(OK))
    const a = createOpenAiTranslateAdapter({
      fetch: fetchImpl,
      apiKey: 'K',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    })
    await a.translate('به نام خدا', { src: 'fa', dst: 'en' })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer K')
    expect(init.headers['content-type']).toBe('application/json')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('gpt-4o-mini')
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[0].content).toMatch(/tafsir/i)
    expect(body.messages[1].role).toBe('user')
    // carries the source text + resolved src/dst language names
    expect(body.messages[1].content).toContain('به نام خدا')
    expect(body.messages[1].content).toContain('Persian')
    expect(body.messages[1].content).toContain('English')
  })

  it('parses choices[0].message.content and reports providerMeta', async () => {
    const a = createOpenAiTranslateAdapter({ fetch: async () => okRes(OK), model: 'gpt-4o-mini' })
    const r = await a.translate('x', { src: 'fa', dst: 'en' })
    expect(r.text).toBe('In the name of God')
    expect(r.providerMeta).toEqual({ provider: 'openai-compat', model: 'gpt-4o-mini' })
  })

  it('derives the URL from baseUrl (free/local path) and strips a trailing slash', async () => {
    const fetchImpl = vi.fn(async () => okRes(OK))
    const a = createOpenAiTranslateAdapter({ fetch: fetchImpl, baseUrl: 'http://localhost:11434/v1/' })
    await a.translate('x', { src: 'fa', dst: 'en' })
    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions')
  })

  it('defaults apiKey to a local placeholder (no real key needed)', async () => {
    const fetchImpl = vi.fn(async () => okRes(OK))
    const a = createOpenAiTranslateAdapter({ fetch: fetchImpl })
    await a.translate('x', { src: 'fa', dst: 'en' })
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer local')
  })

  it('returns empty text when the model yields no content', async () => {
    const a = createOpenAiTranslateAdapter({ fetch: async () => okRes({ choices: [] }) })
    const r = await a.translate('x', { src: 'fa', dst: 'en' })
    expect(r.text).toBe('')
  })

  it('throws a status-carrying error on !ok (so the registry can fall back)', async () => {
    const a = createOpenAiTranslateAdapter({ fetch: async () => errRes(429) })
    await expect(a.translate('x', { src: 'fa', dst: 'en' })).rejects.toMatchObject({ status: 429 })
  })
})
