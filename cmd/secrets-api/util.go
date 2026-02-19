package main

import (
	"fmt"
	"os"
	"strings"
)

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func limitStrings(values []string, limit int) []string {
	if len(values) <= limit {
		return values
	}
	return append(values[:limit], fmt.Sprintf("...+%d more", len(values)-limit))
}
