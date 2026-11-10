package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type App struct {
	cfg   Config
	store *Store
	auth  *Auth
	ai    *AI
	dict  *Dict

	studygoBase string // overridable in tests
}

func newApp(cfg Config, store *Store) (*App, error) {
	auth, err := newAuth(cfg, store)
	if err != nil {
		return nil, err
	}
	return &App{cfg: cfg, store: store, auth: auth, ai: newAI(cfg), dict: newDict(cfg, store)}, nil
}

func (a *App) routes() http.Handler {
	api := http.NewServeMux()
	api.HandleFunc("GET /api/me", a.handleMe)
	api.HandleFunc("GET /api/lists", a.handleLists)
	api.HandleFunc("POST /api/lists", a.handleCreateList)
	api.HandleFunc("GET /api/lists/{id}", a.handleList)
	api.HandleFunc("PATCH /api/lists/{id}", a.handleUpdateList)
	api.HandleFunc("DELETE /api/lists/{id}", a.handleDeleteList)
	api.HandleFunc("GET /api/studygo/books", a.handleStudygoBooks)
	api.HandleFunc("GET /api/studygo/books/{id}", a.handleStudygoBook)
	api.HandleFunc("GET /api/studygo/chapters/{id}", a.handleStudygoChapter)
	api.HandleFunc("GET /api/studygo/lists/{id}/preview", a.handleStudygoPreview)
	api.HandleFunc("POST /api/studygo/lists", a.handleStudygoLists)
	api.HandleFunc("POST /api/studygo/import", a.handleStudygoImport)
	api.HandleFunc("GET /api/subjects", a.handleSubjects)
	api.HandleFunc("POST /api/subjects", a.handleCreateSubject)
	api.HandleFunc("PATCH /api/subjects/{id}", a.handleRenameSubject)
	api.HandleFunc("DELETE /api/subjects/{id}", a.handleDeleteSubject)
	api.HandleFunc("GET /api/lists/{id}/scans", a.handleScans)
	api.HandleFunc("POST /api/lists/{id}/scans", a.handleStartScan)
	api.HandleFunc("DELETE /api/scans/{id}", a.handleDeleteScan)
	api.HandleFunc("POST /api/lists/{id}/check", a.handleCheck)
	api.HandleFunc("POST /api/lists/{id}/words", a.handleAddWords)
	api.HandleFunc("POST /api/lists/{id}/words/delete", a.handleDeleteWords)
	api.HandleFunc("POST /api/lists/{id}/export/{format}", a.handleExport)
	api.HandleFunc("PATCH /api/words/{id}", a.handleUpdateWord)
	api.HandleFunc("GET /api/words/{id}/audio/{side}", a.handleGetAudio)
	api.HandleFunc("PUT /api/words/{id}/audio/{side}", a.handlePutAudio)
	api.HandleFunc("DELETE /api/words/{id}/audio/{side}", a.handleDeleteAudio)

	mux := http.NewServeMux()
	mux.Handle("/api/", a.auth.require(api))
	mux.HandleFunc("GET /auth/login", a.auth.handleLogin)
	mux.HandleFunc("GET /auth/callback", a.auth.handleCallback)
	mux.HandleFunc("GET /auth/logout", a.auth.handleLogout)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "ok") })
	mux.Handle("/", spaHandler())
	return securityHeaders(mux)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("Permissions-Policy", "microphone=(self), camera=(self)")
		next.ServeHTTP(w, r)
	})
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (a *App) fail(w http.ResponseWriter, err error) {
	if errors.Is(err, errNotFound) {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	log.Printf("error: %v", err)
	writeErr(w, http.StatusInternalServerError, "something went wrong on the server")
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	return true
}

func pathID(r *http.Request) int64 {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	return id
}

// ownedList loads the list in the URL, checking it belongs to the caller.
func (a *App) ownedList(w http.ResponseWriter, r *http.Request) (List, bool) {
	l, err := a.store.List(userFrom(r).ID, pathID(r))
	if err != nil {
		a.fail(w, err)
		return l, false
	}
	return l, true
}

func (a *App) ownedWord(w http.ResponseWriter, r *http.Request) (Word, bool) {
	wd, err := a.store.Word(userFrom(r).ID, pathID(r))
	if err != nil {
		a.fail(w, err)
		return wd, false
	}
	return wd, true
}

func (a *App) audioDir(listID int64) string {
	return filepath.Join(a.cfg.DataDir, "audio", strconv.FormatInt(listID, 10))
}

func (a *App) audioFile(wd Word, side string) string {
	return filepath.Join(a.audioDir(wd.ListID), fmt.Sprintf("%d-%s.mp3", wd.ID, side))
}

// audioIfRecorded returns the clip path, or "" when that side has no audio.
func (a *App) audioIfRecorded(wd Word, side string) string {
	if (side == "a" && wd.AudioA == 0) || (side == "b" && wd.AudioB == 0) {
		return ""
	}
	p := a.audioFile(wd, side)
	if _, err := os.Stat(p); err != nil {
		return ""
	}
	return p
}

func validLang(s string) bool { return langRe.MatchString(s) }

func validMode(s string) bool { return s == "a" || s == "b" || s == "both" }

func limitRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// ---- lists ----

func (a *App) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"user":      userFrom(r),
		"canLogout": a.cfg.AuthMode == "oidc",
		"scan":      a.ai.Enabled(),
	})
}

