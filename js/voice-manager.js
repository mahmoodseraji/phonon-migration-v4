// Phonon 40M multilingual voice manager.
// The runtime is vendored locally at ../vendor/phonon-tts; model bytes and selected
// voice embeddings are cached by phonon-tts in the dedicated Cache API cache.
const CACHE_NAME = 'phonon-tts-v1';
const MODEL_ROOT = new URL('../models/phonon/', import.meta.url);
const MODEL_URLS = Object.freeze({
  weights: new URL('model.q8.gguf', MODEL_ROOT).href,
  tokenizer: new URL('tokenizer.json', MODEL_ROOT).href,
  config: new URL('config.json', MODEL_ROOT).href
});

export const VOICE_CATALOG = Object.freeze({
  nele:   { name: 'Nele',   language: 'de', label: 'Nele · German · female' },
  anton:  { name: 'Anton',  language: 'de', label: 'Anton · German · male' },
  zoey:   { name: 'Zoey',   language: 'en', label: 'Zoey · English · female' },
  easton: { name: 'Easton', language: 'en', label: 'Easton · English · male' }
});

const VOICE_URLS = Object.freeze({
  Nele: new URL('voices/nele.safetensors', MODEL_ROOT).href,
  Anton: new URL('voices/anton.safetensors', MODEL_ROOT).href,
  Zoey: new URL('voices/zoey.safetensors', MODEL_ROOT).href,
  Easton: new URL('voices/easton.safetensors', MODEL_ROOT).href
});

function modelSpec(defaultVoice) {
  return {
    weights: { q8: MODEL_URLS.weights },
    tokenizer: MODEL_URLS.tokenizer,
    config: MODEL_URLS.config,
    voices: VOICE_URLS,
    defaultVoice
  };
}

let phononModulePromise = null;
let activeTts = null;
let activeKey = null;
let audioContext = null;
let activeSource = null;
let activeAudio = null;
let activeAudioCancel = null;
let speechSequence = 0;

async function loadPhononModule() {
  if (!phononModulePromise) {
    phononModulePromise = import('../vendor/phonon-tts/index.js').catch(error => {
      phononModulePromise = null;
      throw new Error(
        'The local Phonon runtime is not installed. Run npm install and npm run vendor:phonon, then commit vendor/phonon-tts. ' +
        (error?.message || String(error))
      );
    });
  }
  return phononModulePromise;
}

async function openPhononCache() {
  if (typeof caches === 'undefined') return null;
  try { return await caches.open(CACHE_NAME); } catch { return null; }
}

async function cacheHas(cache, url) {
  if (!cache) return false;
  try { return !!(await cache.match(url)); } catch { return false; }
}

export async function getVoiceStorageStatus() {
  const cache = await openPhononCache();
  const modelChecks = await Promise.all(Object.values(MODEL_URLS).map(url => cacheHas(cache, url)));
  const modelReady = !!cache && modelChecks.every(Boolean);
  const voices = {};
  for (const [id, voice] of Object.entries(VOICE_CATALOG)) {
    voices[id] = modelReady && await cacheHas(cache, VOICE_URLS[voice.name]);
  }
  const voiceChecks = await Promise.all(Object.values(VOICE_URLS).map(url => cacheHas(cache, url)));
  return {
    cacheAvailable: !!cache,
    modelReady,
    voices,
    anyDownloaded: Object.values(voices).some(Boolean),
    anyCachedFiles: modelChecks.some(Boolean) || voiceChecks.some(Boolean)
  };
}

function assertVoice(voiceId, language) {
  const voice = VOICE_CATALOG[voiceId];
  if (!voice) throw new Error(`Unknown Phonon voice: ${voiceId}`);
  if (language && voice.language !== language) {
    throw new Error(`${voice.name} is not a ${language === 'de' ? 'German' : 'English'} voice.`);
  }
  return voice;
}

async function loadTts(voiceId, onProgress = () => {}) {
  const voice = assertVoice(voiceId);
  const status = await getVoiceStorageStatus();
  if (!status.voices[voiceId]) {
    throw new Error(`${voice.name} is not downloaded. Open Settings and download the selected voice first.`);
  }
  const key = `${voice.language}:${voiceId}`;
  if (activeTts && activeKey === key) return activeTts;
  disposeEngine();
  const { PhononTTS } = await loadPhononModule();
  const tts = await PhononTTS.load({
    lang: voice.language,
    model: modelSpec(voice.name),
    voices: [voice.name],
    quant: 'q8',
    device: 'cpu',
    threads: 1,
    cache: true,
    onProgress
  });
  activeTts = tts;
  activeKey = key;
  return tts;
}

