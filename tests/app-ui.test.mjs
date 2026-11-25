import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');

test('the app has six main pages and five bottom navigation items', () => {
  assert.equal((html.match(/class="view(?: active)?"/g) || []).length, 6);
  assert.equal((html.match(/class="nav-item/g) || []).length, 5);
});

test('the interface has no CEFR or collection navigation', () => {
  assert.doesNotMatch(html, /CEFR|A1|A2|B1|B2|Collections|collection/i);
});

test('the library uses bounded rendering and retains individual and batch deletion', () => {
  assert.match(app, /libraryLimit=100/);
  assert.match(app, /slice\(0,libraryLimit\)/);
  assert.match(html, /id="loadMoreWords"/);
  assert.match(app, /data-delete-import-batch/);
  assert.match(app, /data-delete=/);
});

test('CSV import remains in the Library and imported batches remain in Settings', () => {
  assert.match(html, /id="importCsvOpen"/);
  assert.match(html, /id="importCsv"/);
  assert.match(html, /id="importBatchList"/);
});

test('practice visibility depends on available imported data', () => {
  assert.match(app, /function renderPracticeAvailability\(\)/);
  assert.match(app, /import \{[^}]*inferPartOfSpeech[^}]*\} from '\.\/challenges\.js'/);
  assert.match(app, /new Set\(words\.filter\(w=>String\(w\.translation/);
  assert.match(app, /pluralOptions\(w,words\)\.length>=3/);
  assert.match(app, /buildVerbQuestions\(buildVerbBank\(words\)\)/);
});

test('the redesigned pages remove redundant home shortcuts and library filters', () => {
  assert.doesNotMatch(html, /home-links|categoryFilter|favoritesOnly/);
  assert.match(html, /id="wordSearch"/);
  assert.match(html, /id="addWordOpen"/);
  assert.match(html, /id="importCsvOpen"/);
  assert.match(html, /id="progressDue"/);
});

test('V3.8.0 exposes live Phonon voice previews, voice selection and cache deletion', async () => {
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
 const app=await readFile(new URL('../js/app.js',import.meta.url),'utf8');
 const manager=await readFile(new URL('../js/voice-manager.js',import.meta.url),'utf8');
 for(const id of ['nele','anton','zoey','easton'])assert.ok(html.includes('data-voice-preview="'+id+'"'));
 assert.match(html,/id="downloadVoiceModels"/);assert.match(html,/id="deleteVoiceModels"/);
 assert.match(app,/downloadSelectedVoices/);assert.match(app,/deleteDownloadedVoices/);
 assert.match(app,/speakNeural\(voice,text/);assert.match(manager,/deleteAllNeuralVoices/);
 assert.doesNotMatch(html,/assets\/voice-samples\/.*\.ogg/);
});
test('V3.6.2 keeps the home dashboard separate from a full-screen flip-card review', () => {
  assert.match(html, /id="studyCardInner"/);
  assert.match(html, /class="study-card-face study-card-front"/);
  assert.match(html, /class="study-card-face study-card-back"/);
  assert.match(html, /id="endReview"/);
  assert.match(app, /classList\.toggle\('reviewing',hasCurrent\)/);
  assert.match(app, /classList\.add\('is-flipped'\)/);
  assert.match(app, /card-swipe-out/);
});

test('V3.6.2 includes tactile interaction states and respects reduced-motion preferences', async () => {
  const css = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');
  assert.match(css, /rotateY\(180deg\)/);
  assert.match(css, /cardSwipeLeft/);
  assert.match(css, /cardSwipeRight/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /reviewing-session \.bottom-nav/);
});


test('review ratings are outside the flip-card and available before revealing the answer', () => {
  const sceneEnd = html.indexOf('</div>', html.indexOf('<div class="study-card-scene">'));
  const panel = html.indexOf('class="review-rating-panel"');
  assert.ok(panel > html.indexOf('class="study-card-scene"'));
  assert.ok(panel > html.indexOf('</div>\n        </div>', html.indexOf('<div class="study-card-scene">')));
  assert.match(html, /id="ratingPrompt"/);
  assert.match(html, /id="ratingHelp"/);
});

test('review rating labels and descriptions are selected from the active algorithm', () => {
  assert.match(app, /ratingButtonInfo\(w,rating,method\)/);
  assert.match(app, /Did you remember this word\\?/);
  assert.match(app, /How well did you remember\?/);
});


test('Leitner review presents two outcomes while SM-2 presents four ratings', () => {
  assert.match(app, /button\.hidden=method==='leitner' && !\['again','good'\]\.includes\(rating\)/);
  assert.match(app, /leitner-rating-grid/);
  assert.match(html, /data-rating="again"/);
  assert.match(html, /data-rating="good"/);
  assert.match(html, /data-rating="hard"/);
  assert.match(html, /data-rating="easy"/);
});


test('imported CSV batches can be exported and safely updated by stable ID', async () => {
 const db=await readFile(new URL('../js/db.js',import.meta.url),'utf8');
 assert.match(app,/data-export-import-batch/);assert.match(app,/data-update-import-batch/);
 assert.match(app,/function updateImportBatch/);assert.match(app,/row\.id/);
 assert.match(app,/Duplicate word in CSV/);assert.match(app,/already exists outside this batch/);
 assert.match(db,/function replaceImportBatch/);assert.match(db,/transaction\(\['words','reviewLogs'\],'readwrite'\)/);
});
test('failed Phonon playback does not silently switch to a system voice',()=>{assert.match(app,/No voice fallback was used/);assert.match(app,/This voice is not downloaded yet/);});

test('Stories provides a personal library, DOCX/TXT import, interactive reader and independent progress stores', async () => {
 const db=await readFile(new URL('../js/db.js',import.meta.url),'utf8');
 const stories=await readFile(new URL('../js/stories.js',import.meta.url),'utf8');
 assert.match(html,/data-nav="stories"/);assert.match(html,/id="storyLoadRepository"/);assert.match(html,/id="storyImportFile"/);
 assert.match(app,/function openStoryChapter/);assert.match(app,/function showStoryWord/);assert.match(app,/function playStorySentences/);
 assert.match(db,/createObjectStore\('storyProgress'/);assert.match(db,/createObjectStore\('storyEncountered'/);
 assert.match(stories,/export function parseStoryText/);assert.match(stories,/export async function extractDocxText/);
 assert.match(app,/storyProgress/);assert.match(app,/storyEncountered/);
});

test('Stories has explicit continuous narration controls and playback state',()=>{
 for(const id of ['storyPlayPause','storyRepeatSentence','storyStop','storyPlaybackStatus'])assert.ok(html.includes('id="'+id+'"'));
 assert.ok(!html.includes('id="storyPlayAll"'));
 assert.ok(app.includes('new SpeechSynthesisUtterance(text)'));
 assert.ok(app.includes('u.onboundary'));
 assert.ok(app.includes('speechSynthesis.pause()'));
 assert.ok(app.includes('speechSynthesis.resume()'));
 assert.doesNotMatch(app,/waitStory\\(560,token\\)/);
 assert.ok(app.includes("speakNeural(voice,text,rate,stage"));
});
test('Story vocabulary popups remove universal underlines and support dictionary-form confirmation',async()=>{
 const css=await readFile(new URL('../css/app.css',import.meta.url),'utf8');
 assert.ok(css.includes('.story-word { border:0 !important; text-decoration:none !important'));
 assert.ok(app.includes('function findStoryVocabularyEntry'));
 assert.ok(app.includes('dictionaryHref(key)'));
 assert.ok(app.includes('id="storyWordLemma"'));
 assert.ok(app.includes('This dictionary form is already in your vocabulary'));
 assert.ok(app.includes('showStoryWord(w.dataset.storyWord,w)'));
});


test('Stories vocabulary lookup normalizes punctuation and matches inflected forms against stored lemmas',()=>{
 assert.match(app,/normalize\('NFC'\)/);
 assert.match(app,/function storyLookupForms/);
 assert.match(app,/STORY_IRREGULAR_FORMS/);
 assert.match(app,/storyGeneratedForms/);
 assert.match(app,/storyFieldForms/);
 assert.match(app,/presentEr/);
});
test('Story word popups render before optional encounter tracking and support English translation fields',()=>{
 assert.match(app,/info\.hidden=false;info\.style\.display='block'/);
 assert.match(app,/entry\?\.translation_en/);
 assert.match(app,/Could not save story word encounter/);
});
test('Story playback has no artificial paragraph delay',()=>{
 assert.doesNotMatch(app,/waitStory\(560,token\)/);
});


test('Stories narrates a chapter as one continuous utterance with global sentence offsets',()=>{
 assert.match(app,/currentStoryNarrationText=currentStoryChapter\.paragraphs\.join/);
 assert.match(app,/globalStart:globalOffset/);
 assert.match(app,/speakSystemStoryParagraph\(text,textStart,token\)/);
 assert.doesNotMatch(app,/for\(let pi=first\.paragraphIndex/);
 assert.doesNotMatch(app,/waitStory\(/);
});
test('Stories vocabulary matching checks saved forms and common irregular and regular German verb forms',()=>{
 assert.match(app,/STORY_IRREGULAR_FORMS/);
 assert.match(app,/gegangen/);
 assert.match(app,/function storyGeneratedForms/);
 assert.match(app,/presentEr/);
});
test('Story word popup closes on outside tap and Escape without closing when tapped inside',()=>{
 assert.match(app,/document\.addEventListener\('pointerdown'/);
 assert.match(app,/!wordPopup\.contains\(event\.target\)/);
 assert.match(app,/event\.key==='Escape'/);
 assert.match(app,/wordPopup\.addEventListener\('pointerdown'.*stopPropagation/);
});


test('Story Phonon narration uses a continuous plain-text stream without paragraph newline tokens',()=>{
 assert.match(app,/currentStoryNarrationText=currentStoryChapter\.paragraphs\.join\(' '\)/);
 assert.match(app,/globalOffset\+=p\.length\+1/);
 assert.doesNotMatch(app,/currentStoryNarrationText=currentStoryChapter\.paragraphs\.join\('\\n\\n'\)/);
});
test('Separable verb particles are not matched as standalone vocabulary words',()=>{
 const normalizeSource=app.match(/function normaliseStoryWord\\(value\\)\\{[^\\n]+/)?.[0];
 const formsSource=app.match(/function storyFieldForms\\(value\\)\\{[^\\n]+/)?.[0];
 assert.ok(normalizeSource);assert.ok(formsSource);
 const normaliseStoryWord=new Function(normalizeSource+';return normaliseStoryWord')();
 const storyFieldForms=new Function('normaliseStoryWord','STORY_SEPARABLE_PARTICLES',formsSource+';return storyFieldForms')(normaliseStoryWord,new Set(['ab','an','auf','aus','bei','da','ein','fort','her','hin','los','mit','nach','vor','weg','zu','zurück']));
 assert.ok(storyFieldForms('fordert auf').includes('fordert auf'));
 assert.ok(storyFieldForms('fordert auf').includes('fordert'));
 assert.ok(!storyFieldForms('fordert auf').includes('auf'));
 assert.ok(storyFieldForms('ist gegangen').includes('gegangen'));
});
