import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const voice = await readFile(new URL('../js/voice-manager.js', import.meta.url), 'utf8');

test('Stories use a dedicated narration plan and segmented Phonon playback', () => {
  assert.match(app, /createStoryNarrationPlan/);
  assert.match(app, /speakNeuralSegments/);
  assert.match(app, /pauseNeuralSpeech/);
  assert.match(app, /resumeNeuralSpeech/);
  const playback = app.slice(app.indexOf('async function playStorySentences'), app.indexOf('async function completeStoryChapter'));
  assert.match(playback, /speakNeuralSegments/);
  assert.doesNotMatch(playback, /await speakNeural\(voice,/);
});

test('Phonon Stories stream manageable chunks while playback proceeds instead of waiting for the whole chapter', () => {
  assert.match(voice, /function splitLongNarration/);
  assert.match(voice, /tts\.synthWav\(sourceSegments\[index\]/);
  assert.match(voice, /trimNarrationSilence/);
  assert.match(voice, /const producer = \(async \(\) => \{/);
  assert.match(voice, /async function takeSequenceBuffer/);
  assert.match(voice, /sequence\.queue\.push\(\{ buffer, index: index \+ 1 \}\)/);
  assert.match(voice, /await playSequenceBuffer\(sequence, item\.buffer\)/);
  assert.doesNotMatch(voice, /const rendered = \[\]/);
  assert.match(voice, /export function pauseNeuralSpeech/);
  assert.match(voice, /export function resumeNeuralSpeech/);
  assert.match(voice, /function startSequenceChunk/);
  assert.match(voice, /if \(context\.state === 'suspended'\) await context\.resume\(\)/);
});

test('Phonon sentence highlighting follows the actual duration of each playing audio chunk', () => {
  assert.match(voice, /onStage\(\{ type: 'chunk-start', text: item\.text, duration: item\.buffer\.duration/);
  assert.match(app, /highlightNarrationChunk\(event\.text,event\.duration/);
  assert.match(app, /currentStoryNarrationText\.indexOf\(normalised/);
  assert.match(app, /elapsed\+=\(now-lastTick\)\/1000/);
  assert.match(app, /storyPlaybackState!=='paused'/);
  assert.doesNotMatch(app, /highlightEstimatedProgress/);
});

test('stopping or replacing speech cancels the active story sequence', () => {
  assert.match(voice, /function stopCurrentAudio\(\) \{\s*stopActiveSequence\(\);/);
  assert.match(voice, /export function stopNeuralSpeech\(\) \{\s*speechSequence\+\+;\s*stopActiveSequence\(\);/);
});
