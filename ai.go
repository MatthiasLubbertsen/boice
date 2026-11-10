package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

var langNames = map[string]string{
	"de": "German", "nl": "Dutch", "en": "English", "fr": "French", "es": "Spanish",
	"it": "Italian", "pt": "Portuguese", "la": "Latin", "el": "Greek", "sv": "Swedish",
	"da": "Danish", "no": "Norwegian", "pl": "Polish", "tr": "Turkish", "fy": "Frisian",
}

func langName(code string) string {
	if n, ok := langNames[code]; ok {
		return n
	}
	return code
}

// AI talks to the Hack Club AI proxy (OpenAI-compatible chat completions).
type AI struct {
	base, key, model string
	client           *http.Client
}

func newAI(cfg Config) *AI {
	return &AI{base: cfg.AIBaseURL, key: cfg.AIKey, model: cfg.AIModel, client: &http.Client{Timeout: 90 * time.Second}}
}

func (a *AI) Enabled() bool { return a.key != "" }

type aiError struct {
	Status int
	Msg    string
}

func (e *aiError) Error() string { return fmt.Sprintf("AI API %d: %s", e.Status, e.Msg) }

// userMessage turns an upstream failure into something worth showing a person.
func (e *aiError) userMessage() string {
	switch e.Status {
	case 401, 403:
		return "The Hack Club AI key was rejected. Check HACKCLUB_AI_KEY on the server."
	case 402:
		return "Today's Hack Club AI spending limit is used up. It resets at midnight UTC."
	case 429:
		return "Hack Club AI is rate-limiting requests. Wait a minute and try again."
	}
	return "The AI service returned an error (" + fmt.Sprint(e.Status) + "). Try again."
}

func (a *AI) chat(ctx context.Context, messages []map[string]any) (string, error) {
	send := func(jsonMode bool) (string, error) {
		body := map[string]any{"model": a.model, "messages": messages, "temperature": 0}
		if jsonMode {
			body["response_format"] = map[string]string{"type": "json_object"}
		}
		buf, _ := json.Marshal(body)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, a.base+"/chat/completions", bytes.NewReader(buf))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+a.key)
		res, err := a.client.Do(req)
		if err != nil {
			return "", err
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
		if res.StatusCode != http.StatusOK {
			return "", &aiError{res.StatusCode, truncate(string(raw), 300)}
		}
		var out struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(raw, &out); err != nil || len(out.Choices) == 0 {
			return "", errors.New("unexpected AI response")
		}
		return out.Choices[0].Message.Content, nil
	}
	text, err := send(true)
	var ae *aiError
	if errors.As(err, &ae) && ae.Status == http.StatusBadRequest {
		// Some models reject response_format; the prompt asks for JSON anyway.
		return send(false)
	}
	return text, err
}

// extractJSON pulls the outermost JSON object out of a model reply that may be
// wrapped in prose or code fences.
func extractJSON(s string, v any) error {
	i, j := strings.Index(s, "{"), strings.LastIndex(s, "}")
	if i < 0 || j <= i {
		return errors.New("no JSON in AI reply")
	}
	return json.Unmarshal([]byte(s[i:j+1]), v)
}

type Pair struct {
	A      string `json:"a"`
	B      string `json:"b"`
	Unsure bool   `json:"unsure"`
}

// firstForm keeps only the first of several forms written as "form | form".
// Books print "der Schüler | die Schülerinnen" (singular | plural); only the
// first one is wanted.
func firstForm(s string) string {
	if i := strings.IndexAny(s, "|¦│"); i >= 0 {
		s = s[:i]
	}
	return cleanText(s)
}

const defPrompt = `This is a photo of a glossary from a schoolbook: terms, each followed by its definition.
The photo may be rotated or taken at an angle; read it anyway. Terms are usually bold or coloured and
directly followed by their definition, which may wrap over several lines. Ignore running page text
that is not a term with a definition (section headings such as "§4.2 Een verdeelde wereld", page
headers, exercises, tips).

Extract every term with its definition, in reading order, and reply with only this JSON:
{"page": <printed page number or null>, "pairs": [{"a": "<term>", "b": "<definition>", "unsure": false}]}

Rules:
- Transcribe exactly what is printed, in the original language. Keep capital letters and punctuation.
- "a" is only the term, "b" is the whole definition joined into one string. Fix hyphenation from line breaks.
- Never invent or complete a definition. Skip terms without a definition.
- Set "unsure": true when text is blurry, cut off or you had to guess.
- If there are no terms, return {"page": null, "pairs": []}.`

