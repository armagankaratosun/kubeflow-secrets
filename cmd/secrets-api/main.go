// Package main implements the kubeflow-secrets API server.
package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"time"
)

//go:embed static/*
var staticFS embed.FS

const readHeaderTimeout = 10 * time.Second

func main() {
	addr := envOrDefault("LISTEN_ADDR", ":8080")
	userHeader := envOrDefault("USER_HEADER", "kubeflow-userid")
	groupsHeader := envOrDefault("GROUPS_HEADER", "kubeflow-groups")

	cfg, err := buildKubeConfig()
	if err != nil {
		log.Fatalf("build kube config: %v", err)
	}

	srv, err := newServer(cfg, userHeader, groupsHeader)
	if err != nil {
		log.Fatalf("create server: %v", err)
	}

	routes := http.NewServeMux()
	routes.HandleFunc("/healthz", srv.handleHealthz)
	routes.HandleFunc("/api/namespaces", srv.withJSON(srv.handleNamespaces))
	routes.HandleFunc("/api/secrets", srv.withJSON(srv.handleSecrets))
	routes.HandleFunc("/api/secrets/", srv.withJSON(srv.handleSecretByName))

	staticSub, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatalf("prepare embedded static assets: %v", err)
	}
	routes.Handle("/", http.FileServer(http.FS(staticSub)))

	log.Printf("starting secrets API on %s", addr)
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           srv.withLogging(routes),
		ReadHeaderTimeout: readHeaderTimeout,
	}

	if err := httpServer.ListenAndServe(); err != nil {
		log.Fatalf("listen and serve: %v", err)
	}
}
