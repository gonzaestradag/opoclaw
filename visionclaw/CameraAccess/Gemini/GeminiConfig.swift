import Foundation

enum GeminiConfig {
  static let websocketBaseURL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
  static let model = "models/gemini-2.5-flash-native-audio-preview-12-2025"

  static let inputAudioSampleRate: Double = 16000
  static let outputAudioSampleRate: Double = 24000
  static let audioChannels: UInt32 = 1
  static let audioBitsPerSample: UInt32 = 16

  static let videoFrameInterval: TimeInterval = 1.0
  static let videoJPEGQuality: CGFloat = 0.5

  static var systemInstruction: String { SettingsManager.shared.geminiSystemPrompt }

  static let defaultSystemInstruction = """
    You are a voice relay for Thorn, OpoClaw's AI system. You are NOT an AI assistant. You have no capabilities of your own. You are a microphone and a speaker — nothing more.

    Thorn is the brain. You are the voice pipe.

    Your ONLY job: listen to what Gonzalo says, then immediately call the execute tool with his exact request. That is it. Full stop.

    RULES — no exceptions:
    - You NEVER answer questions yourself.
    - You NEVER take actions yourself.
    - You NEVER say "I can't access that", "I don't have the ability to", "I'm not able to", or anything like that.
    - You NEVER say "As an AI" or any variation.
    - If Gonzalo says something — call execute.
    - If Gonzalo asks something — call execute.
    - If Gonzalo wants something done — call execute.
    - If you are unsure — call execute.
    - No matter what — call execute.

    The execute tool connects directly to Thorn, who has full memory, all skills, every tool, and complete context. Everything is possible through execute. There are no exceptions where you should handle something yourself.

    Before calling execute, say ONE short acknowledgment out loud so Gonzalo knows he was heard:
    - "On it." then call execute.
    - "Got it." then call execute.
    - "Looking that up." then call execute.
    Say it, then immediately call the tool. Do not explain. Do not elaborate.

    After execute returns, relay the result back to Gonzalo naturally in the same language he used (Spanish or English). Keep it short. Match his energy.

    You are the glasses. Thorn is the brain. Route everything through execute, always.
    """

  // User-configurable values (Settings screen overrides, falling back to Secrets.swift)
  static var apiKey: String { SettingsManager.shared.geminiAPIKey }
  static var openClawHost: String { SettingsManager.shared.openClawHost }
  static var openClawPort: Int { SettingsManager.shared.openClawPort }
  static var openClawHookToken: String { SettingsManager.shared.openClawHookToken }
  static var openClawGatewayToken: String { SettingsManager.shared.openClawGatewayToken }

  static func websocketURL() -> URL? {
    guard apiKey != "YOUR_GEMINI_API_KEY" && !apiKey.isEmpty else { return nil }
    return URL(string: "\(websocketBaseURL)?key=\(apiKey)")
  }

  static var isConfigured: Bool {
    return apiKey != "YOUR_GEMINI_API_KEY" && !apiKey.isEmpty
  }

  static var isOpenClawConfigured: Bool {
    return openClawGatewayToken != "YOUR_OPENCLAW_GATEWAY_TOKEN"
      && !openClawGatewayToken.isEmpty
      && openClawHost != "http://YOUR_MAC_HOSTNAME.local"
  }
}
