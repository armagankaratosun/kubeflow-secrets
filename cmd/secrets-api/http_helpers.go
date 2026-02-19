package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

var (
	errReadRequestBody  = errors.New("failed to read request body")
	errInvalidJSONInput = errors.New("invalid JSON payload")
)

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, errorResponse{Error: msg})
}

func mapKubeError(err error, fallback string) (int, string) {
	if errors.Is(err, errSecretNotManaged) {
		return http.StatusNotFound, "not found"
	}
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

func decodeJSON(body []byte, out any) error {
	if err := json.Unmarshal(body, out); err != nil {
		return errInvalidJSONInput
	}
	return nil
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func sanitizeForLog(v string) string {
	return strings.TrimSpace(strings.Trim(v, "\""))
}
