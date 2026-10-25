# Abilock Python launcher

Abilock lets an AI assistant discover and call your configured external capabilities
while the broker keeps provider credentials. The Python package provides the same
`abl` command as the npm package. It requires **Node.js >= 22.12** on `PATH`.

The launcher forwards arguments, the environment, and terminal streams directly to
the canonical Node CLI. This wheel contains the execution client only: select an
existing remote broker explicitly with `ABILOCK_ENDPOINT` and privately grant its
execution capability through `ABILOCK_EXEC_TOKEN`. It does not contain the local
worker or management UI, install Node.js, download npm dependencies, or add provider
credential parameters. The complete Node package supports one-shot local execution
and a temporary `abl config` page. Configure provider credentials in the management UI.

```sh
abl --help
abl list --json
abl list --query "生图" --json
abl config
```

The wheel includes the repository's Node CLI and its existing `ws` JavaScript
dependency with the original MIT license. Build resources are copied from `bin/`
and the locked local `node_modules/ws` dependency; no second CLI source is maintained.

For a local build, first prepare the repository's existing dependencies and Python
build tools (`setuptools >= 77` and `wheel`). Build with:

```sh
python -m pip wheel . --no-index --no-deps --no-build-isolation --wheel-dir artifacts/packages
```

The build itself does not download dependencies. A source distribution includes only
the CLI files and the required `ws` JavaScript sources so it can build the same wheel
offline when the Python build tools are present. No package has been published.

Run the launcher checks without additional test dependencies:

```sh
python -m unittest discover -s python/tests -v
```
