package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Studygo (formerly WRTS) has no public API. These calls are the ones its own
// website makes, observed from the web app:
//
//	GET practiceable_items/created   -> {"created_items": [...]}  lists/quizzes the user made
//	GET recent_items                 -> {"recent_items": [...]}   what the user practised lately
//	GET lists/{id}/data              -> {"title", "words_collection": [{"words": [a, b]}],
//	                                     "subject": {"name"}, "locales": [{"language": {"code"}}, ...]}
//
// Authentication is the X-Auth-Token header, a token the person copies from
// their own logged-in browser. Boice uses it for the one request and never
// stores or logs it.

const studygoBase = "https://api.studygo.com/api/v3"

type studygoClient struct {
	base   string
	token  string
	client *http.Client
}

func (a *App) studygo(token string) *studygoClient {
	base := a.studygoBase
	if base == "" {
		base = studygoBase
	}
	return &studygoClient{base: base, token: token, client: &http.Client{Timeout: 25 * time.Second}}
}

type studygoError struct{ msg string }

func (e *studygoError) Error() string { return e.msg }

func (c *studygoClient) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/"+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if c.token != "" { // the public endpoints (browsing, previews) need no login
		req.Header.Set("X-Auth-Token", c.token)
	}
	req.Header.Set("X-Client-Type", "web")
	req.Header.Set("X-Language-Code", "nl")
	req.Header.Set("X-Locale-Code", "nl-NL")
	req.Header.Set("Origin", "https://studygo.com")
	req.Header.Set("Referer", "https://studygo.com/")
	res, err := c.client.Do(req)
	if err != nil {
		return &studygoError{"Studygo could not be reached. Try again later."}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	switch {
	case res.StatusCode == http.StatusUnauthorized:
		return &studygoError{"Studygo rejected the token. It may have expired: copy a fresh one."}
	case res.StatusCode == http.StatusForbidden:
		return &studygoError{"Studygo says you may not open this list."}
	case res.StatusCode == http.StatusNotFound:
		return &studygoError{"That list no longer exists on Studygo."}
	case res.StatusCode != http.StatusOK:
		return &studygoError{fmt.Sprintf("Studygo answered with an error (%d).", res.StatusCode)}
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return &studygoError{"Studygo sent something unexpected. The site may have changed."}
	}
	return nil
}

// StudygoList is one entry in the pick-list of importable lists.
type StudygoList struct {
	ID        int64  `json:"id"`
	Title     string `json:"title"`
	Words     int    `json:"words"`
	Own       bool   `json:"own"`
	Imported  bool   `json:"imported"`
	ListID    int64  `json:"listId,omitempty"`
	WordsText string `json:"-"`
}

// firstNumber pulls "22" out of "22 woorden".
func firstNumber(s string) int {
	n, _ := strconv.Atoi(strings.Fields(s + " ")[0])
	return n
}

func (c *studygoClient) lists(ctx context.Context) ([]StudygoList, error) {
	var created struct {
		Items []struct {
			ID        int64  `json:"id"`
			Title     string `json:"title"`
			WordCount string `json:"word_count_display"`
			Link      *struct {
				Type string `json:"type"`
				ID   int64  `json:"id"`
			} `json:"link"`
		} `json:"created_items"`
	}
	if err := c.get(ctx, "practiceable_items/created", &created); err != nil {
		return nil, err
	}
	var recent struct {
		Items []struct {
			Title string `json:"title"`
			Count string `json:"item_count_display"`
			Own   bool   `json:"is_from_current_user"`
			Link  struct {
				Type string `json:"type"`
				ID   int64  `json:"id"`
			} `json:"link"`
		} `json:"recent_items"`
	}
	if err := c.get(ctx, "recent_items", &recent); err != nil {
		return nil, err
	}
	var out []StudygoList
	seen := map[int64]bool{}
	add := func(l StudygoList) {
		if l.ID > 0 && !seen[l.ID] {
			seen[l.ID] = true
			out = append(out, l)
		}
	}
	for _, it := range created.Items {
		// Quizzes carry a link of type user_quiz; word lists have a plain id.
		if it.Link != nil && it.Link.Type != "list" {
			continue
		}
		add(StudygoList{ID: it.ID, Title: it.Title, Words: firstNumber(it.WordCount), Own: true})
	}
	for _, it := range recent.Items {
		if it.Link.Type == "list" {
			add(StudygoList{ID: it.Link.ID, Title: it.Title, Words: firstNumber(it.Count), Own: it.Own})
		}
	}
	return out, nil
}

