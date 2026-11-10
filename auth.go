package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	sessionCookie = "boice_session"
	flowCookie    = "boice_login"
	sessionTTL    = 30 * 24 * time.Hour
)

type User struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ctxKey struct{}

func userFrom(r *http.Request) User {
	u, _ := r.Context().Value(ctxKey{}).(User)
	return u
}

type Auth struct {
	cfg    Config
	secret []byte
	client *http.Client

	mu   sync.Mutex
	disc *oidcDiscovery
}

type oidcDiscovery struct {
	AuthURL     string   `json:"authorization_endpoint"`
	TokenURL    string   `json:"token_endpoint"`
	UserinfoURL string   `json:"userinfo_endpoint"`
	PKCE        []string `json:"code_challenge_methods_supported"`
}

func newAuth(cfg Config, store *Store) (*Auth, error) {
	secret := cfg.SessionSecret
	if secret == "" {
		// Persist a generated secret so sessions survive restarts.
		secret = store.Meta("session_secret")
		if secret == "" {
			secret = randomToken(32)
			if err := store.SetMeta("session_secret", secret); err != nil {
				return nil, err
			}
		}
	}
	return &Auth{cfg: cfg, secret: []byte(secret), client: &http.Client{Timeout: 15 * time.Second}}, nil
}

func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// sign and verify produce tamper-proof cookie values: base64(json).base64(hmac).
func (a *Auth) sign(v any) string {
	payload, _ := json.Marshal(v)
	p := base64.RawURLEncoding.EncodeToString(payload)
	m := hmac.New(sha256.New, a.secret)
	m.Write([]byte(p))
	return p + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (a *Auth) verify(s string, v any) bool {
	p, sig, ok := strings.Cut(s, ".")
	if !ok {
		return false
	}
	got, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil {
		return false
	}
	m := hmac.New(sha256.New, a.secret)
	m.Write([]byte(p))
	if !hmac.Equal(got, m.Sum(nil)) {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(p)
	return err == nil && json.Unmarshal(payload, v) == nil
}

type sessionData struct {
	User User  `json:"u"`
	Exp  int64 `json:"e"`
}

type flowData struct {
	State    string `json:"s"`
	Verifier string `json:"v"`
	Next     string `json:"n"`
	Exp      int64  `json:"e"`
}

func (a *Auth) secure() bool { return strings.HasPrefix(a.cfg.BaseURL, "https://") }

func (a *Auth) setCookie(w http.ResponseWriter, name, value string, ttl time.Duration) {
	c := &http.Cookie{Name: name, Value: value, Path: "/", HttpOnly: true, Secure: a.secure(), SameSite: http.SameSiteLaxMode}
	if ttl <= 0 {
		c.MaxAge = -1
	} else {
		c.MaxAge = int(ttl.Seconds())
	}
	http.SetCookie(w, c)
}

// currentUser resolves the user for a request according to the auth mode.
func (a *Auth) currentUser(r *http.Request) (User, bool) {
	switch a.cfg.AuthMode {
	case "none":
		return User{ID: "local", Name: "Local user"}, true
	case "forward":
		// Trusts the reverse proxy: the app must not be reachable around it.
		id := strings.TrimSpace(r.Header.Get(a.cfg.ForwardHeader))
		if id == "" {
			return User{}, false
		}
		name := strings.TrimSpace(r.Header.Get("Remote-Name"))
		if name == "" {
			name = id
		}
		return User{ID: strings.ToLower(id), Name: name}, true
	default:
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			return User{}, false
		}
		var s sessionData
		if !a.verify(c.Value, &s) || s.Exp < time.Now().Unix() || s.User.ID == "" {
			return User{}, false
		}
		return s.User, true
	}
}

// require guards API routes: a signed-in user, plus a custom header on writes
// so other sites cannot forge requests with the user's cookies.
func (a *Auth) require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, ok := a.currentUser(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]any{
				"error": "not signed in", "login": a.cfg.AuthMode == "oidc",
			})
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("X-Boice") == "" {
			writeErr(w, http.StatusForbidden, "missing X-Boice header")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, u)))
	})
}

func (a *Auth) discovery(ctx context.Context) (*oidcDiscovery, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.disc != nil {
		return a.disc, nil
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, a.cfg.OIDCIssuer+"/.well-known/openid-configuration", nil)
	res, err := a.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("discovery returned %s", res.Status)
	}
	var d oidcDiscovery
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&d); err != nil {
		return nil, err
	}
	if d.AuthURL == "" || d.TokenURL == "" || d.UserinfoURL == "" {
		return nil, errors.New("discovery document is missing endpoints")
	}
	a.disc = &d
	return a.disc, nil
}

func (a *Auth) redirectURI() string { return a.cfg.BaseURL + "/auth/callback" }

