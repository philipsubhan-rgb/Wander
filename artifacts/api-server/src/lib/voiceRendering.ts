/**
 * Speech rendering — the Voice Gateway's rendering pass (§2.4).
 *
 * Marco's assistant turn is ONE text. The screen shows it as-is; the
 * voice channel speaks it. This pass makes that same text speakable
 * WITHOUT re-authoring it: it is deliberately subtractive — markdown
 * syntax is removed and list structure is flattened, but every word,
 * name, time, and figure survives byte-identical. There is no
 * summarizer here and never will be: a parallel "voice version" of an
 * answer could diverge from what the screen shows (Story 2.2 — what
 * is said matches what is shown), and a re-formatted price is a wrong
 * price. Prices and totals are spoken exactly as the presentation
 * layer phrased them in the text the traveler can also read.
 */

const FENCE_RE = /^```[a-zA-Z0-9_-]*\s*$/;
const HEADING_RE = /^#{1,6}\s+/;
const BLOCKQUOTE_RE = /^>\s?/;
const LIST_MARKER_RE = /^\s*(?:[-*•]|\d{1,3}[.)])\s+/;

/**
 * Render an assistant turn's text for speech.
 *
 * - Code fences drop (their contents stay, as plain lines).
 * - Heading / blockquote / list markers drop; the line's text stays.
 * - Bold markers (`**`) and inline-code backticks drop; the words stay.
 * - Indentation is trimmed; blank runs collapse to a single blank line
 *   (a natural pause point for TTS).
 *
 * Everything else — wording, figures, punctuation — is untouched.
 */
export function renderSpeechText(text: string): string {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (FENCE_RE.test(rawLine.trim())) continue;
    let line = rawLine.trim();
    line = line.replace(HEADING_RE, "");
    line = line.replace(BLOCKQUOTE_RE, "");
    line = line.replace(LIST_MARKER_RE, "");
    line = line.replace(/\*\*/g, "");
    line = line.replace(/`/g, "");
    if (line.length === 0) {
      // Collapse blank runs: keep at most one consecutive blank line.
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    out.push(line);
  }
  // No leading/trailing blank lines.
  while (out.length > 0 && out[0] === "") out.shift();
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}
