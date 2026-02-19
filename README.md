# kubeflow-secrets

Small Kubeflow web app + API for creating Kubernetes secrets in user namespaces via Kubernetes impersonation.

## What it does

- Trusts identity headers from Kubeflow ingress/auth path:
  - `kubeflow-userid`
  - `kubeflow-groups`
- Builds a per-request impersonated Kubernetes client:
  - `Impersonate-User`
  - `Impersonate-Group`
- Exposes minimal API:
  - `GET /api/namespaces` (returns only the caller's Profile namespace)
  - `GET /api/secrets` (optional `?namespace=` must match caller namespace)
  - `POST /api/secrets`
  - `GET /api/secrets/{name}`
  - `PUT /api/secrets/{name}`
  - `DELETE /api/secrets/{name}`
- Only returns secrets created/managed by this app (`managed-by=kubeflow-secrets`).
- Enforces single-namespace behavior from Profile ownership:
  - namespace is derived from `Profile.spec.owner.name == kubeflow-userid`
  - cross-namespace requests are rejected
- Validates secret payload and blocks sensitive types (for example `kubernetes.io/service-account-token`).
- Relies on RBAC for final authorization.

## Local run

```bash
go mod tidy
go run ./cmd/secrets-api
```

Server defaults:

- `LISTEN_ADDR=:8080`
- `USER_HEADER=kubeflow-userid`
- `GROUPS_HEADER=kubeflow-groups`

## Development checks

```bash
gofmt -w cmd/secrets-api/*.go
go test ./...
golangci-lint run --config .golangci.yml
```

`lint-test` GitHub Actions workflow runs tests and `golangci-lint` on push/PR to `main`.

## API examples

```bash
curl -H 'kubeflow-userid:user@example.com' \
     -H 'kubeflow-groups:team-a,team-b' \
     http://localhost:8080/api/namespaces
```

```bash
curl -X POST http://localhost:8080/api/secrets \
  -H 'Content-Type: application/json' \
  -H 'kubeflow-userid:user@example.com' \
  -d '{
    "namespace":"my-profile",
    "name":"my-secret",
    "type":"Opaque",
    "stringData":{"username":"u","password":"p"}
  }'
```

## Deploy to Kubeflow

```bash
kubectl apply -k manifests/base
```

The base Deployment is PodSecurity `restricted` compatible:

- `allowPrivilegeEscalation: false`
- `capabilities.drop: [\"ALL\"]`
- `runAsNonRoot: true`
- `runAsUser/runAsGroup/fsGroup: 65532`
- `seccompProfile.type: RuntimeDefault`

Then access through Kubeflow gateway path:

- `/secrets/`
