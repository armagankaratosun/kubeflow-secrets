package main

import (
	"context"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

//go:embed static/*
var staticFS embed.FS

type server struct {
	baseConfig     *rest.Config
	adminDynamic   dynamic.Interface
	userHeader     string
	groupsHeader   string
	profileGVR     schema.GroupVersionResource
	allowedTypes   map[corev1.SecretType]struct{}
	blockedTypes   map[corev1.SecretType]struct{}
	maxPayloadSize int64
}

type errorResponse struct {
	Error string `json:"error"`
}

type namespaceResponse struct {
	Namespaces []string `json:"namespaces"`
}

type secretListItem struct {
	Name              string            `json:"name"`
	Namespace         string            `json:"namespace"`
	Type              corev1.SecretType `json:"type"`
	CreationTimestamp time.Time         `json:"creationTimestamp"`
}

type secretListResponse struct {
	Items []secretListItem `json:"items"`
}

type createSecretRequest struct {
	Namespace   string            `json:"namespace"`
	Name        string            `json:"name"`
	Type        corev1.SecretType `json:"type"`
	Data        map[string]string `json:"data"`
	StringData  map[string]string `json:"stringData"`
	Labels      map[string]string `json:"labels"`
	Annotations map[string]string `json:"annotations"`
}

type createSecretResponse struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace"`
	Type      corev1.SecretType `json:"type"`
}

var (
	errProfileNotFound = errors.New("no profile namespace found for user")
	errMultipleProfile = errors.New("multiple profile namespaces found for user")
)

func main() {
	addr := envOrDefault("LISTEN_ADDR", ":8080")
	userHeader := envOrDefault("USER_HEADER", "kubeflow-userid")
	groupsHeader := envOrDefault("GROUPS_HEADER", "kubeflow-groups")

	cfg, err := buildKubeConfig()
	if err != nil {
		log.Fatalf("build kube config: %v", err)
	}

	adminDynamic, err := dynamic.NewForConfig(cfg)
	if err != nil {
		log.Fatalf("create dynamic client: %v", err)
	}

	s := &server{
		baseConfig:   cfg,
		adminDynamic: adminDynamic,
		userHeader:   strings.ToLower(userHeader),
		groupsHeader: strings.ToLower(groupsHeader),
		profileGVR: schema.GroupVersionResource{
			Group:    "kubeflow.org",
			Version:  "v1",
			Resource: "profiles",
		},
		allowedTypes: map[corev1.SecretType]struct{}{
			corev1.SecretTypeOpaque:           {},
			corev1.SecretTypeDockerConfigJson: {},
		},
		blockedTypes: map[corev1.SecretType]struct{}{
			corev1.SecretTypeServiceAccountToken: {},
			corev1.SecretTypeBootstrapToken:      {},
		},
		maxPayloadSize: 1 << 20,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc("/api/namespaces", s.withJSON(s.handleNamespaces))
	mux.HandleFunc("/api/secrets", s.withJSON(s.handleSecrets))

	staticSub, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatalf("prepare embedded static assets: %v", err)
	}
	fileServer := http.FileServer(http.FS(staticSub))
	mux.Handle("/", fileServer)

	handler := s.withLogging(mux)
	log.Printf("starting secrets API on %s", addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("listen and serve: %v", err)
	}
}

func buildKubeConfig() (*rest.Config, error) {
	if cfg, err := rest.InClusterConfig(); err == nil {
		cfg.QPS = 20
		cfg.Burst = 40
		return cfg, nil
	}

	kubeconfig := os.Getenv("KUBECONFIG")
	if kubeconfig == "" {
		home, _ := os.UserHomeDir()
		if home != "" {
			kubeconfig = home + "/.kube/config"
		}
	}

	cfg, err := clientcmd.BuildConfigFromFlags("", kubeconfig)
	if err != nil {
		return nil, err
	}
	cfg.QPS = 20
	cfg.Burst = 40
	return cfg, nil
}

func (s *server) withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s from %s in %s", r.Method, r.URL.Path, r.RemoteAddr, time.Since(start).String())
	})
}

func (s *server) withJSON(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		next(w, r)
	}
}

