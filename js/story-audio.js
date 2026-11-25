export function createStoryNarrationPlan({ paragraphs = [], sentences = [], startIndex = 0, mode = 'chapter' } = {}) {
  if (!Array.isArray(paragraphs) || !Array.isArray(sentences) || !sentences.length) return null;
  const index = Math.max(0, Math.min(Number(startIndex) || 0, sentences.length - 1));
  const first = sentences[index];
  if (!first || !paragraphs[first.paragraphIndex]) return null;
  let segments;
  if (mode === 'sentence') {
    segments = [first.text];
  } else if (mode === 'paragraph') {
    segments = [paragraphs[first.paragraphIndex]];
  } else {
    segments = paragraphs.slice(first.paragraphIndex);
    segments[0] = segments[0].slice(first.start);
  }
  segments = segments.map(value => String(value || '').trim()).filter(Boolean);
  if (!segments.length) return null;
  return Object.freeze({
    startIndex: index,
    paragraphIndex: first.paragraphIndex,
    startOffset: first.globalStart,
    segments: Object.freeze(segments),
    text: segments.join(' ')
  });
}
