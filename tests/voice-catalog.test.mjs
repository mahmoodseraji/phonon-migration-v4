import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const manager=await readFile(new URL('../js/voice-manager.js',import.meta.url),'utf8');
test('German selector has system, Nele and Anton',()=>{const select=html.match(/<select id="germanSpeechVoice"[\s\S]*?<\/select>/)?.[0]||'';for(const value of ['system','nele','anton'])assert.match(select,new RegExp('value="'+value+'"'));assert.equal((select.match(/<option\b/g)||[]).length,3);});
test('English selector has system, Zoey and Easton',()=>{const select=html.match(/<select id="englishSpeechVoice"[\s\S]*?<\/select>/)?.[0]||'';for(const value of ['system','zoey','easton'])assert.match(select,new RegExp('value="'+value+'"'));assert.equal((select.match(/<option\b/g)||[]).length,3);});
test('voice previews use live Phonon synthesis rather than static recordings',()=>{for(const id of ['nele','anton','zoey','easton'])assert.match(html,new RegExp('data-voice-preview="'+id+'"'));assert.match(manager,/tts\.synthWav/);assert.doesNotMatch(html,/assets\/voice-samples\/.*\.ogg/);assert.doesNotMatch(manager,/sample:/);});