func (a *App) handleLists(w http.ResponseWriter, r *http.Request) {
	lists, err := a.store.Lists(userFrom(r).ID)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lists)
}

type listInput struct {
	Name       string `json:"name"`
	LangA      string `json:"langA"`
	LangB      string `json:"langB"`
	RecordMode string `json:"recordMode"`
	Kind       string `json:"kind"`
	SubjectID  *int64 `json:"subjectId"`
}

func (in *listInput) validate() string {
	in.Name = limitRunes(strings.TrimSpace(in.Name), 120)
	switch {
	case in.Name == "":
		return "give the list a name"
	case !validLang(in.LangA) || !validLang(in.LangB):
		return "unknown language"
	case !validMode(in.RecordMode):
		return "unknown record mode"
	case in.Kind != "lang" && in.Kind != "def":
		return "unknown list type"
	}
	return ""
}

// checkSubject makes sure a linked subject belongs to the caller.
func (a *App) checkSubject(w http.ResponseWriter, r *http.Request, id *int64) bool {
	if id == nil {
		return true
	}
	if _, err := a.store.Subject(userFrom(r).ID, *id); err != nil {
		writeErr(w, http.StatusBadRequest, "unknown subject")
		return false
	}
	return true
}

func (a *App) handleCreateList(w http.ResponseWriter, r *http.Request) {
	in := listInput{LangA: "de", LangB: "nl", RecordMode: "a", Kind: "lang"}
	if !readJSON(w, r, &in) {
		return
	}
	if msg := in.validate(); msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	if !a.checkSubject(w, r, in.SubjectID) {
		return
	}
	id, err := a.store.CreateList(userFrom(r).ID, in.Name, in.LangA, in.LangB, in.RecordMode, in.Kind, in.SubjectID)
	if err != nil {
		a.fail(w, err)
		return
	}
	l, err := a.store.List(userFrom(r).ID, id)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, l)
}

func (a *App) handleList(w http.ResponseWriter, r *http.Request) {
	l, ok := a.ownedList(w, r)
	if !ok {
		return
	}
	words, err := a.store.Words(l.ID)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"list": l, "words": words})
}

