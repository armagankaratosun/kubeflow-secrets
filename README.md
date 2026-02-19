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

Then access through Kubeflow gateway path:

- `/secrets/`