type studygoData struct {
	Title           string `json:"title"`
	WordsCollection []struct {
		Words []string `json:"words"`
	} `json:"words_collection"`
	Subject *struct {
		Name string `json:"name"`
	} `json:"subject"`
	Locales []struct {
		Language struct {
			Code string `json:"code"`
		} `json:"language"`
	} `json:"locales"`
}

func (c *studygoClient) data(ctx context.Context, id int64) (studygoData, error) {
	var d studygoData
	if c.token == "" {
		return c.publicData(ctx, id)
	}
	err := c.get(ctx, fmt.Sprintf("lists/%d/data", id), &d)
	return d, err
}

// publicData reads a list through the login-free endpoint the website uses for
// shared and publisher lists. It has the same words in the same order, in a
// different shape.
func (c *studygoClient) publicData(ctx context.Context, id int64) (studygoData, error) {
	var p struct {
		Title                string `json:"title"`
		WordsWithPerformance []struct {
			Words []string `json:"words"`
		} `json:"words_with_performance"`
		Subject *struct {
			Name string `json:"name"`
		} `json:"subject"`
		Locales []struct {
			LanguageCode string `json:"language_code"`
			Locale       string `json:"locale"`
		} `json:"locales"`
	}
	if err := c.get(ctx, fmt.Sprintf("public/lists/%d", id), &p); err != nil {
		return studygoData{}, err
	}
	d := studygoData{Title: p.Title, Subject: p.Subject}
	d.WordsCollection = make([]struct {
		Words []string `json:"words"`
	}, len(p.WordsWithPerformance))
	for i, w := range p.WordsWithPerformance {
		d.WordsCollection[i].Words = w.Words
	}
	for _, l := range p.Locales {
		code := l.LanguageCode
		if code == "" {
			code = l.Locale // "de" or "de-DE"
		}
		code = strings.ToLower(strings.SplitN(code, "-", 2)[0])
		d.Locales = append(d.Locales, struct {
			Language struct {
				Code string `json:"code"`
			} `json:"language"`
		}{Language: struct {
			Code string `json:"code"`
		}{code}})
	}
	return d, nil
}

// shape works out what a Studygo list becomes in Boice: its languages, its
// kind and its word pairs. Two languages make a word list; the same language
// on both sides (a history glossary, say) makes terms and definitions.
func (d studygoData) shape() (langA, langB, kind string, pairs [][2]string, err error) {
	langA, langB = "de", "nl"
	if len(d.Locales) > 0 {
		langA = d.Locales[0].Language.Code
		langB = langA
	}
	if len(d.Locales) > 1 {
		langB = d.Locales[1].Language.Code
	}
	if !validLang(langA) || !validLang(langB) {
		return "", "", "", nil, fmt.Errorf("unusable language codes %q/%q", langA, langB)
	}
	kind = "lang"
	if langA == langB {
		kind = "def"
	}
	for _, e := range d.WordsCollection {
		if len(e.Words) < 2 {
			continue
		}
		term, tr := cleanText(e.Words[0]), cleanText(e.Words[1])
		if kind == "lang" {
			term, tr = firstForm(term), firstForm(tr)
		}
		if term == "" && tr == "" {
			continue
		}
		pairs = append(pairs, [2]string{limitRunes(term, 300), limitRunes(tr, 300)})
	}
	if len(pairs) > 5000 {
		pairs = pairs[:5000]
	}
	return langA, langB, kind, pairs, nil
}

// ---- handlers ----

type studygoTokenInput struct {
	Token string `json:"token"`
}

func cleanToken(s string) string {
	return strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(s), "x-auth-token:"))
}

func (a *App) writeStudygoErr(w http.ResponseWriter, err error) {
	var se *studygoError
	if errors.As(err, &se) {
		status := http.StatusBadGateway
		if strings.Contains(se.msg, "rejected") {
			status = http.StatusUnauthorized
		}
		// 401 would sign the person out of Boice itself, so use 422 for a bad token.
		if status == http.StatusUnauthorized {
			status = http.StatusUnprocessableEntity
		}
		writeErr(w, status, se.msg)
		return
	}
	a.fail(w, err)
}