func (a *App) handleUpdateList(w http.ResponseWriter, r *http.Request) {
	l, ok := a.ownedList(w, r)
	if !ok {
		return
	}
	in := listInput{Name: l.Name, LangA: l.LangA, LangB: l.LangB, RecordMode: l.RecordMode, Kind: l.Kind, SubjectID: l.SubjectID}
	if !readJSON(w, r, &in) {
		return
	}
	if msg := in.validate(); msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	if !a.checkSubject(w, r, in.SubjectID) {
		return
	}
	if err := a.store.UpdateList(l.ID, in.Name, in.LangA, in.LangB, in.RecordMode, in.Kind, in.SubjectID); err != nil {
		a.fail(w, err)
		return
	}
	l, err := a.store.List(userFrom(r).ID, l.ID)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, l)
}

func (a *App) handleDeleteList(w http.ResponseWriter, r *http.Request) {
	l, ok := a.ownedList(w, r)
	if !ok {
		return
	}
	if err := a.store.DeleteList(l.ID); err != nil {
		a.fail(w, err)
		return
	}
	_ = os.RemoveAll(a.audioDir(l.ID))
	w.WriteHeader(http.StatusNoContent)
}

// ---- scanning and checking ----

// checkPairs runs the dictionary check and, for entries with unknown words,
// asks the AI for a correction. It returns the issues per pair.
func (a *App) checkPairs(ctx context.Context, l List, pairs []Pair) (issues [][]Issue, dictOK bool) {
	issues = make([][]Issue, len(pairs))
	as, bs := make([]string, len(pairs)), make([]string, len(pairs))
	for i, p := range pairs {
		as[i], bs[i] = p.A, p.B
		if p.Unsure {
			issues[i] = append(issues[i], Issue{})
		}
	}
	if l.Kind == "def" {
		// Definitions are sentences: a dictionary check would only cry wolf.
		return issues, true
	}
	unkA, okA := a.dict.Unknown(ctx, l.LangA, as)
	unkB, okB := a.dict.Unknown(ctx, l.LangB, bs)

	type ref struct {
		pair int
		side string
	}
	var reqs []fixRequest
	var refs []ref
	for i, p := range pairs {
		if len(unkA[i]) > 0 {
			reqs = append(reqs, fixRequest{len(reqs), langName(l.LangA), p.A, unkA[i], p.B})
			refs = append(refs, ref{i, "a"})
		}
		if len(unkB[i]) > 0 {
			reqs = append(reqs, fixRequest{len(reqs), langName(l.LangB), p.B, unkB[i], p.A})
			refs = append(refs, ref{i, "b"})
		}
	}
	fixes := map[int]string{}
	if a.ai.Enabled() && len(reqs) > 0 && len(reqs) <= 150 {
		var err error
		if fixes, err = a.ai.SuggestFixes(ctx, reqs); err != nil {
			log.Printf("AI second opinion failed: %v", err)
			fixes = map[int]string{}
		}
	}
	for n, rq := range reqs {
		is := Issue{Side: refs[n].side, Token: strings.Join(rq.Unknown, ", ")}
		if fix := fixes[n]; fix != "" && fix != rq.Text {
			is.Suggestion = limitRunes(fix, 300)
		}
		issues[refs[n].pair] = append(issues[refs[n].pair], is)
	}
	return issues, okA && okB
}

type scannedWord struct {
	Term        string  `json:"term"`
	Translation string  `json:"translation"`
	Issues      []Issue `json:"issues"`
}

// handleStartScan accepts a photo and reads it in the background, so the
// person can leave the page. The result is kept until they review it.
func (a *App) handleStartScan(w http.ResponseWriter, r *http.Request) {
	l, ok := a.ownedList(w, r)
	if !ok {
		return
	}
	if !a.ai.Enabled() {
		writeErr(w, http.StatusServiceUnavailable, "Photo scanning is off: the server has no Hack Club AI key.")
		return
	}
	img, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 12<<20))
	if err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "That photo is too large (max 12 MB).")
		return
	}
	mimeType := http.DetectContentType(img)
	if mimeType != "image/jpeg" && mimeType != "image/png" && mimeType != "image/webp" {
		writeErr(w, http.StatusBadRequest, "Upload a JPEG, PNG or WebP photo.")
		return
	}
	id, err := a.store.CreateScan(l.ID)
	if err != nil {
		a.fail(w, err)
		return
	}
	go a.runScan(id, l, img, mimeType)
	writeJSON(w, http.StatusAccepted, Scan{ID: id, ListID: l.ID, Status: "running", Words: []scannedWord{}})
}

