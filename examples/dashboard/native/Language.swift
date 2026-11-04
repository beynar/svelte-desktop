// The Modules page's text analysis: Apple's on-device NaturalLanguage, in Swift, on the main actor.
// host.native.language.analyze({ text }) — Codable types are typed for the pages (src/native.d.ts).
import NaturalLanguage

struct AnalyzeArgs: Codable { let text: String }

struct Analysis: Codable {
  /// BCP 47 code ("en", "fr"…), nil when the text is too short to tell.
  let language: String?
  let confidence: Double
  /// -1 (negative) to 1 (positive).
  let sentiment: Double
  let keywords: [String]
}

func desktopSetup() {
  Desktop.command("language.analyze") { (a: AnalyzeArgs) -> Analysis in
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(a.text)
    let language = recognizer.dominantLanguage
    let confidence = language.flatMap { recognizer.languageHypotheses(withMaximum: 1)[$0] } ?? 0

    let tagger = NLTagger(tagSchemes: [.sentimentScore, .lexicalClass])
    tagger.string = a.text
    let score = tagger.tag(at: a.text.startIndex, unit: .paragraph, scheme: .sentimentScore).0?.rawValue
    var keywords: [String] = []
    tagger.enumerateTags(in: a.text.startIndex..<a.text.endIndex, unit: .word, scheme: .lexicalClass, options: [.omitPunctuation, .omitWhitespace]) { tag, range in
      let word = String(a.text[range])
      if tag == .noun, word.count > 2, !keywords.contains(word.lowercased()) { keywords.append(word.lowercased()) }
      return keywords.count < 8
    }
    return Analysis(language: language?.rawValue, confidence: confidence, sentiment: Double(score ?? "0") ?? 0, keywords: keywords)
  }
}
