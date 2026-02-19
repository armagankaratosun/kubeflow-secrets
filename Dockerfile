FROM golang:1.24-alpine AS builder
WORKDIR /src

RUN apk add --no-cache ca-certificates git

COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
  go build -trimpath -ldflags="-s -w" -o /out/kubeflow-secrets ./cmd/kubeflow-secrets

FROM gcr.io/distroless/static:nonroot
WORKDIR /
COPY --from=builder /out/kubeflow-secrets /kubeflow-secrets
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/kubeflow-secrets"]