func (s *server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func (s *server) handleNamespaces(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	user, _, err := s.identityFromRequest(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, err.Error())
		return
	}

	ns, err := s.resolveUserNamespace(r.Context(), user)
	if err != nil {
		status, msg := mapNamespaceResolutionError(err)
		writeError(w, status, msg)
		return
	}

	writeJSON(w, http.StatusOK, namespaceResponse{Namespaces: []string{ns}})
}

func (s *server) handleSecrets(w http.ResponseWriter, r *http.Request) {
	user, groups, err := s.identityFromRequest(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, err.Error())
		return
	}

	impClient, err := s.newImpersonatedClient(user, groups)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create Kubernetes client")
		return
	}

	userNamespace, err := s.resolveUserNamespace(r.Context(), user)
	if err != nil {
		status, msg := mapNamespaceResolutionError(err)
		writeError(w, status, msg)
		return
	}

	switch r.Method {
	case http.MethodGet:
		s.handleSecretsList(w, r, impClient, userNamespace)
	case http.MethodPost:
		s.handleSecretsCreate(w, r, impClient, userNamespace)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *server) handleSecretsList(w http.ResponseWriter, r *http.Request, impClient kubernetes.Interface, userNamespace string) {
	ns := userNamespace
	if requestedNamespace := strings.TrimSpace(r.URL.Query().Get("namespace")); requestedNamespace != "" && requestedNamespace != userNamespace {
		writeError(w, http.StatusForbidden, "cross-namespace access is not allowed")
		return
	}

	secretList, err := impClient.CoreV1().Secrets(ns).List(r.Context(), metav1.ListOptions{})
	if err != nil {
		status, msg := mapKubeError(err, "failed to list secrets")
		writeError(w, status, msg)
		return
	}

	items := make([]secretListItem, 0, len(secretList.Items))
	for _, sec := range secretList.Items {
		if sec.Type == corev1.SecretTypeServiceAccountToken {
			continue
		}
		items = append(items, secretListItem{
			Name:              sec.Name,
			Namespace:         sec.Namespace,
			Type:              sec.Type,
			CreationTimestamp: sec.CreationTimestamp.Time,
		})
	}

	sort.Slice(items, func(i, j int) bool {
		return items[i].Name < items[j].Name
	})

	writeJSON(w, http.StatusOK, secretListResponse{Items: items})
}

func (s *server) handleSecretsCreate(w http.ResponseWriter, r *http.Request, impClient kubernetes.Interface, userNamespace string) {
	body, err := io.ReadAll(io.LimitReader(r.Body, s.maxPayloadSize))
	if err != nil {
		writeError(w, http.StatusBadRequest, "failed to read request body")
		return
	}
	defer r.Body.Close()

	var req createSecretRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}
	requestedNamespace := strings.TrimSpace(req.Namespace)
	if requestedNamespace != "" && requestedNamespace != userNamespace {
		writeError(w, http.StatusForbidden, "cross-namespace access is not allowed")
		return
	}
	req.Namespace = userNamespace

	secret, err := s.validateAndBuildSecret(req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	created, err := impClient.CoreV1().Secrets(secret.Namespace).Create(r.Context(), secret, metav1.CreateOptions{})
	if err != nil {
		status, msg := mapKubeError(err, "failed to create secret")
		writeError(w, status, msg)
		return
	}

	writeJSON(w, http.StatusCreated, createSecretResponse{
		Name:      created.Name,
		Namespace: created.Namespace,
		Type:      created.Type,
	})
}

