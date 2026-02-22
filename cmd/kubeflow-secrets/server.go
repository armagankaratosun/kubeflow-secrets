package main

import (
	"errors"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
)

const (
	managedByLabelKey              = "managed-by"
	managedByLabelValue            = "kubeflow-secrets"
	secretsPathPrefix              = "/api/secrets/"
	secretSubresourceEvents        = "events"
	secretSubresourceYAML          = "yaml"
	secretPathWithSubresourceParts = 2
	maxPayloadBytes                = 1 << 20
)

var (
	errProfileNotFound  = errors.New("no profile namespace found for user")
	errSecretNotManaged = errors.New("secret is not managed by kubeflow-secrets")
)

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

func newServer(cfg *rest.Config, userHeader, groupsHeader string) (*server, error) {
	adminDynamic, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}

	return &server{
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
		maxPayloadSize: maxPayloadBytes,
	}, nil
}
