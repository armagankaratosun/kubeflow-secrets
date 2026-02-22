package main

import (
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/yaml"
)

func (s *server) withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		if r.URL.Path == "/healthz" {
			return
		}

		user := sanitizeForLog(r.Header.Get(s.userHeader))
		reqID := firstNonEmpty(
			r.Header.Get("x-request-id"),
			r.Header.Get("x-b3-traceid"),
			r.Header.Get("traceparent"),
		)

		logSafef(
			"request method=%s path=%s status=%d duration=%s remote=%s user=%q request_id=%q",
			r.Method,
			r.URL.Path,
			rec.status,
			time.Since(start).String(),
			r.RemoteAddr,
			user,
			reqID,
		)
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
		logSafef("namespace resolution failed: identity error: %v", err)
		writeError(w, http.StatusUnauthorized, err.Error())
		return
	}

	namespaces, err := s.resolveUserNamespaces(r.Context(), user)
	if err != nil {
		logSafef("namespace resolution failed: user=%q err=%v", sanitizeForLog(user), err)
		status, msg := mapNamespaceResolutionError(err)
		writeError(w, status, msg)
		return
	}

	logSafef("namespace resolved: user=%q namespaces=%q", sanitizeForLog(user), strings.Join(namespaces, ","))
	writeJSON(w, http.StatusOK, namespaceResponse{Namespaces: namespaces})
}