func (s *server) validateAndBuildSecret(req createSecretRequest) (*corev1.Secret, error) {
	namespace := strings.TrimSpace(req.Namespace)
	name := strings.TrimSpace(req.Name)
	if namespace == "" {
		return nil, errors.New("namespace is required")
	}
	if name == "" {
		return nil, errors.New("name is required")
	}
	if errs := validation.IsDNS1123Subdomain(name); len(errs) > 0 {
		return nil, fmt.Errorf("invalid secret name: %s", strings.Join(errs, ", "))
	}

	secretType := req.Type
	if secretType == "" {
		secretType = corev1.SecretTypeOpaque
	}
	if _, blocked := s.blockedTypes[secretType]; blocked {
		return nil, fmt.Errorf("secret type %q is not allowed", secretType)
	}
	if _, ok := s.allowedTypes[secretType]; !ok {
		return nil, fmt.Errorf("secret type %q is not in allowed list", secretType)
	}

	if len(req.Data) == 0 && len(req.StringData) == 0 {
		return nil, errors.New("either data or stringData must be provided")
	}

	decodedData := make(map[string][]byte, len(req.Data))
	for k, v := range req.Data {
		if strings.TrimSpace(k) == "" {
			return nil, errors.New("data contains an empty key")
		}
		decoded, err := base64.StdEncoding.DecodeString(v)
		if err != nil {
			return nil, fmt.Errorf("data[%q] is not valid base64", k)
		}
		decodedData[k] = decoded
	}

	if secretType == corev1.SecretTypeDockerConfigJson {
		if _, ok := decodedData[corev1.DockerConfigJsonKey]; !ok {
			if _, okString := req.StringData[corev1.DockerConfigJsonKey]; !okString {
				return nil, fmt.Errorf("dockerconfigjson secret requires %q key", corev1.DockerConfigJsonKey)
			}
		}
	}

	return &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:        name,
			Namespace:   namespace,
			Labels:      req.Labels,
			Annotations: req.Annotations,
		},
		Type:       secretType,
		Data:       decodedData,
		StringData: req.StringData,
	}, nil
}

func (s *server) resolveUserNamespace(ctx context.Context, user string) (string, error) {
	profiles, err := s.adminDynamic.Resource(s.profileGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return "", err
	}

	owned := make([]string, 0, 1)
	for _, p := range profiles.Items {
		ns := strings.TrimSpace(p.GetName())
		if ns == "" {
			continue
		}
		ownerName, found, err := unstructured.NestedString(p.Object, "spec", "owner", "name")
		if err != nil {
			return "", err
		}
		if !found {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(ownerName), user) {
			owned = append(owned, ns)
		}
	}

	if len(owned) == 0 {
		return "", errProfileNotFound
	}
	if len(owned) > 1 {
		sort.Strings(owned)
		return "", fmt.Errorf("%w: %s", errMultipleProfile, strings.Join(owned, ","))
	}
	return owned[0], nil
}

func (s *server) identityFromRequest(r *http.Request) (string, []string, error) {
	user := strings.TrimSpace(r.Header.Get(s.userHeader))
	if user == "" {
		return "", nil, fmt.Errorf("missing %s header", s.userHeader)
	}

	rawGroups := r.Header.Values(s.groupsHeader)
	groups := normalizeGroups(rawGroups)
	return user, groups, nil
}

func normalizeGroups(values []string) []string {
	seen := make(map[string]struct{})
	out := make([]string, 0, len(values))
	for _, value := range values {
		parts := strings.Split(value, ",")
		for _, p := range parts {
			g := strings.TrimSpace(p)
			if g == "" {
				continue
			}
			if _, ok := seen[g]; ok {
				continue
			}
			seen[g] = struct{}{}
			out = append(out, g)
		}
	}
	sort.Strings(out)
	return out
}

func (s *server) newImpersonatedClient(user string, groups []string) (kubernetes.Interface, error) {
	cfg := rest.CopyConfig(s.baseConfig)
	cfg.Impersonate = rest.ImpersonationConfig{
		UserName: user,
		Groups:   groups,
	}
	return kubernetes.NewForConfig(cfg)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, errorResponse{Error: msg})
}

func mapKubeError(err error, fallback string) (int, string) {
	if apierrors.IsForbidden(err) {
		return http.StatusForbidden, "forbidden"
	}
	if apierrors.IsAlreadyExists(err) {
		return http.StatusConflict, "already exists"
	}
	if apierrors.IsNotFound(err) {
		return http.StatusNotFound, "not found"
	}
	if apierrors.IsUnauthorized(err) {
		return http.StatusUnauthorized, "unauthorized"
	}
	if err == nil {
		return http.StatusOK, ""
	}
	return http.StatusInternalServerError, fmt.Sprintf("%s: %v", fallback, err)
}

func mapNamespaceResolutionError(err error) (int, string) {
	if errors.Is(err, errProfileNotFound) {
		return http.StatusForbidden, "no kubeflow profile found for user"
	}
	if errors.Is(err, errMultipleProfile) {
		return http.StatusConflict, "multiple kubeflow profiles found for user"
	}
	return mapKubeError(err, "failed to resolve user namespace")
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