// runScan reads one photo and stores the outcome. It outlives the request.
func (a *App) runScan(id int64, l List, img []byte, mimeType string) {
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	defer func() {
		if p := recover(); p != nil {
			log.Printf("scan panic: %v", p)
			a.store.FinishScan(id, 0, nil, false, "Could not read the photo. Try again.")
		}
	}()

	pairs, page, err := a.ai.Extract(ctx, img, mimeType, l.LangA, l.LangB, l.Kind)
	if err != nil {
		log.Printf("scan: %v", err)
		msg := "Could not read the photo. Try again, or take a sharper picture."
		var ae *aiError
		if errors.As(err, &ae) {
			msg = ae.userMessage()
		}
		a.store.FinishScan(id, 0, nil, false, msg)
		return
	}
	if len(pairs) > 400 {
		pairs = pairs[:400]
	}
	issues, dictOK := a.checkPairs(ctx, l, pairs)
	out := make([]scannedWord, len(pairs))
	for i, p := range pairs {
		out[i] = scannedWord{limitRunes(p.A, 300), limitRunes(p.B, 300), issues[i]}
		if out[i].Issues == nil {
			out[i].Issues = []Issue{}
		}
	}
	a.store.FinishScan(id, page, out, dictOK, "")
}

func (a *App) handleScans(w http.ResponseWriter, r *http.Request) {
	l, ok := a.ownedList(w, r)
	if !ok {
		return
	}
	scans, err := a.store.Scans(l.ID)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, scans)
}

func (a *App) handleDeleteScan(w http.ResponseWriter, r *http.Request) {
	sc, err := a.store.Scan(userFrom(r).ID, pathID(r))
	if err != nil {
		a.fail(w, err)
		return
	}
	if err := a.store.DeleteScan(sc.ID); err != nil {
		a.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- subjects ----

func (a *App) handleSubjects(w http.ResponseWriter, r *http.Request) {
	subs, err := a.store.Subjects(userFrom(r).ID)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, subs)
}

func subjectName(w http.ResponseWriter, r *http.Request) (string, bool) {
	var in struct {
		Name string `json:"name"`
	}
	if !readJSON(w, r, &in) {
		return "", false
	}
	name := limitRunes(strings.TrimSpace(in.Name), 80)
	if name == "" {
		writeErr(w, http.StatusBadRequest, "give the subject a name")
		return "", false
	}
	return name, true
}

func (a *App) handleCreateSubject(w http.ResponseWriter, r *http.Request) {
	name, ok := subjectName(w, r)
	if !ok {
		return
	}
	id, err := a.store.CreateSubject(userFrom(r).ID, name)
	if err != nil {
		a.fail(w, err)
		return
	}
	sub, err := a.store.Subject(userFrom(r).ID, id)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, sub)
}

func (a *App) handleRenameSubject(w http.ResponseWriter, r *http.Request) {
	sub, err := a.store.Subject(userFrom(r).ID, pathID(r))
	if err != nil {
		a.fail(w, err)
		return
	}
	name, ok := subjectName(w, r)
	if !ok {
		return
	}
	if err := a.store.RenameSubject(sub.ID, name); err != nil {
		a.fail(w, err)
		return
	}
	sub.Name = name
	writeJSON(w, http.StatusOK, sub)
}

