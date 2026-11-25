import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { timeStretchPcm } from '../js/voice-manager.js';
const manager=await readFile(new URL('../js/voice-manager.js',import.meta.url),'utf8');
const app=await readFile(new URL('../js/app.js',import.meta.url),'utf8');
const sw=await readFile(new URL('../sw.js',import.meta.url),'utf8');
test('uses the pinned local Phonon browser runtime and multilingual checkpoint',()=>{
 assert.match(manager,/import\('\.\.\/vendor\/phonon-tts\/index\.js'\)/);
 assert.match(manager,/model\.q8\.gguf/);
 assert.match(manager,/tokenizer\.json/);
 assert.match(manager,/config\.json/);
 assert.match(manager,/quant:\s*'q8'/);
 assert.match(manager,/lang:\s*voice\.language/);
 assert.doesNotMatch(manager,/piper|onnxruntime|phonemiz/i);
});
test('supports four named voices and independent language selection',()=>{
 for(const id of ['nele','anton','zoey','easton'])assert.match(manager,new RegExp('\\b'+id+'\\b'));
 assert.match(app,/\['system','nele','anton'\]/);
 assert.match(app,/\['system','zoey','easton'\]/);
});
test('downloads only selected voices, keeps system speech explicit, and removes Phonon cache',()=>{
 assert.match(app,/downloadNeuralVoice\(id/);
 assert.match(app,/No voice fallback was used/);
 assert.match(manager,/cache\.delete\(url\)/);
 assert.match(manager,/deleteAllNeuralVoices/);
 assert.match(manager,/cacheAvailable: !!cache/);
 assert.match(manager,/anyCachedFiles: modelChecks\.some\(Boolean\) \|\| voiceChecks\.some\(Boolean\)/);
 assert.match(app,/!remaining\.cacheAvailable/);
 assert.match(app,/remaining\.anyCachedFiles/);
 assert.match(manager,/CACHE_NAME = 'phonon-tts-v1'/);
});
test('uses the official API and Web Audio playback',()=>{
 assert.match(manager,/PhononTTS\.load/);
 assert.match(manager,/tts\.synthWav/);
 assert.match(manager,/tts\.dispose\(\)/);
 assert.match(manager,/decodeAudioData/);
});
test('service worker precaches the vendored runtime',()=>{
 for(const file of ['index.js','worker.js','phonon_tts_simd_bg.wasm'])assert.ok(sw.includes(file),file);
 assert.match(sw,/deutsch-meister-v3\.10\.1/);
});

test('Phonon speed adjustment changes duration without shifting the original pitch',()=>{
 const sampleRate=24000,frequency=440,duration=1.2,input=new Float32Array(sampleRate*duration);
 for(let i=0;i<input.length;i++)input[i]=Math.sin(2*Math.PI*frequency*i/sampleRate);
 for(const rate of [0.75,1.2]){
  const output=timeStretchPcm(input,rate,sampleRate);
  assert.ok(Math.abs(output.length/input.length-1/rate)<0.01);
  let crossings=0;for(let i=1;i<output.length;i++)if(output[i-1]<=0&&output[i]>0)crossings++;
  const measured=crossings/(output.length/sampleRate);
  assert.ok(Math.abs(measured-frequency)<8, 'expected pitch near 440 Hz, got '+measured);
 }
});
