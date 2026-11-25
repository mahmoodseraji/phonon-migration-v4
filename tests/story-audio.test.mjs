import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryNarrationPlan } from '../js/story-audio.js';

const paragraphs = [
  'Erster Satz. Zweiter Satz.',
  'Dritter Satz. Vierter Satz.'
];
const sentences = [
  { text: 'Erster Satz.', paragraphIndex: 0, start: 0, globalStart: 0 },
  { text: 'Zweiter Satz.', paragraphIndex: 0, start: 13, globalStart: 13 },
  { text: 'Dritter Satz.', paragraphIndex: 1, start: 0, globalStart: 27 },
  { text: 'Vierter Satz.', paragraphIndex: 1, start: 13, globalStart: 40 }
];

test('chapter narration plan preserves paragraphs as separate synthesis segments', () => {
  const plan = createStoryNarrationPlan({ paragraphs, sentences, startIndex: 1 });
  assert.deepEqual(plan.segments, ['Zweiter Satz.', 'Dritter Satz. Vierter Satz.']);
  assert.equal(plan.startOffset, 13);
  assert.equal(plan.text, 'Zweiter Satz. Dritter Satz. Vierter Satz.');
});

test('paragraph playback creates one segment for the selected paragraph', () => {
  const plan = createStoryNarrationPlan({ paragraphs, sentences, startIndex: 2, mode: 'paragraph' });
  assert.deepEqual(plan.segments, ['Dritter Satz. Vierter Satz.']);
  assert.equal(plan.paragraphIndex, 1);
});

test('repeat sentence creates only the selected sentence segment', () => {
  const plan = createStoryNarrationPlan({ paragraphs, sentences, startIndex: 1, mode: 'sentence' });
  assert.deepEqual(plan.segments, ['Zweiter Satz.']);
});

test('invalid or empty story positions return null', () => {
  assert.equal(createStoryNarrationPlan({ paragraphs, sentences: [], startIndex: 0 }), null);
  assert.equal(createStoryNarrationPlan({ paragraphs: [], sentences, startIndex: 0 }), null);
});