func (a *App) handleDeleteSubject(w http.ResponseWriter, r *http.Request) {
	sub, err := a.store.Subject(userFrom(r).ID, pathID(r))
	if err != nil {
		a.fail(w, err)
		return
	}
	if err := a.store.DeleteSubject(sub.ID); err != nil {
		a.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleCheck re-runs the dictionary check over the whole list.
func (a *App) handleCheck(w http.ResponseWriter, r *http.Request) {
	l, ok := a.ownedList(w, r)
	if !ok {
		return
	}
	words, err := a.store.Words(l.ID)
	if err != nil {
		a.fail(w, err)
		return
	}
	pairs := make([]Pair, len(words))
	for i, wd := range words {
		pairs[i] = Pair{A: wd.Term, B: wd.Translation}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 150*time.Second)
	defer cancel()
	issues, dictOK := a.checkPairs(ctx, l, pairs)
	if !dictOK {
		writeErr(w, http.StatusBadGateway, "The dictionary could not be reached. Try again later.")
		return
	}
	for i := range words {
		if issues[i] == nil {
			issues[i] = []Issue{}
		}
		words[i].Issues = issues[i]
		if err := a.store.SetIssues(words[i].ID, issues[i]); err != nil {
			a.fail(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"words": words})
}

// ---- words ----

func cleanIssues(in []Issue) []Issue {
	out := []Issue{}
	for _, is := range in {
		if (is.Side == "" || is.Side == "a" || is.Side == "b") && len(out) < 8 {
			out = append(out, Issue{is.Side, limitRunes(is.Token, 200), limitRunes(is.Suggestion, 300)})
		}
	}
	return out
}

func (a *App) handleAddWords(w http.ResponseWriter, r *http.Request) {
	l, ok := a.ownedList(w, r)
	if !ok {
		return
	}
	var in struct {
		Words []struct {
			Term        string  `json:"term"`
			Translation string  `json:"translation"`
			Page        int     `json:"page"`
			Note        string  `json:"note"`
			Issues      []Issue `json:"issues"`
		} `json:"words"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if l.WordCount+len(in.Words) > 5000 {
		writeErr(w, http.StatusBadRequest, "A list can hold at most 5000 words.")
		return
	}
	var words []Word
	for _, x := range in.Words {
		wd := Word{
			Term:        limitRunes(cleanText(x.Term), 300),
			Translation: limitRunes(cleanText(x.Translation), 300),
			Page:        max(0, min(x.Page, 99999)),
			Note:        limitRunes(strings.TrimSpace(x.Note), 500),
			Issues:      cleanIssues(x.Issues),
		}
		if wd.Term != "" || wd.Translation != "" {
			words = append(words, wd)
		}
	}
	added, err := a.store.AddWords(l.ID, words)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"words": added})
}

func (a *App) handleDeleteWords(w http.ResponseWriter, r *http.Request) {
	l, ok := a.ownedList(w, r)
	if !ok {
		return
	}
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if err := a.store.DeleteWords(l.ID, in.IDs); err != nil {
		a.fail(w, err)
		return
	}
	for _, id := range in.IDs {
		for _, side := range []string{"a", "b"} {
			_ = os.Remove(a.audioFile(Word{ID: id, ListID: l.ID}, side))
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handleUpdateWord(w http.ResponseWriter, r *http.Request) {
	wd, ok := a.ownedWord(w, r)
	if !ok {
		return
	}
	var in struct {
		Term        *string  `json:"term"`
		Translation *string  `json:"translation"`
		Page        *int     `json:"page"`
		Note        *string  `json:"note"`
		Flagged     *bool    `json:"flagged"`
		Issues      *[]Issue `json:"issues"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	// Editing a side settles the warnings about it.
	dropIssues := func(side string) {
		kept := []Issue{}
		for _, is := range wd.Issues {
			if is.Side != side && is.Side != "" {
				kept = append(kept, is)
			}
		}
		wd.Issues = kept
	}
	if in.Term != nil {
		if t := limitRunes(cleanText(*in.Term), 300); t != wd.Term {
			wd.Term = t
			dropIssues("a")
		}
	}
	if in.Translation != nil {
		if t := limitRunes(cleanText(*in.Translation), 300); t != wd.Translation {
			wd.Translation = t
			dropIssues("b")
		}
	}
	if in.Page != nil {
		wd.Page = max(0, min(*in.Page, 99999))
	}
	if in.Note != nil {
		wd.Note = limitRunes(strings.TrimSpace(*in.Note), 500)
	}
	if in.Flagged != nil {
		wd.Flagged = *in.Flagged
	}
	if in.Issues != nil {
		wd.Issues = cleanIssues(*in.Issues)
	}
	if err := a.store.UpdateWord(wd); err != nil {
		a.fail(w, err)
		return
	}
	wd.UpdatedAt = now()
	writeJSON(w, http.StatusOK, wd)
}

// ---- audio ----

func audioSide(r *http.Request) (string, bool) {
	s := r.PathValue("side")
	return s, s == "a" || s == "b"
}

func (a *App) handleGetAudio(w http.ResponseWriter, r *http.Request) {
	wd, ok := a.ownedWord(w, r)
	side, sideOK := audioSide(r)
	if !ok {
		return
	}
	p := ""
	if sideOK {
		p = a.audioIfRecorded(wd, side)
	}
	if p == "" {
		writeErr(w, http.StatusNotFound, "no recording")
		return
	}
	w.Header().Set("Content-Type", "audio/mpeg")
	// The client adds ?v=<updatedAt>, so a clip URL never changes content.
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeFile(w, r, p)
}

func (a *App) handlePutAudio(w http.ResponseWriter, r *http.Request) {
	wd, ok := a.ownedWord(w, r)
	side, sideOK := audioSide(r)
	if !ok {
		return
	}
	if !sideOK {
		writeErr(w, http.StatusBadRequest, "unknown side")
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 3<<20))
	if err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "That recording is too long.")
		return
	}
	frames, ms, err := cleanMP3(raw)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := os.MkdirAll(a.audioDir(wd.ListID), 0o755); err != nil {
		a.fail(w, err)
		return
	}
	dst := a.audioFile(wd, side)
	if err := os.WriteFile(dst+".tmp", frames, 0o644); err != nil {
		a.fail(w, err)
		return
	}
	if err := os.Rename(dst+".tmp", dst); err != nil {
		a.fail(w, err)
		return
	}
	if err := a.store.SetAudio(wd, side, ms); err != nil {
		a.fail(w, err)
		return
	}
	wd, err = a.store.Word(userFrom(r).ID, wd.ID)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, wd)
}

