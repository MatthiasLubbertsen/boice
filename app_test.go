package main

import (
	"archive/zip"
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeClip is n valid 44.1 kHz mono frames.
func fakeClip(n int) []byte { return bytes.Repeat(silentFrame, n) }

func TestCleanMP3(t *testing.T) {
	id3 := append([]byte("ID3\x04\x00\x00\x00\x00\x00\x05hello"), fakeClip(10)...)
	frames, ms, err := cleanMP3(append(id3, []byte("TAGjunk")...))
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 10*104 || ms != 261 {
		t.Fatalf("got %d bytes, %d ms", len(frames), ms)
	}
	if _, _, err := cleanMP3([]byte("this is not audio at all, sorry")); err == nil {
		t.Fatal("garbage accepted")
	}
	// 48 kHz stereo header must be rejected.
	bad := bytes.Repeat(append([]byte{0xFF, 0xFB, 0x94, 0x00}, make([]byte, 380)...), 10)
	if _, _, err := cleanMP3(bad); err == nil {
		t.Fatal("wrong format accepted")
	}
	var buf bytes.Buffer
	_ = writeSilence(&buf, 1000)
	if n := buf.Len() / 104; n != 38 {
		t.Fatalf("1s of silence = %d frames", n)
	}
}

func TestTokens(t *testing.T) {
	got := strings.Join(tokens("sich etw. ansehen (Pl.) die E-Mail, grüne Augen a"), "|")
	if want := "sich|ansehen|die|E-Mail|grüne|Augen"; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

type harness struct {
	t      *testing.T
	srv    *httptest.Server
	app    *App
	client *http.Client
	header map[string]string
}

func newHarness(t *testing.T, cfg Config, upstream http.Handler) *harness {
	t.Helper()
	cfg.DataDir = t.TempDir()
	_ = os.MkdirAll(filepath.Join(cfg.DataDir, "audio"), 0o755)
	store, err := openStore(filepath.Join(cfg.DataDir, "boice.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	if upstream != nil {
		up := httptest.NewServer(upstream)
		t.Cleanup(up.Close)
		cfg.AIBaseURL, cfg.AIKey, cfg.AIModel = up.URL, "test-key", "test-model"
		cfg.OIDCIssuer = up.URL
		cfg.DictCheck = true
		app, err := newApp(cfg, store)
		if err != nil {
			t.Fatal(err)
		}
		app.dict.apiURL = func(wiki string) string { return up.URL + "/wiki/" + wiki }
		return finishHarness(t, app)
	}
	app, err := newApp(cfg, store)
	if err != nil {
		t.Fatal(err)
	}
	return finishHarness(t, app)
}

func finishHarness(t *testing.T, app *App) *harness {
	srv := httptest.NewServer(app.routes())
	t.Cleanup(srv.Close)
	jar, _ := cookiejar.New(nil)
	return &harness{t: t, srv: srv, app: app, client: &http.Client{Jar: jar}, header: map[string]string{"X-Boice": "1"}}
}

func (h *harness) do(method, path string, body any, out any) int {
	h.t.Helper()
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case []byte:
		rd = bytes.NewReader(b)
	default:
		buf, _ := json.Marshal(b)
		rd = bytes.NewReader(buf)
	}
	req, _ := http.NewRequest(method, h.srv.URL+path, rd)
	for k, v := range h.header {
		req.Header.Set(k, v)
	}
	res, err := h.client.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	switch o := out.(type) {
	case nil:
	case *[]byte:
		*o = raw
	default:
		if err := json.Unmarshal(raw, out); err != nil {
			h.t.Fatalf("%s %s: %v: %s", method, path, err, raw)
		}
	}
	return res.StatusCode
}

// fakeUpstream plays the Hack Club AI API, Wiktionary and an OIDC provider.
func fakeUpstream(t *testing.T) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /chat/completions", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			http.Error(w, "no key", 401)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		reply := "```json\n" + `{"page": 42, "pairs": [
			{"a": "grune  Augen", "b": "groene ogen"},
			{"a": "das Haus", "b": "het huis", "unsure": true},
			{"a": "die Donaudampfschiff", "b": "de boot"},
			{"a": "", "b": "leeg"}]}` + "\n```"
		if !bytes.Contains(raw, []byte("image_url")) {
			if !bytes.Contains(raw, []byte("grune")) {
				t.Errorf("fix request lacks the unknown word: %s", raw)
			}
			reply = `{"results": [{"i": 0, "fix": "grüne Augen"}, {"i": 1, "fix": null}]}`
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]string{"content": reply}}},
		})
	})
	known := map[string]bool{"Augen": true, "groene": true, "ogen": true, "das": true, "Haus": true,
		"het": true, "huis": true, "die": true, "de": true, "boot": true}
	mux.HandleFunc("GET /wiki/{lang}", func(w http.ResponseWriter, r *http.Request) {
		var pages []map[string]any
		for _, title := range strings.Split(r.URL.Query().Get("titles"), "|") {
			p := map[string]any{"title": title}
			switch {
			case r.PathValue("lang") != "en" || !known[title]:
				p["missing"] = true
			case r.URL.Query().Get("clcategories") == "":
				t.Errorf("English Wiktionary lookup without a language filter")
			default:
				p["categories"] = []any{map[string]string{"title": "Category:X lemmas"}}
			}
			pages = append(pages, p)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"query": map[string]any{"pages": pages}})
	})
	// OIDC
	mux.HandleFunc("GET /.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		base := "http://" + r.Host
		_ = json.NewEncoder(w).Encode(map[string]any{
			"authorization_endpoint": base + "/authorize", "token_endpoint": base + "/token",
			"userinfo_endpoint": base + "/userinfo", "code_challenge_methods_supported": []string{"S256"},
		})
	})
	mux.HandleFunc("GET /authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("client_id") != "cid" || q.Get("code_challenge") == "" {
			http.Error(w, "bad authorize request", 400)
			return
		}
		http.Redirect(w, r, q.Get("redirect_uri")+"?code=thecode&state="+q.Get("state"), http.StatusFound)
	})
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		id, secret, _ := r.BasicAuth()
		if id != "cid" || secret != "csecret" || r.FormValue("code") != "thecode" || r.FormValue("code_verifier") == "" {
			http.Error(w, "bad token request", 400)
			return
		}
		_, _ = io.WriteString(w, `{"access_token": "at", "token_type": "Bearer"}`)
	})
	mux.HandleFunc("GET /userinfo", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer at" {
			http.Error(w, "no", 401)
			return
		}
		_, _ = io.WriteString(w, `{"sub": "x", "preferred_username": "Matthias", "name": "Matthias L"}`)
	})
	return mux
}

