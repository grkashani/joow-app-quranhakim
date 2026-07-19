// quranGPT — a Quran-scoped assistant.
//
// If VITE_GPT_ENDPOINT is set, questions are sent to that backend (which runs an
// LLM with Quran RAG). Otherwise it falls back to a fully-local, citation-based
// answer: it retrieves the most relevant ayahs and presents them — no hallucination,
// every claim is a real ayah. This keeps the app useful offline and safe on scripture.
import { rankAyahs } from './search.js'

const ENDPOINT = import.meta.env.VITE_GPT_ENDPOINT || ''

export async function askQuranGpt(question, history = []) {
  const sources = await rankAyahs(question, { limit: 5 })

  if (ENDPOINT) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          history,
          context: sources.map((s) => ({ surah: s.surah, ayah: s.n, ar: s.ar, fa: s.fa, en: s.en })),
        }),
      })
      if (res.ok) {
        const data = await res.json()
        return { answer: data.answer, sources: data.sources || sources, mode: 'llm' }
      }
    } catch {
      /* fall through to local retrieval */
    }
  }

  // Local retrieval fallback.
  if (!sources.length) {
    return {
      answer: 'برای این پرسش آیهٔ مرتبطی پیدا نشد. لطفاً واژه‌های کلیدی پرسش را ساده‌تر یا مشخص‌تر بنویسید.',
      sources: [],
      mode: 'retrieval',
    }
  }
  return {
    answer:
      'بر پایهٔ متن قرآن، آیه‌های مرتبط با پرسش شما در ادامه آمده است (پاسخ مستند به آیات، بدون تفسیر افزوده):',
    sources,
    mode: 'retrieval',
  }
}
