package main

import (
	"net/http"
	"time"

	corev1 "k8s.io/api/core/v1"
)

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

type secretDetailResponse struct {
	Name              string            `json:"name"`
	Namespace         string            `json:"namespace"`
	Type              corev1.SecretType `json:"type"`
	CreationTimestamp time.Time         `json:"creationTimestamp"`
	Labels            map[string]string `json:"labels"`
	Annotations       map[string]string `json:"annotations"`
	Data              map[string]string `json:"data"`
	StringData        map[string]string `json:"stringData"`
}

type secretYAMLResponse struct {
	YAML string `json:"yaml"`
}

type secretEventItem struct {
	Type      string    `json:"type"`
	Reason    string    `json:"reason"`
	Message   string    `json:"message"`
	Count     int32     `json:"count"`
	FirstSeen time.Time `json:"firstSeen"`
	LastSeen  time.Time `json:"lastSeen"`
	Source    string    `json:"source"`
}

type secretEventsResponse struct {
	Items []secretEventItem `json:"items"`
}

type secretUpsertRequest struct {
	Namespace   string            `json:"namespace"`
	Name        string            `json:"name"`
	Type        corev1.SecretType `json:"type"`
	Data        map[string]string `json:"data"`
	StringData  map[string]string `json:"stringData"`
	Labels      map[string]string `json:"labels"`
	Annotations map[string]string `json:"annotations"`
}

type secretUpsertResponse struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace"`
	Type      corev1.SecretType `json:"type"`
}

type deleteSecretResponse struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Deleted   bool   `json:"deleted"`
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}