func (a *App) handleStudygoLists(w http.ResponseWriter, r *http.Request) {
	var in studygoTokenInput
	if !readJSON(w, r, &in) {
		return
	}
	token := cleanToken(in.Token)
	if token == "" {
		writeErr(w, http.StatusBadRequest, "Paste your Studygo token first.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	lists, err := a.studygo(token).lists(ctx)
	if err != nil {
		a.writeStudygoErr(w, err)
		return
	}
	for i := range lists {
		if id, ok := a.store.ListByStudygoID(userFrom(r).ID, lists[i].ID); ok {
			lists[i].Imported, lists[i].ListID = true, id
		}
	}
	if lists == nil {
		lists = []StudygoList{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"lists": lists})
}

type studygoResult struct {
	ID     int64  `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"` // imported | exists | error
	ListID int64  `json:"listId,omitempty"`
	Words  int    `json:"words"`
	Error  string `json:"error,omitempty"`
}

func (a *App) handleStudygoImport(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string  `json:"token"`
		IDs   []int64 `json:"ids"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	token := cleanToken(in.Token) // empty = public lists only, no login needed
	if len(in.IDs) == 0 {
		writeErr(w, http.StatusBadRequest, "Pick at least one list.")
		return
	}
	if len(in.IDs) > 30 {
		writeErr(w, http.StatusBadRequest, "Import at most 30 lists at a time.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	client := a.studygo(token)
	owner := userFrom(r).ID

	results := []studygoResult{}
	for _, id := range in.IDs {
		res := studygoResult{ID: id}
		if existing, ok := a.store.ListByStudygoID(owner, id); ok {
			res.Status, res.ListID = "exists", existing
			results = append(results, res)
			continue
		}
		d, err := client.data(ctx, id)
		if err != nil {
			var se *studygoError
			if errors.As(err, &se) && strings.Contains(se.msg, "rejected") {
				a.writeStudygoErr(w, err)
				return
			}
			res.Status, res.Error = "error", err.Error()
			results = append(results, res)
			continue
		}
		listID, n, err := a.importStudygo(owner, id, d)
		res.Title = limitRunes(cleanText(d.Title), 120)
		if err != nil {
			log.Printf("studygo import %d: %v", id, err)
			res.Status, res.Error = "error", "That list could not be saved."
		} else {
			res.Status, res.ListID, res.Words = "imported", listID, n
		}
		results = append(results, res)
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

// importStudygo turns one Studygo list into a Boice list.
func (a *App) importStudygo(owner string, studygoID int64, d studygoData) (listID int64, words int, err error) {
	langA, langB, kind, pairs, err := d.shape()
	if err != nil {
		return 0, 0, err
	}
	name := limitRunes(cleanText(d.Title), 120)
	if name == "" {
		name = "Studygo list " + strconv.FormatInt(studygoID, 10)
	}
	var subjectID *int64
	if d.Subject != nil {
		if sn := limitRunes(cleanText(d.Subject.Name), 80); sn != "" {
			id, err := a.store.SubjectByName(owner, sn)
			if err != nil {
				return 0, 0, err
			}
			subjectID = &id
		}
	}
	batch := make([]Word, len(pairs))
	for i, p := range pairs {
		batch[i] = Word{Term: p[0], Translation: p[1]}
	}
	listID, err = a.store.CreateList(owner, name, langA, langB, "a", kind, subjectID)
	if err != nil {
		return 0, 0, err
	}
	if err := a.store.SetStudygoID(listID, studygoID); err != nil {
		return 0, 0, err
	}
	added, err := a.store.AddWords(listID, batch)
	if err != nil {
		_ = a.store.DeleteList(listID)
		return 0, 0, err
	}
	return listID, len(added), nil
}

// ---- browsing: subject -> book -> chapter -> list, no login needed ----

type browseFilter struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type browseBook struct {
	ID        int64  `json:"id"`
	Title     string `json:"title"`
	Publisher string `json:"publisher"`
	Grade     string `json:"grade"`
	Edition   string `json:"edition"`
	Subject   string `json:"subject"`
}

func (a *App) handleStudygoBooks(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	params := url.Values{"type": {"books"}, "limit": {"24"}}
	for _, k := range [][2]string{{"subject", "subject_id"}, {"track", "school_track_id"}} {
		if v := q.Get(k[0]); v != "" {
			if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
				params.Set(k[1], strconv.FormatInt(n, 10))
			}
		}
	}
	if n, err := strconv.Atoi(q.Get("grade")); err == nil && n >= 1 && n <= 12 {
		params.Set("grade_number", strconv.Itoa(n))
	}
	if n, err := strconv.Atoi(q.Get("offset")); err == nil && n > 0 && n <= 5000 {
		params.Set("offset", strconv.Itoa(n))
	}
	if t := limitRunes(cleanText(q.Get("q")), 100); t != "" {
		params.Set("search_terms", t)
	}
	var res struct {
		Sections []struct {
			Total   int `json:"total_count"`
			Filters struct {
				Subjects []struct {
					ID   int64  `json:"id"`
					Name string `json:"name"`
				} `json:"subject_id"`
				Tracks []struct {
					Section string `json:"section_name"`
					Tracks  []struct {
						ID   int64  `json:"id"`
						Name string `json:"name"`
					} `json:"school_tracks"`
				} `json:"school_track_id"`
				Grades []string `json:"grade_number"`
			} `json:"available_filters"`
			Results []struct {
				ID        json.Number `json:"id"`
				Title     string      `json:"title"`
				Publisher string      `json:"publisher_name"`
				Grade     string      `json:"grade_display"`
				Edition   json.Number `json:"edition_number"`
				Subject   string      `json:"subject_name"`
			} `json:"results"`
		} `json:"result_sections"`
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := a.studygo("").get(ctx, "public/search?"+params.Encode(), &res); err != nil {
		a.writeStudygoErr(w, err)
		return
	}
	out := struct {
		Total    int            `json:"total"`
		Books    []browseBook   `json:"books"`
		Subjects []browseFilter `json:"subjects"`
		Levels   []browseFilter `json:"levels"`
		Grades   []string       `json:"grades"`
	}{Books: []browseBook{}, Subjects: []browseFilter{}, Levels: []browseFilter{}, Grades: []string{}}
	if len(res.Sections) > 0 {
		s := res.Sections[0]
		out.Total, out.Grades = s.Total, s.Filters.Grades
		for _, f := range s.Filters.Subjects {
			out.Subjects = append(out.Subjects, browseFilter{f.ID, f.Name})
		}
		for _, sec := range s.Filters.Tracks {
			if sec.Section != "Nederland" {
				continue
			}
			for _, t := range sec.Tracks {
				out.Levels = append(out.Levels, browseFilter{t.ID, t.Name})
			}
		}
		for _, b := range s.Results {
			id, _ := b.ID.Int64()
			out.Books = append(out.Books, browseBook{id, b.Title, b.Publisher, b.Grade, b.Edition.String(), b.Subject})
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *App) handleStudygoBook(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	if id <= 0 {
		writeErr(w, http.StatusBadRequest, "unknown book")
		return
	}
	var res struct {
		Title    string `json:"title"`
		Chapters []struct {
			ID    int64  `json:"id"`
			Title string `json:"title"`
		} `json:"chapters"`
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := a.studygo("").get(ctx, fmt.Sprintf("public/books/%d", id), &res); err != nil {
		a.writeStudygoErr(w, err)
		return
	}
	chapters := []browseFilter{}
	for _, c := range res.Chapters {
		chapters = append(chapters, browseFilter{c.ID, c.Title})
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "title": res.Title, "chapters": chapters})
}

type browseList struct {
	ID        int64  `json:"id"`
	Title     string `json:"title"`
	Paragraph string `json:"paragraph"`
	Words     int    `json:"words"`
	Imported  bool   `json:"imported"`
	ListID    int64  `json:"listId,omitempty"`
}

func (a *App) handleStudygoChapter(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	if id <= 0 {
		writeErr(w, http.StatusBadRequest, "unknown chapter")
		return
	}
	type item struct {
		ID        int64  `json:"id"`
		Title     string `json:"title"`
		Paragraph string `json:"paragraph_display"`
		WordCount string `json:"word_count_display"`
	}
	var res struct {
		Chapter struct {
			Title string `json:"title"`
			Book  string `json:"book_name"`
			Lists struct {
				Highlighted []item `json:"highlighted"`
				Other       []item `json:"other"`
			} `json:"lists"`
		} `json:"chapter"`
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := a.studygo("").get(ctx, fmt.Sprintf("public/chapters/%d", id), &res); err != nil {
		a.writeStudygoErr(w, err)
		return
	}
	lists := []browseList{}
	seen := map[int64]bool{}
	for _, it := range append(res.Chapter.Lists.Highlighted, res.Chapter.Lists.Other...) {
		if it.ID == 0 || seen[it.ID] {
			continue
		}
		seen[it.ID] = true
		bl := browseList{ID: it.ID, Title: it.Title, Paragraph: it.Paragraph, Words: firstNumber(it.WordCount)}
		if lid, ok := a.store.ListByStudygoID(userFrom(r).ID, it.ID); ok {
			bl.Imported, bl.ListID = true, lid
		}
		lists = append(lists, bl)
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "title": res.Chapter.Title, "book": res.Chapter.Book, "lists": lists})
}

// previewMax is how many words a preview carries; enough to recognise a list.
const previewMax = 300

type previewWord struct {
	Term        string `json:"term"`
	Translation string `json:"translation"`
}

// handleStudygoPreview shows the first words of a list as they would be imported.
func (a *App) handleStudygoPreview(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	if id <= 0 {
		writeErr(w, http.StatusBadRequest, "unknown list")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	d, err := a.studygo("").data(ctx, id)
	if err != nil {
		a.writeStudygoErr(w, err)
		return
	}
	langA, langB, kind, pairs, err := d.shape()
	if err != nil {
		writeErr(w, http.StatusBadGateway, "That list uses a language Boice can't read.")
		return
	}
	words := []previewWord{}
	for _, p := range pairs[:min(len(pairs), previewMax)] {
		words = append(words, previewWord{p[0], p[1]})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": id, "title": cleanText(d.Title), "kind": kind, "langA": langA, "langB": langB,
		"total": len(pairs), "words": words,
	})
}

// ---- searching lists by name (needs the person's token) ----

type searchList struct {
	ID        int64  `json:"id"`
	Title     string `json:"title"`
	Words     int    `json:"words"`
	Creator   string `json:"creator"`
	Subject   string `json:"subject"`
	Book      string `json:"book"`
	Chapter   string `json:"chapter"`
	Paragraph string `json:"paragraph"`
	Imported  bool   `json:"imported"`
	ListID    int64  `json:"listId,omitempty"`
}

const searchPageSize = 20

// handleStudygoSearch looks lists up by name, among students' lists or the
// publishers' official ones. Studygo's filter parameters do not work on this
// call, so it is text search only.
func (a *App) handleStudygoSearch(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token  string `json:"token"`
		Q      string `json:"q"`
		Kind   string `json:"kind"` // "user" | "official"
		Offset int    `json:"offset"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	token := cleanToken(in.Token)
	q := limitRunes(cleanText(in.Q), 100)
	if token == "" {
		writeErr(w, http.StatusUnprocessableEntity, "Searching lists needs your Studygo token.")
		return
	}
	if q == "" {
		writeErr(w, http.StatusBadRequest, "Type something to search for.")
		return
	}
	searchType := "user_lists"
	if in.Kind == "official" {
		searchType = "official_lists"
	}
	params := url.Values{
		"type": {searchType}, "search_terms": {q}, "limit": {strconv.Itoa(searchPageSize)},
		"apply_default_filters": {"false"},
	}
	if in.Offset > 0 && in.Offset <= 5000 {
		params.Set("offset", strconv.Itoa(in.Offset))
	}
	var res struct {
		Sections []struct {
			Total   int `json:"total_count"`
			Results []struct {
				ID        json.Number `json:"id"`
				Title     string      `json:"title"`
				Words     int         `json:"word_count"`
				Creator   string      `json:"creator_name"`
				Subject   string      `json:"subject_name"`
				Book      string      `json:"book_title"`
				Chapter   json.Number `json:"book_chapter_nr"`
				Paragraph json.Number `json:"book_paragraph_nr"`
			} `json:"results"`
		} `json:"result_sections"`
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := a.studygo(token).get(ctx, "search?"+params.Encode(), &res); err != nil {
		a.writeStudygoErr(w, err)
		return
	}
	out := struct {
		Total int          `json:"total"`
		More  bool         `json:"more"`
		Lists []searchList `json:"lists"`
	}{Lists: []searchList{}}
	if len(res.Sections) > 0 {
		sec := res.Sections[0]
		out.Total = sec.Total
		for _, it := range sec.Results {
			id, err := it.ID.Int64()
			if err != nil || id <= 0 {
				continue
			}
			sl := searchList{ID: id, Title: cleanText(it.Title), Words: it.Words, Creator: cleanText(it.Creator),
				Subject: cleanText(it.Subject), Book: cleanText(it.Book), Chapter: it.Chapter.String(), Paragraph: it.Paragraph.String()}
			if lid, ok := a.store.ListByStudygoID(userFrom(r).ID, id); ok {
				sl.Imported, sl.ListID = true, lid
			}
			out.Lists = append(out.Lists, sl)
		}
		out.More = len(sec.Results) == searchPageSize && in.Offset+searchPageSize < 5000
	}
	writeJSON(w, http.StatusOK, out)
}
