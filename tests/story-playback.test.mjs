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

test('Phonon Stories synthesize manageable segments and combine them into one playback buffer', () => {
  assert.match(voice, /function splitLongNarration/);
  assert.match(voice, /tts\.synthWav\(sourceSegments\[index\]/);
  assert.match(voice, /trimNarrationSilence/);
  assert.match(voice, /context\.createBuffer\(1, combined\.length, sampleRate\)/);
  assert.match(voice, /export function pauseNeuralSpeech/);
  assert.match(voice, /export function resumeNeuralSpeech/);
});

test('stopping or replacing speech cancels the active story sequence', () => {
  assert.match(voice, /function stopCurrentAudio\(\) \{\s*stopActiveSequence\(\);/);
  assert.match(voice, /export function stopNeuralSpeech\(\) \{\s*speechSequence\+\+;\s*stopActiveSequence\(\);/);
});
