package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Dict checks whether words exist, using Wiktionary as the dictionary: the
// English Wiktionary (which covers inflected forms of many languages and tags
// each entry with its language), then the Wiktionary in the word's own
// language. Results are cached in SQLite, so each word is looked up only once.
type Dict struct {
	store   *Store
	client  *http.Client
	enabled bool
	apiURL  func(wiki string) string // overridable in tests
}

func newDict(cfg Config, store *Store) *Dict {
	return &Dict{
		store:   store,
		client:  &http.Client{Timeout: 10 * time.Second},
		enabled: cfg.DictCheck,
		apiURL:  func(wiki string) string { return "https://" + wiki + ".wiktionary.org/w/api.php" },
	}
}

var (
	tokenRe = regexp.MustCompile(`[\p{L}][\p{L}'’\-]*`)
	langRe  = regexp.MustCompile(`^[a-z]{2,3}$`)
)

// tokens splits a vocabulary entry into the words worth checking. It skips
// single letters and abbreviations ("etw.", "Pl.").
func tokens(text string) []string {
	var out []string
	for _, loc := range tokenRe.FindAllStringIndex(text, -1) {
		tok := strings.TrimRight(text[loc[0]:loc[1]], "-'’")
		if utf8.RuneCountInString(tok) < 2 {
			continue
		}
		if loc[1] < len(text) && text[loc[1]] == '.' && utf8.RuneCountInString(tok) <= 4 {
			continue
		}
		out = append(out, tok)
	}
	return out
}

// candidates are the spellings under which a token may be listed.
func candidates(tok string) []string {
	tok = strings.ReplaceAll(tok, "’", "'")
	lower := strings.ToLower(tok)
	out := []string{tok}
	if lower != tok {
		out = append(out, lower)
	}
	r, size := utf8.DecodeRuneInString(lower)
	if title := string(unicode.ToUpper(r)) + lower[size:]; title != tok && title != lower {
		out = append(out, title)
	}
	return out
}

// Unknown returns, per input text, the tokens that are in no dictionary.
// ok is false when the dictionary could not be reached.
func (d *Dict) Unknown(ctx context.Context, lang string, texts []string) (unknown [][]string, ok bool) {
	unknown = make([][]string, len(texts))
	if !d.enabled || !langRe.MatchString(lang) {
		return unknown, false
	}
	perText := make([][]string, len(texts))
	need := map[string]bool{}
	for i, t := range texts {
		perText[i] = tokens(t)
		for _, tok := range perText[i] {
			for _, part := range append([]string{tok}, hyphenParts(tok)...) {
				for _, c := range candidates(part) {
					need[c] = true
				}
			}
		}
	}
	if len(need) == 0 {
		return unknown, true
	}
	all := make([]string, 0, len(need))
	for c := range need {
		all = append(all, c)
	}
	known, err := d.store.DictLookup(lang, all)
	if err != nil {
		return unknown, false
	}
	var missing []string
	for _, c := range all {
		if _, cached := known[c]; !cached {
			missing = append(missing, c)
		}
	}
	if len(missing) > 0 {
		fresh, err := d.fetch(ctx, lang, missing)
		if err != nil {
			log.Printf("dictionary check failed: %v", err)
			return unknown, false
		}
		d.store.DictStore(lang, fresh)
		for c, k := range fresh {
			known[c] = k
		}
	}
	isKnown := func(tok string) bool {
		for _, c := range candidates(tok) {
			if known[c] {
				return true
			}
		}
		return false
	}
	for i, toks := range perText {
		seen := map[string]bool{}
		for _, tok := range toks {
			if seen[tok] || isKnown(tok) {
				continue
			}
			if parts := hyphenParts(tok); len(parts) > 0 {
				allKnown := true
				for _, p := range parts {
					allKnown = allKnown && isKnown(p)
				}
				if allKnown {
					continue
				}
			}
			seen[tok] = true
			unknown[i] = append(unknown[i], tok)
		}
	}
	return unknown, true
}

func hyphenParts(tok string) []string {
	if !strings.Contains(tok, "-") {
		return nil
	}
	var out []string
	for _, p := range strings.Split(tok, "-") {
		if utf8.RuneCountInString(p) >= 2 {
			out = append(out, p)
		}
	}
	return out
}

// fetch decides which titles are real words of the language. A title counts
// when the English Wiktionary has an entry for it *in that language* (a bare
// page is not enough: "grune" exists there, but not as German), or when the
// language's own Wiktionary has a page for it.
func (d *Dict) fetch(ctx context.Context, lang string, titles []string) (map[string]bool, error) {
	result := make(map[string]bool, len(titles))
	for _, t := range titles {
		result[t] = false
	}
	if name, ok := langNames[lang]; ok {
		en, err := d.exists(ctx, "en", titles, []string{
			"Category:" + name + " lemmas", "Category:" + name + " non-lemma forms",
		})
		if err != nil {
			return nil, err
		}
		for t, k := range en {
			result[t] = k
		}
	}
	if lang != "en" {
		var retry []string
		for t, k := range result {
			if !k {
				retry = append(retry, t)
			}
		}
		if len(retry) > 0 {
			native, err := d.exists(ctx, lang, retry, nil)
			if err != nil {
				return nil, err
			}
			for t, k := range native {
				if k {
					result[t] = true
				}
			}
		}
	}
	return result, nil
}

// exists reports which titles have a page on the given Wiktionary. With
// categories set, a page only counts if it is in at least one of them.
func (d *Dict) exists(ctx context.Context, wiki string, titles, categories []string) (map[string]bool, error) {
	out := make(map[string]bool, len(titles))
	for start := 0; start < len(titles); start += 50 {
		chunk := titles[start:min(start+50, len(titles))]
		q := url.Values{
			"action": {"query"}, "format": {"json"}, "formatversion": {"2"},
			"titles": {strings.Join(chunk, "|")},
		}
		if len(categories) > 0 {
			q.Set("prop", "categories")
			q.Set("clcategories", strings.Join(categories, "|"))
			q.Set("cllimit", "max")
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, d.apiURL(wiki)+"?"+q.Encode(), nil)
		req.Header.Set("User-Agent", "Boice/1.0 (self-hosted vocabulary trainer)")
		res, err := d.client.Do(req)
		if err != nil {
			return nil, err
		}
		body, _ := io.ReadAll(io.LimitReader(res.Body, 2<<20))
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("wiktionary returned %s", res.Status)
		}
		var data struct {
			Query struct {
				Normalized []struct{ From, To string } `json:"normalized"`
				Pages      []struct {
					Title      string `json:"title"`
					Missing    bool   `json:"missing"`
					Invalid    bool   `json:"invalid"`
					Categories []any  `json:"categories"`
				} `json:"pages"`
			} `json:"query"`
		}
		if err := json.Unmarshal(body, &data); err != nil {
			return nil, err
		}
		found := map[string]bool{}
		for _, p := range data.Query.Pages {
			found[p.Title] = !p.Missing && !p.Invalid && (len(categories) == 0 || len(p.Categories) > 0)
		}
		norm := map[string]string{}
		for _, n := range data.Query.Normalized {
			norm[n.From] = n.To
		}
		for _, t := range chunk {
			title := t
			if to, ok := norm[t]; ok {
				title = to
			}
			out[t] = found[title]
		}
	}
	return out, nil
}
