package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

const maxOwnerNamesInLog = 10

func (s *server) resolveUserNamespaces(ctx context.Context, user string) ([]string, error) {
	profiles, err := s.adminDynamic.Resource(s.profileGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	userCandidates := identityCandidates(user)
	owned := make([]string, 0, 1)
	ownerNames := make([]string, 0, len(profiles.Items))
	for _, profile := range profiles.Items {
		namespace := strings.TrimSpace(profile.GetName())
		if namespace == "" {
			continue
		}

		ownerName, found, err := unstructured.NestedString(profile.Object, "spec", "owner", "name")
		if err != nil {
			return nil, err
		}
		if !found {
			continue
		}

		ownerNames = append(ownerNames, ownerName)
		if identitiesMatch(userCandidates, identityCandidates(ownerName)) {
			owned = append(owned, namespace)
		}
	}

	if len(owned) == 0 {
		logSafef("profile match failed: user=%q candidates=%q profile_owners=%q", sanitizeForLog(user), strings.Join(userCandidates, ","), strings.Join(limitStrings(ownerNames, maxOwnerNamesInLog), ","))
		return nil, errProfileNotFound
	}

	sort.Strings(owned)
	return owned, nil
}

func (s *server) identityFromRequest(r *http.Request) (string, []string, error) {
	user := strings.TrimSpace(r.Header.Get(s.userHeader))
	if user == "" {
		return "", nil, fmt.Errorf("missing %s header", s.userHeader)
	}
	return user, normalizeGroups(r.Header.Values(s.groupsHeader)), nil
}

func (s *server) newImpersonatedClient(user string, groups []string) (kubernetes.Interface, error) {
	cfg := rest.CopyConfig(s.baseConfig)
	cfg.Impersonate = rest.ImpersonationConfig{
		UserName: user,
		Groups:   groups,
	}
	return kubernetes.NewForConfig(cfg)
}

func normalizeGroups(values []string) []string {
	seen := make(map[string]struct{})
	out := make([]string, 0, len(values))
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			group := strings.TrimSpace(part)
			if group == "" {
				continue
			}
			if _, ok := seen[group]; ok {
				continue
			}
			seen[group] = struct{}{}
			out = append(out, group)
		}
	}
	sort.Strings(out)
	return out
}

func normalizeIdentity(v string) string {
	return strings.ToLower(sanitizeForLog(v))
}

func identityCandidates(v string) []string {
	normalized := normalizeIdentity(v)
	if normalized == "" {
		return nil
	}

	seen := map[string]struct{}{normalized: {}}
	candidates := []string{normalized}

	addSuffix := func(sep string) {
		if idx := strings.LastIndex(normalized, sep); idx > -1 && idx+1 < len(normalized) {
			suffix := strings.TrimSpace(normalized[idx+1:])
			if suffix == "" {
				return
			}
			if _, ok := seen[suffix]; ok {
				return
			}
			seen[suffix] = struct{}{}
			candidates = append(candidates, suffix)
		}
	}

	addSuffix(":")
	addSuffix("|")
	addSuffix("#")
	return candidates
}

func identitiesMatch(a, b []string) bool {
	if len(a) == 0 || len(b) == 0 {
		return false
	}

	seen := make(map[string]struct{}, len(a))
	for _, item := range a {
		seen[item] = struct{}{}
	}
	for _, item := range b {
		if _, ok := seen[item]; ok {
			return true
		}
	}
	return false
}
