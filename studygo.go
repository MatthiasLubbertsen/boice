package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
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
	req.Header.Set("X-Auth-Token", c.token)
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
	err := c.get(ctx, fmt.Sprintf("lists/%d/data", id), &d)
	return d, err
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
	token := cleanToken(in.Token)
	if token == "" || len(in.IDs) == 0 {
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

// importStudygo turns one Studygo list into a Boice list. Two different
// languages make a word list; the same language on both sides (a history
// glossary, say) makes a terms-and-definitions list.
func (a *App) importStudygo(owner string, studygoID int64, d studygoData) (listID int64, words int, err error) {
	langA, langB := "de", "nl"
	if len(d.Locales) > 0 {
		langA = d.Locales[0].Language.Code
		langB = langA
	}
	if len(d.Locales) > 1 {
		langB = d.Locales[1].Language.Code
	}
	if !validLang(langA) || !validLang(langB) {
		return 0, 0, fmt.Errorf("unusable language codes %q/%q", langA, langB)
	}
	kind := "lang"
	if langA == langB {
		kind = "def"
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
	var batch []Word
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
		batch = append(batch, Word{Term: limitRunes(term, 300), Translation: limitRunes(tr, 300)})
	}
	if len(batch) > 5000 {
		batch = batch[:5000]
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
