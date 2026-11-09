import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConnectionFields,
  blankConnection,
  connectionWrite,
  credentialFields,
  type Connection,
} from "../web/components/connection-form.js";
import { ConnectionEditor } from "../web/components/connection-editor.js";

// Synthetic form state only. No Store, real credentials, network or platform helper.
const password = "synthetic-simplification-password";
const cloud = {
  accessKeyId: "synthetic-simplification-access-id",
  secretAccessKey: "synthetic-simplification-secret",
  sessionToken: "synthetic-simplification-session-token",
};
const certificate = {
  cert: "synthetic-simplification-client-certificate",
  key: "synthetic-simplification-client-private-key",
  ca: "synthetic-simplification-server-ca",
  passphrase: "synthetic-simplification-private-key-password",
};

function form(kind: Connection["kind"]): Connection {
  return { ...blankConnection(kind), alias: `SIMPLE_${kind.toUpperCase()}` };
}

function fields(connection: Connection, section: "basic" | "advanced" | "all") {
  return renderToStaticMarkup(React.createElement(ConnectionFields, {
    connection, section, identity: "keep", onChange() {}, onIdentityChange() {},
  }));
}

function label(markup: string, text: RegExp) {
  return [...markup.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)]
    .map((match) => match[1])
    .find((content) => text.test(content.replace(/<[^>]*>/g, "")));
}

function editor(connection: Connection, original: Connection | null = null) {
  return renderToStaticMarkup(React.createElement(ConnectionEditor, {
    edit: connection, original, saved: original ?? undefined,
    secrets: {}, sshIdentity: "keep", busy: false, keyReading: false,
    configurationReady: true, configurationAlert: null, alert: null,
    connectionTest: {
      disabled: false, pending: false, result: null,
      onTest() {}, onCancel() {}, onConfirm() {},
    },
    onEdit() {}, onFieldsChange() {}, onIdentity() {}, onSecrets() {},
    onKeyReading() {}, onKeyError() {}, onKind() {}, onClose() {}, onSubmit() {},
  }));
}

type ElementProps = {
  children?: React.ReactNode;
  "aria-label"?: string;
  onChange?: (event: { target: { value: string } }) => void;
};
function selectElement(node: React.ReactNode, name: string): React.ReactElement<ElementProps> | undefined {
  for (const child of React.Children.toArray(node)) {
    if (!React.isValidElement<ElementProps>(child)) continue;
    if (child.type === "select" && child.props["aria-label"] === name) return child;
    const found = selectElement(child.props.children, name);
    if (found) return found;
  }
  return undefined;
}

test("PostgreSQL requires a new password while an untouched saved password is retained", () => {
  const connection = form("postgres");
  assert.equal(credentialFields(connection, "keep").find((field) => field.key === "password")?.required, true);
  assert.match(label(editor(connection), /^密码/) ?? "", /<input\b[^>]*\brequired=""/);
  assert.match(label(editor(connection), /^密码/) ?? "", /class="required-mark" aria-hidden="true">\*/);
  assert.match(label(editor(connection), /^密码/) ?? "", /aria-label="密码"/);
  assert.throws(() => connectionWrite(connection, null, {}, "keep"), /密码/);
  assert.deepEqual(connectionWrite(connection, null, { password }, "keep").secret, { password });

  const saved = { ...connection, hasSecret: true, revision: 7 };
  const edited = { ...saved, note: "Updated synthetic note" };
  const payload = connectionWrite(edited, saved, {}, "keep");
  assert.equal(Object.hasOwn(payload, "secret"), false);
  assert.equal(payload.clearSecret, false);
  assert.equal(payload.expectedRevision, 7);
  assert.doesNotMatch(label(editor(edited, saved), /^密码/) ?? "", /<input\b[^>]*\brequired=""/);
  assert.doesNotMatch(label(editor(edited, saved), /^密码/) ?? "", /required-mark/);
  assert.match(label(editor(edited, saved), /^密码/) ?? "", /aria-label="密码（留空保留）"/);
});

test("MySQL IP addresses surface the required TLS certificate name; disabling TLS removes that requirement", () => {
  for (const host of ["203.0.113.12", "2001:db8::12"]) {
    const connection = form("mysql");
    Object.assign(connection.config, { host, tls: true });
    const serverName = label(fields(connection, "basic"), /^TLS.*域名/);
    assert.ok(serverName, "a required TLS identity cannot be hidden in collapsed options");
    assert.match(serverName, /<input\b[^>]*\brequired=""/);
    assert.match(serverName, /required-mark/);
    assert.match(serverName, /aria-label="TLS 证书域名"/);
    assert.equal(label(fields(connection, "advanced"), /^TLS.*域名/), undefined);

    connection.config.tls = false;
    assert.equal(label(fields(connection, "basic"), /^TLS.*域名/), undefined);
    assert.equal(label(fields(connection, "advanced"), /^TLS.*域名/), undefined);
    assert.equal(label(fields(connection, "advanced"), /CA/), undefined);
  }
  const hostname = form("mysql");
  Object.assign(hostname.config, { host: "database.example.test", tls: true });
  assert.equal(label(fields(hostname, "basic"), /^TLS.*域名/), undefined);
  const override = label(fields(hostname, "advanced"), /^TLS.*域名/);
  assert.ok(override);
  assert.doesNotMatch(override, /<input\b[^>]*\brequired=""/);
  assert.doesNotMatch(override, /required-mark/);
});