func (a *App) handleDeleteAudio(w http.ResponseWriter, r *http.Request) {
	wd, ok := a.ownedWord(w, r)
	side, sideOK := audioSide(r)
	if !ok {
		return
	}
	if !sideOK {
		writeErr(w, http.StatusBadRequest, "unknown side")
		return
	}
	_ = os.Remove(a.audioFile(wd, side))
	if err := a.store.SetAudio(wd, side, 0); err != nil {
		a.fail(w, err)
		return
	}
	wd, err := a.store.Word(userFrom(r).ID, wd.ID)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, wd)
}

// ---- export ----

type exportInput struct {
	WordIDs []int64 `json:"wordIds"` // in the order to export; empty = whole list
	// MP3
	Sides     []string `json:"sides"`     // clip order per word, e.g. ["a","b"]
	GapMs     int      `json:"gapMs"`     // pause between the sides of one word
	PairGapMs int      `json:"pairGapMs"` // pause before the next word
	Repeat    int      `json:"repeat"`
	// CSV
	Reversed bool `json:"reversed"`
	// Anki
	Direction    string `json:"direction"`
	IncludeAudio bool   `json:"includeAudio"`
}

func safeFilename(s string) string {
	s = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`\/:*?"<>|`, r) || r < 32 {
			return '-'
		}
		return r
	}, s)
	if s = strings.TrimSpace(s); s == "" {
		return "boice"
	}
	return s
}

