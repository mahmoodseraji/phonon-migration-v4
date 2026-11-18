import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStoryText,splitStorySentences} from '../js/stories.js';

test('story parser groups Teil and Kapitel headings and keeps paragraph boundaries',()=>{
 const parts=parseStoryText('Teil I – Ein neuer Anfang\nKapitel 1: Das Leben wartet nicht\nErster Satz.\nZweiter Satz.\n\nNeuer Absatz.\nKapitel 2: Die erste Begegnung\nWeiter geht es.');
 assert.equal(parts.length,1);
 assert.equal(parts[0].title,'Teil I – Ein neuer Anfang');
 assert.equal(parts[0].chapters.length,2);
 assert.equal(parts[0].chapters[0].paragraphs.length,2);
 assert.equal(parts[0].chapters[0].title,'Kapitel 1: Das Leben wartet nicht');
});

test('plain text without headings remains importable as one chapter',()=>{
 const parts=parseStoryText('Ein kurzer Anfang.\n\nEin zweiter Absatz.');
 assert.equal(parts[0].chapters.length,1);
 assert.equal(parts[0].chapters[0].paragraphs.length,2);
});

test('sentence splitter preserves German sentence punctuation',()=>{
 assert.deepEqual(splitStorySentences('Hallo! Wie geht es dir? Gut, danke.'),['Hallo!','Wie geht es dir?','Gut, danke.']);
});
