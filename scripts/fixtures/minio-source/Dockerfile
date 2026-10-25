# Local integration-test fixture only. MinIO source is AGPL-3.0.
# Context: fixed source archive extracted as src/ by the documented preparation recipe.
ARG BUILD_IMAGE=golang:1.24-bookworm
ARG RUNTIME_IMAGE=debian:bookworm-slim
FROM ${BUILD_IMAGE} AS build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2 GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org
WORKDIR /src
COPY src/go.mod src/go.sum ./
RUN go mod download && go mod verify
COPY src/ ./
RUN go build -p 2 -mod=readonly -tags kqueue -trimpath -buildvcs=false \
    -ldflags="-s -w -X github.com/minio/minio/cmd.Version=2025-09-07T16:13:09Z -X github.com/minio/minio/cmd.ReleaseTag=RELEASE.2025-09-07T16-13-09Z -X github.com/minio/minio/cmd.CommitID=07c3a429bfed433e49018cb0f78a52145d4bedeb -X github.com/minio/minio/cmd.ShortCommitID=07c3a429bfed -X github.com/minio/minio/cmd.CopyrightYear=2025" \
    -o /out/minio .
FROM ${RUNTIME_IMAGE}
LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="07c3a429bfed433e49018cb0f78a52145d4bedeb" \
      org.opencontainers.image.licenses="AGPL-3.0" \
      dev.abilock.purpose="temporary-local-integration-fixture" \
      dev.abilock.source.sha256="c9598dcce3440977e79f787f2ba0e7e4d92c8d556bd51e7cef3785bafd6635f3"
COPY --from=build /out/minio /usr/local/bin/minio
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY src/LICENSE /usr/share/doc/minio/LICENSE
RUN mkdir -p /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 9000
ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/data", "--console-address", ":9001"]