async function waitForVoiceCache(voiceId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let status = await getVoiceStorageStatus();
  while (!status.voices[voiceId] && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    status = await getVoiceStorageStatus();
  }
  return status;
}

export async function downloadNeuralVoice(voiceId, onProgress = () => {}) {
  const voice = assertVoice(voiceId);
  const before = await getVoiceStorageStatus();
  if (before.voices[voiceId]) return before;
  if (typeof caches === 'undefined') {
    throw new Error('This browser does not provide persistent Cache Storage. Use HTTPS or localhost, then try again.');
  }
  disposeEngine();
  const { PhononTTS } = await loadPhononModule();
  const tts = await PhononTTS.load({
    lang: voice.language,
    model: modelSpec(voice.name),
    voices: [voice.name],
    quant: 'q8',
    device: 'cpu',
    threads: 1,
    cache: true,
    onProgress
  });
  tts.dispose();
  // The package persists worker-fetched bytes asynchronously on the page thread.
  // Wait for its Cache API writes before reporting the selected voice as installed.
  const after = await waitForVoiceCache(voiceId);
  if (!after.voices[voiceId]) {
    throw new Error('Phonon finished loading, but the browser did not retain the model and voice in its cache. Check available device storage.');
  }
  return after;
}

/** Pitch-preserving WSOLA time stretch for the mono Phonon waveform. */
export function timeStretchPcm(input, rate = 1, sampleRate = 24000) {
  const source = input instanceof Float32Array ? input : new Float32Array(input);
  const factor = Math.max(0.65, Math.min(1.25, Number(rate) || 1));
  if (Math.abs(factor - 1) < 0.015 || source.length < sampleRate * 0.08) return source.slice();
  const windowSize = Math.max(256, Math.round(sampleRate * 0.04));
  const overlap = Math.floor(windowSize / 2);
  const synthesisHop = windowSize - overlap;
  const searchRadius = Math.max(24, Math.round(sampleRate * 0.004));
  const targetLength = Math.max(1, Math.round(source.length / factor));
  const output = new Float32Array(targetLength + windowSize);
  output.set(source.subarray(0, Math.min(windowSize, source.length)), 0);
  let outputPosition = 0;
  let inputPosition = 0;
  while (outputPosition + synthesisHop + overlap < targetLength && inputPosition + windowSize < source.length) {
    outputPosition += synthesisHop;
    const expected = Math.round(inputPosition + synthesisHop * factor);
    const min = Math.max(0, expected - searchRadius);
    const max = Math.min(source.length - windowSize, expected + searchRadius);
    let best = Math.max(min, Math.min(max, expected));
    let bestScore = -Infinity;
    for (let candidate = min; candidate <= max; candidate += 2) {
      let score = 0;
      for (let j = 0; j < overlap; j += 3) score += output[outputPosition + j] * source[candidate + j];
      if (score > bestScore) { bestScore = score; best = candidate; }
    }
    for (let j = 0; j < overlap; j++) {
      const mix = j / Math.max(1, overlap - 1);
      output[outputPosition + j] = output[outputPosition + j] * (1 - mix) + source[best + j] * mix;
    }
    output.set(source.subarray(best + overlap, best + windowSize), outputPosition + overlap);
    inputPosition = best;
  }
  const filledUntil = Math.min(targetLength, outputPosition + windowSize);
  if (filledUntil < targetLength) {
    const remaining = targetLength - filledUntil;
    const sourceStart = Math.max(0, source.length - remaining);
    output.set(source.subarray(sourceStart, sourceStart + remaining), filledUntil);
  }
  return output.slice(0, targetLength);
}

function getAudioContext() {
  if (!audioContext || audioContext.state === 'closed') {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (AudioContextClass) audioContext = new AudioContextClass();
  }
  return audioContext;
}

function stopCurrentAudio() {
  stopActiveSequence();
  if (activeSource) {
    try { activeSource.stop(); } catch { /* already stopped */ }
    activeSource = null;
  }
  if (activeAudio) {
    activeAudio.pause();
    activeAudioCancel?.();
    activeAudio = null;
    activeAudioCancel = null;
  }
}