test("selecting R2 persists auto signing region without offering an editable region field", () => {
  let connection = form("s3");
  connection.config.region = "us-west-2";
  const tree = ConnectionFields({
    connection, section: "basic", identity: "keep",
    onChange(next) { connection = next; }, onIdentityChange() {},
  });
  const provider = selectElement(tree, "平台");
  assert.ok(provider?.props.onChange);
  provider.props.onChange({ target: { value: "r2" } });
  assert.equal(connection.config.provider, "r2");
  assert.equal(connection.config.region, "auto");
  assert.equal(label(fields(connection, "all"), /^区域/), undefined);
  const payload = connectionWrite(connection, null, cloud, "keep");
  assert.equal(payload.connection.config.region, "auto");
  assert.deepEqual(payload.secret, cloud);
});

test("collapsed advanced controls preserve temporary cloud credentials and certificate options in submitted payloads", () => {
  for (const kind of ["s3", "aws"] as const) {
    const connection = form(kind);
    const token = credentialFields(connection, "keep").find((field) => field.key === "sessionToken");
    assert.ok(token?.advanced, "temporary credentials belong to the optional controls");
    assert.equal(token.required, undefined);
    assert.deepEqual(connectionWrite(connection, null, cloud, "keep").secret, cloud);
  }
  for (const kind of ["docker", "kubernetes"] as const) {
    const connection = form(kind);
    connection.config.auth = "mtls";
    const credentials = credentialFields(connection, "keep");
    for (const key of ["ca", "passphrase"]) {
      assert.equal(credentials.find((field) => field.key === key)?.advanced, true);
    }
    assert.deepEqual(connectionWrite(connection, null, certificate, "keep").secret, certificate);
  }
  const kubernetes = form("kubernetes");
  const bearer = { token: "synthetic-simplification-token", ca: certificate.ca };
  assert.deepEqual(connectionWrite(kubernetes, null, bearer, "keep").secret, bearer);
});

test("the editor starts with optional credentials and metadata collapsed while required credentials stay accessible", () => {
  for (const kind of ["aws", "docker", "kubernetes"] as const) {
    const connection = form(kind);
    const markup = editor(connection);
    const options = markup.match(/<details\b([^>]*)>([\s\S]*?)<\/details>/);
    assert.ok(options, "optional controls remain available in the form");
    assert.doesNotMatch(options[1], /\bopen(?:=|\s|$)/);
    assert.match(options[2], /<summary>更多选项<\/summary>/);
    assert.match(options[2], /备注/);
    assert.match(options[2], /文档/);
    assert.doesNotMatch(options[2], /required-mark/, "optional controls must not display mandatory markers");
    const primary = markup.replace(options[0], "");
    const definitions = credentialFields(connection, "keep");
    for (const field of definitions) {
      const escaped = field.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const title = new RegExp(`^${escaped}`);
      assert.ok(label(field.advanced ? options[2] : primary, title), `${field.key} must remain available in its intended section`);
      if (field.required)
        assert.match(label(primary, title) ?? "", /required-mark/, `${field.key} is marked while required`);
    }
  }
});

test("new Kubernetes connections exclude Secrets and simplified edits retain explicit resource and namespace boundaries", () => {
  const fresh = form("kubernetes");
  assert.ok(Array.isArray(fresh.config.resources));
  assert.ok(!fresh.config.resources.includes("secrets"));
  const newPayload = connectionWrite(fresh, null, { token: password }, "keep");
  assert.deepEqual(newPayload.connection.config.resources, fresh.config.resources);

  const saved = {
    ...fresh, hasSecret: true, revision: 4,
    config: {
      ...fresh.config, namespace: "synthetic-main", namespaces: ["synthetic-main", "synthetic-extra"],
      resources: ["pods", "secrets"], trustedPrivate: true,
    },
  };
  const before = structuredClone(saved);
  fields(saved, "basic");
  fields(saved, "advanced");
  editor(saved, saved);
  assert.deepEqual(saved, before, "rendering the simplified sections cannot rewrite saved scope");
  const payload = connectionWrite({ ...saved, note: "Synthetic edit" }, saved, {}, "keep");
  assert.deepEqual(payload.connection.config, before.config);
  assert.equal(Object.hasOwn(payload, "secret"), false);
});

test("metadata-only edits preserve existing advanced configuration and never send replacement secrets", () => {
  const configurations: [Connection["kind"], Record<string, unknown>][] = [
    ["ssh", { remoteRoot: "/srv/synthetic", fileAccess: "read", allowShell: false, hostKeySHA256: "retired-synthetic-pin" }],
    ["s3", { prefix: "synthetic/", allowedCommands: ["get-object"], trustedPrivate: true, ca: certificate.ca }],
    ["aws", { allowedServices: ["sts"], endpoints: { sts: "https://sts.example.test" } }],
    ["docker", { apiVersion: "v1.44", trustedPrivate: true }],
    ["registry", { allowedRepositories: ["synthetic/project"], allowedCommands: ["tags"], ca: certificate.ca }],
  ];
  for (const [kind, config] of configurations) {
    const saved: Connection = {
      ...form(kind), hasSecret: true, revision: 9,
      config: { ...form(kind).config, ...config },
    };
    const before = structuredClone(saved.config);
    fields(saved, "basic");
    fields(saved, "advanced");
    const payload = connectionWrite({ ...saved, documentationUrl: "https://docs.example.test/updated" }, saved, {}, "keep");
    assert.deepEqual(payload.connection.config, before, kind);
    assert.equal(Object.hasOwn(payload, "secret"), false, kind);
    assert.equal(payload.clearSecret, false, kind);
    assert.equal(payload.expectedRevision, 9, kind);
  }
});
