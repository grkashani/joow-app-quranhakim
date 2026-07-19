//
//  SpeechToTextPlugin.swift
//  App (JoowQuran — com.joow.quran)
//
//  Custom Capacitor 8 plugin: JS calls `Speech.transcribe({ url, locale }) -> { text }`.
//  Downloads a remote mp3, requests Speech authorization, and transcribes ON-DEVICE:
//    • iOS 26+  → SpeechAnalyzer + SpeechTranscriber (long-form, no 1-minute cap)
//    • iOS < 26 → SFSpeechRecognizer with ~30s AVAudioFile chunking (on-device)
//
//  ── LOAD-BEARING CAVEATS (verified) ──────────────────────────────────────────────
//  1. PERSIAN (fa-IR) IS NOT SUPPORTED on-device by ANY Apple speech framework.
//     SpeechTranscriber.supportedLocales has no `fa`, and SFSpeechRecognizer has no
//     on-device Persian model. For fa-IR this plugin deliberately rejects with the
//     error code "locale-unsupported" so the JS layer can fall back to the existing
//     server transcription (ElevenLabs) path — see src/lib/iosSpeech.js.
//  2. THE iOS SIMULATOR CANNOT PRODUCE A REAL ON-DEVICE TRANSCRIPT.
//     • SpeechTranscriber.supportedLocales returns [] on Simulator (assets absent).
//     • SFSpeechRecognizer returns error 1107 with requiresOnDeviceRecognition.
//     On the iPhone 17 simulator you CAN exercise: build, bridge, authorization, the
//     supportedLocales guard, and the fa-IR → "locale-unsupported" → server fallback.
//     A real on-device transcript must be proven on a PHYSICAL iOS 26 iPhone, and only
//     for an Apple-supported locale (e.g. ar-SA, en-US).
//  ─────────────────────────────────────────────────────────────────────────────────

import Foundation
import Capacitor
import Speech
import AVFoundation

@objc(SpeechToTextPlugin)
public class SpeechToTextPlugin: CAPPlugin, CAPBridgedPlugin {

    // These three drive Capacitor 8 registration (no Obj-C .m macro needed on SPM).
    public let identifier = "SpeechToTextPlugin"
    public let jsName = "Speech"                       // must match registerPlugin("Speech") in JS
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "transcribe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isLocaleSupported", returnType: CAPPluginReturnPromise)
    ]

    /// JS: Speech.transcribe({ url, locale }) -> { text }
    @objc func transcribe(_ call: CAPPluginCall) {
        guard let urlStr = call.getString("url"),
              let remoteURL = URL(string: urlStr),
              remoteURL.scheme?.hasPrefix("http") == true else {
            call.reject("missing-url", "A valid https `url` is required.")
            return
        }
        let locale = call.getString("locale") ?? "en-US"

        Task {
            do {
                let text = try await Transcription.run(remoteURL: remoteURL, localeID: locale)
                call.resolve(["text": text])
            } catch let e as TranscribeError {
                // Structured code so JS can branch (esp. "locale-unsupported" → server fallback).
                call.reject(e.message, e.code, e, ["code": e.code])
            } catch {
                call.reject(error.localizedDescription, "transcribe-failed", error)
            }
        }
    }

    /// JS: Speech.isLocaleSupported({ locale }) -> { supported, reason }
    /// Lets the web layer decide up-front whether to attempt on-device or go straight to server.
    @objc func isLocaleSupported(_ call: CAPPluginCall) {
        let locale = call.getString("locale") ?? "en-US"
        Task {
            let (supported, reason) = await Transcription.localeSupport(localeID: locale)
            call.resolve(["supported": supported, "reason": reason])
        }
    }
}

// MARK: - Error type

struct TranscribeError: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }

    static let notAuthorized      = TranscribeError(code: "not-authorized",      message: "Speech recognition authorization was denied.")
    static let localeUnsupported  = TranscribeError(code: "locale-unsupported",  message: "This locale has no on-device speech model on this device.")
    static let recognizerUnavail  = TranscribeError(code: "recognizer-unavailable", message: "Speech recognizer is unavailable (Simulator or offline model missing).")
    static let downloadFailed     = TranscribeError(code: "download-failed",     message: "Could not download the audio file.")
    static let emptyResult        = TranscribeError(code: "empty-result",        message: "Transcription produced no text.")
}

// MARK: - Transcription core

enum Transcription {