function disposeEngine() {
  if (activeTts) {
    try { activeTts.dispose(); } catch { /* worker may already have stopped */ }
    activeTts = null;
    activeKey = null;
  }
}


let activeSequence = null;

function stopActiveSequence() {
  const sequence = activeSequence;
  if (!sequence) return;
  activeSequence = null;
  sequence.cancelled = true;
  const playback = sequence.currentPlayback;
  if (playback) {
    if (playback.source) {
      playback.source.onended = null;
      try { playback.source.stop(); } catch { /* already stopped */ }
      playback.source = null;
    }
    sequence.currentPlayback = null;
    playback.resolve?.();
  }
  if (sequence.source) {
    sequence.source.onended = null;
    try { sequence.source.stop(); } catch { /* already stopped */ }
    sequence.source = null;
  }
  sequence.resolve?.();
  if (typeof wakeSequence === 'function') wakeSequence(sequence);
}

function startSequenceAt(sequence) {
  if (activeSequence !== sequence || sequence.cancelled || sequence.paused) return;
  const source = sequence.context.createBufferSource();
  source.buffer = sequence.buffer;
  source.connect(sequence.context.destination);
  sequence.source = source;
  sequence.startedAt = sequence.context.currentTime;
  source.onended = () => {
    if (activeSequence !== sequence || sequence.paused || sequence.cancelled) return;
    activeSequence = null;
    sequence.source = null;
    sequence.resolve?.();
  };
  source.start(0, sequence.offset);
}

function splitLongNarration(text, maxLength = 1700) {
  const source = String(text || '').trim();
  if (source.length <= maxLength) return source ? [source] : [];
  const sentences = source.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/gu) || [source];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) continue;
    if (current && current.length + piece.length + 1 > maxLength) {
      chunks.push(current);
      current = '';
    }
    if (piece.length > maxLength) {
      for (let i = 0; i < piece.length; i += maxLength) {
        if (current) { chunks.push(current); current = ''; }
        chunks.push(piece.slice(i, i + maxLength));
      }
    } else current = current ? current + ' ' + piece : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

function trimNarrationSilence(samples, threshold = 0.0018, tailSamples = 900) {
  let first = 0;
  while (first < samples.length && Math.abs(samples[first]) < threshold) first++;
  let last = samples.length - 1;
  while (last > first && Math.abs(samples[last]) < threshold) last--;
  if (first >= samples.length) return new Float32Array(Math.min(samples.length, tailSamples));
  return samples.slice(first, Math.min(samples.length, last + 1 + tailSamples));
}

function wakeSequence(sequence) {
  const waiters = sequence.queueWaiters.splice(0);
  for (const wake of waiters) wake();
}

function waitForSequenceChange(sequence) {
  return new Promise(resolve => sequence.queueWaiters.push(resolve));
}

async function takeSequenceBuffer(sequence) {
  while (!sequence.cancelled) {
    if (sequence.queue.length) return sequence.queue.shift();
    if (sequence.producerDone) {
      if (sequence.error) throw sequence.error;
      return null;
    }
    await waitForSequenceChange(sequence);
  }
  return null;
}

async function waitUntilSequenceResumes(sequence) {
  while (sequence.paused && !sequence.cancelled) await waitForSequenceChange(sequence);
  return !sequence.cancelled;
}

function startSequenceChunk(sequence) {
  const playback = sequence.currentPlayback;
  if (!playback || sequence.paused || sequence.cancelled || activeSequence !== sequence) return;
  const source = sequence.context.createBufferSource();
  source.buffer = playback.buffer;
  source.connect(sequence.context.destination);
  playback.source = source;
  playback.startedAt = sequence.context.currentTime;
  source.onended = () => {
    if (activeSequence !== sequence || sequence.cancelled || sequence.paused || sequence.currentPlayback !== playback) return;
    playback.source = null;
    sequence.currentPlayback = null;
    playback.resolve();
  };
  try {
    source.start(0, playback.offset);
  } catch (error) {
    playback.source = null;
    sequence.currentPlayback = null;
    playback.reject(error);
  }
}