func (s *server) handleSecrets(w http.ResponseWriter, r *http.Request) {
	userNamespace, impClient, ok := s.userContext(w, r)
	if !ok {
		return
	}

	switch r.Method {
	case http.MethodGet:
		s.handleSecretsList(w, r, impClient, userNamespace)
	case http.MethodPost:
		s.handleSecretCreate(w, r, impClient, userNamespace)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *server) handleSecretByName(w http.ResponseWriter, r *http.Request) {
	userNamespace, impClient, ok := s.userContext(w, r)
	if !ok {
		return
	}

	secretName, subresource, err := parseSecretPath(r.URL.Path)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid path")
		return
	}

	switch subresource {
	case "":
		switch r.Method {
		case http.MethodGet:
			s.handleSecretGet(w, r, impClient, userNamespace, secretName)
		case http.MethodPut:
			s.handleSecretUpdate(w, r, impClient, userNamespace, secretName)
		case http.MethodDelete:
			s.handleSecretDelete(w, r, impClient, userNamespace, secretName)
		default:
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	case secretSubresourceEvents:
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.handleSecretEvents(w, r, impClient, userNamespace, secretName)
	case secretSubresourceYAML:
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.handleSecretYAML(w, r, impClient, userNamespace, secretName)
	default:
		writeError(w, http.StatusBadRequest, "invalid path")
	}
}

func (s *server) userContext(w http.ResponseWriter, r *http.Request) (string, kubernetes.Interface, bool) {
	user, groups, err := s.identityFromRequest(r)
	if err != nil {
		logSafef("request denied: identity error: %v", err)
		writeError(w, http.StatusUnauthorized, err.Error())
		return "", nil, false
	}

	impClient, err := s.newImpersonatedClient(user, groups)
	if err != nil {
		logSafef("request failed: user=%q client init error=%v", sanitizeForLog(user), err)
		writeError(w, http.StatusInternalServerError, "failed to create Kubernetes client")
		return "", nil, false
	}

	userNamespaces, err := s.resolveUserNamespaces(r.Context(), user)
	if err != nil {
		logSafef("request failed: user=%q namespace resolution error=%v", sanitizeForLog(user), err)
		status, msg := mapNamespaceResolutionError(err)
		writeError(w, status, msg)
		return "", nil, false
	}

	userNamespace, ok := resolveNamespaceFromRequest(r, userNamespaces)
	if !ok {
		reqNamespace := requestedNamespace(r)
		logSafef("request failed: user=%q namespace=%q allowed_namespaces=%q", sanitizeForLog(user), reqNamespace, strings.Join(userNamespaces, ","))
		writeError(w, http.StatusForbidden, "requested namespace is not owned by current user")
		return "", nil, false
	}

	return userNamespace, impClient, true
}

func resolveNamespaceFromRequest(r *http.Request, allowedNamespaces []string) (string, bool) {
	if len(allowedNamespaces) == 0 {
		return "", false
	}

	requested := requestedNamespace(r)
	if requested == "" {
		return allowedNamespaces[0], true
	}

	for _, namespace := range allowedNamespaces {
		if namespace == requested {
			return namespace, true
		}
	}

	return "", false
}

func requestedNamespace(r *http.Request) string {
	return firstNonEmpty(
		strings.TrimSpace(r.URL.Query().Get("namespace")),
		strings.TrimSpace(r.URL.Query().Get("ns")),
		strings.TrimSpace(r.Header.Get("x-kubeflow-namespace")),
		strings.TrimSpace(r.Header.Get("kubeflow-namespace")),
	)
}

func (s *server) handleSecretsList(w http.ResponseWriter, r *http.Request, impClient kubernetes.Interface, userNamespace string) {
	ns := userNamespace
	if requestedNamespace := strings.TrimSpace(r.URL.Query().Get("namespace")); requestedNamespace != "" && requestedNamespace != userNamespace {
		logSafef("secrets list denied: requested_namespace=%q allowed_namespace=%q", requestedNamespace, userNamespace)
		writeError(w, http.StatusForbidden, "cross-namespace access is not allowed")
		return
	}

	secretList, err := impClient.CoreV1().Secrets(ns).List(r.Context(), metav1.ListOptions{LabelSelector: managedLabelSelector()})
	if err != nil {
		status, msg := mapKubeError(err, "failed to list secrets")
		logSafef("secrets list failed: namespace=%q status=%d err=%v", ns, status, err)
		writeError(w, status, msg)
		return
	}

	items := make([]secretListItem, 0, len(secretList.Items))
	for _, sec := range secretList.Items {
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

func (s *server) handleSecretCreate(w http.ResponseWriter, r *http.Request, impClient kubernetes.Interface, userNamespace string) {
	req, err := s.readUpsertRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if requestedNamespace := strings.TrimSpace(req.Namespace); requestedNamespace != "" && requestedNamespace != userNamespace {
		logSafef("secret create denied: requested_namespace=%q allowed_namespace=%q secret=%q", requestedNamespace, userNamespace, strings.TrimSpace(req.Name))
		writeError(w, http.StatusForbidden, "cross-namespace access is not allowed")
		return
	}

	req.Namespace = userNamespace
	req.Labels = ensureManagedLabels(req.Labels)

	secret, err := s.validateAndBuildSecret(req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	created, err := impClient.CoreV1().Secrets(secret.Namespace).Create(r.Context(), secret, metav1.CreateOptions{})
	if err != nil {
		status, msg := mapKubeError(err, "failed to create secret")
		logSafef("secret create failed: namespace=%q name=%q status=%d err=%v", secret.Namespace, secret.Name, status, err)
		writeError(w, status, msg)
		return
	}

	logSafef("secret created: namespace=%q name=%q type=%q", created.Namespace, created.Name, created.Type)
	writeJSON(w, http.StatusCreated, secretUpsertResponse{
		Name:      created.Name,
		Namespace: created.Namespace,
		Type:      created.Type,
	})
}

func (s *server) handleSecretGet(w http.ResponseWriter, r *http.Request, impClient kubernetes.Interface, userNamespace, secretName string) {
	secret, err := s.getManagedSecret(r.Context(), impClient, userNamespace, secretName)
	if err != nil {
		status, msg := mapKubeError(err, "failed to get secret")
		writeError(w, status, msg)
		return
	}

	writeJSON(w, http.StatusOK, secretToDetail(secret))
}

func (s *server) handleSecretEvents(w http.ResponseWriter, r *http.Request, impClient kubernetes.Interface, userNamespace, secretName string) {
	if _, err := s.getManagedSecret(r.Context(), impClient, userNamespace, secretName); err != nil {
		status, msg := mapKubeError(err, "failed to get secret events")
		writeError(w, status, msg)
		return
	}

	fieldSelector := fmt.Sprintf(
		"involvedObject.kind=Secret,involvedObject.namespace=%s,involvedObject.name=%s",
		userNamespace,
		secretName,
	)
	events, err := impClient.CoreV1().Events(userNamespace).List(
		r.Context(),
		metav1.ListOptions{FieldSelector: fieldSelector},
	)
	if err != nil {
		status, msg := mapKubeError(err, "failed to list events")
		writeError(w, status, msg)
		return
	}

	items := make([]secretEventItem, 0, len(events.Items))
	for _, event := range events.Items {
		items = append(items, secretEventItem{
			Type:      event.Type,
			Reason:    event.Reason,
			Message:   event.Message,
			Count:     event.Count,
			FirstSeen: eventTimeOrZero(event.FirstTimestamp.Time, event.EventTime.Time, event.CreationTimestamp.Time),
			LastSeen:  eventTimeOrZero(event.LastTimestamp.Time, event.EventTime.Time, event.CreationTimestamp.Time),
			Source:    sourceSummary(event.Source),
		})
	}

	sort.SliceStable(items, func(i, j int) bool {
		return items[i].LastSeen.After(items[j].LastSeen)
	})

	writeJSON(w, http.StatusOK, secretEventsResponse{Items: items})
}

func (s *server) handleSecretYAML(w http.ResponseWriter, r *http.Request, impClient kubernetes.Interface, userNamespace, secretName string) {
	secret, err := s.getManagedSecret(r.Context(), impClient, userNamespace, secretName)
	if err != nil {
		status, msg := mapKubeError(err, "failed to get secret yaml")
		writeError(w, status, msg)
		return
	}

	readonly := secret.DeepCopy()
	readonly.ManagedFields = nil

	encoded, err := yaml.Marshal(readonly)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to render yaml")
		return
	}

	writeJSON(w, http.StatusOK, secretYAMLResponse{YAML: string(encoded)})
}

func (s *server) handleSecretUpdate(w http.ResponseWriter, r *http.Request, impClient kubernetes.Interface, userNamespace, secretName string) {
	existing, err := s.getManagedSecret(r.Context(), impClient, userNamespace, secretName)
	if err != nil {
		status, msg := mapKubeError(err, "failed to update secret")
		writeError(w, status, msg)
		return
	}

	req, err := s.readUpsertRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if requestedNamespace := strings.TrimSpace(req.Namespace); requestedNamespace != "" && requestedNamespace != userNamespace {
		writeError(w, http.StatusForbidden, "cross-namespace access is not allowed")
		return
	}
	if requestedName := strings.TrimSpace(req.Name); requestedName != "" && requestedName != secretName {
		writeError(w, http.StatusBadRequest, "secret name in payload does not match path")
		return
	}

	req.Namespace = userNamespace
	req.Name = secretName
	if req.Labels == nil {
		req.Labels = copyStringMap(existing.Labels)
	}
	if req.Annotations == nil {
		req.Annotations = copyStringMap(existing.Annotations)
	}
	req.Labels = ensureManagedLabels(req.Labels)

	updatedSecret, err := s.validateAndBuildSecret(req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	updatedSecret.ResourceVersion = existing.ResourceVersion

	updated, err := impClient.CoreV1().Secrets(userNamespace).Update(r.Context(), updatedSecret, metav1.UpdateOptions{})
	if err != nil {
		status, msg := mapKubeError(err, "failed to update secret")
		logSafef("secret update failed: namespace=%q name=%q status=%d err=%v", userNamespace, secretName, status, err)
		writeError(w, status, msg)
		return
	}

	logSafef("secret updated: namespace=%q name=%q type=%q", updated.Namespace, updated.Name, updated.Type)
	writeJSON(w, http.StatusOK, secretUpsertResponse{
		Name:      updated.Name,
		Namespace: updated.Namespace,
		Type:      updated.Type,
	})
}

func (s *server) handleSecretDelete(w http.ResponseWriter, r *http.Request, impClient kubernetes.Interface, userNamespace, secretName string) {
	if _, err := s.getManagedSecret(r.Context(), impClient, userNamespace, secretName); err != nil {
		status, msg := mapKubeError(err, "failed to delete secret")
		writeError(w, status, msg)
		return
	}

	if err := impClient.CoreV1().Secrets(userNamespace).Delete(r.Context(), secretName, metav1.DeleteOptions{}); err != nil {
		status, msg := mapKubeError(err, "failed to delete secret")
		logSafef("secret delete failed: namespace=%q name=%q status=%d err=%v", userNamespace, secretName, status, err)
		writeError(w, status, msg)
		return
	}

	logSafef("secret deleted: namespace=%q name=%q", userNamespace, secretName)
	writeJSON(w, http.StatusOK, deleteSecretResponse{
		Name:      secretName,
		Namespace: userNamespace,
		Deleted:   true,
	})
}

func (s *server) readUpsertRequest(r *http.Request) (secretUpsertRequest, error) {
	defer func() {
		if err := r.Body.Close(); err != nil {
			logSafef("failed to close request body: %v", err)
		}
	}()

	body, err := io.ReadAll(io.LimitReader(r.Body, s.maxPayloadSize))
	if err != nil {
		return secretUpsertRequest{}, errReadRequestBody
	}

	var req secretUpsertRequest
	if err := decodeJSON(body, &req); err != nil {
		return secretUpsertRequest{}, err
	}
	return req, nil
}

func eventTimeOrZero(values ...time.Time) time.Time {
	for _, value := range values {
		if !value.IsZero() {
			return value
		}
	}
	return time.Time{}
}

func sourceSummary(source corev1.EventSource) string {
	component := strings.TrimSpace(source.Component)
	host := strings.TrimSpace(source.Host)
	switch {
	case component == "" && host == "":
		return "-"
	case component == "":
		return host
	case host == "":
		return component
	default:
		return component + "@" + host
	}
}