func TestFullFlow(t *testing.T) {
	h := newHarness(t, Config{AuthMode: "none"}, fakeUpstream(t))

	// Writes without the anti-CSRF header are refused.
	delete(h.header, "X-Boice")
	if code := h.do("POST", "/api/lists", map[string]string{"name": "x"}, nil); code != 403 {
		t.Fatalf("CSRF guard: got %d", code)
	}
	h.header["X-Boice"] = "1"

	var list List
	if code := h.do("POST", "/api/lists", map[string]string{"name": "Kapitel 3", "recordMode": "both"}, &list); code != 201 {
		t.Fatalf("create list: %d", code)
	}
	base := fmt.Sprintf("/api/lists/%d", list.ID)

	// Scan: a tiny valid PNG header is enough for content sniffing.
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 64)...)
	var scan struct {
		Page        int
		DictChecked bool
		Words       []scannedWord
	}
	if code := h.do("POST", base+"/scan", png, &scan); code != 200 {
		t.Fatalf("scan: %d", code)
	}
	if scan.Page != 42 || !scan.DictChecked || len(scan.Words) != 3 {
		t.Fatalf("scan result: %+v", scan)
	}
	w0 := scan.Words[0]
	if w0.Term != "grune Augen" || len(w0.Issues) != 1 || w0.Issues[0].Suggestion != "grüne Augen" || w0.Issues[0].Token != "grune" {
		t.Fatalf("OCR mistake not caught: %+v", w0)
	}
	if is := scan.Words[1].Issues; len(is) != 1 || is[0].Side != "" {
		t.Fatalf("unsure row not marked: %+v", is)
	}
	if is := scan.Words[2].Issues; len(is) != 1 || is[0].Suggestion != "" || is[0].Token != "Donaudampfschiff" {
		t.Fatalf("unknown word should stay flagged without a suggestion: %+v", is)
	}

	var added struct{ Words []Word }
	in := map[string]any{"words": []map[string]any{
		{"term": w0.Term, "translation": w0.Translation, "page": 42, "issues": w0.Issues},
		{"term": "das Haus", "translation": "het huis", "page": 43},
		{"term": "der Hund", "translation": "de hond", "page": 44},
	}}
	if code := h.do("POST", base+"/words", in, &added); code != 201 || len(added.Words) != 3 {
		t.Fatalf("add words: %d %+v", code, added)
	}
	ids := []int64{added.Words[0].ID, added.Words[1].ID, added.Words[2].ID}

	// Accepting the fix (editing the term) clears the issue.
	var wd Word
	h.do("PATCH", fmt.Sprintf("/api/words/%d", ids[0]), map[string]any{"term": "grüne Augen", "flagged": true}, &wd)
	if wd.Term != "grüne Augen" || len(wd.Issues) != 0 || !wd.Flagged {
		t.Fatalf("update word: %+v", wd)
	}

	// Audio.
	if code := h.do("PUT", fmt.Sprintf("/api/words/%d/audio/a", ids[0]), []byte("nope nope nope nope"), nil); code != 400 {
		t.Fatalf("bad audio accepted: %d", code)
	}
	h.do("PUT", fmt.Sprintf("/api/words/%d/audio/a", ids[0]), fakeClip(40), &wd)
	if wd.AudioA != 1044 {
		t.Fatalf("audio duration: %d", wd.AudioA)
	}
	h.do("PUT", fmt.Sprintf("/api/words/%d/audio/b", ids[0]), fakeClip(20), nil)
	h.do("PUT", fmt.Sprintf("/api/words/%d/audio/a", ids[1]), fakeClip(10), nil)
	var clip []byte
	if code := h.do("GET", fmt.Sprintf("/api/words/%d/audio/a", ids[0]), nil, &clip); code != 200 || len(clip) != 40*104 {
		t.Fatalf("get audio: %d, %d bytes", code, len(clip))
	}

	var detail struct {
		List  List
		Words []Word
	}
	h.do("GET", base, nil, &detail)
	if detail.List.WordCount != 3 || detail.List.Recorded != 1 || detail.List.Flagged != 1 {
		t.Fatalf("counts: %+v", detail.List)
	}

	// MP3 export: word 2 then word 0, both sides, with gaps.
	var mp3 []byte
	exp := map[string]any{"wordIds": []int64{ids[1], ids[0], ids[2]}, "sides": []string{"a", "b"}, "gapMs": 1000, "pairGapMs": 500}
	if code := h.do("POST", base+"/export/mp3", exp, &mp3); code != 200 {
		t.Fatalf("mp3 export: %d %s", code, mp3)
	}
	// 300ms lead-in (11) + clip 10 + pair gap (19) + clip 40 + gap (38) + clip 20 + pair gap (19)
	if frames, _, err := cleanMP3(mp3); err != nil || len(frames) != len(mp3) || len(mp3)/104 != 11+10+19+40+38+20+19 {
		t.Fatalf("mp3 export: %v, %d frames", err, len(mp3)/104)
	}

	// CSV export.
	var csvOut []byte
	h.do("POST", base+"/export/csv", map[string]any{"reversed": true, "wordIds": ids[:1]}, &csvOut)
	if want := "\xEF\xBB\xBFDutch,German,Page,Note\ngroene ogen,grüne Augen,42,\n"; string(csvOut) != want {
		t.Fatalf("csv: %q", csvOut)
	}

	// Anki export: a zip with a readable collection and the audio files.
	var apkg []byte
	if code := h.do("POST", base+"/export/anki", map[string]any{"direction": "both"}, &apkg); code != 200 {
		t.Fatalf("anki export: %d", code)
	}
	zr, err := zip.NewReader(bytes.NewReader(apkg), int64(len(apkg)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		files[f.Name], _ = io.ReadAll(rc)
		rc.Close()
	}
	var media map[string]string
	if err := json.Unmarshal(files["media"], &media); err != nil || len(media) != 3 || len(files) != 5 {
		t.Fatalf("anki media: %v %v (%d files)", err, media, len(files))
	}
	dbPath := filepath.Join(t.TempDir(), "c.anki2")
	_ = os.WriteFile(dbPath, files["collection.anki2"], 0o644)
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var notes, cards int
	var flds string
	_ = db.QueryRow(`SELECT COUNT(*) FROM notes`).Scan(&notes)
	_ = db.QueryRow(`SELECT COUNT(*) FROM cards`).Scan(&cards)
	_ = db.QueryRow(`SELECT flds FROM notes ORDER BY id LIMIT 1`).Scan(&flds)
	if notes != 3 || cards != 6 || !strings.HasPrefix(flds, "grüne Augen\x1fgroene ogen\x1f[sound:boice-") {
		t.Fatalf("anki db: %d notes, %d cards, %q", notes, cards, flds)
	}

	// Delete words, then the list, and make sure audio goes with it.
	if code := h.do("POST", base+"/words/delete", map[string]any{"ids": ids[:1]}, nil); code != 204 {
		t.Fatalf("delete words: %d", code)
	}
	if _, err := os.Stat(h.app.audioFile(Word{ID: ids[0], ListID: list.ID}, "a")); !os.IsNotExist(err) {
		t.Fatal("audio file survived word deletion")
	}
	h.do("DELETE", base, nil, nil)
	if code := h.do("GET", base, nil, nil); code != 404 {
		t.Fatalf("deleted list still there: %d", code)
	}
}