function playSequenceBuffer(sequence, buffer) {
  return new Promise((resolve, reject) => {
    sequence.currentPlayback = { buffer, offset: 0, startedAt: 0, source: null, resolve, reject };
    startSequenceChunk(sequence);
  });
}

/**
 * Stream story narration: synthesize one manageable chunk at a time, begin as soon
 * as the first chunk is ready, and keep a small queue ahead of the audio output.
 * This avoids waiting for an entire chapter to be synthesized before playback.
 */
export async function speakNeuralSegments(voiceId, segments, rate = 0.88, onStage = () => {}) {
  const voice = assertVoice(voiceId, 'de');
  const sourceSegments = (Array.isArray(segments) ? segments : [segments])
    .flatMap(segment => splitLongNarration(segment, 850))
    .filter(segment => segment.trim());
  if (!sourceSegments.length) throw new Error('There is no story text to pronounce.');
  const totalCharacters = sourceSegments.reduce((sum, segment) => sum + segment.length, 0);
  if (totalCharacters > 24000) throw new Error('This chapter is too long for one Phonon reading session. Please listen paragraph by paragraph.');

  const token = ++speechSequence;
  stopCurrentAudio();
  const context = getAudioContext();
  if (!context) throw new Error('Web Audio is not available in this browser. Choose System voice in Settings.');

  // Unlock/resume Web Audio immediately in the Play button's original tap gesture.
  const unlockPromise = context.state === 'suspended' ? context.resume() : Promise.resolve();
  onStage('Loading the selected Phonon voice');
  const tts = await loadTts(voiceId, progress => {
    const file = progress?.file || 'voice files';
    const amount = progress?.total ? ' · ' + Math.round(progress.loaded / progress.total * 100) + '%' : '';
    onStage('Loading ' + file + amount);
  });
  if (token !== speechSequence) return;

  const sequence = {
    context, queue: [], queueWaiters: [], producerDone: false, error: null,
    cancelled: false, paused: false, currentPlayback: null, completedChunks: 0,
    totalChunks: sourceSegments.length, resolve: null, reject: null
  };
  activeSequence = sequence;

  const producer = (async () => {
    try {
      for (let index = 0; index < sourceSegments.length; index++) {
        if (token !== speechSequence || sequence.cancelled) break;
        const wav = await tts.synthWav(sourceSegments[index], { voice: voice.name });
        if (token !== speechSequence || sequence.cancelled) break;
        const decoded = await context.decodeAudioData(await wav.arrayBuffer());
        const stretched = timeStretchPcm(decoded.getChannelData(0), rate, decoded.sampleRate);
        const samples = trimNarrationSilence(stretched);
        const buffer = context.createBuffer(1, samples.length, decoded.sampleRate);
        buffer.copyToChannel(samples, 0);
        sequence.queue.push({ buffer, text: sourceSegments[index], index: index + 1 });
        wakeSequence(sequence);
      }
    } catch (error) {
      sequence.error = error;
    } finally {
      sequence.producerDone = true;
      wakeSequence(sequence);
    }
  })();

  try {
    await unlockPromise;
    while (!sequence.cancelled) {
      const item = await takeSequenceBuffer(sequence);
      if (!item || sequence.cancelled) break;
      if (!(await waitUntilSequenceResumes(sequence))) break;
      if (context.state === 'suspended') await context.resume();
      if (context.state !== 'running') throw new Error('iOS audio context is ' + context.state + '; playback could not start.');
      if (sequence.cancelled) break;
      onStage({ type: 'chunk-start', text: item.text, duration: item.buffer.duration, index: item.index, total: sequence.totalChunks });
      await playSequenceBuffer(sequence, item.buffer);
      sequence.completedChunks = item.index;
    }
    await producer;
    if (!sequence.cancelled && sequence.error) throw sequence.error;
  } finally {
    if (activeSequence === sequence) activeSequence = null;
    sequence.cancelled = true;
    wakeSequence(sequence);
  }
}

export function pauseNeuralSpeech() {
  const sequence = activeSequence;
  if (!sequence || sequence.paused || sequence.cancelled) return false;
  sequence.paused = true;
  const playback = sequence.currentPlayback;
  if (playback?.source) {
    playback.offset = Math.min(playback.buffer.duration,
      playback.offset + sequence.context.currentTime - playback.startedAt);
    playback.source.onended = null;
    try { playback.source.stop(); } catch { /* already stopped */ }
    playback.source = null;
  }
  return true;
}

