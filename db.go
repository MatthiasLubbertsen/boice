package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS lists (
  id          INTEGER PRIMARY KEY,
  owner       TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  lang_a      TEXT    NOT NULL DEFAULT 'de',
  lang_b      TEXT    NOT NULL DEFAULT 'nl',
  record_mode TEXT    NOT NULL DEFAULT 'a',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lists_owner ON lists(owner);

CREATE TABLE IF NOT EXISTS words (
  id          INTEGER PRIMARY KEY,
  list_id     INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  pos         INTEGER NOT NULL,
  term        TEXT    NOT NULL,
  translation TEXT    NOT NULL,
  page        INTEGER NOT NULL DEFAULT 0,
  note        TEXT    NOT NULL DEFAULT '',
  flagged     INTEGER NOT NULL DEFAULT 0,
  issues      TEXT    NOT NULL DEFAULT '[]',
  audio_a     INTEGER NOT NULL DEFAULT 0,
  audio_b     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS words_list ON words(list_id, pos);

CREATE TABLE IF NOT EXISTS subjects (
  id         INTEGER PRIMARY KEY,
  owner      TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS subjects_owner ON subjects(owner);

CREATE TABLE IF NOT EXISTS scans (
  id           INTEGER PRIMARY KEY,
  list_id      INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'running',
  page         INTEGER NOT NULL DEFAULT 0,
  words        TEXT    NOT NULL DEFAULT '[]',
  dict_checked INTEGER NOT NULL DEFAULT 0,
  error        TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scans_list ON scans(list_id);

CREATE TABLE IF NOT EXISTS dict_cache (
  lang  TEXT NOT NULL,
  word  TEXT NOT NULL,
  known INTEGER NOT NULL,
  PRIMARY KEY (lang, word)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
`

var errNotFound = errors.New("not found")

// Issue is a possible OCR/spelling problem found by the dictionary check.
type Issue struct {
	Side       string `json:"side"` // "a" or "b"
	Token      string `json:"token"`
	Suggestion string `json:"suggestion,omitempty"`
}

type List struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	LangA      string `json:"langA"`
	LangB      string `json:"langB"`
	RecordMode string `json:"recordMode"`
	Kind       string `json:"kind"` // "lang" (word pairs) or "def" (term + definition)
	SubjectID  *int64 `json:"subjectId"`
	CreatedAt  int64  `json:"createdAt"`
	UpdatedAt  int64  `json:"updatedAt"`
	WordCount  int    `json:"wordCount"`
	Recorded   int    `json:"recorded"`
	Flagged    int    `json:"flagged"`
	ScansReady int    `json:"scansReady"`
	ScansBusy  int    `json:"scansBusy"`
}

type Subject struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	ListCount int    `json:"listCount"`
}

type Word struct {
	ID          int64   `json:"id"`
	ListID      int64   `json:"listId"`
	Pos         int     `json:"pos"`
	Term        string  `json:"term"`
	Translation string  `json:"translation"`
	Page        int     `json:"page"`
	Note        string  `json:"note"`
	Flagged     bool    `json:"flagged"`
	Issues      []Issue `json:"issues"`
	AudioA      int     `json:"audioA"` // duration in ms, 0 = not recorded
	AudioB      int     `json:"audioB"`
	UpdatedAt   int64   `json:"updatedAt"`
}

type Store struct{ db *sql.DB }

func openStore(path string) (*Store, error) {
	q := url.Values{}
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "synchronous(NORMAL)")
	q.Add("_pragma", "cache_size(-2000)") // 2 MB page cache
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // one connection: tiny memory use, no lock juggling
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	// A scan that was running when the server stopped will never finish.
	_, _ = db.Exec(`UPDATE scans SET status='error', error='The server restarted while reading this photo. Scan it again.' WHERE status='running'`)
	return &Store{db}, nil
}

// migrate adds columns that older databases lack.
func migrate(db *sql.DB) error {
	have := map[string]bool{}
	rows, err := db.Query(`SELECT name FROM pragma_table_info('lists')`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var n string
		_ = rows.Scan(&n)
		have[n] = true
	}
	rows.Close()
	if !have["kind"] {
		if _, err := db.Exec(`ALTER TABLE lists ADD COLUMN kind TEXT NOT NULL DEFAULT 'lang'`); err != nil {
			return err
		}
	}
	if !have["subject_id"] {
		if _, err := db.Exec(`ALTER TABLE lists ADD COLUMN subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL`); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) Close() error { return s.db.Close() }

func now() int64 { return time.Now().Unix() }

// recordedExpr counts a word as recorded when every side the list asks for has audio.
const recordedExpr = `CASE l.record_mode
  WHEN 'a' THEN w.audio_a > 0
  WHEN 'b' THEN w.audio_b > 0
  ELSE w.audio_a > 0 AND w.audio_b > 0 END`

const listSelect = `SELECT l.id, l.name, l.lang_a, l.lang_b, l.record_mode, l.kind, l.subject_id, l.created_at, l.updated_at,
  COUNT(w.id), COALESCE(SUM(` + recordedExpr + `), 0), COALESCE(SUM(w.flagged), 0),
  (SELECT COUNT(*) FROM scans s WHERE s.list_id = l.id AND s.status = 'done'),
  (SELECT COUNT(*) FROM scans s WHERE s.list_id = l.id AND s.status = 'running')
  FROM lists l LEFT JOIN words w ON w.list_id = l.id `

func scanList(row interface{ Scan(...any) error }) (List, error) {
	var l List
	err := row.Scan(&l.ID, &l.Name, &l.LangA, &l.LangB, &l.RecordMode, &l.Kind, &l.SubjectID, &l.CreatedAt, &l.UpdatedAt,
		&l.WordCount, &l.Recorded, &l.Flagged, &l.ScansReady, &l.ScansBusy)
	return l, err
}

func (s *Store) Lists(owner string) ([]List, error) {
	rows, err := s.db.Query(listSelect+`WHERE l.owner = ? GROUP BY l.id ORDER BY l.updated_at DESC`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []List{}
	for rows.Next() {
		l, err := scanList(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func (s *Store) List(owner string, id int64) (List, error) {
	l, err := scanList(s.db.QueryRow(listSelect+`WHERE l.owner = ? AND l.id = ? GROUP BY l.id`, owner, id))
	if errors.Is(err, sql.ErrNoRows) {
		return l, errNotFound
	}
	return l, err
}

func (s *Store) CreateList(owner, name, langA, langB, mode, kind string, subjectID *int64) (int64, error) {
	t := now()
	res, err := s.db.Exec(`INSERT INTO lists (owner, name, lang_a, lang_b, record_mode, kind, subject_id, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?)`, owner, name, langA, langB, mode, kind, subjectID, t, t)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) UpdateList(id int64, name, langA, langB, mode, kind string, subjectID *int64) error {
	_, err := s.db.Exec(`UPDATE lists SET name=?, lang_a=?, lang_b=?, record_mode=?, kind=?, subject_id=?, updated_at=? WHERE id=?`,
		name, langA, langB, mode, kind, subjectID, now(), id)
	return err
}

func (s *Store) DeleteList(id int64) error {
	_, err := s.db.Exec(`DELETE FROM lists WHERE id=?`, id)
	return err
}

func (s *Store) touchList(id int64) {
	_, _ = s.db.Exec(`UPDATE lists SET updated_at=? WHERE id=?`, now(), id)
}

const wordSelect = `SELECT w.id, w.list_id, w.pos, w.term, w.translation, w.page, w.note, w.flagged,
  w.issues, w.audio_a, w.audio_b, w.updated_at FROM words w `

func scanWord(row interface{ Scan(...any) error }) (Word, error) {
	var w Word
	var issues string
	err := row.Scan(&w.ID, &w.ListID, &w.Pos, &w.Term, &w.Translation, &w.Page, &w.Note, &w.Flagged,
		&issues, &w.AudioA, &w.AudioB, &w.UpdatedAt)
	if err != nil {
		return w, err
	}
	if json.Unmarshal([]byte(issues), &w.Issues) != nil || w.Issues == nil {
		w.Issues = []Issue{}
	}
	return w, nil
}

func (s *Store) Words(listID int64) ([]Word, error) {
	rows, err := s.db.Query(wordSelect+`WHERE w.list_id = ? ORDER BY w.pos, w.id`, listID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Word{}
	for rows.Next() {
		w, err := scanWord(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// Word returns a word only if it belongs to a list owned by owner.
func (s *Store) Word(owner string, id int64) (Word, error) {
	w, err := scanWord(s.db.QueryRow(wordSelect+
		`JOIN lists l ON l.id = w.list_id WHERE w.id = ? AND l.owner = ?`, id, owner))
	if errors.Is(err, sql.ErrNoRows) {
		return w, errNotFound
	}
	return w, err
}

func issuesJSON(i []Issue) string {
	if len(i) == 0 {
		return "[]"
	}
	b, _ := json.Marshal(i)
	return string(b)
}

func (s *Store) AddWords(listID int64, words []Word) ([]Word, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var pos int
	if err := tx.QueryRow(`SELECT COALESCE(MAX(pos), 0) FROM words WHERE list_id=?`, listID).Scan(&pos); err != nil {
		return nil, err
	}
	t := now()
	out := make([]Word, 0, len(words))
	for _, w := range words {
		pos++
		res, err := tx.Exec(`INSERT INTO words (list_id, pos, term, translation, page, note, flagged, issues, updated_at)
			VALUES (?,?,?,?,?,?,?,?,?)`, listID, pos, w.Term, w.Translation, w.Page, w.Note, w.Flagged, issuesJSON(w.Issues), t)
		if err != nil {
			return nil, err
		}
		w.ID, _ = res.LastInsertId()
		w.ListID, w.Pos, w.UpdatedAt = listID, pos, t
		if w.Issues == nil {
			w.Issues = []Issue{}
		}
		out = append(out, w)
	}
	if _, err := tx.Exec(`UPDATE lists SET updated_at=? WHERE id=?`, t, listID); err != nil {
		return nil, err
	}
	return out, tx.Commit()
}

func (s *Store) UpdateWord(w Word) error {
	_, err := s.db.Exec(`UPDATE words SET term=?, translation=?, page=?, note=?, flagged=?, issues=?, updated_at=? WHERE id=?`,
		w.Term, w.Translation, w.Page, w.Note, w.Flagged, issuesJSON(w.Issues), now(), w.ID)
	s.touchList(w.ListID)
	return err
}

func (s *Store) SetIssues(id int64, issues []Issue) error {
	_, err := s.db.Exec(`UPDATE words SET issues=? WHERE id=?`, issuesJSON(issues), id)
	return err
}

func (s *Store) SetAudio(w Word, side string, ms int) error {
	col := "audio_a"
	if side == "b" {
		col = "audio_b"
	}
	_, err := s.db.Exec(`UPDATE words SET `+col+`=?, updated_at=? WHERE id=?`, ms, now(), w.ID)
	s.touchList(w.ListID)
	return err
}

func (s *Store) DeleteWords(listID int64, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	args := make([]any, 0, len(ids)+1)
	args = append(args, listID)
	for _, id := range ids {
		args = append(args, id)
	}
	_, err := s.db.Exec(`DELETE FROM words WHERE list_id=? AND id IN (?`+strings.Repeat(",?", len(ids)-1)+`)`, args...)
	s.touchList(listID)
	return err
}

// Dictionary cache.

func (s *Store) DictLookup(lang string, words []string) (map[string]bool, error) {
	out := map[string]bool{}
	for start := 0; start < len(words); start += 200 {
		chunk := words[start:min(start+200, len(words))]
		args := []any{lang}
		for _, w := range chunk {
			args = append(args, w)
		}
		rows, err := s.db.Query(`SELECT word, known FROM dict_cache WHERE lang=? AND word IN (?`+
			strings.Repeat(",?", len(chunk)-1)+`)`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var w string
			var k bool
			if err := rows.Scan(&w, &k); err != nil {
				rows.Close()
				return nil, err
			}
			out[w] = k
		}
		rows.Close()
	}
	return out, nil
}

func (s *Store) DictStore(lang string, known map[string]bool) {
	tx, err := s.db.Begin()
	if err != nil {
		return
	}
	for w, k := range known {
		_, _ = tx.Exec(`INSERT OR REPLACE INTO dict_cache (lang, word, known) VALUES (?,?,?)`, lang, w, k)
	}
	_ = tx.Commit()
}

func (s *Store) Meta(key string) string {
	var v string
	_ = s.db.QueryRow(`SELECT value FROM meta WHERE key=?`, key).Scan(&v)
	return v
}

func (s *Store) SetMeta(key, value string) error {
	_, err := s.db.Exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)`, key, value)
	return err
}

// Subjects.

func (s *Store) Subjects(owner string) ([]Subject, error) {
	rows, err := s.db.Query(`SELECT s.id, s.name, COUNT(l.id) FROM subjects s
		LEFT JOIN lists l ON l.subject_id = s.id WHERE s.owner = ? GROUP BY s.id ORDER BY s.name COLLATE NOCASE`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Subject{}
	for rows.Next() {
		var x Subject
		if err := rows.Scan(&x.ID, &x.Name, &x.ListCount); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func (s *Store) Subject(owner string, id int64) (Subject, error) {
	var x Subject
	err := s.db.QueryRow(`SELECT s.id, s.name, COUNT(l.id) FROM subjects s
		LEFT JOIN lists l ON l.subject_id = s.id WHERE s.owner = ? AND s.id = ? GROUP BY s.id`, owner, id).
		Scan(&x.ID, &x.Name, &x.ListCount)
	if errors.Is(err, sql.ErrNoRows) {
		return x, errNotFound
	}
	return x, err
}

func (s *Store) CreateSubject(owner, name string) (int64, error) {
	res, err := s.db.Exec(`INSERT INTO subjects (owner, name, created_at) VALUES (?,?,?)`, owner, name, now())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) RenameSubject(id int64, name string) error {
	_, err := s.db.Exec(`UPDATE subjects SET name=? WHERE id=?`, name, id)
	return err
}

// DeleteSubject removes the subject; its lists stay, just unlinked.
func (s *Store) DeleteSubject(id int64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE lists SET subject_id=NULL WHERE subject_id=?`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM subjects WHERE id=?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// Scans: photos read in the background.

type Scan struct {
	ID          int64         `json:"id"`
	ListID      int64         `json:"listId"`
	Status      string        `json:"status"` // running | done | error
	Page        int           `json:"page"`
	Words       []scannedWord `json:"words"`
	DictChecked bool          `json:"dictChecked"`
	Error       string        `json:"error"`
	CreatedAt   int64         `json:"createdAt"`
}

func (s *Store) CreateScan(listID int64) (int64, error) {
	res, err := s.db.Exec(`INSERT INTO scans (list_id, created_at) VALUES (?,?)`, listID, now())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) FinishScan(id int64, page int, words []scannedWord, dictChecked bool, errMsg string) {
	status := "done"
	if errMsg != "" {
		status = "error"
	}
	b, _ := json.Marshal(words)
	_, _ = s.db.Exec(`UPDATE scans SET status=?, page=?, words=?, dict_checked=?, error=? WHERE id=?`,
		status, page, string(b), dictChecked, errMsg, id)
}

func scanScan(row interface{ Scan(...any) error }) (Scan, error) {
	var sc Scan
	var words string
	if err := row.Scan(&sc.ID, &sc.ListID, &sc.Status, &sc.Page, &words, &sc.DictChecked, &sc.Error, &sc.CreatedAt); err != nil {
		return sc, err
	}
	if json.Unmarshal([]byte(words), &sc.Words) != nil || sc.Words == nil {
		sc.Words = []scannedWord{}
	}
	return sc, nil
}

const scanSelect = `SELECT sc.id, sc.list_id, sc.status, sc.page, sc.words, sc.dict_checked, sc.error, sc.created_at FROM scans sc `

func (s *Store) Scans(listID int64) ([]Scan, error) {
	rows, err := s.db.Query(scanSelect+`WHERE sc.list_id = ? ORDER BY sc.id`, listID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Scan{}
	for rows.Next() {
		sc, err := scanScan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sc)
	}
	return out, rows.Err()
}

func (s *Store) Scan(owner string, id int64) (Scan, error) {
	sc, err := scanScan(s.db.QueryRow(scanSelect+`JOIN lists l ON l.id = sc.list_id WHERE sc.id = ? AND l.owner = ?`, id, owner))
	if errors.Is(err, sql.ErrNoRows) {
		return sc, errNotFound
	}
	return sc, err
}

func (s *Store) DeleteScan(id int64) error {
	_, err := s.db.Exec(`DELETE FROM scans WHERE id=?`, id)
	return err
}