func TestForwardAuthIsolatesUsers(t *testing.T) {
	h := newHarness(t, Config{AuthMode: "forward", ForwardHeader: "Remote-User"}, nil)
	if code := h.do("GET", "/api/lists", nil, nil); code != 401 {
		t.Fatalf("no header: %d", code)
	}
	h.header["Remote-User"] = "alice"
	var list List
	h.do("POST", "/api/lists", map[string]string{"name": "A"}, &list)
	h.header["Remote-User"] = "bob"
	if code := h.do("GET", fmt.Sprintf("/api/lists/%d", list.ID), nil, nil); code != 404 {
		t.Fatalf("bob can read alice's list: %d", code)
	}
	var lists []List
	h.do("GET", "/api/lists", nil, &lists)
	if len(lists) != 0 {
		t.Fatal("bob sees lists")
	}
}

func TestOIDCLogin(t *testing.T) {
	cfg := Config{AuthMode: "oidc", OIDCClientID: "cid", OIDCSecret: "csecret", OIDCScopes: "openid profile"}
	h := newHarness(t, cfg, fakeUpstream(t))
	h.app.auth.cfg.BaseURL = h.srv.URL

	if code := h.do("GET", "/api/me", nil, nil); code != 401 {
		t.Fatalf("anonymous: %d", code)
	}
	// Follows login → provider → callback → "/", collecting the session cookie.
	if code := h.do("GET", "/auth/login", nil, nil); code != 200 {
		t.Fatalf("login flow: %d", code)
	}
	var me struct{ User User }
	if code := h.do("GET", "/api/me", nil, &me); code != 200 || me.User.ID != "matthias" || me.User.Name != "Matthias L" {
		t.Fatalf("after login: %d %+v", code, me)
	}
	// A forged cookie is rejected.
	h2 := finishHarness(t, h.app)
	req, _ := http.NewRequest("GET", h2.srv.URL+"/api/me", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: "eyJ1Ijp7ImlkIjoiYSJ9fQ.AAAA"})
	res, _ := http.DefaultClient.Do(req)
	if res.StatusCode != 401 {
		t.Fatalf("forged cookie: %d", res.StatusCode)
	}
	h.do("GET", "/auth/logout", nil, nil)
	if code := h.do("GET", "/api/me", nil, nil); code != 401 {
		t.Fatalf("after logout: %d", code)
	}
}