export function resumeNeuralSpeech() {
  const sequence = activeSequence;
  if (!sequence || !sequence.paused || sequence.cancelled) return false;
  sequence.paused = false;
  const resume = sequence.context.state === 'suspended' ? sequence.context.resume() : Promise.resolve();
  resume.then(() => {
    if (activeSequence !== sequence || sequence.cancelled || sequence.paused) return;
    if (sequence.currentPlayback) startSequenceChunk(sequence);
    wakeSequence(sequence);
  }).catch(error => {
    sequence.error = error;
    sequence.producerDone = true;
    wakeSequence(sequence);
  });
  wakeSequence(sequence);
  return true;
}

export async function speakNeural(voiceId, text, rate = 0.88, onStage = () => {}) {
  const voice = assertVoice(voiceId);
  const sourceText = String(text || '').trim();
  if (!sourceText) throw new Error('There is no text to pronounce.');
  if (sourceText.length > 12000) throw new Error('This chapter is too long for one continuous Phonon narration. Please use System voice or listen paragraph by paragraph.');

  const token = ++speechSequence;
  stopCurrentAudio();

  // Start/resume audio synchronously in the original tap gesture before model inference.
  const context = getAudioContext();
  const resumePromise = context && context.state === 'suspended' ? context.resume() : Promise.resolve();

  onStage('Loading the selected Phonon voice');
  const tts = await loadTts(voiceId, progress => {
    const file = progress?.file || 'voice files';
    const amount = progress?.total ? ` · ${Math.round(progress.loaded / progress.total * 100)}%` : '';
    onStage(`Loading ${file}${amount}`);
  });
  if (token !== speechSequence) return;
  onStage('Generating speech');
  const wav = await tts.synthWav(sourceText, { voice: voice.name });
  if (token !== speechSequence) return;
  onStage('Preparing audio playback');

  if (context) {
    await resumePromise;
    if (context.state !== 'running') throw new Error(`iOS audio context is ${context.state}; playback could not start.`);
    if (token !== speechSequence) return;
    const decoded = await context.decodeAudioData(await wav.arrayBuffer());
    if (token !== speechSequence) return;
    const stretched = timeStretchPcm(decoded.getChannelData(0), rate, decoded.sampleRate);
    const audioBuffer = context.createBuffer(1, stretched.length, decoded.sampleRate);
    audioBuffer.copyToChannel(stretched, 0);
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = 1;
    source.connect(context.destination);
    activeSource = source;
    onStage('Playing Phonon audio');
    await new Promise((resolve, reject) => {
      source.onended = () => {
        source.buffer = null;
        if (activeSource === source) activeSource = null;
        resolve();
      };
      try { source.start(0); } catch (error) { reject(error); }
    });
    return;
  }

  // Fallback for browsers without Web Audio. The system voice remains the app-level fallback
  // if the browser blocks this delayed audio-element playback.
  const url = URL.createObjectURL(wav);
  const audio = new Audio(url);
  activeAudio = audio;
  audio.playbackRate = Math.max(0.65, Math.min(1.25, Number(rate) || 0.88));
  try {
    const finished = new Promise(resolve => {
      activeAudioCancel = resolve;
      audio.addEventListener('ended', resolve, { once: true });
      audio.addEventListener('error', resolve, { once: true });
    });
    await audio.play();
    onStage('Playing Phonon audio');
    await finished;
  } finally {
    if (activeAudio === audio) activeAudio = null;
    activeAudioCancel = null;
    URL.revokeObjectURL(url);
  }
}

export async function deleteAllNeuralVoices() {
  terminateNeuralWorker();
  const cache = await openPhononCache();
  if (!cache) return false;
  let removed = false;
  for (const url of [...Object.values(VOICE_URLS), ...Object.values(MODEL_URLS)]) {
    removed = (await cache.delete(url)) || removed;
  }
  return removed;
}

export function stopNeuralSpeech() {
  speechSequence++;
  stopActiveSequence();
  stopCurrentAudio();
}

export function terminateNeuralWorker() {
  stopNeuralSpeech();
  disposeEngine();
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close().catch(() => {});
  }
  audioContext = null;
}

export const neuralVoiceModelIds = Object.freeze({
  nele: 'Nele', anton: 'Anton', zoey: 'Zoey', easton: 'Easton'
});