    // Entry point used by the plugin.
    static func run(remoteURL: URL, localeID: String) async throws -> String {
        try await authorize()

        // Check locale support BEFORE downloading. The primary use case (fa-IR) and the
        // Simulator both reject here — downloading a 5–20 min mp3 first would waste tens of
        // MB and many seconds on every ayah only to throw it away.
        let (supported, _) = await localeSupport(localeID: localeID)
        guard supported else { throw TranscribeError.localeUnsupported }

        let localURL = try await download(remoteURL)
        defer { try? FileManager.default.removeItem(at: localURL) }

        if #available(iOS 26.0, *) {
            return try await modern(localURL: localURL, localeID: localeID)
        } else {
            return try await legacy(localURL: localURL, localeID: localeID)
        }
    }

    /// Report whether the locale can be transcribed on-device on THIS device, without doing work.
    static func localeSupport(localeID: String) async -> (Bool, String) {
        if #available(iOS 26.0, *) {
            // `Locale.identifier(.bcp47)` is iOS 16+, so it lives inside this iOS 26 branch.
            let bcp47 = Locale(identifier: localeID).identifier(.bcp47)
            let supported = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }
            if supported.isEmpty { return (false, "no-assets-on-this-device") } // Simulator
            return supported.contains(bcp47) ? (true, "speechanalyzer")
                                             : (false, "locale-unsupported")
        } else {
            guard let r = SFSpeechRecognizer(locale: Locale(identifier: localeID)) else {
                return (false, "locale-unsupported")
            }
            return r.supportsOnDeviceRecognition ? (true, "sfspeech-ondevice")
                                                 : (false, "locale-unsupported")
        }
    }

    // MARK: authorization

    static func authorize() async throws {
        let current = SFSpeechRecognizer.authorizationStatus()
        if current == .authorized { return }
        let status = await withCheckedContinuation { (cont: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0) }
        }
        guard status == .authorized else { throw TranscribeError.notAuthorized }
    }

    // MARK: download to temp

    static func download(_ url: URL) async throws -> URL {
        do {
            let (tmp, response) = try await URLSession.shared.download(from: url)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                throw TranscribeError.downloadFailed
            }
            let dest = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
                .appendingPathExtension("mp3")
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: tmp, to: dest)
            return dest
        } catch let e as TranscribeError {
            throw e
        } catch {
            throw TranscribeError.downloadFailed
        }
    }

    // MARK: iOS 26+ — SpeechAnalyzer + SpeechTranscriber (long-form, on-device)

    @available(iOS 26.0, *)
    static func modern(localURL: URL, localeID: String) async throws -> String {
        let locale = Locale(identifier: localeID)
        let want = locale.identifier(.bcp47)

        // On Simulator supportedLocales == [] → this guard trips → JS falls back to server.
        let supported = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }
        guard supported.contains(want) else { throw TranscribeError.localeUnsupported }

        // `.transcription` = fully on-device, final (non-volatile) results — the right preset
        // for a file. NOTE: `.offlineTranscription` (used in beta blog posts / both research
        // reports) does NOT exist in the shipped iOS 26 SDK; the offline preset is `.transcription`.
        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)

        // Ensure the per-locale on-device model is installed (downloads once if needed).
        let installed = Set(await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) })
        if !installed.contains(want) {
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                try await request.downloadAndInstall()
            }
        }

        let analyzer = SpeechAnalyzer(modules: [transcriber])

        // Consume results CONCURRENTLY so a long file cannot stall on a bounded stream.
        let collector = Task { () -> AttributedString in
            var acc = AttributedString("")
            for try await result in transcriber.results where result.isFinal {
                acc.append(result.text)
            }
            return acc
        }

        let audioFile = try AVAudioFile(forReading: localURL)
        if try await analyzer.analyzeSequence(from: audioFile) != nil {
            try await analyzer.finalizeAndFinishThroughEndOfInput()
        } else {
            // cancelAndFinishNow() is `async` but NOT throwing — no `try`.
            await analyzer.cancelAndFinishNow()
        }

        let final = try await collector.value
        let text = String(final.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw TranscribeError.emptyResult }
        return text
    }

    // MARK: iOS < 26 — SFSpeechRecognizer with ~30s chunking (on-device, avoids 1-min cap)

    static func legacy(localURL: URL, localeID: String) async throws -> String {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeID)),
              recognizer.isAvailable else {
            throw TranscribeError.recognizerUnavail
        }
        guard recognizer.supportsOnDeviceRecognition else {
            // e.g. fa-IR — no on-device model → let JS fall back to server.
            throw TranscribeError.localeUnsupported
        }

        let text = try await Chunker.transcribe(fileURL: localURL, recognizer: recognizer)
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw TranscribeError.emptyResult }
        return trimmed
    }
}

// MARK: - Legacy chunker (SFSpeechRecognizer, ~30s AVAudioPCMBuffer segments)

enum Chunker {

    /// Reads the file in ~30s PCM segments and runs one on-device recognition request per
    /// segment, concatenating `bestTranscription.formattedString`. This sidesteps the
    /// ~1-minute / 1000-req-per-hour ceilings of a single SFSpeechRecognizer request.
    static func transcribe(fileURL: URL, recognizer: SFSpeechRecognizer) async throws -> String {
        let file = try AVAudioFile(forReading: fileURL)
        let format = file.processingFormat
        let sampleRate = format.sampleRate
        let chunkFrames = AVAudioFrameCount(sampleRate * 30.0)   // ~30 seconds per chunk
        let totalFrames = file.length

        var pieces: [String] = []
        var startFrame: AVAudioFramePosition = 0

        while startFrame < totalFrames {
            let remaining = AVAudioFrameCount(min(AVAudioFramePosition(chunkFrames), totalFrames - startFrame))
            guard remaining > 0,
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: remaining) else { break }

            file.framePosition = startFrame
            try file.read(into: buffer, frameCount: remaining)
            startFrame += AVAudioFramePosition(buffer.frameLength)

            if buffer.frameLength == 0 { break }

            let piece = try await recognize(buffer: buffer, recognizer: recognizer)
            if !piece.isEmpty { pieces.append(piece) }
        }

        return pieces.joined(separator: " ")
    }

    private static func recognize(buffer: AVAudioPCMBuffer,
                                  recognizer: SFSpeechRecognizer) async throws -> String {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, Error>) in
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.requiresOnDeviceRecognition = true      // strictly on-device
            request.shouldReportPartialResults = false
            if #available(iOS 16.0, *) { request.addsPunctuation = true }

            var didResume = false
            let finishOnce: (Result<String, Error>) -> Void = { result in
                guard !didResume else { return }
                didResume = true
                cont.resume(with: result)
            }

            let task = recognizer.recognitionTask(with: request) { result, error in
                if let error = error {
                    finishOnce(.failure(error))
                    return
                }
                if let result = result, result.isFinal {
                    finishOnce(.success(result.bestTranscription.formattedString))
                }
            }
            _ = task // keep alive until the callback resolves

            request.append(buffer)
            request.endAudio()
        }
    }
}
