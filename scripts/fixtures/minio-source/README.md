# MinIO 本地集成测试镜像

该镜像仅用于 Permivelo 的临时对象存储协议验证，不是部署方案。MinIO 官方仓库已归档，此处固定官方历史 release 源码；不依赖 DockerHub/Quay 的历史预编译镜像。源码许可证为 AGPL-3.0，项目仅保存构建配方和证据，没有发布镜像或二进制。

来源：

- [固定 release 源码](https://github.com/minio/minio/tree/RELEASE.2025-09-07T16-13-09Z)
- [官方 go.mod](https://github.com/minio/minio/blob/RELEASE.2025-09-07T16-13-09Z/go.mod)，要求 Go 1.24。
- [官方构建参数](https://github.com/minio/minio/blob/RELEASE.2025-09-07T16-13-09Z/Makefile)，使用 `CGO_ENABLED=0` 和 kqueue 标签。
- 提交：`07c3a429bfed433e49018cb0f78a52145d4bedeb`。
- GitHub 标签 API 报告签名验证有效；这不是本地独立 PGP 验证。
- 源码压缩包 SHA-256：`c9598dcce3440977e79f787f2ba0e7e4d92c8d556bd51e7cef3785bafd6635f3`。这是从官方 HTTPS 下载内容计算的校验值，不是另行发布的官方摘要。

在项目根目录执行以下配方。使用独立空 Docker 客户端配置，避免读取用户 registry 凭据；源码和构建上下文都在临时目录。需要已有 Docker 服务，没有安装系统工具。

```sh
fixture_dir=$(mktemp -d /tmp/abilock-minio-build.XXXXXX)
mkdir "$fixture_dir/src" "$fixture_dir/docker-config"
printf '{}\n' > "$fixture_dir/docker-config/config.json"
curl --fail --location --proto '=https' --tlsv1.2 \
  https://codeload.github.com/minio/minio/tar.gz/refs/tags/RELEASE.2025-09-07T16-13-09Z \
  --output "$fixture_dir/minio.tar.gz"
printf '%s  %s\n' \
  c9598dcce3440977e79f787f2ba0e7e4d92c8d556bd51e7cef3785bafd6635f3 \
  "$fixture_dir/minio.tar.gz" | shasum -a 256 -c -
tar -xzf "$fixture_dir/minio.tar.gz" -C "$fixture_dir/src" --strip-components=1
cp scripts/fixtures/minio-source/Dockerfile "$fixture_dir/Dockerfile"
docker --config "$fixture_dir/docker-config" --host unix:///var/run/docker.sock build \
  --force-rm \
  --build-arg BUILD_IMAGE=golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac \
  --build-arg RUNTIME_IMAGE=debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 \
  --tag abilock-test-minio:source-20250907 "$fixture_dir"
docker --config "$fixture_dir/docker-config" --host unix:///var/run/docker.sock run \
  --rm --network none abilock-test-minio:source-20250907 --version
```

构建依赖只通过 `https://proxy.golang.org` 下载，并由 `sum.golang.org` 和源码 `go.sum` 校验。正式测试的服务容器由 `scripts/docker-test-environment.mjs` 管理，使用假凭据和本机端口；测试完成需停止其创建的所有服务容器。构建命令本身不启动对象存储服务、不挂载用户 home、不向执行 CLI 暴露 Docker socket。

实际构建结果与镜像 ID 在 `artifacts/docker-minio-build.json`；服务协议验证结果另见对象存储测试报告。
