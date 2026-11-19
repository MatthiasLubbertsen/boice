# Boice (book + voice)

Learn vocab from your schoolbooks. Photograph a vocab table, fix what the OCR got wrong, say each word out loud, and export your own voice as one MP3, an Anki deck or a CSV.

- **Scan**: a photo becomes word pairs (default German → Dutch). Every word is checked against Wiktionary, and unknown words get a suggested fix, so OCR mistakes stand out. Photos are read in the background: upload, carry on, and review the result when it's ready. For "der Schüler | die Schülerinnen" style cells only the first form is kept.
- **Terms & definitions**: lists don't have to be languages. A glossary page (term + definition, e.g. history) can be scanned, recorded and exported the same way. No dictionary check for these.
- **Studygo browse**: find publisher lists the way you'd look them up in the book (subject, level, grade or a search, then book, chapter and paragraph), preview the first words, and import. No Studygo login needed.
- **Studygo search**: search lists by name, students' lists included (needs your token for the search only; previewing and importing what you find doesn't). Previews show the language direction and every word, so you can check it's the right list.
- **Studygo import**: paste a token from your own logged-in Studygo session and pull in your word lists (words, language pair, subject). Two languages become a word list; the same language on both sides becomes terms and definitions. The token is used for that request only, never stored or logged by the server. Studygo has no public API, so this relies on the same endpoints its website uses and may need updating if they change.
- **Subjects**: group lists by school subject and link lists to them from the Subjects page.
- **Record**: words appear one by one; Boice detects when you stop talking and moves on (or use Space / tap). Redo, listen back, flag. Record German, Dutch or both, per list.
- **Practice**: flashcards that play your recordings; missed cards come back.
- **Filters**: unrecorded, recorded, flagged, to check, page range, search, shuffle, A→Z, reversed direction. Record, practice and export all use the current filter (or just the selected rows).
- **Export**: MP3 (language order, thinking time and pauses default to 0.5 s, repeats, optional shuffle), Anki `.apkg` (with your audio), CSV.

Go backend (one static binary, SQLite, ~15 MB RAM idle) with an embedded React + shadcn/ui frontend. Dark only, yellow accent.

## Run it

Needs HTTPS in production (browsers only allow the microphone on HTTPS). See [compose.yaml](compose.yaml) for Boice + Tinyauth.

```sh
cp .env.example .env   # fill in the values
docker compose up -d
```

| Variable | |
|---|---|
| `AUTH_MODE` | `oidc` (Tinyauth login), `forward` (trust a proxy header) or `none` (local use only) |
| `BASE_URL` | public URL of Boice (OIDC redirect) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | from `tinyauth oidc create` |
| `FORWARD_AUTH_HEADER` | header carrying the username in `forward` mode (default `Remote-User`) |
| `HACKCLUB_AI_KEY` | key from ai.hackclub.com/dashboard. Server-side only. Without it, scanning is off |
| `HACKCLUB_AI_MODEL` | vision model (default `google/gemini-3.8-flash`) |
| `DICT_CHECK` | `off` disables the Wiktionary check |
| `DATA_DIR`, `ADDR` | `/data` and `:8080` in the image |

In `forward` mode the app must only be reachable through the proxy, otherwise anyone can send the header.

## Develop

```sh
cd web && pnpm install && pnpm dev     # frontend on :5173, proxies /api to :8080
AUTH_MODE=none go run .                # backend (needs web/dist to exist once: pnpm build)
go test ./...
```

## Notes

- Clips are stored as 44.1 kHz mono MP3 (encoded in the browser), so the server joins them for export without ffmpeg.
- Each user only sees their own lists (matched by Tinyauth username).
- The Hack Club AI API has a daily spending limit; the app shows a clear message when it is reached.
