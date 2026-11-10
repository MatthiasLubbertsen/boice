package main

import (
	"archive/zip"
	"crypto/sha1"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"os"
	"strconv"
	"time"
)

// An .apkg file is a zip with an SQLite database (collection.anki2), a JSON
// index of media files ("media") and the media files themselves, named 0, 1, 2…

const ankiSchema = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null,
  ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null,
  models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null,
  usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null,
  flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null,
  mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null,
  ivl integer not null, factor integer not null, reps integer not null, lapses integer not null,
  left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null,
  ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
`

const ankiCSS = `.card { font-family: system-ui, sans-serif; font-size: 28px; text-align: center; color: #111; background: #fff; }
.nightMode.card { color: #f5f5f5; background: #171717; }
.lang { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: #a3a3a3; margin-bottom: .6em; }
.meta { font-size: 14px; color: #a3a3a3; margin-top: 1em; }`

type ankiOpts struct {
	Direction    string // ab | ba | both
	IncludeAudio bool
}

func ankiTemplate(ord int, name, front, frontAudio, frontLang, back, backAudio, backLang string) map[string]any {
	q := fmt.Sprintf(`<div class="lang">%s</div>{{%s}}{{%s}}`, html.EscapeString(frontLang), front, frontAudio)
	a := fmt.Sprintf(`{{FrontSide}}<hr id="answer"><div class="lang">%s</div>{{%s}}{{%s}}`+
		`{{#Note}}<div class="meta">{{Note}}</div>{{/Note}}{{#Page}}<div class="meta">p. {{Page}}</div>{{/Page}}`,
		html.EscapeString(backLang), back, backAudio)
	return map[string]any{
		"name": name, "ord": ord, "qfmt": q, "afmt": a,
		"bqfmt": "", "bafmt": "", "did": nil, "bfont": "", "bsize": 0,
	}
}

// writeAnki builds an .apkg for the given words. audioPath returns the file
// for a word's clip, or "" if there is none.
func writeAnki(w io.Writer, tmpDir string, list List, words []Word, o ankiOpts, audioPath func(Word, string) string) error {
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(tmpDir, "anki-*.db")
	if err != nil {
		return err
	}
	dbPath := f.Name()
	f.Close()
	defer os.Remove(dbPath)

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return err
	}
	defer db.Close()
	if _, err := db.Exec(ankiSchema); err != nil {
		return err
	}

	nowMs := time.Now().UnixMilli()
	nowS := nowMs / 1000
	// Stable ids per list, so re-importing an export updates the same deck.
	deckID := 1_600_000_000_000 + list.ID
	variant := map[string]int64{"ab": 0, "ba": 1, "both": 2}[o.Direction]
	modelID := 1_700_000_000_000 + list.ID*4 + variant

	nameA, nameB := langName(list.LangA), langName(list.LangB)
	if list.Kind == "def" {
		nameA, nameB = "Term", "Definition"
	}
	var tmpls []map[string]any
	if o.Direction != "ba" {
		tmpls = append(tmpls, ankiTemplate(len(tmpls), nameA+" → "+nameB, "A", "AudioA", nameA, "B", "AudioB", nameB))
	}
	if o.Direction != "ab" {
		tmpls = append(tmpls, ankiTemplate(len(tmpls), nameB+" → "+nameA, "B", "AudioB", nameB, "A", "AudioA", nameA))
	}
	var req []any
	for ord := range tmpls {
		req = append(req, []any{ord, "any", []any{ord % 2}})
	}
	fieldNames := []string{"A", "B", "AudioA", "AudioB", "Page", "Note"}
	var flds []map[string]any
	for i, n := range fieldNames {
		flds = append(flds, map[string]any{
			"name": n, "ord": i, "font": "Arial", "size": 20, "media": []any{}, "rtl": false, "sticky": false,
		})
	}
	models := map[string]any{strconv.FormatInt(modelID, 10): map[string]any{
		"id": modelID, "name": "Boice (" + nameA + " ↔ " + nameB + ")", "type": 0, "mod": nowS, "usn": -1,
		"sortf": 0, "did": deckID, "tmpls": tmpls, "flds": flds, "css": ankiCSS, "tags": []any{}, "vers": []any{},
		"latexPre":  "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n",
		"latexPost": "\\end{document}", "latexsvg": false,
		"req": req,
	}}
	deck := func(id int64, name string) map[string]any {
		return map[string]any{
			"id": id, "name": name, "mod": nowS, "usn": -1, "desc": "", "dyn": 0, "conf": 1, "collapsed": false,
			"extendNew": 0, "extendRev": 50,
			"newToday": []int{0, 0}, "revToday": []int{0, 0}, "lrnToday": []int{0, 0}, "timeToday": []int{0, 0},
		}
	}
	decks := map[string]any{"1": deck(1, "Default"), strconv.FormatInt(deckID, 10): deck(deckID, list.Name)}
	dconf := map[string]any{"1": map[string]any{
		"id": 1, "name": "Default", "mod": 0, "usn": 0, "maxTaken": 60, "autoplay": true, "timer": 0,
		"replayq": true, "dyn": false,
		"new": map[string]any{"bury": true, "delays": []int{1, 10}, "initialFactor": 2500, "ints": []int{1, 4, 7},
			"order": 1, "perDay": 20, "separate": true},
		"lapse": map[string]any{"delays": []int{10}, "leechAction": 0, "leechFails": 8, "minInt": 1, "mult": 0},
		"rev": map[string]any{"bury": true, "ease4": 1.3, "fuzz": 0.05, "ivlFct": 1, "maxIvl": 36500,
			"minSpace": 1, "perDay": 100},
	}}
	conf := map[string]any{
		"activeDecks": []int{1}, "curDeck": 1, "newSpread": 0, "collapseTime": 1200, "timeLim": 0,
		"estTimes": true, "dueCounts": true, "curModel": nil, "nextPos": 1, "sortType": "noteFld",
		"sortBackwards": false, "addToCur": true,
	}
	js := func(v any) string { b, _ := json.Marshal(v); return string(b) }

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO col VALUES (1,?,?,?,11,0,0,0,?,?,?,?,'{}')`,
		nowS, nowMs, nowMs, js(conf), js(models), js(decks), js(dconf)); err != nil {
		return err
	}

	var media []string // index = name inside the zip
	var mediaSrc []string
	sound := func(wd Word, side string) string {
		if !o.IncludeAudio {
			return ""
		}
		p := audioPath(wd, side)
		if p == "" {
			return ""
		}
		name := fmt.Sprintf("boice-%d-%s.mp3", wd.ID, side)
		media = append(media, name)
		mediaSrc = append(mediaSrc, p)
		return "[sound:" + name + "]"
	}
	for i, wd := range words {
		page := ""
		if wd.Page > 0 {
			page = strconv.Itoa(wd.Page)
		}
		a := html.EscapeString(wd.Term)
		fields := a + "\x1f" + html.EscapeString(wd.Translation) + "\x1f" + sound(wd, "a") + "\x1f" +
			sound(wd, "b") + "\x1f" + page + "\x1f" + html.EscapeString(wd.Note)
		sum := sha1.Sum([]byte(wd.Term))
		csum := int64(binary.BigEndian.Uint32(sum[:4]))
		tags := ""
		if wd.Flagged {
			tags = " flagged "
		}
		nid := nowMs + int64(i)
		if _, err := tx.Exec(`INSERT INTO notes VALUES (?,?,?,?,-1,?,?,?,?,0,'')`,
			nid, fmt.Sprintf("boice-%d", wd.ID), modelID, nowS, tags, fields, wd.Term, csum); err != nil {
			return err
		}
		for ord := range tmpls {
			cid := nowMs + int64(i*len(tmpls)+ord)
			if _, err := tx.Exec(`INSERT INTO cards VALUES (?,?,?,?,?,-1,0,0,?,0,0,0,0,0,0,0,0,'')`,
				cid, nid, deckID, ord, nowS, i+1); err != nil {
				return err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if err := db.Close(); err != nil {
		return err
	}

	zw := zip.NewWriter(w)
	add := func(name, src string, method uint16) error {
		in, err := os.Open(src)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: method, Modified: time.Now()})
		if err != nil {
			return err
		}
		_, err = io.Copy(out, in)
		return err
	}
	if err := add("collection.anki2", dbPath, zip.Deflate); err != nil {
		return err
	}
	index := map[string]string{}
	for i, name := range media {
		index[strconv.Itoa(i)] = name
		if err := add(strconv.Itoa(i), mediaSrc[i], zip.Store); err != nil {
			return err
		}
	}
	mw, err := zw.Create("media")
	if err != nil {
		return err
	}
	if _, err := mw.Write([]byte(js(index))); err != nil {
		return err
	}
	return zw.Close()
}
