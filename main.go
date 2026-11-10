// Boice — book + voice. A small self-hosted vocab recorder.
package main

import (
	"context"
	"embed"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

//go:embed all:web/dist
var webDist embed.FS

type Config struct {
	Addr    string
	DataDir string
	BaseURL string // public URL of this app, e.g. https://boice.example.com

	AuthMode      string // oidc | forward | none
	OIDCIssuer    string
	OIDCClientID  string
	OIDCSecret    string
	OIDCScopes    string
	ForwardHeader string
	SessionSecret string

	AIBaseURL string
	AIKey     string
	AIModel   string
	DictCheck bool
}

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func loadConfig() (Config, error) {
	c := Config{
		Addr:          env("ADDR", ":8080"),
		DataDir:       env("DATA_DIR", "./data"),
		BaseURL:       strings.TrimRight(env("BASE_URL", ""), "/"),
		AuthMode:      strings.ToLower(env("AUTH_MODE", "")),
		OIDCIssuer:    strings.TrimRight(env("OIDC_ISSUER", ""), "/"),
		OIDCClientID:  env("OIDC_CLIENT_ID", ""),
		OIDCSecret:    env("OIDC_CLIENT_SECRET", ""),
		OIDCScopes:    env("OIDC_SCOPES", "openid profile email"),
		ForwardHeader: env("FORWARD_AUTH_HEADER", "Remote-User"),
		SessionSecret: env("SESSION_SECRET", ""),
		AIBaseURL:     strings.TrimRight(env("HACKCLUB_AI_URL", "https://ai.hackclub.com/proxy/v1"), "/"),
		AIKey:         env("HACKCLUB_AI_KEY", ""),
		AIModel:       env("HACKCLUB_AI_MODEL", "google/gemini-3.8-flash"),
		DictCheck:     env("DICT_CHECK", "on") != "off",
	}
	if f := env("HACKCLUB_AI_KEY_FILE", ""); f != "" && c.AIKey == "" {
		b, err := os.ReadFile(f)
		if err != nil {
			return c, err
		}
		c.AIKey = strings.TrimSpace(string(b))
	}
	switch c.AuthMode {
	case "oidc":
		if c.OIDCIssuer == "" || c.OIDCClientID == "" || c.OIDCSecret == "" || c.BaseURL == "" {
			return c, errors.New("AUTH_MODE=oidc needs OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and BASE_URL")
		}
	case "forward", "none":
	default:
		return c, errors.New("set AUTH_MODE to oidc, forward or none")
	}
	return c, nil
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(cfg.DataDir, "audio"), 0o755); err != nil {
		log.Fatalf("data dir: %v", err)
	}
	store, err := openStore(filepath.Join(cfg.DataDir, "boice.db"))
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer store.Close()

	app, err := newApp(cfg, store)
	if err != nil {
		log.Fatalf("init: %v", err)
	}
	if cfg.AuthMode == "none" {
		log.Print("WARNING: AUTH_MODE=none — anyone who can reach this port has full access")
	}
	if cfg.AIKey == "" {
		log.Print("HACKCLUB_AI_KEY is not set — photo scanning is disabled")
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           app.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
	}
	go func() {
		log.Printf("boice listening on %s (auth: %s)", cfg.Addr, cfg.AuthMode)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

// spaHandler serves the embedded frontend and falls back to index.html for
// client-side routes.
func spaHandler() http.Handler {
	dist, err := fs.Sub(webDist, "web/dist")
	if err != nil {
		panic(err)
	}
	files := http.FileServerFS(dist)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		if f, err := dist.Open(p); err == nil {
			f.Close()
			if strings.HasPrefix(p, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			files.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFileFS(w, r, dist, "index.html")
	})
}
