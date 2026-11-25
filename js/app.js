import {openDB,setDB,all,put,putMany,putReviewResult,replaceImportBatch,removeMany,remove,clear,getSetting,setSetting,deleteWordsAndLogs,mergeBackupRecords} from './db.js';
// All learning content comes from the learner's own vocabulary.
import {today,isDue,schedule,ensureSchedules,ratingButtonInfo} from './scheduler.js';
import {hasLearningHistory,buildDailyStudyQueue,distributionFor,sm2LearningStage} from './study-session.js';
import {conjugationRows,dictionaryHref} from './flashcard.js';
import {parseCSV} from './csv.js';
import {stripArticle,formatPlural,pluralOptions,getArticle,inferPartOfSpeech,buildVerbBank,buildVerbQuestions,uniqueOptions,shuffle} from './challenges.js';
import {getVoiceStorageStatus,downloadNeuralVoice,speakNeural,speakNeuralSegments,pauseNeuralSpeech,resumeNeuralSpeech,stopNeuralSpeech,terminateNeuralWorker,deleteAllNeuralVoices} from './voice-manager.js';
import {createStoryNarrationPlan} from './story-audio.js';
import {parseStoryText,extractDocxText,splitStorySentences} from './stories.js';
const $=id=>document.getElementById(id),uid=()=>crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(16).slice(2)}`;
const SETTING_DEFAULTS={theme:'dark',dailyGoal:10,newWordsPerDay:10,algorithm:'sm2',speechRate:.88,germanVoiceMode:'system',englishVoiceMode:'system',v3StartedOn:null};
const ALGORITHMS=['sm2','leitner'],THEMES=['dark','light','system'],GOALS=[5,10,15,20,30],RATES=[.75,.88,1];
// Settings come from IndexedDB or a user-supplied backup file, so never trust them blindly:
// an unknown algorithm name makes the scheduler throw and the app would fail to start.
function sanitizeSettings(raw={}){
 const r=raw||{},num=v=>Number(v);
 const out={};
 if(ALGORITHMS.includes(r.algorithm))out.algorithm=r.algorithm;
 if(THEMES.includes(r.theme))out.theme=r.theme;
 if(GOALS.includes(num(r.dailyGoal)))out.dailyGoal=num(r.dailyGoal);
 if(GOALS.includes(num(r.newWordsPerDay)))out.newWordsPerDay=num(r.newWordsPerDay);
 if(RATES.includes(num(r.speechRate)))out.speechRate=num(r.speechRate);
 out.germanVoiceMode=['system','nele','anton'].includes(r.germanVoiceMode)?r.germanVoiceMode:'system';
 out.englishVoiceMode=['system','zoey','easton'].includes(r.englishVoiceMode)?r.englishVoiceMode:'system';
 if(typeof r.v3StartedOn==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(r.v3StartedOn))out.v3StartedOn=r.v3StartedOn;
 return out;
}
let words=[],settings={},logs=[],sessions=[],stories=[],storyProgress=[],storyEncountered=[],currentStory=null,currentStoryChapter=null,currentStorySentences=[],storyPlaybackToken=0,currentView='home',studyQueue=[],studyIndex=0,currentWord=null,exercise=null,toastTimer,libraryLimit=100;
const voiceModelReady={nele:false,anton:false,zoey:false,easton:false};let voiceFailureShown=false,voiceDownloadRunning=false;
function applyLanguage(){document.documentElement.lang='en';}
function toast(msg){const el=$('toast');el.textContent=msg;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),2400)}
function activeWords(){return words}
function dueWords(){const method=settings.algorithm||'sm2';return activeWords().filter(w=>hasLearningHistory(w,logs)&&isDue(w,method)).sort((a,b)=>String(a.scheduling?.[method]?.dueDate||a.dueDate||'').localeCompare(String(b.scheduling?.[method]?.dueDate||b.dueDate||'')))}
function newWordsRemaining(){const used=new Set(logs.filter(x=>x.type==='new_word'&&x.date===today()).map(x=>x.wordId));return Math.max(0,Number(settings.newWordsPerDay||10)-used.size)}
function availableStudyQueue(){const method=settings.algorithm||'sm2';return buildDailyStudyQueue({words:activeWords(),reviewLogs:logs,duePredicate:w=>isDue(w,method),date:today(),newWordsPerDay:settings.newWordsPerDay||10,method})}
function reviewedToday(){const seen=new Set();for(const log of logs)if(log.date===today()&&log.type==='review')seen.add(log.wordId);return seen.size}
function streak(){
 const byDate=new Map(),cutoff=settings.v3StartedOn||today();
 for(const log of logs){
  let day=byDate.get(log.date);if(!day){day={legacy:false,quiz:false,reviews:new Set()};byDate.set(log.date,day);}
  if(log.type==='legacy'){day.legacy=true;continue;}
  if(log.legacy||log.date<cutoff)continue;
  if(log.type==='quiz'&&(Number(log.total||0)>0||log.legacy))day.quiz=true;
  if(log.type==='review'&&log.wordId)day.reviews.add(log.wordId);
 }
 const days=[...byDate.entries()].filter(([,v])=>v.legacy||v.quiz||v.reviews.size>=5).map(([date])=>date).sort();
 const set=new Set(days);let current=0,d=new Date();if(!set.has(today()))d.setDate(d.getDate()-1);
 for(;;){const key=localDate(d);if(set.has(key)){current++;d.setDate(d.getDate()-1);}else break;}
 let best=0,run=0,previous=null;for(const date of days){const dt=new Date(date+'T12:00:00');if(previous&&Math.round((dt-previous)/86400000)===1)run++;else run=1;best=Math.max(best,run);previous=dt;}
 return {current,best};
}

function renderStories(){
 const host=$('storyList');if(!host)return;
 host.innerHTML=stories.length?stories.map(story=>{const chapters=story.parts.flatMap(p=>p.chapters),done=chapters.filter(c=>storyProgress.some(x=>x.chapterId===c.id&&x.completed)).length;
 return '<article class="story-card"><div class="story-card-heading"><div><span class="eyebrow">YOUR STORY</span><h2>'+esc(story.title)+'</h2><p>'+chapters.length+' chapters · '+done+' completed</p></div><button class="text-button" type="button" data-story-delete="'+esc(story.id)+'">Delete</button></div>'+story.parts.map(part=>'<section class="story-part"><h3>'+esc(part.title)+'</h3>'+part.chapters.map(ch=>{const pr=storyProgress.find(x=>x.chapterId===ch.id);return '<button class="story-chapter-row" type="button" data-story-open="'+esc(story.id)+'" data-chapter-open="'+esc(ch.id)+'"><span><b>'+esc(ch.title)+'</b><small>'+ch.paragraphs.length+' paragraphs · '+(pr?.completed?'Completed':pr?'In progress':'Not started')+'</small></span><span>›</span></button>';}).join('')+'</section>').join('')+'</article>';}).join(''):'<div class="empty-state"><h2>Your reading library is empty</h2><p>Import your own .docx or .txt story. Parts and chapters are detected from headings.</p></div>';
}
function bindStories(){
 const wordPopup=$('storyWordInfo');document.addEventListener('pointerdown',event=>{if(!wordPopup.hidden&&!wordPopup.contains(event.target))closeStoryWordPopup();});document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!wordPopup.hidden)closeStoryWordPopup();});wordPopup.addEventListener('pointerdown',event=>event.stopPropagation());
 $('storyImportOpen').onclick=()=>$('storyImportFile').click();
 $('storyImportFile').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{await importStoryFile(file);}catch(err){toast(err.message||'Could not import story.');}finally{e.target.value='';}};
 $('storyLoadRepository').onclick=loadRepositoryStory;
 $('storyList').onclick=async e=>{const del=e.target.closest('[data-story-delete]'),open=e.target.closest('[data-story-open]');
  if(del){const id=del.dataset.storyDelete;if(!confirm('Delete this story and its reading progress? Vocabulary and review history will not be changed.'))return;const target=stories.find(x=>x.id===id);if(!target)return;const ids=target.parts.flatMap(p=>p.chapters.map(c=>c.id));await remove('stories',id);for(const cid of ids){await remove('storyProgress',cid);for(const x of storyEncountered.filter(y=>y.chapterId===cid))await remove('storyEncountered',x.id);}stories=await all('stories');storyProgress=await all('storyProgress');storyEncountered=await all('storyEncountered');renderStories();toast('Story deleted. Vocabulary and review schedules are unchanged.');}
  else if(open)openStoryChapter(open.dataset.storyOpen,open.dataset.chapterOpen);
 };
 $('storyBack').onclick=()=>{stopStoryPlayback();$('storyReader').hidden=true;$('storyLibrary').hidden=false;renderStories();};
 $('storyReaderContent').onclick=async e=>{const w=e.target.closest('[data-story-word]'),s=e.target.closest('[data-story-sentence]'),p=e.target.closest('[data-story-paragraph]');if(w){await showStoryWord(w.dataset.storyWord,w);return;}if(s){playStorySentences(Number(s.dataset.storySentence));return;}if(p)playStoryParagraph(Number(p.dataset.storyParagraph));};
 $('storyPlayPause').onclick=toggleStoryPlayback;$('storyStop').onclick=stopStoryPlayback;$('storyRepeatSentence').onclick=()=>playStorySentences(currentStorySentenceIndex,true);
 $('storyCompleteChapter').onclick=completeStoryChapter;
}
async function importStoryFile(file){const content=file.name.toLowerCase().endsWith('.docx')?await extractDocxText(file):await file.text();await saveStoryText(content,file.name||'Imported story');}
async function loadRepositoryStory(){const b=$('storyLoadRepository');b.disabled=true;b.textContent='Loading…';try{const r=await fetch('./Deutsc_geschafte.docx');if(!r.ok)throw Error('Repository DOCX not found. Import the file manually.');const blob=await r.blob();await importStoryFile(new File([blob],'Deutsc_geschafte.docx',{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));}catch(e){toast(e.message||'Could not load repository story.');}finally{b.disabled=false;b.textContent='Load Deutsc_geschafte.docx';}}
async function saveStoryText(text,fileName){const parts=parseStoryText(text),count=parts.reduce((n,p)=>n+p.chapters.length,0);if(!count)throw Error('No readable chapters were found.');const id=uid();for(const p of parts)for(const c of p.chapters)c.id=id+'-'+c.id;const story={id,title:String(fileName).replace(/\.(docx|txt)$/i,'').replace(/[_-]+/g,' ').trim()||'Imported story',sourceName:fileName,parts,importedAt:new Date().toISOString()};await put('stories',story);stories=await all('stories');renderStories();toast('Imported '+count+' chapters.');}
let currentStorySentenceIndex=0,storyPlaybackState='stopped',storyActiveParagraphIndex=0,storySystemVoice=null,storyEstimateTimer=null,currentStoryNarrationText='',storyParagraphOffsets=[];
function openStoryChapter(storyId,chapterId){currentStory=stories.find(x=>x.id===storyId);currentStoryChapter=currentStory?.parts.flatMap(p=>p.chapters).find(c=>c.id===chapterId);if(!currentStoryChapter)return;stopStoryPlayback();$('storyLibrary').hidden=true;$('storyReader').hidden=false;$('storyReaderTitle').textContent=currentStoryChapter.title;$('storyReaderSubtitle').textContent=currentStory.title;const pr=storyProgress.find(x=>x.chapterId===chapterId);$('storyCompleteChapter').textContent=pr?.completed?'Completed ✓':'Mark chapter complete';currentStorySentences=[];currentStoryNarrationText=currentStoryChapter.paragraphs.join(' ');storyParagraphOffsets=[];let html='',globalOffset=0;currentStoryChapter.paragraphs.forEach((p,pi)=>{storyParagraphOffsets.push(globalOffset);let cursor=0;const rendered=splitStorySentences(p).map(sentence=>{const i=currentStorySentences.length,start=p.indexOf(sentence,cursor);cursor=Math.max(cursor,start)+sentence.length;currentStorySentences.push({text:sentence,paragraphIndex:pi,start:Math.max(0,start),globalStart:globalOffset+Math.max(0,start)});return renderStorySentence(sentence,i);}).join(' ');html+='<section class="story-paragraph" data-story-paragraph-block="'+pi+'"><div class="story-paragraph-tools"><span>Paragraph '+(pi+1)+'</span><button class="text-button" type="button" data-story-paragraph="'+pi+'">Listen to paragraph ▶</button></div><p>'+rendered+'</p></section>';globalOffset+=p.length+1;});$('storyReaderContent').innerHTML=html;closeStoryWordPopup();$('storyPlaybackStatus').textContent='Ready to listen';$('storyPlayPause').textContent='▶ Play';$('storyRepeatSentence').disabled=true;put('storyProgress',{id:chapterId,storyId,chapterId,lastOpenedAt:new Date().toISOString(),lastParagraph:pr?.lastParagraph||0,completed:!!pr?.completed,completedAt:pr?.completedAt||null}).then(async()=>storyProgress=await all('storyProgress')).catch(console.error);}
function renderStorySentence(sentence,index){const re=/[\p{L}\p{M}]+(?:[-’'][\p{L}\p{M}]+)*/gu;let html='',last=0,m;while((m=re.exec(sentence))){html+=esc(sentence.slice(last,m.index));html+='<button type="button" class="story-word" data-story-word="'+esc(m[0])+'">'+esc(m[0])+'</button>';last=m.index+m[0].length;}html+=esc(sentence.slice(last));return '<span class="story-sentence" data-story-sentence="'+index+'">'+html+'</span>';}
function normaliseStoryWord(value){return String(value||'').normalize('NFC').toLocaleLowerCase('de-DE').replace(/^[^\p{L}\p{M}]+|[^\p{L}\p{M}]+$/gu,'').trim();}
const STORY_IRREGULAR_FORMS={
 sein:'bin bist ist sind seid war waren gewesen',haben:'habe hast hat haben habt hatte hatten gehabt',werden:'werde wirst wird werden werdet wurde wurden geworden',
 gehen:'gehe gehst geht gehen ging gingen gegangen',kommen:'komme kommst kommt kommen kam kamen gekommen',sehen:'sehe siehst sieht sehen sah sahen gesehen',
 geben:'gebe gibst gibt geben gab gaben gegeben',nehmen:'nehme nimmst nimmt nehmen nahm nahmen genommen',sprechen:'spreche sprichst spricht sprechen sprach sprachen gesprochen',
 fahren:'fahre fährst fährt fahren fuhr fuhren gefahren',laufen:'laufe läufst läuft laufen lief liefen gelaufen',lesen:'lese liest lesen las lasen gelesen',
 essen:'esse isst essen aß aßen gegessen',trinken:'trinke trinkst trinkt trinken trank tranken getrunken',schreiben:'schreibe schreibst schreibt schreiben schrieb schrieben geschrieben',
 finden:'finde findest findet finden fand fanden gefunden',bleiben:'bleibe bleibst bleibt bleiben blieb blieben geblieben',liegen:'liege liegst liegt liegen lag lagen gelegen',
 stehen:'stehe stehst steht stehen stand standen gestanden',sitzen:'sitze sitzt sitzen saß saßen gesessen',schlafen:'schlafe schläfst schläft schlafen schlief schliefen geschlafen',
 tragen:'trage trägst trägt tragen trug trugen getragen',treffen:'treffe triffst trifft treffen traf trafen getroffen',helfen:'helfe hilfst hilft helfen half halfen geholfen',
 denken:'denke denkst denkt denken dachte dachten gedacht',bringen:'bringe bringst bringt bringen brachte brachten gebracht',wissen:'weiß weißt wissen wusste wussten gewusst',
 kennen:'kenne kennst kennt kennen kannte kannten gekannt',tun:'tue tust tut tun tat taten getan',rufen:'rufe rufst ruft rufen rief riefen gerufen',
 ziehen:'ziehe ziehst zieht ziehen zog zogen gezogen',verlieren:'verliere verlierst verliert verlieren verlor verloren',gewinnen:'gewinne gewinnst gewinnt gewinnen gewann gewonnen',
 beginnen:'beginne beginnst beginnt beginnen begann begonnen',vergessen:'vergesse vergisst vergessen vergaß vergaßen',steigen:'steige steigst steigt steigen stieg stiegen gestiegen',
 fallen:'falle fällst fällt fallen fiel fielen gefallen',halten:'halte hältst hält halten hielt hielten gehalten',lassen:'lasse lässt lassen ließ ließen gelassen',
 schließen:'schließe schließt schließen schloss schlossen geschlossen',entscheiden:'entscheide entscheidest entscheidet entscheiden entschied entschieden',
 verstehen:'verstehe verstehst versteht verstehen verstand verstanden',können:'kann kannst können konnte konnten gekonnt',müssen:'muss musst müssen musste mussten gemusst',
 dürfen:'darf darfst dürfen durfte durften gedurft',sollen:'soll sollst sollen sollte sollten gesollt',wollen:'will willst wollen wollte wollten gewollt',mögen:'mag magst mögen mochte mochten gemocht'
};
const STORY_IRREGULAR_LOOKUP=(()=>{const map=new Map();for(const [lemma,forms] of Object.entries(STORY_IRREGULAR_FORMS)){map.set(lemma,lemma);for(const form of forms.split(/\s+/))map.set(form,lemma);}return map;})();
const STORY_SEPARABLE_PARTICLES=new Set(['ab','an','auf','aus','bei','da','ein','empor','entgegen','entlang','fest','fort','gegenüber','heim','her','heraus','herein','herunter','hin','hinauf','hinein','hinaus','hinunter','los','mit','nach','nieder','statt','um','vor','vorbei','weg','weiter','zu','zurück','zusammen']);
function storyFieldForms(value){return String(value||'').split(/[;,|/]+/).flatMap(part=>{const phrase=normaliseStoryWord(part);if(!phrase)return[];const tokens=phrase.split(/\s+/);return[phrase,...tokens.filter((token,index)=>!(tokens.length>1&&index>0&&STORY_SEPARABLE_PARTICLES.has(token)))];});}
function storyGeneratedForms(word){const forms=new Set([word.german,stripArticle(word.german||''),word.plural,word.presentIch,word.presentDu,word.presentEr,word.presentWir,word.presentIhr,word.presentSie,word.prateritum,word.perfekt].flatMap(storyFieldForms));const lemma=normaliseStoryWord(stripArticle(word.german||''));if(!lemma)return forms;
 const irregular=STORY_IRREGULAR_FORMS[lemma];if(irregular)for(const f of irregular.split(/\s+/))forms.add(f);
 if(lemma.endsWith('en')&&lemma.length>4){const stem=lemma.slice(0,-2),soft=/[td]$/.test(stem),participle=lemma.endsWith('ieren')?stem+'t':'ge'+stem+(soft?'et':'t');for(const f of [stem,stem+'e',stem+(soft?'est':'st'),stem+(soft?'et':'t'),stem+'te',stem+'ten',participle])forms.add(f);}
 // Comparative umlaut forms such as größer -> groß are resolved through reversed endings and umlaut candidates.
 if(['adjective','adjektiv','adj'].includes(String(word.partOfSpeech||'').toLowerCase())){for(const suffix of ['sten','ste','ster','stes','stem','er','es','em','e','en'])if(lemma.endsWith(suffix)&&lemma.length>suffix.length+2)forms.add(lemma.slice(0,-suffix.length));}
 return forms;}
function storyLookupForms(raw){const key=normaliseStoryWord(raw),forms=new Set(key?[key]:[]),add=value=>{const v=normaliseStoryWord(value);if(v)forms.add(v);};
 const endings=['ern','em','en','er','es','e','n','s','st','t','te','ten','est','et','sten','ste','ster','stes','stem'];
 for(const form of [...forms]){for(const suffix of endings){if(form.length<=suffix.length+2||!form.endsWith(suffix))continue;const stem=form.slice(0,-suffix.length);add(stem);for(const ending of ['en','n','e','er','s',''])add(stem+ending);}
  const plain=form.replace(/ä/g,'a').replace(/ö/g,'o').replace(/ü/g,'u');add(plain);for(const suffix of endings)if(plain.endsWith(suffix)&&plain.length>suffix.length+2)add(plain.slice(0,-suffix.length));
 }
 const irregular=STORY_IRREGULAR_LOOKUP.get(key);if(irregular)add(irregular);
 return forms;}
function findStoryVocabularyEntry(raw){const key=normaliseStoryWord(raw);if(!key)return null;const exact=words.find(w=>storyGeneratedForms(w).has(key));if(exact)return exact;
 const candidates=storyLookupForms(key);return words.find(w=>candidates.has(normaliseStoryWord(stripArticle(w.german||'')))||[...storyGeneratedForms(w)].some(form=>candidates.has(form)))||null;}
function closeStoryWordPopup(){const info=$('storyWordInfo');info.hidden=true;info.style.display='none';}
async function showStoryWord(raw,anchor){const key=normaliseStoryWord(raw);if(!key||!currentStoryChapter)return;const entry=findStoryVocabularyEntry(key),old=storyEncountered.find(x=>x.chapterId===currentStoryChapter.id&&x.word===key),now=new Date().toISOString();const info=$('storyWordInfo');const meaning=entry?.translation||entry?.meaning||entry?.translation_en||entry?.english||'';const title=entry?.german||raw;info.innerHTML='<div class="story-word-popover-head"><div><span class="eyebrow">'+(entry?'IN YOUR VOCABULARY':'NOT IN YOUR VOCABULARY')+'</span><h3>'+esc(title)+'</h3></div><button class="icon-button" id="storyWordClose" type="button" aria-label="Close">×</button></div>'+(entry?'<p class="story-word-meaning">'+(meaning?esc(meaning):'No English meaning has been saved for this word.')+'</p>':'<p class="story-word-meaning">This word is not in your personal vocabulary yet.</p><label class="story-lemma-label" for="storyWordLemma">Dictionary form (lemma)</label><input class="field story-lemma-input" id="storyWordLemma" value="'+esc(key)+'" autocomplete="off">')+'<div class="story-word-actions">'+(entry?'<button type="button" class="button button-outline" id="storyWordSpeak">🔊</button>':'<a class="button button-outline" id="storyWordDictionary" href="'+esc(dictionaryHref(key))+'" target="_blank" rel="noopener noreferrer">Look up</a><button type="button" class="button button-primary" id="storyWordAdd">＋ Add</button>')+'</div>';
 info.hidden=false;info.style.display='block';if(anchor){const r=anchor.getBoundingClientRect(),width=Math.min(286,window.innerWidth-24),left=Math.max(12,Math.min(window.innerWidth-width-12,r.left)),top=Math.max(12,Math.min(window.innerHeight-220,r.bottom+8));info.style.position='fixed';info.style.width=width+'px';info.style.left=left+'px';info.style.top=top+'px';info.style.right='auto';}else{info.style.position='sticky';info.style.left='';info.style.top='8px';}
 $('storyWordClose').onclick=closeStoryWordPopup;if(entry)$('storyWordSpeak').onclick=()=>speak(title,'de');else $('storyWordAdd').onclick=()=>{const lemma=normaliseStoryWord($('storyWordLemma').value)||key;const duplicate=findStoryVocabularyEntry(lemma);if(duplicate){toast('This dictionary form is already in your vocabulary.');info.hidden=true;info.style.display='none';return;}info.hidden=true;info.style.display='none';showView('library');openEditor({german:lemma});};
 // Encounter tracking is secondary: a storage failure must never prevent the popup from opening.
 put('storyEncountered',{id:currentStoryChapter.id+':'+key,storyId:currentStory.id,chapterId:currentStoryChapter.id,word:key,firstSeenAt:old?.firstSeenAt||now,lastSeenAt:now,timesSeen:(old?.timesSeen||0)+1}).then(()=>all('storyEncountered')).then(rows=>storyEncountered=rows).catch(error=>console.warn('Could not save story word encounter',error));}
function setStoryHighlight(i){document.querySelectorAll('.story-sentence.is-speaking').forEach(x=>x.classList.remove('is-speaking'));const el=document.querySelector('[data-story-sentence="'+i+'"]');if(el){el.classList.add('is-speaking');el.scrollIntoView({block:'nearest',behavior:'smooth'});}currentStorySentenceIndex=i;}
function updateStoryPlayer(state,message){storyPlaybackState=state;$('storyPlaybackStatus').textContent=message||({playing:'Playing',paused:'Paused',stopped:'Ready to listen',finished:'Finished'}[state]||'Ready to listen');$('storyPlayPause').textContent=state==='playing'?'Ⅱ Pause':state==='paused'?'▶ Resume':'▶ Play';$('storyRepeatSentence').disabled=!currentStorySentences.length||state==='stopped'&&currentStorySentenceIndex===0;}
function highlightNarrationChunk(chunkText,duration,startOffset,token){if(storyEstimateTimer){clearInterval(storyEstimateTimer);storyEstimateTimer=null;}const normalised=String(chunkText||'').trim();if(!normalised||!duration)return startOffset;const chunkStart=currentStoryNarrationText.indexOf(normalised,Math.max(0,startOffset));if(chunkStart<0)return startOffset;const chunkEnd=chunkStart+normalised.length;const list=currentStorySentences.map((s,i)=>({...s,index:i})).filter(s=>s.globalStart<chunkEnd&&s.globalStart+s.text.length>chunkStart);if(!list.length)return chunkEnd;const weights=list.map(s=>Math.max(1,Math.min(chunkEnd,s.globalStart+s.text.length)-Math.max(chunkStart,s.globalStart)));const total=weights.reduce((sum,n)=>sum+n,0);let elapsed=0,lastTick=performance.now(),active=-1;storyEstimateTimer=setInterval(()=>{if(token!==storyPlaybackToken){clearInterval(storyEstimateTimer);storyEstimateTimer=null;return;}const now=performance.now();if(storyPlaybackState!=='paused')elapsed+=(now-lastTick)/1000;lastTick=now;const progress=Math.min(1,elapsed/Math.max(.01,duration))*total;let accumulated=0,next=list[list.length-1];for(let i=0;i<list.length;i++){accumulated+=weights[i];if(progress<=accumulated){next=list[i];break;}}if(next.index!==active){active=next.index;currentStorySentenceIndex=next.index;setStoryHighlight(next.index);}if(elapsed>=duration){clearInterval(storyEstimateTimer);storyEstimateTimer=null;}},50);return chunkEnd;}
function speakSystemStoryParagraph(text,startOffset,token){return new Promise((resolve,reject)=>{const u=new SpeechSynthesisUtterance(text),rate=Number($('storySpeechRate').value||.88);u.lang='de-DE';u.rate=rate;if(storySystemVoice)u.voice=storySystemVoice;u.onstart=()=>updateStoryPlayer('playing','Playing');u.onboundary=e=>{if(token!==storyPlaybackToken||typeof e.charIndex!=='number')return;const absolute=e.charIndex+startOffset,match=currentStorySentences.map((s,i)=>({...s,index:i})).filter(s=>s.globalStart<=absolute).pop();if(match){currentStorySentenceIndex=match.index;setStoryHighlight(match.index);}};u.onend=resolve;u.onerror=e=>['canceled','interrupted'].includes(e.error)?resolve():reject(Error('Browser speech playback failed.'));speechSynthesis.speak(u);});}
async function playStorySentences(start,mode=false){
 if(!currentStoryChapter)return;
 const onlySentence=mode===true,onlyParagraph=mode==='paragraph',token=++storyPlaybackToken;
 if(storyEstimateTimer){clearInterval(storyEstimateTimer);storyEstimateTimer=null;}
 if('speechSynthesis'in window)speechSynthesis.cancel();
 stopNeuralSpeech();
 const voice=settings.germanVoiceMode||'system',rate=Number($('storySpeechRate').value||.88);
 if(voice==='system'){
  const voices=speechSynthesis.getVoices();
  storySystemVoice=storySystemVoice||voices.find(v=>/^de[-_]DE$/i.test(v.lang))||voices.find(v=>/^de/i.test(v.lang))||null;
 }else{
  if(!voiceModelReady[voice]){toast('Selected Phonon voice is not downloaded. Choose System or download the voice in Settings.');updateStoryPlayer('stopped','Selected Phonon voice is not installed');return;}
  storySystemVoice=null;
 }
 currentStorySentenceIndex=Math.max(0,Math.min(start,currentStorySentences.length-1));
 const first=currentStorySentences[currentStorySentenceIndex];if(!first)return;
 const plan=createStoryNarrationPlan({paragraphs:currentStoryChapter.paragraphs,sentences:currentStorySentences,startIndex:currentStorySentenceIndex,mode:onlySentence?'sentence':onlyParagraph?'paragraph':'chapter'});
 if(!plan||!plan.text.trim())return;
 storyActiveParagraphIndex=first.paragraphIndex;
 updateStoryPlayer('playing','Preparing narration');
 setStoryHighlight(currentStorySentenceIndex);
 const prior=storyProgress.find(x=>x.chapterId===currentStoryChapter.id)||{id:currentStoryChapter.id,storyId:currentStory.id,chapterId:currentStoryChapter.id,completed:false};
 put('storyProgress',{...prior,lastParagraph:first.paragraphIndex,lastOpenedAt:new Date().toISOString()}).then(()=>all('storyProgress')).then(rows=>storyProgress=rows).catch(error=>console.warn('Could not save story reading progress',error));
 let narrationSearchOffset=plan.startOffset;
 try{
  if(voice==='system')await speakSystemStoryParagraph(plan.text,plan.startOffset,token);
  else await speakNeuralSegments(voice,plan.segments,rate,event=>{if(typeof event==='string'){$('storyPlaybackStatus').textContent=event;return;}if(event?.type==='chunk-start'){ $('storyPlaybackStatus').textContent='Playing Phonon audio · '+event.index+'/'+event.total;narrationSearchOffset=highlightNarrationChunk(event.text,event.duration,narrationSearchOffset,token);}});
 }catch(error){if(token===storyPlaybackToken){console.error('Story narration failed:',error);toast(error.message||'Could not play this story.');updateStoryPlayer('stopped','Playback could not start');}}
 finally{if(token===storyPlaybackToken){if(storyEstimateTimer){clearInterval(storyEstimateTimer);storyEstimateTimer=null;}if(storyPlaybackState!=='paused')updateStoryPlayer('finished','Playback finished');document.querySelectorAll('.story-sentence.is-speaking').forEach(x=>x.classList.remove('is-speaking'));}}
}
function playStoryParagraph(i){const at=currentStorySentences.findIndex(x=>x.paragraphIndex===i);if(at>=0)playStorySentences(at,'paragraph');}
function toggleStoryPlayback(){
 if(storyPlaybackState==='playing'){
  if((settings.germanVoiceMode||'system')==='system'){speechSynthesis.pause();updateStoryPlayer('paused','Paused');}
  else if(pauseNeuralSpeech())updateStoryPlayer('paused','Paused');
  else stopStoryPlayback();
  return;
 }
 if(storyPlaybackState==='paused'){
  if((settings.germanVoiceMode||'system')==='system'&&speechSynthesis.speaking){speechSynthesis.resume();updateStoryPlayer('playing','Playing');}
  else if((settings.germanVoiceMode||'system')!=='system'&&resumeNeuralSpeech())updateStoryPlayer('playing','Playing');
  else playStorySentences(currentStorySentenceIndex);
  return;
 }
 playStorySentences(0);
}
function stopStoryPlayback(){
 storyPlaybackToken++;
 if('speechSynthesis'in window)speechSynthesis.cancel();
 stopNeuralSpeech();
 if(storyEstimateTimer){clearInterval(storyEstimateTimer);storyEstimateTimer=null;}
 document.querySelectorAll('.story-sentence.is-speaking').forEach(x=>x.classList.remove('is-speaking'));
 currentStorySentenceIndex=0;
 updateStoryPlayer('stopped','Stopped · ready from the beginning');
}
async function completeStoryChapter(){const id=currentStoryChapter?.id;if(!id)return;const old=storyProgress.find(x=>x.chapterId===id)||{id,storyId:currentStory.id,chapterId:id};await put('storyProgress',{...old,completed:true,completedAt:new Date().toISOString()});storyProgress=await all('storyProgress');$('storyCompleteChapter').textContent='Completed ✓';renderStories();toast('Chapter completed. Review schedules were not changed.');}

async function init(){
 try{
  try{localStorage.removeItem('deutsch-meister-piper-preloaded-v1')}catch{}
  const db=await openDB();setDB(db);
  [words,logs,sessions,stories,storyProgress,storyEncountered]=await Promise.all([all('words'),all('reviewLogs'),all('sessions'),all('stories'),all('storyProgress'),all('storyEncountered')]);
  settings={theme:await getSetting('theme','dark'),dailyGoal:await getSetting('dailyGoal',10),algorithm:await getSetting('algorithm','sm2'),speechRate:await getSetting('speechRate',.88),germanVoiceMode:await getSetting('germanVoiceMode','system'),englishVoiceMode:await getSetting('englishVoiceMode','system'),newWordsPerDay:await getSetting('newWordsPerDay',10),v3StartedOn:await getSetting('v3StartedOn',null)};
  settings={...SETTING_DEFAULTS,...sanitizeSettings(settings)};
  // Ask the browser not to evict the learner's progress under storage pressure (Safari/iOS in particular).
  try{navigator.storage?.persist?.()}catch{}
  if(!settings.v3StartedOn){settings.v3StartedOn=today();await setSetting('v3StartedOn',settings.v3StartedOn);}
  await migrateLegacyHistory();
  words=await all('words');
  for(const bundled of words.filter(w=>w.source==='builtin'))await remove('words',bundled.id);
  words=words.filter(w=>w.source!=='builtin');
  for(const w of words){const upgraded=ensureSchedules(w,settings.algorithm);if(JSON.stringify(upgraded)!==JSON.stringify(w))await put('words',upgraded);}
  words=await all('words');applyTheme();applyLanguage();bind();bindStories();renderAll();
  registerOfflineWorker();
  refreshVoiceStorageStatus().catch(error=>console.warn('Phonon cache status unavailable:',error));
  window.addEventListener('pagehide',terminateNeuralWorker);
  let shownDay=today();document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')terminateNeuralWorker();else if(today()!==shownDay){shownDay=today();if(!currentWord)renderAll();}});
 }catch(e){
  console.error('Deutsch Meister startup failed:',e);
  const host=document.getElementById('main');
  if(host){host.innerHTML=`<section class="startup-error"><h1>Deutsch Meister could not start</h1><p>${esc(e?.message||String(e))}</p><p>Your browser storage may be unavailable or blocked. Open the app from its HTTPS address and reload.</p><button class="button button-outline" onclick="location.reload()">Reload app</button></section>`;}
 }
}

async function registerOfflineWorker(){
 if(!('serviceWorker'in navigator)||!location.protocol.startsWith('http')){
  setVoiceStatus('System voices are available. Offline app caching requires HTTPS or localhost.');
  return;
 }
 try{
  await navigator.serviceWorker.register('./sw.js');
  await navigator.serviceWorker.ready;
  setVoiceStatus('System voices are available. Choose a sample, then download only the Phonon voices you want.');
 }catch(error){
  console.warn('Offline app shell could not be prepared:',error);
  setVoiceStatus('System voices are available. Offline app caching could not be prepared.');
 }
}
async function migrateLegacyHistory(){if(await getSetting('v3HistoryMigrated',false))return;const legacyActivity=await getSetting('activityByDate',{}),legacyStreak=await getSetting('streakDays',[]);for(const [date,entry] of Object.entries(legacyActivity||{})){for(const wordId of entry.reviewedWordIds||[]){await put('reviewLogs',{id:`v2-review-${date}-${wordId}`,date,type:'review',wordId,rating:'legacy',legacy:true});}for(let i=0;i<(entry.quizzes||0);i++){await put('reviewLogs',{id:`v2-quiz-${date}-${i}`,date,type:'quiz',correct:0,total:0,legacy:true});}}for(const date of legacyStreak||[]){await put('reviewLogs',{id:`v2-streak-${date}`,date,type:'legacy'});}logs=await all('reviewLogs');await setSetting('v3HistoryMigrated',true);}
function applyTheme(){const t=settings.theme||'dark';document.body.classList.toggle('light',t==='light'||(t==='system'&&matchMedia('(prefers-color-scheme: light)').matches));$('themeSelect').value=t;}
function renderAll(){renderHome();if(currentView==='stories')renderStories();if(currentView==='home')renderLearn();if(currentView==='library')renderLibrary();if(currentView==='progress')renderProgress();if(currentView==='settings')renderImportBatches();renderPracticeAvailability();$('dailyGoalSelect').value=String(settings.dailyGoal||10);$('newWordsPerDaySelect').value=String(settings.newWordsPerDay||10);$('algorithmSelect').value=settings.algorithm||'sm2';$('speechRate').value=String(settings.speechRate||.88);$('themeSelect').value=settings.theme||'dark';renderVoiceSettings();}
function renderHome(){const active=activeWords(),due=dueWords(),fresh=activeWords().filter(w=>!hasLearningHistory(w,logs)&&!logs.some(x=>x.type==='new_word'&&x.date===today()&&x.wordId===w.id)).length,goal=Number(settings.dailyGoal||10),done=reviewedToday(),st=streak(),mastered=active.filter(w=>{const x=w.scheduling?.[settings.algorithm]||w;return settings.algorithm==='leitner'?(x.box||0)>=5:(Number(x.repetitions||0)>=4);}).length;$('homeWords').textContent=active.length;$('homeDue').textContent=due.length;$('homeMastered').textContent=mastered;$('homeStreak').textContent=`${st.current} ${st.current===1?'day':'days'}`;$('goalNumber').textContent=`${done} / ${goal}`;$('goalBar').style.width=`${Math.min(100,done/goal*100)}%`;$('goalPercent').textContent=`${Math.min(100,Math.round(done/goal*100))}%`;$('goalCaption').textContent=done>=goal?'Daily goal complete — excellent work.':'A focused session is a good start.';$('homeFocusText').textContent=due.length?`${due.length} learned ${due.length===1?'word is':'words are'} due, plus up to ${Math.min(newWordsRemaining(),fresh)} new words.`:fresh&&newWordsRemaining()>0?`No reviews are due. You can learn up to ${Math.min(newWordsRemaining(),fresh)} new words today.`:'No reviews are due and no new words remain within today’s limit.';$('startReview').disabled=availableStudyQueue().length===0||!!currentWord;$('startReview').textContent=availableStudyQueue().length?'Start learning →':'No words available';}
function renderLearn(){const available=availableStudyQueue();const hasCurrent=!!currentWord;$('learnEmptyText').textContent='No learned words are due and no new words remain within today’s limit.';$('learnEmpty').hidden=available.length>0||hasCurrent;$('studyCard').hidden=!hasCurrent;$('sessionProgress').hidden=!hasCurrent;$('sessionProgress').textContent=hasCurrent?(hasLearningHistory(currentWord,logs)?`Review ${studyIndex+1} of ${studyQueue.length}`:`New word ${studyIndex+1} of ${studyQueue.length}`):'';$('homeView').classList.toggle('reviewing',hasCurrent);document.body.classList.toggle('reviewing-session',hasCurrent);if(hasCurrent)showStudyWord();}
async function startStudy(){stopStudySpeech();const queue=availableStudyQueue();studyQueue=queue;studyIndex=0;currentWord=studyQueue[0]||null;showView('home');renderLearn();renderHome();if(!currentWord)toast('No words are due or available as new today.');}
function showStudyWord({autoplay=true,preserveFace=false}={}){
 const w=currentWord;if(!w)return;
 const wasFlipped=$('studyCard').classList.contains('is-flipped');
 const method=settings.algorithm||'sm2';
 const activeState=w.scheduling?.[method]||{};
 $('studyGerman').textContent=w.german||'';
 const pos=String(w.partOfSpeech||inferPartOfSpeech(w)||'').trim();
 $('studyPartOfSpeech').textContent=pos;$('studyArticle').textContent=getArticle(w)||'';$('studyArticle').hidden=!getArticle(w);$('studyPlural').textContent=w.plural?`Plural: ${w.plural}`:'';$('studyPlural').hidden=!w.plural;
 $('studyLevel').textContent=hasLearningHistory(w,logs)?(method==='leitner'?`LEITNER · BOX ${activeState.box||1}`:`SM-2 · REPETITION ${activeState.repetitions||0}`):'NEW WORD';
 $('studyCounter').textContent=`${studyIndex+1} / ${studyQueue.length}`;
 $('studyTranslation').textContent=w.translation||'No English meaning provided.';
 // Labels and intervals must explain the selected algorithm, not assume SM-2.
 $('ratingPrompt').textContent=method==='leitner'
  ? 'Did you remember this word?'
  : 'How well did you remember?';
 $('ratingHelp').textContent=method==='leitner'
  ? 'Forgot returns it to Box 1; Remembered moves it forward one box. The interval shows when it is due again.'
  : 'The interval shows when this word is due again. You can rate without revealing the answer.';
 const ratingGrid=document.querySelector('.review-rating-panel .rating-grid');
 ratingGrid?.classList.toggle('leitner-rating-grid',method==='leitner');
 document.querySelectorAll('[data-rating]').forEach(button=>{
  const rating=button.dataset.rating;
  button.hidden=method==='leitner' && !['again','good'].includes(rating);
  if(button.hidden)return;
  const info=ratingButtonInfo(w,rating,method);
  const label=button.querySelector('b');
  const detail=button.querySelector('small');
  if(label)label.textContent=info.label;
  if(detail)detail.textContent=info.detail;
  button.setAttribute('aria-label',`${info.label}. Next review: ${info.detail}`);
 });
 $('studyTranslationSpeak').disabled=!w.translation;
 $('studyExample').textContent=w.example||'';
 $('studyExampleEn').textContent=w.exampleEn||'';
 $('studyGermanExampleBlock').hidden=!(w.example||'').trim();
 $('studyEnglishExampleBlock').hidden=!(w.exampleEn||'').trim();
 $('studyExampleSpeakDe').disabled=!(w.example||'').trim();
 $('studyExampleSpeakEn').disabled=!(w.exampleEn||'').trim();
 const dictionary=dictionaryHref(w.german);
 const link=$('studyDictionaryLink');link.hidden=!dictionary;if(dictionary)link.href=dictionary;else link.removeAttribute('href');
 const forms=conjugationRows(w);$('studyConjugations').innerHTML=forms.map(([label,value])=>`<div class="conjugation-line"><b>${esc(label)}</b><span>${esc(value)}</span></div>`).join('');$('studyConjugations').hidden=!forms.length;
 $('studyTranslationSpeak').onclick=()=>speak(w.translation,'en');
 $('studyExampleSpeakDe').onclick=()=>speak(w.example,'de');
 $('studyExampleSpeakEn').onclick=()=>speak(w.exampleEn,'en');
 $('studyCard').classList.remove('is-flipped','card-swipe-out','swipe-left','swipe-right');if(preserveFace&&wasFlipped)$('studyCard').classList.add('is-flipped');$('studyCard').setAttribute('aria-label',`Flashcard for ${w.german}. Tap to flip.`);
 if(autoplay&&!preserveFace)playStudySequence([[w.german,'de']]);
}
async function rateWord(rating){
 const card=$('studyCard');
 if(!currentWord||card.classList.contains('card-swipe-out'))return;
 stopStudySpeech();
 // Capture everything up front: the learner may end the session or switch method while the animation runs.
 const wordId=currentWord.id,method=settings.algorithm;
 const direction=rating==='again'||rating==='hard'?'left':'right';
 card.classList.add('card-swipe-out',`swipe-${direction}`);
 try{
  await new Promise(resolve=>setTimeout(resolve,230));
  // Always schedule from the freshest stored copy, never from the stale object captured when the queue was built.
  const fresh=words.find(w=>w.id===wordId);
  if(fresh){
   const updated=schedule(fresh,rating,method);
   const entry={id:uid(),date:today(),type:'review',wordId,rating,algorithm:method};
   const entries=[entry];
   const wasNew=!hasLearningHistory(fresh,logs);
   if(wasNew&&!logs.some(x=>x.type==='new_word'&&x.date===today()&&x.wordId===wordId))
    entries.push({id:uid(),date:today(),type:'new_word',wordId});
   await putReviewResult(updated,entries);
   words=words.map(w=>w.id===updated.id?updated:w);
   logs.push(...entries); // schedule and history commit together
  }
  if(!studyQueue.length)return; // session was ended while the card was animating
  studyIndex++;currentWord=studyQueue[studyIndex]||null;
  if(!currentWord){toast('Study session complete. Nice work!');$('studyCard').hidden=true;$('learnEmpty').hidden=false;}
 }catch(error){
  console.error('Could not save review:',error);
  card.classList.remove('card-swipe-out','swipe-left','swipe-right');
  toast('Could not save this review. Please try again.');
  return;
 }
 renderHome();renderLearn();if(currentView==='progress')renderProgress();
}
function renderLibrary(){
 const q=$('wordSearch').value.toLocaleLowerCase();
 const personal=words.filter(w=>!q||`${w.german} ${w.translation}`.toLocaleLowerCase().includes(q));
 const visible=personal.slice(0,libraryLimit);
 $('personalWordList').innerHTML=visible.length?visible.map(w=>`<article class="word-row" data-open-word="${esc(w.id)}" tabindex="0" role="button" aria-label="View ${esc(w.german)}"><div class="word-main"><b>${esc(w.german)}</b><small>${esc(w.translation||'')}${w.article?' · '+esc(w.article):''} · <a class="dictionary-link" href="${esc(dictionaryHref(w.german))}" target="_blank" rel="noopener noreferrer">▤ Wörterbuch</a></small></div><div class="word-actions"><button data-edit="${esc(w.id)}" aria-label="Edit word">✎</button><button data-delete="${esc(w.id)}" aria-label="Delete word">×</button></div></article>`).join(''):'<div class="empty-inline">No words found. Add a word or import your CSV file.</div>';
 const more=$('loadMoreWords');if(more){more.hidden=visible.length>=personal.length;more.textContent=`Show ${Math.min(100,personal.length-visible.length)} more (${personal.length-visible.length} remaining)`;}
 const count=$('libraryCount');if(count)count.textContent=`${personal.length} ${personal.length===1?'word':'words'}`;
}
function renderProgress(){
 const st=streak(),active=activeWords(),method=settings.algorithm||'sm2';
 const quizLogs=logs.filter(x=>x.type==='quiz'),correct=quizLogs.reduce((n,x)=>n+(x.correct||0),0),answered=quizLogs.reduce((n,x)=>n+(x.total||0),0);
 const states=active.map(w=>ensureSchedules(w,method).scheduling[method]);
 const mastered=states.filter((x,i)=>method==='leitner'?(x.box||1)>=5:Number(x.repetitions||0)>=4).length;
 const due=dueWords().length;
 $('progressStreak').innerHTML=`${st.current} <small>days</small>`;
 $('progressStreakMessage').textContent=st.current?`Your best streak is ${st.best} days. Keep it going.`:'Start your next streak today.';
 $('totalReviews').textContent=logs.filter(x=>x.type==='review').length;$('progressMastered').textContent=mastered;$('progressTotalWords').textContent=active.length;$('progressReviewedToday').textContent=reviewedToday();
 $('quizAccuracy').textContent=answered?`${Math.round(correct/answered*100)}%`:'—';
 const counts=new Map();for(const log of logs)counts.set(log.date,(counts.get(log.date)||0)+1);const last=[];for(let i=6;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);const date=localDate(d);last.push({day:['S','M','T','W','T','F','S'][d.getDay()],n:counts.get(date)||0});}
 const activityChart=$('activityChart'),hasActivity=last.some(x=>x.n>0);
 activityChart.classList.toggle('empty',!hasActivity);
 if(hasActivity){const max=Math.max(1,...last.map(x=>x.n));activityChart.innerHTML=last.map(x=>`<div class="activity-column"><i style="height:${Math.max(3,x.n/max*100)}%" title="${x.n} activities"></i><small>${x.day}</small></div>`).join('');}
 else activityChart.innerHTML='<p class="empty-inline">Your review activity will appear here.</p>';
 $('progressActivityNote').hidden=!hasActivity;
 $('progressDue').textContent=due;$('progressLearning').textContent=Math.max(0,active.length-mastered);
 const label=method==='leitner'?'Leitner':'SM-2';
 const distribution=distributionFor(active,method,logs);$('methodSnapshot').innerHTML=`<div class="distribution-heading"><strong>${label} distribution</strong><span>${distribution.total} total</span></div>${distribution.labels.map((name,i)=>`<button type="button" class="distribution-row distribution-open" data-distribution-index="${i}"><span>${name}</span><b>${distribution.counts[i]}</b><span aria-hidden="true">›</span></button>`).join('')}`;
}
function wordDetailMarkup(w){
 const rows=[['Meaning',w.translation],['Article',w.article],['Plural',w.plural],['Synonym',w.synonym],['Part of speech',w.partOfSpeech],['German example',w.example],['English example',w.exampleEn],['Notes',w.notes],...conjugationRows(w)];
 return `<div class="word-detail-title"><span class="muted">${esc(w.partOfSpeech||'Vocabulary')}</span><h2>${esc(w.german)}</h2></div>${rows.filter(([,v])=>String(v||'').trim()).map(([k,v])=>`<div class="word-detail-row"><b>${esc(k)}</b><p>${esc(v)}</p></div>`).join('')}<a class="dictionary-link" href="${esc(dictionaryHref(w.german))}" target="_blank" rel="noopener noreferrer">Open dictionary ↗</a>`;
}
function openWordDetail(word){if(!word)return;$('wordDetailContent').innerHTML=wordDetailMarkup(word);$('wordDetailModal').showModal();}
function openDistributionGroup(index){
 const method=settings.algorithm||'sm2',distribution=distributionFor(activeWords(),method,logs),label=distribution.labels[index];if(!label)return;
 const selected=activeWords().filter(w=>method==='leitner'?Number(w.scheduling?.leitner?.box||w.box||1)===index+1:sm2StageForModal(w)===label);
 $('distributionModalTitle').textContent=`${label} · ${selected.length} words`;
 $('distributionModalList').innerHTML=selected.length?selected.map(w=>`<button type="button" class="distribution-word" data-open-word="${esc(w.id)}"><span><b>${esc(w.article?`${w.article} `:'')}${esc(w.german)}</b><small>${esc(w.translation||'')}</small></span><span aria-hidden="true">›</span></button>`).join(''):'<p class="muted">No words in this group.</p>';
 $('distributionModal').showModal();
}
function sm2StageForModal(word){return sm2LearningStage(word,logs);}
function showView(name){
 if(name==='learn')name='home';currentView=name;
 document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.dataset.view===name));
 document.querySelectorAll('.nav-item').forEach(v=>v.classList.toggle('active',v.dataset.nav===name));
 if(name==='settings'){$('themeSelect').value=settings.theme||'dark';renderImportBatches();renderVoiceSettings();}
 if(name==='progress')renderProgress();
 if(name==='library')renderLibrary();
 if(name==='practice')renderPracticeAvailability();
 if(name==='stories')renderStories();
 if(name==='home'){renderHome();renderLearn();}
}
function openEditor(w=null){$('wordEditor').hidden=false;$('editorTitle').textContent=w?'Edit vocabulary':'Add vocabulary';$('editId').value=w?.id||'';for(const [field,key] of Object.entries({fieldGerman:'german',fieldTranslation:'translation',fieldArticle:'article',fieldPlural:'plural',fieldExample:'example',fieldNotes:'exampleEn',fieldPartOfSpeech:'partOfSpeech',fieldPresentIch:'presentIch',fieldPresentDu:'presentDu',fieldPresentEr:'presentEr',fieldPresentWir:'presentWir',fieldPresentIhr:'presentIhr',fieldPresentSie:'presentSie',fieldPrateritum:'prateritum',fieldPerfekt:'perfekt',fieldAuxiliary:'auxiliary'}))$(field).value=w?.[key]||'';if(w&&!w.article)$('fieldArticle').value=getArticle(w);const dialog=$('wordEditorDialog');if(!dialog.open)dialog.showModal();}
async function saveEditor(e){e.preventDefault();const id=$('editId').value||uid(),old=words.find(w=>w.id===id)||{};const typed=$('fieldGerman').value.trim().toLocaleLowerCase();if(!typed)return toast('Please enter the German word.');if(words.some(x=>x.id!==id&&String(x.german||'').trim().toLocaleLowerCase()===typed))return toast('This word is already in your library.');const w=ensureSchedules({...old,id,german:$('fieldGerman').value.trim(),translation:$('fieldTranslation').value.trim(),article:$('fieldArticle').value.trim(),plural:$('fieldPlural').value.trim(),example:$('fieldExample').value.trim(),exampleEn:$('fieldNotes').value.trim(),category:old.category||'Imported',partOfSpeech:$('fieldPartOfSpeech').value.trim(),presentIch:$('fieldPresentIch')?.value.trim()||'',presentDu:$('fieldPresentDu').value.trim(),presentEr:$('fieldPresentEr').value.trim(),presentWir:$('fieldPresentWir')?.value.trim()||'',presentIhr:$('fieldPresentIhr')?.value.trim()||'',presentSie:$('fieldPresentSie')?.value.trim()||'',prateritum:$('fieldPrateritum').value.trim(),perfekt:$('fieldPerfekt').value.trim(),auxiliary:$('fieldAuxiliary').value,source:'personal',active:true,box:old.box||1,repetitions:old.repetitions||0,easeFactor:old.easeFactor||2.5,interval:old.interval||0,dueDate:old.dueDate||today(),favorite:old.favorite||false,createdAt:old.createdAt||new Date().toISOString()},settings.algorithm);await put('words',w);words=await all('words');const editingCurrent=!!currentWord&&currentWord.id===id&&document.body.classList.contains('reviewing-session');if(editingCurrent){currentWord=w;studyQueue=studyQueue.map(item=>item.id===id?w:item);showStudyWord({autoplay:false,preserveFace:true});renderHome();}else{renderAll();}$('wordEditorDialog').close();$('wordEditor').hidden=true;e.target.reset();toast('Word saved.');}
function renderVoiceSettings(){
 const german=$('germanSpeechVoice'),english=$('englishSpeechVoice');
 if(german)german.value=settings.germanVoiceMode||'system';
 if(english)english.value=settings.englishVoiceMode||'system';
 const selected=[settings.germanVoiceMode,settings.englishVoiceMode].filter(id=>id&&id!=='system');
 const needsDownload=selected.some(id=>!voiceModelReady[id]);
 const anyDownloaded=Object.values(voiceModelReady).some(Boolean);
 const downloadButton=$('downloadVoiceModels'),removeButton=$('deleteVoiceModels');
 if(downloadButton){downloadButton.hidden=!selected.length||!needsDownload;downloadButton.disabled=voiceDownloadRunning;}
 if(removeButton){removeButton.hidden=!anyDownloaded;removeButton.disabled=voiceDownloadRunning;}
}
function setVoiceStatus(message,percent=null){
 const status=$('voiceDownloadStatus');if(status)status.textContent=message;
 const track=$('voiceProgressTrack'),bar=$('voiceProgressBar');
 if(track)track.hidden=percent===null;
 if(bar&&percent!==null)bar.style.width=`${Math.max(0,Math.min(100,percent))}%`;
}
async function refreshVoiceStorageStatus(){
 const result=await getVoiceStorageStatus();
 Object.assign(voiceModelReady,result.voices||{});
 renderVoiceSettings();
 const selected=[settings.germanVoiceMode,settings.englishVoiceMode].filter(id=>id&&id!=='system');
 if(selected.some(id=>voiceModelReady[id]))setVoiceStatus('Your selected Phonon voice is ready for offline use.');
 else if(result.anyDownloaded)setVoiceStatus('Phonon voices are saved on this device. Select one to use it.');
 else setVoiceStatus('Listen to the samples below. System voices work immediately; download only the Phonon voices you choose.');
}
async function downloadSelectedVoices(){
 if(voiceDownloadRunning)return;
 const selected=[...new Set([settings.germanVoiceMode,settings.englishVoiceMode].filter(id=>id&&id!=='system'&&!voiceModelReady[id]))];
 if(!selected.length)return toast('Choose a Phonon voice first.');
 if(!navigator.onLine)return toast('Connect to the internet before downloading a voice.');
 if(!confirm('Download the selected Phonon voice(s)? The shared multilingual model is about 75 MB on the first download. Additional selected voice embeddings are small.'))return;
 voiceDownloadRunning=true;renderVoiceSettings();
 try{
  for(let i=0;i<selected.length;i++){
   const id=selected[i],label=id[0].toUpperCase()+id.slice(1);
   setVoiceStatus(`Preparing ${label}…`,0);
   const result=await downloadNeuralVoice(id,progress=>{
    const file=String(progress.file||'voice files').replace('voice:','');
    const pct=progress.total?Math.round(progress.loaded/progress.total*100):0;
    const stage=progress.cached?'Reading saved':'Downloading';
    setVoiceStatus(`${label}: ${stage} ${file} · ${pct}%`,pct);
   });
   Object.assign(voiceModelReady,result.voices||{});
   setVoiceStatus(`${label} is installed and ready offline.`,100);
  }
  renderVoiceSettings();
  setVoiceStatus('Selected Phonon voice(s) are installed for offline use.',100);
  toast('Phonon voice download complete.');
 }catch(error){
  console.error('Phonon download failed:',error);
  setVoiceStatus(`Voice download failed: ${error?.message||String(error)}. System voices remain available.`);
  toast('Could not install the selected Phonon voice.');
 }finally{voiceDownloadRunning=false;renderVoiceSettings();}
}
async function deleteDownloadedVoices(){
 if(voiceDownloadRunning)return;
 if(!confirm('Delete all downloaded Phonon voices and the shared model from this device? Your vocabulary and learning progress will not be affected.'))return;
 voiceDownloadRunning=true;renderVoiceSettings();
 try{
  terminateNeuralWorker();
  await deleteAllNeuralVoices();
  const remaining=await getVoiceStorageStatus();
  if(!remaining.cacheAvailable)throw new Error('Browser Cache Storage is unavailable, so deletion could not be verified.');
  if(remaining.anyCachedFiles||remaining.modelReady||remaining.anyDownloaded)throw new Error('Some Phonon model files are still present in browser storage.');
  for(const id of Object.keys(voiceModelReady))voiceModelReady[id]=false;
  settings.germanVoiceMode='system';settings.englishVoiceMode='system';
  await Promise.all([setSetting('germanVoiceMode','system'),setSetting('englishVoiceMode','system')]);
  setVoiceStatus('Downloaded Phonon model and voices deleted. System voices are active.');
  toast('Downloaded Phonon voices deleted.');
 }catch(error){
  setVoiceStatus(`Could not delete all Phonon files: ${error?.message||String(error)}`);
  toast('Voice deletion failed.');
 }finally{voiceDownloadRunning=false;renderVoiceSettings();}
}
let studySpeechToken=0;
function stopStudySpeech(){studySpeechToken++;try{if('speechSynthesis'in window)speechSynthesis.cancel();}catch{}stopNeuralSpeech();}
async function playStudySequence(sequence){stopStudySpeech();const token=studySpeechToken;for(const [text,language] of sequence){if(token!==studySpeechToken)return;if(!String(text||'').trim())continue;try{await speak(text,language);}catch(error){if(token===studySpeechToken)console.warn('Flashcard speech failed:',error);}if(token!==studySpeechToken)return;}}
async function speak(text,language='de',voiceOverride=null){
 if(!text?.trim())return toast(language==='de'?'No German text available.':'No English text available.');const voice=voiceOverride||(language==='de'?(settings.germanVoiceMode||'system'):(settings.englishVoiceMode||'system'));
 if(voice!=='system'){
  if(!voiceModelReady[voice]){setVoiceStatus('This Phonon voice is not installed. Download it before testing or using it.');toast('This voice is not downloaded yet. Select it and use “Download selected voices”.');return;}
  try{if('speechSynthesis'in window)speechSynthesis.cancel();await speakNeural(voice,text,Number(settings.speechRate||.88),stage=>{$('voiceDiagnosticStatus').textContent=`${voice}: ${stage}`;const log=$('voiceDiagnosticLog');if(log){const item=document.createElement('li');item.textContent=`${new Date().toLocaleTimeString()} — ${voice}: ${stage}`;log.prepend(item);while(log.children.length>12)log.lastChild.remove();}});$('voiceDiagnosticStatus').textContent='Phonon audio playback completed.';return;}
  catch(error){console.warn('Phonon playback failed.',error);$('voiceDiagnosticStatus').textContent=`Failed: ${error?.message||String(error)}`;setVoiceStatus(`Phonon playback failed: ${error?.message||String(error)}. Choose System voice to use browser speech.`);toast('Phonon playback failed. No voice fallback was used.');return;}
 }
 terminateNeuralWorker();if(!('speechSynthesis'in window)){toast('Speech synthesis is not supported in this browser.');return Promise.resolve();}speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(text);utterance.lang=language==='de'?'de-DE':'en-US';utterance.rate=Number(settings.speechRate||.88);return new Promise(resolve=>{utterance.onend=resolve;utterance.onerror=resolve;speechSynthesis.speak(utterance);});
}
let practiceAvailabilitySource=null,practiceAvailabilityCache=null;
function renderPracticeAvailability(){
 if(practiceAvailabilitySource!==words){
 const validNouns=words.filter(w=>!!getArticle(w));
 const hasMeaning=new Set(words.filter(w=>String(w.translation||'').trim()).map(w=>String(w.translation).trim().toLowerCase())).size>=3;
 const hasPlural=validNouns.some(w=>String(w.plural||'').trim()&&pluralOptions(w,words).length>=3);
 const hasVerbs=buildVerbQuestions(buildVerbBank(words)).length>0;
 const hasListening=words.some(w=>String(w.example||'').trim())&&new Set(words.map(w=>w.german)).size>=3;
 const available={meaning:hasMeaning,article:validNouns.length>0,plural:hasPlural,verb:hasVerbs,listening:hasListening};
 practiceAvailabilitySource=words;practiceAvailabilityCache=available;
 }
 const available=practiceAvailabilityCache||{};
 let shown=0;
 document.querySelectorAll('[data-exercise]').forEach(button=>{const enabled=!!available[button.dataset.exercise];button.hidden=!enabled;if(enabled)shown++;});
 const empty=$('practiceEmpty');if(empty)empty.hidden=shown>0;
}
function startExercise(type){
 const active=activeWords();let pool=active;
 if(type==='meaning')pool=active.filter(w=>w.translation&&w.translation.trim());
 if(type==='article')pool=active.filter(w=>!!getArticle(w));
 if(type==='plural')pool=active.filter(w=>w.plural&&w.plural.trim());
 if(type==='listening')pool=active.filter(w=>w.example&&w.example.trim());
 if(type==='verb')pool=buildVerbBank(active);
 if(type!=='verb'&&pool.length<1)return toast('No suitable active words for this exercise. Add vocabulary with the required information.');
 let qs=[];
 if(type==='verb')qs=buildVerbQuestions(pool);
 else if(type==='listening')qs=shuffle(pool).slice(0,8).map(w=>{const sentence=(w.example||'').split(/\s\/\s|\s—\s/)[0];return {answer:w.german,meaning:w.translation,options:uniqueOptions(w.german,active.filter(x=>x.id!==w.id).map(x=>x.german)),prompt:'Listen to the complete German sentence. Which vocabulary item did you hear?',speak:sentence,hiddenTranscript:sentence,explanation:`${w.german} means ${w.translation}.`};});
 else qs=shuffle(pool).slice(0,Math.min(10,pool.length)).map(w=>{
  const answer=type==='article'?getArticle(w):type==='plural'?formatPlural(w.plural):w.translation;
  const prompt=type==='article'?`Which definite article belongs to “${stripArticle(w.german)}”?`:type==='plural'?`Choose the correct nominative plural of “${stripArticle(w.german)}”.`:`What does “${w.german}” mean?`;
  const options=type==='article'?uniqueOptions(answer,['der','die','das']):type==='plural'?pluralOptions(w,active):uniqueOptions(answer,active.filter(x=>x.id!==w.id).map(x=>x.translation));
  return {word:w.german,answer,options,prompt,speak:w.german,explanation:type==='plural'?`Singular: ${w.german}. Nominative plural: ${formatPlural(w.plural)}.`:''};
 }).filter(q=>q.options.length>=3&&q.options.filter(x=>x===q.answer).length===1);
 qs=qs.filter(q=>Array.isArray(q.options)&&q.options.length>=2&&new Set(q.options).size===q.options.length&&q.options.filter(x=>x===q.answer).length===1);
 if(!qs.length)return toast(type==='verb'?'Not enough distinct imported verb forms are available yet. Add more verb forms or vocabulary.':'Not enough valid questions are available yet. Add more vocabulary with the required fields.');
 exercise={type,questions:qs};exercise.index=0;exercise.correct=0;exercise.answered=false;$('exercisePanel').hidden=false;$('exercisePanel').scrollIntoView({behavior:'smooth',block:'start'});showExerciseQuestion();
}
function localDate(d=new Date()){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function showExerciseQuestion(){const q=exercise.questions[exercise.index];exercise.answered=false;$('exerciseType').textContent=exercise.type.toUpperCase();$('exercisePrompt').textContent=q.prompt;$('exerciseProgress').style.width=`${exercise.index/exercise.questions.length*100}%`;$('exerciseFeedback').textContent='';if($('exerciseTranscript')){$('exerciseTranscript').hidden=true;$('exerciseTranscript').textContent='';}$('exerciseNext').hidden=true;$('exerciseAudio').hidden=exercise.type!=='listening';$('exerciseChoices').innerHTML=q.options.map(o=>`<button class="choice-button" data-choice="${esc(o)}">${esc(o)}</button>`).join('');}
function answerExercise(choice){if(exercise.answered)return;exercise.answered=true;const q=exercise.questions[exercise.index],ok=choice===q.answer;if(ok)exercise.correct++;document.querySelectorAll('.choice-button').forEach(b=>{b.disabled=true;if(b.textContent===q.answer)b.classList.add('correct');else if(b.textContent===choice)b.classList.add('incorrect')});$('exerciseFeedback').textContent=(ok?'Correct — gut gemacht! ':`Correct answer: ${q.answer}. `)+(q.explanation||'');if(exercise.type==='listening'){$('exerciseTranscript').hidden=false;$('exerciseTranscript').textContent=`Transcript: ${q.hiddenTranscript||q.speak}\nTarget word: ${q.answer} — ${q.meaning||''}`;} $('exerciseNext').hidden=false;$('exerciseNext').textContent=exercise.index===exercise.questions.length-1?'Finish':'Continue →';}
async function nextExercise(){exercise.index++;if(exercise.index>=exercise.questions.length){const result={id:uid(),date:today(),type:'quiz',correct:exercise.correct,total:exercise.questions.length,exercise:exercise.type};await put('reviewLogs',result);logs=await all('reviewLogs');$('exercisePanel').hidden=true;toast(`Completed: ${exercise.correct} / ${exercise.questions.length} correct.`);renderAll();return;}showExerciseQuestion();}
function download(name,content,type){const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);}
async function exportBackup(){const collections=await all('collections');const payload={app:'Deutsch Meister',version:'3.7.0',exportedAt:new Date().toISOString(),settings,words,reviewLogs:logs,sessions,collections};download(`deutsch-meister-v3-backup-${today()}.json`,JSON.stringify(payload,null,2),'application/json');$('dataStatus').textContent='Backup exported.';}
async function restoreBackup(file){
 let data;
 try{data=JSON.parse(await file.text());}catch{throw Error('This file is not valid JSON.');}
 if(!data||typeof data!=='object'||!Array.isArray(data.words))throw Error('Invalid backup: words array is missing.');
 const incoming=data.words.filter(w=>w&&typeof w==='object'&&String(w.german||'').trim());
 const dropped=data.words.length-incoming.length;
 if(!incoming.length)throw Error('Invalid backup: it contains no usable words.');
 if(!confirm(`Restore ${incoming.length} words and learning history? This merges records by ID; it does not delete current data.`))return;
 const restoredSettings=sanitizeSettings(data.settings);
 // Keep the earliest valid history start so streak dates contained in the backup are not hidden by a newer local start date.
 const existingStart=settings.v3StartedOn,backupStart=restoredSettings.v3StartedOn;
 if(existingStart&&backupStart)restoredSettings.v3StartedOn=existingStart<backupStart?existingStart:backupStart;
 else if(existingStart&&!backupStart)restoredSettings.v3StartedOn=existingStart;
 const method=restoredSettings.algorithm||settings.algorithm;
 // Normalise every record exactly as startup does, so partial/legacy schedules cannot cause later errors.
 const prepared=incoming.map(w=>ensureSchedules({...w,id:w.id||uid(),source:w.source==='builtin'?'personal':(w.source||'personal')},method));
 const goodLogs=(Array.isArray(data.reviewLogs)?data.reviewLogs:[]).filter(x=>x&&typeof x==='object'&&x.id&&typeof x.date==='string');
 const goodSessions=(Array.isArray(data.sessions)?data.sessions:[]).filter(x=>x&&typeof x==='object'&&x.id);
 const goodCollections=(Array.isArray(data.collections)?data.collections:[]).filter(x=>x&&typeof x==='object'&&x.id);
 const settingRecords=Object.entries(restoredSettings).map(([key,value])=>({key,value}));
 // All restored stores commit together; a quota or validation failure cannot leave a partial restore.
 await mergeBackupRecords({words:prepared,reviewLogs:goodLogs,sessions:goodSessions,settings:settingRecords,collections:goodCollections});
 [words,logs,sessions]=await Promise.all([all('words'),all('reviewLogs'),all('sessions')]);
 settings={...settings,...restoredSettings};
 renderAll();applyTheme();
 $('dataStatus').textContent=`Restored ${prepared.length} words${dropped?` (${dropped} unusable records skipped)`:''}. Existing unmatched data was kept.`;
}
const BATCH_CSV_COLUMNS=['id','german','article','part_of_speech','translation_en','example_de','example_en','plural','present_ich','present_du','present_er_sie_es','present_wir','present_ihr','present_sie','prateritum','perfekt','perfekt_auxiliary','dictionary_url'];
const BATCH_CSV_MAP={german:'german',article:'article',part_of_speech:'partOfSpeech',translation_en:'translation',example_de:'example',example_en:'exampleEn',plural:'plural',present_ich:'presentIch',present_du:'presentDu',present_er_sie_es:'presentEr',present_wir:'presentWir',present_ihr:'presentIhr',present_sie:'presentSie',prateritum:'prateritum',perfekt:'perfekt',perfekt_auxiliary:'auxiliary',dictionary_url:'dictionaryUrl'};
function csvWordFields(r){return {german:String(r.german||'').trim(),translation:r.translation_en||r.translation||'',article:r.article||'',plural:r.plural||'',example:r.example_de||r.example||'',exampleEn:r.example_en||'',notes:r.notes||'',category:r.category||'Imported',partOfSpeech:r.part_of_speech||r.partofspeech||r.partOfSpeech||'',presentIch:r.present_ich||r.presentIch||'',presentDu:r.present_du||r.presentDu||'',presentEr:r.present_er_sie_es||r.present_er||r.presentEr||'',presentWir:r.present_wir||'',presentIhr:r.present_ihr||'',presentSie:r.present_sie||'',prateritum:r.prateritum||r.präteritum||'',perfekt:r.perfekt||'',auxiliary:r.perfekt_auxiliary||r.auxiliary||'',dictionaryUrl:String(r.dictionary_url||r.dictionaryUrl||'').trim().replace(/\\([:.])/g,'$1')};}
async function importCsv(file){
 const rows=parseCSV(await file.text());if(!rows.length)throw Error('CSV is empty.');if(!('german'in rows[0]))throw Error('Required column: german. All other columns are optional.');
 const batchId=uid(),importedAt=new Date().toISOString(),fileName=file.name||'Imported CSV';let added=0,skipped=0;const toAdd=[];const existing=new Set(words.map(w=>String(w.german||'').trim().toLocaleLowerCase()));
 for(const r of rows){if(!String(r.german||'').trim()){skipped++;continue;}const normalized=String(r.german).trim().toLocaleLowerCase();if(existing.has(normalized)){skipped++;continue;}existing.add(normalized);toAdd.push(ensureSchedules({...csvWordFields(r),id:uid(),source:'personal',sourceType:'csv',importBatchId:batchId,importFileName:fileName,importedAt,active:true,box:1,repetitions:0,easeFactor:2.5,interval:0,dueDate:today(),favorite:false,createdAt:importedAt},settings.algorithm));added++;}
 if(toAdd.length)await putMany('words',toAdd);words=await all('words');renderAll();$('dataStatus').textContent=`Imported ${added}; skipped ${skipped} empty or duplicate rows.`;if(!added)$('dataStatus').textContent+=' No new batch was created because no new rows were added.';toast(`Imported ${added} words; skipped ${skipped}.`);
}
function exportImportBatchCsv(batchId){
 const batch=words.filter(w=>w.importBatchId===batchId);if(!batch.length)return toast('This import batch is no longer available.');
 const q=v=>'"'+String(v??'').replace(/"/g,'""')+'"';const rows=batch.map(w=>[w.id,...BATCH_CSV_COLUMNS.slice(1).map(c=>w[BATCH_CSV_MAP[c]])]);
 download('deutsch-meister-batch.csv','\ufeff'+[BATCH_CSV_COLUMNS.join(','),...rows.map(row=>row.map(q).join(','))].join('\n'),'text/csv;charset=utf-8');$('dataStatus').textContent='Batch CSV exported with stable word IDs. Keep the id column unchanged when correcting words to preserve their learning history.';
}
async function updateImportBatch(batchId,file){
 const target=words.filter(w=>w.importBatchId===batchId);if(!target.length)throw Error('This imported batch no longer exists.');
 const rows=parseCSV(await file.text());if(!rows.length||!('german'in rows[0]))throw Error('CSV must contain a german column and at least one vocabulary row.');
 const incoming=rows.filter(r=>String(r.german||'').trim());if(!incoming.length)throw Error('No vocabulary rows were found.');
 const targetById=new Map(target.map(w=>[String(w.id),w])),targetByGerman=new Map(target.map(w=>[String(w.german||'').trim().toLocaleLowerCase(),w]));
 const outside=new Set(words.filter(w=>w.importBatchId!==batchId).map(w=>String(w.german||'').trim().toLocaleLowerCase()));
 const seen=new Set(),seenIds=new Set(),retained=new Set(),toPut=[];let added=0;const meta=target[0];
 for(const row of incoming){const german=String(row.german).trim(),normalized=german.toLocaleLowerCase();if(seen.has(normalized))throw Error(`Duplicate word in CSV: “${german}”. Correct duplicates before updating.`);seen.add(normalized);if(outside.has(normalized))throw Error(`“${german}” already exists outside this batch. No changes were saved.`);
  let old=null;if(String(row.id||'').trim()){const id=String(row.id).trim();if(seenIds.has(id))throw Error(`Duplicate ID in CSV: ${id}. No changes were saved.`);seenIds.add(id);old=targetById.get(id);if(!old)throw Error(`The CSV contains an ID that does not belong to this batch: ${row.id}. No changes were saved.`);}else old=targetByGerman.get(normalized)||null;
  const fields=csvWordFields(row);if(old){retained.add(old.id);toPut.push({...old,...fields,id:old.id});}else{added++;toPut.push(ensureSchedules({...fields,id:uid(),source:'personal',sourceType:'csv',importBatchId:batchId,importFileName:meta.importFileName||file.name||'Imported CSV',importedAt:meta.importedAt||new Date().toISOString(),active:true,box:1,repetitions:0,easeFactor:2.5,interval:0,dueDate:today(),favorite:false,createdAt:new Date().toISOString()},settings.algorithm));}
 }
 const removed=target.filter(w=>!retained.has(w.id)),label=meta.importFileName||'this CSV file';const message=`Update “${label}”?\\n\\nKeep and update: ${retained.size}\\nAdd as new (fresh learning schedule): ${added}\\nRemove: ${removed.length} (their review history will also be deleted)\\n\\nExisting IDs in the exported CSV preserve Leitner/SM-2 schedules and review history. If you changed a German spelling, keep its id column so it is recognised as the same word.`;
 if(!confirm(message))return;await replaceImportBatch(batchId,toPut,removed.map(w=>w.id));words=await all('words');logs=await all('reviewLogs');renderAll();$('dataStatus').textContent=`Updated “${label}”: ${retained.size} retained, ${added} added, ${removed.length} removed.`;toast('Imported batch updated.');
}
function renderImportBatches(){
 const host=$('importBatchList');if(!host)return;const grouped=new Map();for(const w of words.filter(x=>x.source!=='builtin'&&x.importBatchId)){const key=w.importBatchId;if(!grouped.has(key))grouped.set(key,{id:key,name:w.importFileName||'Imported CSV',date:w.importedAt||w.createdAt||'',count:0});grouped.get(key).count++;}
 const batches=[...grouped.values()].sort((a,b)=>String(b.date).localeCompare(String(a.date)));
 host.innerHTML=batches.length?batches.map(b=>`<div class="import-batch-row"><div class="import-batch-meta"><b>${esc(b.name)}</b><small>${b.count} words · ${b.date?new Date(b.date).toLocaleDateString():''}</small></div><div class="import-batch-actions"><button class="button button-outline" type="button" data-export-import-batch="${esc(b.id)}">Export CSV</button><button class="button button-outline" type="button" data-update-import-batch="${esc(b.id)}">Update from CSV</button><input type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" hidden data-update-batch-file="${esc(b.id)}"><button class="button button-danger" type="button" data-delete-import-batch="${esc(b.id)}">Delete batch</button></div></div>`).join(''):'<p class="muted small">No tracked CSV imports yet.</p>';
}
async function deleteImportBatch(batchId){const batch=words.filter(w=>w.importBatchId===batchId);if(!batch.length)return;const label=batch[0].importFileName||'this CSV file';if(!confirm(`Delete the complete import “${label}” (${batch.length} words) and its review history? Other personal words and other CSV imports will remain.`))return;const ids=new Set(batch.map(w=>w.id));await deleteWordsAndLogs([...ids]);words=await all('words');logs=await all('reviewLogs');renderAll();$('dataStatus').textContent=`Deleted CSV import “${label}” (${batch.length} words).`;}
function exportCsv(){const cols=BATCH_CSV_COLUMNS.slice(1),q=v=>'"'+String(v??'').replace(/"/g,'""')+'"';download('deutsch-meister-vocabulary.csv','\ufeff'+[cols.join(','),...words.map(w=>cols.map(c=>q(w[BATCH_CSV_MAP[c]])).join(','))].join('\n'),'text/csv;charset=utf-8');$('dataStatus').textContent='CSV exported.';}
function safeDictionaryHref(value){try{const raw=String(value||'').trim().replace(/\\([:.])/g,'$1');const url=new URL(raw);return url.protocol==='https:'?url.href:'';}catch{return '';}}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function bind(){document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>showView(b.dataset.nav));document.querySelectorAll('[data-action="go-learn"]').forEach(b=>b.onclick=startStudy);document.querySelectorAll('[data-action="go-practice"]').forEach(b=>b.onclick=()=>showView('practice'));document.querySelectorAll('[data-action="go-library"]').forEach(b=>b.onclick=()=>showView('library'));$('settingsOpen').onclick=()=>showView('settings');$('startReview').onclick=startStudy;const flipCard=()=>{const card=$('studyCard');if(card.classList.contains('is-flipped')){card.classList.remove('is-flipped');playStudySequence([[currentWord?.german,'de']]);}else{card.classList.add('is-flipped');playStudySequence([[currentWord?.example,'de'],[currentWord?.translation,'en']]);}};$('studyCard').addEventListener('click',e=>{if(e.target.closest('button,a'))return;flipCard();});$('studyCard').addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&!e.target.closest('button,a')){e.preventDefault();flipCard();}});['studySpeak','studyTranslationSpeak','studyExampleSpeakDe','studyExampleSpeakEn'].forEach(id=>$(id).addEventListener('click',e=>e.stopPropagation()));$('endReview').onclick=()=>{stopStudySpeech();currentWord=null;studyQueue=[];studyIndex=0;$('studyCard').hidden=true;renderLearn();renderHome();};$('studySpeak').onclick=()=>playStudySequence([[currentWord?.german,'de']]);$('studyTranslationSpeak').onclick=()=>speak(currentWord?.translation,'en');document.querySelectorAll('[data-rating]').forEach(b=>b.onclick=()=>rateWord(b.dataset.rating));$('addWordOpen').onclick=()=>openEditor();$('importCsvOpen').onclick=()=>$('importCsv').click();$('closeEditor').onclick=()=>{$('wordEditor').hidden=true;$('wordEditorDialog').close();};$('studyEditWord').onclick=e=>{e.stopPropagation();if(currentWord)openEditor(currentWord);};$('wordEditor').onsubmit=saveEditor;$('personalWordList').onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&e.target.closest('[data-open-word]')&&!e.target.closest('button,a')){e.preventDefault();openWordDetail(words.find(x=>x.id===e.target.closest('[data-open-word]').dataset.openWord));}};$('personalWordList').onclick=async e=>{if(e.target.closest('a'))return;const ed=e.target.closest('[data-edit]'),del=e.target.closest('[data-delete]'),view=e.target.closest('[data-open-word]');if(ed){e.stopPropagation();openEditor(words.find(x=>x.id===ed.dataset.edit));}else if(del){e.stopPropagation();const target=words.find(x=>x.id===del.dataset.delete);if(!target)return;if(confirm(`Delete “${target.german}” permanently? Its review history will also be removed.`)){await deleteWordsAndLogs([target.id]);words=await all('words');logs=await all('reviewLogs');renderAll();toast('Personal word deleted.');}}else if(view){openWordDetail(words.find(x=>x.id===view.dataset.openWord));}};$('methodSnapshot').onclick=e=>{const b=e.target.closest('[data-distribution-index]');if(b)openDistributionGroup(Number(b.dataset.distributionIndex));};$('distributionModalList').onclick=e=>{const b=e.target.closest('[data-open-word]');if(b){const w=words.find(x=>x.id===b.dataset.openWord);$('distributionModal').close();openWordDetail(w);}};$('wordDetailClose').onclick=()=>$('wordDetailModal').close();$('distributionClose').onclick=()=>$('distributionModal').close();$('wordSearch').oninput=()=>{libraryLimit=100;renderLibrary()};$('loadMoreWords').onclick=()=>{libraryLimit+=100;renderLibrary()};document.querySelectorAll('[data-exercise]').forEach(b=>b.onclick=()=>startExercise(b.dataset.exercise));$('closeExercise').onclick=()=>$('exercisePanel').hidden=true;$('exerciseChoices').onclick=e=>{const b=e.target.closest('[data-choice]');if(b)answerExercise(b.dataset.choice)};$('exerciseNext').onclick=nextExercise;$('exerciseAudio').onclick=()=>speak(exercise?.questions[exercise.index]?.speak);$('themeSelect').onchange=async()=>{settings.theme=$('themeSelect').value;await setSetting('theme',settings.theme);applyTheme()};$('dailyGoalSelect').onchange=async()=>{settings.dailyGoal=Number($('dailyGoalSelect').value);await setSetting('dailyGoal',settings.dailyGoal);renderHome()};$('newWordsPerDaySelect').onchange=async()=>{settings.newWordsPerDay=Number($('newWordsPerDaySelect').value);await setSetting('newWordsPerDay',settings.newWordsPerDay);renderHome();renderLearn();};$('algorithmSelect').onchange=async()=>{settings.algorithm=$('algorithmSelect').value;await setSetting('algorithm',settings.algorithm);renderAll();renderProgress();toast('Review method changed. Only the selected method is shown in Progress.');};$('speechRate').onchange=async()=>{settings.speechRate=Number($('speechRate').value);await setSetting('speechRate',settings.speechRate)};$('germanSpeechVoice').onchange=async()=>{settings.germanVoiceMode=$('germanSpeechVoice').value;await setSetting('germanVoiceMode',settings.germanVoiceMode);if(settings.germanVoiceMode!=='system'&&!voiceModelReady[settings.germanVoiceMode])setVoiceStatus('German voice selected. Download it to use it offline.');renderVoiceSettings();};$('englishSpeechVoice').onchange=async()=>{settings.englishVoiceMode=$('englishSpeechVoice').value;await setSetting('englishVoiceMode',settings.englishVoiceMode);if(settings.englishVoiceMode!=='system'&&!voiceModelReady[settings.englishVoiceMode])setVoiceStatus('English voice selected. Download it to use it offline.');renderVoiceSettings();};$('deleteVoiceModels').onclick=deleteDownloadedVoices;$('downloadVoiceModels').onclick=downloadSelectedVoices;
 $('exportJson').onclick=exportBackup;$('exportCsv').onclick=exportCsv;$('restoreJson').onchange=e=>{if(e.target.files[0])restoreBackup(e.target.files[0]).catch(err=>toast(err.message));e.target.value=''};$('importCsv').onchange=e=>{if(e.target.files[0])importCsv(e.target.files[0]).catch(err=>{$('dataStatus').textContent=err.message;toast('CSV import failed.')});e.target.value=''};$('importBatchList').onclick=e=>{const ex=e.target.closest('[data-export-import-batch]'),up=e.target.closest('[data-update-import-batch]'),del=e.target.closest('[data-delete-import-batch]');if(ex)exportImportBatchCsv(ex.dataset.exportImportBatch);else if(up)up.parentElement.querySelector('[data-update-batch-file]')?.click();else if(del)deleteImportBatch(del.dataset.deleteImportBatch)};$('importBatchList').onchange=e=>{const input=e.target.closest('[data-update-batch-file]');if(input?.files?.[0])updateImportBatch(input.dataset.updateBatchFile,input.files[0]).catch(err=>{console.error(err);$('dataStatus').textContent=err.message;toast('Batch update failed. No partial changes were saved.')}).finally(()=>{input.value=''});};document.querySelectorAll('[data-voice-preview]').forEach(button=>button.onclick=()=>{const id=button.dataset.voicePreview,german=['nele','anton'].includes(id);speak(german?'Guten Tag! Wie geht es Ihnen heute?':'Hello! How are you doing today?',german?'de':'en',id);});$('deletePersonalWords').onclick=async()=>{const personal=[...words];if(!personal.length)return toast('There are no vocabulary entries to delete.');if(!confirm(`Permanently delete all ${personal.length} vocabulary entries and their review history? Export a JSON backup first if you may need these words later.`))return;const ids=new Set(personal.map(w=>w.id));await deleteWordsAndLogs([...ids],logs.filter(x=>ids.has(x.wordId)).map(x=>x.id));words=await all('words');logs=await all('reviewLogs');renderAll();$('dataStatus').textContent=`Deleted ${personal.length} vocabulary entries.`;toast('Personal vocabulary deleted.');};$('resetProgress').onclick=async()=>{if(!confirm('Reset all review schedules and learning history while keeping every word?'))return;const fresh=words.map(w=>{const x={...w,scheduling:{leitner:{box:1,interval:0,dueDate:today(),reviewCount:0},sm2:{repetitions:0,easeFactor:2.5,interval:0,dueDate:today(),reviewCount:0}},box:1,repetitions:0,easeFactor:2.5,interval:0,dueDate:today()};delete x.lastReviewed;delete x.reviewCount;return x;});await putMany('words',fresh);await clear('reviewLogs');words=await all('words');logs=[];currentWord=null;studyQueue=[];studyIndex=0;$('studyCard').hidden=true;renderAll();toast('Learning progress reset. Your words are safe.');};}
init();