func attach(w http.ResponseWriter, contentType, filename string) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
	w.Header().Set("Cache-Control", "no-store")
}

func (a *App) handleExport(w http.ResponseWriter, r *http.Request) {
	l, ok := a.ownedList(w, r)
	if !ok {
		return
	}
	in := exportInput{GapMs: 500, PairGapMs: 500, Repeat: 1, Direction: "ab", IncludeAudio: true}
	if !readJSON(w, r, &in) {
		return
	}
	all, err := a.store.Words(l.ID)
	if err != nil {
		a.fail(w, err)
		return
	}
	words := all
	if len(in.WordIDs) > 0 {
		byID := make(map[int64]Word, len(all))
		for _, wd := range all {
			byID[wd.ID] = wd
		}
		words = words[:0:0]
		for _, id := range in.WordIDs {
			if wd, ok := byID[id]; ok {
				words = append(words, wd)
			}
		}
	}
	if len(words) == 0 {
		writeErr(w, http.StatusBadRequest, "There are no words to export.")
		return
	}
	name := safeFilename(l.Name)

	switch r.PathValue("format") {
	case "csv":
		attach(w, "text/csv; charset=utf-8", name+".csv")
		_, _ = w.Write([]byte("\xEF\xBB\xBF")) // BOM so Excel reads UTF-8
		cw := csv.NewWriter(w)
		row := func(x, y, page, note string) {
			if in.Reversed {
				x, y = y, x
			}
			_ = cw.Write([]string{x, y, page, note})
		}
		headA, headB := langName(l.LangA), langName(l.LangB)
		if l.Kind == "def" {
			headA, headB = "Term", "Definition"
		}
		row(headA, headB, "Page", "Note")
		for _, wd := range words {
			page := ""
			if wd.Page > 0 {
				page = strconv.Itoa(wd.Page)
			}
			row(wd.Term, wd.Translation, page, wd.Note)
		}
		cw.Flush()

	case "anki":
		if in.Direction != "ab" && in.Direction != "ba" && in.Direction != "both" {
			in.Direction = "ab"
		}
		attach(w, "application/octet-stream", name+".apkg")
		err := writeAnki(w, filepath.Join(a.cfg.DataDir, "tmp"), l, words,
			ankiOpts{Direction: in.Direction, IncludeAudio: in.IncludeAudio}, a.audioIfRecorded)
		if err != nil {
			log.Printf("anki export: %v", err)
		}

	case "mp3":
		var sides []string
		for _, s := range in.Sides {
			if (s == "a" || s == "b") && len(sides) < 4 {
				sides = append(sides, s)
			}
		}
		if len(sides) == 0 {
			sides = []string{"a"}
		}
		gap, pairGap := max(0, min(in.GapMs, 30000)), max(0, min(in.PairGapMs, 30000))
		repeat := max(1, min(in.Repeat, 5))

		// Resolve every clip first, so we can fail cleanly before streaming.
		type item struct{ clips []string }
		var items []item
		for _, wd := range words {
			var clips []string
			for _, s := range sides {
				if p := a.audioIfRecorded(wd, s); p != "" {
					clips = append(clips, p)
				}
			}
			if len(clips) > 0 {
				items = append(items, item{clips})
			}
		}
		if len(items) == 0 {
			writeErr(w, http.StatusBadRequest, "None of the selected words has a recording yet.")
			return
		}
		attach(w, "audio/mpeg", name+".mp3")
		_ = writeSilence(w, 300)
		for _, it := range items {
			for range repeat {
				for i, p := range it.clips {
					f, err := os.Open(p)
					if err != nil {
						continue
					}
					_, err = io.Copy(w, f)
					f.Close()
					if err != nil {
						return // client went away
					}
					if i < len(it.clips)-1 {
						_ = writeSilence(w, gap)
					}
				}
				_ = writeSilence(w, pairGap)
			}
		}

	default:
		writeErr(w, http.StatusNotFound, "unknown export format")
	}
}
