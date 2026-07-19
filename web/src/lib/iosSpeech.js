// iosSpeech.js — thin bridge to the native iOS `Speech` Capacitor plugin
// (ios/App/App/SpeechToTextPlugin.swift). On-device long-form transcription of a
// remote mp3 via SpeechAnalyzer (iOS 26+) / SFSpeechRecognizer-chunked (iOS < 26).
//
// IMPORTANT: Apple has NO on-device Persian (fa-IR) model, and the iOS Simulator
// cannot produce a real transcript at all. So this is a best-effort accelerator for
// Apple-supported locales (ar-SA, en-US, …) only. For fa-IR — and on Simulator — the
// native call rejects with code "locale-unsupported"; callers should catch that and
// fall back to the server transcription (see transcribe.js getServerTranscript()).

import { registerPlugin, Capacitor } from '@capacitor/core'

// The JS name MUST equal `jsName` in SpeechToTextPlugin.swift ("Speech").
const Speech = registerPlugin('Speech')

/** True only when the native iOS Speech plugin is actually present. */
export function isIosSpeechAvailable() {
  return Capacitor.getPlatform() === 'ios' && Capacitor.isPluginAvailable('Speech')
}

/**
 * Ask the native side whether `locale` can be transcribed on-device on THIS device.
 * Returns { supported: boolean, reason: string }. Never throws; on non-iOS returns
 * { supported: false, reason: 'not-ios' }. Useful to decide up-front between
 * on-device and server, e.g. reason === 'no-assets-on-this-device' means Simulator.
 */
export async function isLocaleSupportedOnDevice(locale) {
  if (!isIosSpeechAvailable()) return { supported: false, reason: 'not-ios' }
  try {
    return await Speech.isLocaleSupported({ locale })
  } catch {
    return { supported: false, reason: 'error' }
  }
}

/**
 * Transcribe a remote mp3 fully on-device.
 * @param {string} url    - https URL of the audio (e.g. a tafsir mp3).
 * @param {string} locale - BCP-47 locale, e.g. "fa-IR", "ar-SA", "en-US".
 * @returns {Promise<string>} the full transcript text.
 * @throws  On non-iOS: Error('ios-only'). On unsupported locale / Simulator:
 *          Error with .code === 'locale-unsupported' (catch this to fall back to server).
 *          Other codes: 'not-authorized', 'download-failed', 'recognizer-unavailable',
 *          'empty-result', 'transcribe-failed'.
 */
export async function transcribeOnDevice(url, locale) {
  if (!isIosSpeechAvailable()) {
    const e = new Error('On-device transcription is only available in the iOS app.')
    e.code = 'ios-only'
    throw e
  }
  try {
    const { text } = await Speech.transcribe({ url, locale })
    return (text || '').trim()
  } catch (err) {
    // Capacitor surfaces the native reject code on err.code (and err.data.code).
    const code = err?.code || err?.data?.code || 'transcribe-failed'
    const e = new Error(err?.message || 'Transcription failed.')
    e.code = code
    throw e
  }
}

export default { isIosSpeechAvailable, isLocaleSupportedOnDevice, transcribeOnDevice }
