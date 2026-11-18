# Deutsch Meister 3.9.0

## What's new in 3.9.0

- Added a personal Stories library with DOCX and plain-text import. The repository story `Deutsc_geschafte.docx` can be loaded directly from the app.
- Detects `Teil` and `Kapitel` headings and preserves paragraph boundaries.
- Added tap-to-look-up words, personal-vocabulary matching, pronunciation, paragraph and sentence playback, adjustable speed and spoken-sentence highlighting.
- Tracks encountered words, reading position and completed chapters in separate IndexedDB stores. Story activity never changes Leitner or SM-2 review dates, schedules or review history.
- Existing vocabulary and review stores remain untouched; IndexedDB is upgraded additively.


Deutsch Meister is an offline-first German vocabulary PWA. It contains no bundled vocabulary: learners add words manually or import their own CSV/TSV files.

## What's new in 3.8.0

- Imported CSV batches can be exported with stable word IDs, corrected and updated in place.
- Retained entries keep their IDs, Leitner and SM-2 schedules, review logs and batch metadata. New entries get fresh schedules; removed entries are shown for confirmation and their review logs are deleted only after confirmation.
- Batch updates detect duplicate German words, duplicate IDs, IDs from other batches and collisions with words outside the selected batch before any changes are saved.
- Batch updates write vocabulary changes and remove linked logs in one IndexedDB transaction.
- Settings now tests each Phonon voice through the same on-device model, speaker embedding and playback path used for normal pronunciation.
- Selected Phonon voices no longer silently fall back to browser speech. Choose System voice explicitly when you want the browser's speech engine.

## Phonon pronunciation

Four on-device voices are available: Nele and Anton (German), Zoey and Easton (US English). Neural downloads are user-initiated. The shared multilingual q8 model is downloaded once; only selected voice embeddings are loaded. Downloaded model and voice files can be deleted without affecting vocabulary or learning progress.

The runtime is vendored locally so its JavaScript and WebAssembly files are available offline after the app shell has been installed.

### Install the local Phonon runtime

Node.js 20+ is recommended. From the repository root:

```bash
npm install
npm run vendor:phonon
```

This copies the exact pinned `phonon-tts@0.4.2` package, including its WebAssembly modules and licence notices, into `vendor/phonon-tts`. Commit that generated directory when preparing the static GitHub Pages release. The script refuses to vendor a different runtime version.

The Phonon 40M multilingual checkpoint and voice embeddings are stored in `models/phonon`. The model is CC BY-NC 4.0 and must not be used commercially without appropriate permission. See `PHONON-LICENSE-NOTICE.md` and `PHONON-RUNTIME-NOTICE.md`.

## Build automation

GitHub Actions runs the syntax checks and automated regression suite on pushes to `main`. The release checks also verify the vendored Phonon runtime and required WebAssembly assets.

## Existing learning features

The two learning methods retain independent schedules for every word. Leitner uses five boxes (1, 2, 4, 7 and 14 days); Forgot returns a word to Box 1 and Remembered advances one box. Classic SM-2 uses Again=1, Hard=3, Good=4, Easy=5; successful intervals begin at 1 day and 6 days, then use the updated ease factor. Due dates use local calendar dates.

The app continues to use the existing IndexedDB database, vocabulary, review history, CSV/TSV import/export, JSON backup/restore, challenges, quizzes, deletion, progress and PWA features. The pronunciation migration does not intentionally modify vocabulary or scheduler data.

## Run locally

Serve this folder from localhost or HTTPS; do not open `index.html` as a `file://` URL.

```bash
python -m http.server 8000
```

Open `http://localhost:8000`.

## Automated checks

```bash
npm test
```

Tests are source-level and mocked checks; they do not prove actual audio generation on a physical device. Before release, run the vendor command, run the full suite, then test a fresh install, cached offline startup, voice switching, deletion and playback on iPhone Safari/iOS 26. No iPhone 16 / iOS 26 verification is claimed until that test has actually been performed.
