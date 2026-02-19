package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"unicode/utf8"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/kubernetes"
)

func (s *server) getManagedSecret(ctx context.Context, client kubernetes.Interface, namespace, name string) (*corev1.Secret, error) {
	secret, err := client.CoreV1().Secrets(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	if !isManagedSecret(secret) {
		return nil, errSecretNotManaged
	}
	return secret, nil
}

func (s *server) validateAndBuildSecret(req secretUpsertRequest) (*corev1.Secret, error) {
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
	for key, value := range req.Data {
		if strings.TrimSpace(key) == "" {
			return nil, errors.New("data contains an empty key")
		}
		decoded, err := base64.StdEncoding.DecodeString(value)
		if err != nil {
			return nil, fmt.Errorf("data[%q] is not valid base64", key)
		}
		decodedData[key] = decoded
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
			Labels:      ensureManagedLabels(req.Labels),
			Annotations: copyStringMap(req.Annotations),
		},
		Type:       secretType,
		Data:       decodedData,
		StringData: copyStringMap(req.StringData),
	}, nil
}

func secretToDetail(secret *corev1.Secret) secretDetailResponse {
	data := make(map[string]string, len(secret.Data))
	stringData := make(map[string]string, len(secret.Data))

	for key, value := range secret.Data {
		data[key] = base64.StdEncoding.EncodeToString(value)
		if utf8.Valid(value) {
			stringData[key] = string(value)
		}
	}

	return secretDetailResponse{
		Name:              secret.Name,
		Namespace:         secret.Namespace,
		Type:              secret.Type,
		CreationTimestamp: secret.CreationTimestamp.Time,
		Labels:            copyStringMap(secret.Labels),
		Annotations:       copyStringMap(secret.Annotations),
		Data:              data,
		StringData:        stringData,
	}
}

func secretNameFromPath(path string) (string, error) {
	if !strings.HasPrefix(path, secretsPathPrefix) {
		return "", errors.New("invalid path")
	}

	raw := strings.TrimPrefix(path, secretsPathPrefix)
	if raw == "" || strings.Contains(raw, "/") {
		return "", errors.New("invalid secret name")
	}

	name, err := url.PathUnescape(raw)
	if err != nil {
		return "", errors.New("invalid secret name")
	}
	if errs := validation.IsDNS1123Subdomain(name); len(errs) > 0 {
		return "", errors.New("invalid secret name")
	}
	return name, nil
}

func copyStringMap(in map[string]string) map[string]string {
	if in == nil {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func ensureManagedLabels(in map[string]string) map[string]string {
	labels := copyStringMap(in)
	if labels == nil {
		labels = make(map[string]string, 1)
	}
	labels[managedByLabelKey] = managedByLabelValue
	return labels
}

func isManagedSecret(secret *corev1.Secret) bool {
	if secret == nil || secret.Labels == nil {
		return false
	}
	return secret.Labels[managedByLabelKey] == managedByLabelValue
}

func managedLabelSelector() string {
	return fmt.Sprintf("%s=%s", managedByLabelKey, managedByLabelValue)
}
