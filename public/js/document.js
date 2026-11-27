export const DOCUMENT_MAX_CHARS = 100_000;
export const DOCUMENT_PART_CHARS = 10_000;

/** Non-overlapping parts whose concatenation is the original document. */
export function documentParts(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Paste a document first.');
  if (text.length > DOCUMENT_MAX_CHARS) throw new RangeError(`Documents are limited to ${DOCUMENT_MAX_CHARS.toLocaleString('en-US')} characters.`);
  const parts = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + DOCUMENT_PART_CHARS, text.length);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf('\n', end - 1), text.lastIndexOf(' ', end - 1));
      if (boundary >= start + DOCUMENT_PART_CHARS * 0.75) end = boundary + 1;
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

const normalized = (text) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function distinctDocumentIdeas(ideas, existing = []) {
  const prepared = existing.map((idea) => ({ title: normalized(idea.title), pitch: normalized(idea.pitch) }));
  const unique = [];
  for (const idea of ideas) {
    const title = normalized(idea.title);
    const pitch = normalized(idea.pitch);
    const words = new Set(pitch.split(' '));
    const duplicate = prepared.some((other) => {
      if (title === other.title || (pitch && pitch === other.pitch)) return true;
      if (words.size < 8) return false;
      const theirs = new Set(other.pitch.split(' '));
      const shared = [...words].filter((word) => theirs.has(word)).length;
      return shared / (words.size + theirs.size - shared) >= 0.85;
    });
    if (!duplicate) {
      prepared.push({ title, pitch });
      unique.push(idea);
    }
  }
  return unique;
}
