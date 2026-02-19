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

func limitStrings(values []string, max int) []string {
	if len(values) <= max {
		return values
	}
	return append(values[:max], fmt.Sprintf("...+%d more", len(values)-max))
}
