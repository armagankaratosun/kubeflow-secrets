package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

var (
	errReadRequestBody  = errors.New("failed to read request body")
	errInvalidJSONInput = errors.New("invalid JSON payload")
)

func writeJSON(w http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(status)
	//nolint:gosec // Response is JSON and served with application/json content type.
	_, _ = w.Write(append(body, '\n'))
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

func logSafef(format string, args ...any) {
	sanitizedArgs := make([]any, 0, len(args))
	for _, arg := range args {
		sanitizedArgs = append(sanitizedArgs, sanitizeLogArg(arg))
	}

	log.Printf(format, sanitizedArgs...)
}

func sanitizeLogArg(arg any) any {
	switch value := arg.(type) {
	case string:
		return sanitizeSingleLine(value)
	case error:
		return sanitizeSingleLine(value.Error())
	default:
		return arg
	}
}

func sanitizeSingleLine(v string) string {
	return strings.NewReplacer("\n", "\\n", "\r", "\\r").Replace(v)
}