// Extract reads the entries out of a photo: word pairs of a vocabulary table,
// or terms with definitions when kind is "def".
func (a *AI) Extract(ctx context.Context, img []byte, mime, langA, langB, kind string) (pairs []Pair, page int, err error) {
	prompt := defPrompt
	if kind != "def" {
		prompt = vocabPrompt(langA, langB)
	}
	return a.extract(ctx, img, mime, prompt, kind)
}

func vocabPrompt(langA, langB string) string {
	return fmt.Sprintf(`This is a photo of a vocabulary list or table from a schoolbook.
Column/language A is %[1]s, column/language B is %[2]s.

Extract every vocabulary pair, top to bottom, and reply with only this JSON:
{"page": <printed page number or null>, "pairs": [{"a": "<%[1]s>", "b": "<%[2]s>", "unsure": false}]}

Rules:
- Transcribe exactly what is printed. Keep articles, plural notes, brackets, capital letters, umlauts and ß.
- Some cells list several forms separated by "|" (for example "der Schüler | die Schülerinnen"). Write only the first form.
- Never translate or fill in a missing side yourself. Skip rows where one side is missing.
- If the columns are in the other order on the page, still put %[1]s in "a" and %[2]s in "b".
- Join a cell that wraps over several lines into one string. Fix hyphenation from line breaks.
- Ignore headings, exercise numbers, example sentences outside the table and handwriting.
- Set "unsure": true when a cell is blurry, cut off or you had to guess.
- If there are no vocabulary pairs, return {"page": null, "pairs": []}.`, langName(langA), langName(langB))
}

func (a *AI) extract(ctx context.Context, img []byte, mime, prompt, kind string) (pairs []Pair, page int, err error) {
	reply, err := a.chat(ctx, []map[string]any{{
		"role": "user",
		"content": []map[string]any{
			{"type": "text", "text": prompt},
			{"type": "image_url", "image_url": map[string]string{
				"url": "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(img),
			}},
		},
	}})
	if err != nil {
		return nil, 0, err
	}
	var out struct {
		Page  *float64 `json:"page"`
		Pairs []Pair   `json:"pairs"`
	}
	if err := extractJSON(reply, &out); err != nil {
		return nil, 0, err
	}
	for _, p := range out.Pairs {
		p.A, p.B = cleanText(p.A), cleanText(p.B)
		if kind != "def" {
			p.A, p.B = firstForm(p.A), firstForm(p.B)
		}
		if p.A != "" && p.B != "" {
			pairs = append(pairs, p)
		}
	}
	if out.Page != nil && *out.Page > 0 && *out.Page < 100000 {
		page = int(*out.Page)
	}
	return pairs, page, nil
}

type fixRequest struct {
	I       int      `json:"i"`
	Lang    string   `json:"language"`
	Text    string   `json:"text"`
	Unknown []string `json:"not_in_dictionary"`
	Other   string   `json:"translation"`
}

// SuggestFixes asks the model for a second opinion on entries whose words are
// not in the dictionary. It returns a corrected text per index, or "" when the
// model considers the entry fine as it is.
func (a *AI) SuggestFixes(ctx context.Context, items []fixRequest) (map[int]string, error) {
	in, _ := json.Marshal(items)
	prompt := `These vocabulary entries were read from a schoolbook photo by OCR. For each one, some words
were not found in a dictionary. Decide whether "text" contains a reading or spelling mistake (wrong or
missing umlaut, swapped letters, l/I/1 confusion, merged or split words...). The "translation" shows what
the entry should mean. Rare words, compounds, names and abbreviations are usually fine: leave them alone.

Reply with only this JSON: {"results": [{"i": <index>, "fix": "<full corrected text>" or null}]}
Use null when the text is correct. Never rephrase, only repair mistakes.

Entries:
` + string(in)
	reply, err := a.chat(ctx, []map[string]any{{"role": "user", "content": prompt}})
	if err != nil {
		return nil, err
	}
	var out struct {
		Results []struct {
			I   int     `json:"i"`
			Fix *string `json:"fix"`
		} `json:"results"`
	}
	if err := extractJSON(reply, &out); err != nil {
		return nil, err
	}
	fixes := map[int]string{}
	for _, r := range out.Results {
		fixes[r.I] = ""
		if r.Fix != nil {
			fixes[r.I] = cleanText(*r.Fix)
		}
	}
	return fixes, nil
}

func cleanText(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