func safeNext(n string) string {
	if !strings.HasPrefix(n, "/") || strings.HasPrefix(n, "//") || strings.ContainsAny(n, "\\\r\n") {
		return "/"
	}
	return n
}

func (a *Auth) handleLogin(w http.ResponseWriter, r *http.Request) {
	if a.cfg.AuthMode != "oidc" {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	d, err := a.discovery(r.Context())
	if err != nil {
		log.Printf("oidc discovery: %v", err)
		http.Error(w, "The login provider is unreachable. Try again in a moment.", http.StatusBadGateway)
		return
	}
	flow := flowData{
		State:    randomToken(18),
		Verifier: randomToken(32),
		Next:     safeNext(r.URL.Query().Get("next")),
		Exp:      time.Now().Add(10 * time.Minute).Unix(),
	}
	a.setCookie(w, flowCookie, a.sign(flow), 10*time.Minute)

	q := url.Values{
		"response_type": {"code"},
		"client_id":     {a.cfg.OIDCClientID},
		"redirect_uri":  {a.redirectURI()},
		"scope":         {a.cfg.OIDCScopes},
		"state":         {flow.State},
	}
	if slices.Contains(d.PKCE, "S256") {
		sum := sha256.Sum256([]byte(flow.Verifier))
		q.Set("code_challenge", base64.RawURLEncoding.EncodeToString(sum[:]))
		q.Set("code_challenge_method", "S256")
	}
	sep := "?"
	if strings.Contains(d.AuthURL, "?") {
		sep = "&"
	}
	http.Redirect(w, r, d.AuthURL+sep+q.Encode(), http.StatusFound)
}

func (a *Auth) handleCallback(w http.ResponseWriter, r *http.Request) {
	fail := func(msg string, err error) {
		log.Printf("oidc callback: %s: %v", msg, err)
		http.Error(w, "Sign-in failed: "+msg+". Go back and try again.", http.StatusBadRequest)
	}
	c, err := r.Cookie(flowCookie)
	var flow flowData
	if err != nil || !a.verify(c.Value, &flow) || flow.Exp < time.Now().Unix() {
		fail("the login attempt expired", err)
		return
	}
	a.setCookie(w, flowCookie, "", 0)
	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		fail("the provider said "+e, errors.New(q.Get("error_description")))
		return
	}
	if q.Get("state") == "" || !hmac.Equal([]byte(q.Get("state")), []byte(flow.State)) {
		fail("state mismatch", nil)
		return
	}
	d, err := a.discovery(r.Context())
	if err != nil {
		fail("provider unreachable", err)
		return
	}

	form := url.Values{
		"grant_type":   {"authorization_code"},
		"code":         {q.Get("code")},
		"redirect_uri": {a.redirectURI()},
	}
	if slices.Contains(d.PKCE, "S256") {
		form.Set("code_verifier", flow.Verifier)
	}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, d.TokenURL, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.SetBasicAuth(url.QueryEscape(a.cfg.OIDCClientID), url.QueryEscape(a.cfg.OIDCSecret))
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	if err := a.doJSON(req, &tok); err != nil || tok.AccessToken == "" {
		fail("could not exchange the login code", err)
		return
	}

	// The token came straight from the provider over TLS, so the userinfo
	// endpoint is an authoritative source for who signed in.
	req, _ = http.NewRequestWithContext(r.Context(), http.MethodGet, d.UserinfoURL, nil)
	req.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	var info struct {
		Sub      string `json:"sub"`
		Username string `json:"preferred_username"`
		Email    string `json:"email"`
		Name     string `json:"name"`
	}
	if err := a.doJSON(req, &info); err != nil {
		fail("could not load your profile", err)
		return
	}
	// Tinyauth's sub changes when the client id changes, so prefer the username.
	id := cmpFirst(info.Username, info.Email, info.Sub)
	if id == "" {
		fail("the provider returned no user id", nil)
		return
	}
	u := User{ID: strings.ToLower(id), Name: cmpFirst(info.Name, info.Username, info.Email, id)}
	a.setCookie(w, sessionCookie, a.sign(sessionData{User: u, Exp: time.Now().Add(sessionTTL).Unix()}), sessionTTL)
	http.Redirect(w, r, safeNext(flow.Next), http.StatusFound)
}

func (a *Auth) handleLogout(w http.ResponseWriter, r *http.Request) {
	a.setCookie(w, sessionCookie, "", 0)
	http.Redirect(w, r, "/", http.StatusFound)
}

func (a *Auth) doJSON(req *http.Request, v any) error {
	res, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("%s: %s", res.Status, truncate(string(body), 200))
	}
	return json.Unmarshal(body, v)
}

func cmpFirst(vals ...string) string {
	for _, v := range vals {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
