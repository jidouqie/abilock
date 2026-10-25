"""Read public documentation URLs; save only link metadata in the project.

Bodies are research scratch files under /tmp, not project deliverables.
No credentials, environment variables, user configuration, or remote writes.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from hashlib import sha256
from html.parser import HTMLParser
from pathlib import Path
import gzip
import json
import re
import urllib.request

ROOT = Path(__file__).resolve().parent
SCRATCH = Path('/tmp/api-call-hub-public-pages')
URLS = {
    'agentvault-security': 'https://docs.agent-vault.dev/learn/security',
    'agentvault-services': 'https://docs.agent-vault.dev/services/overview',
    'agentvault-license': 'https://raw.githubusercontent.com/Infisical/agent-vault/main/LICENSE',
    'agentvault-index': 'https://docs.agent-vault.dev/llms.txt',
    'hunyuan-chat': 'https://cloud.tencent.com/document/product/1729/111007',
    'hunyuan-start': 'https://cloud.tencent.com/document/product/1729/111008',
    'fastmcp-openapi': 'https://gofastmcp.com/integrations/openapi',
    'nango-intro': 'https://nango.dev/docs/getting-started/intro-to-nango',
    'nango-proxy': 'https://nango.dev/docs/reference/backend/http-api/proxy/post.md',
    'composio-custody': 'https://docs.composio.dev/docs/security/token-custody',
    'pipedream-proxy': 'https://pipedream.com/docs/connect/api-proxy',
    'contextforge-readme': 'https://raw.githubusercontent.com/IBM/mcp-context-forge/main/README.md',
    'litellm-virtual': 'https://docs.litellm.ai/docs/proxy/virtual_keys',
    'litellm-mcp': 'https://docs.litellm.ai/docs/mcp',
    'bifrost-mcp': 'https://docs.getbifrost.ai/mcp/overview',
    'bifrost-config': 'https://docs.getbifrost.ai/deployment-guides/config-json',
    'newapi-readme': 'https://raw.githubusercontent.com/QuantumNous/new-api/main/README.md',
    'unkey-index': 'https://www.unkey.com/docs/llms.txt',
    'unkey-readme': 'https://raw.githubusercontent.com/unkeyed/unkey/main/README.md',
    'infisical-readme': 'https://raw.githubusercontent.com/Infisical/infisical/main/README.md',
    'vault-kv': 'https://developer.hashicorp.com/vault/docs/secrets/kv',
    'deepseek-auth': 'https://api-docs.deepseek.com/api/deepseek-api/',
    'deepseek-start': 'https://api-docs.deepseek.com/',
    'ark-key': 'https://docs.volcengine.com/docs/ark/api-key?lang=zh',
    'ark-chat': 'https://docs.volcengine.com/docs/ark/chat-api?lang=zh',
    'ark-images': 'https://www.volcengine.com/docs/82379/1541523',
    'ark-video': 'https://www.volcengine.com/docs/82379/1520757',
    'ark-embedding': 'https://www.volcengine.com/docs/82379/1521760',
    'volc-tts': 'https://docs.volcengine.com/docs/6561/1598757',
    'volc-asr': 'https://www.volcengine.com/docs/6561/1354868',
    'hunyuan-guide': 'https://cloud.tencent.com/document/product/1300/80695',
    'hunyuan-compat': 'https://cloud.tencent.com/document/product/1300/103556',
    'yuanbao-product': 'https://yuanbao.tencent.com/',
    'aliyun-key': 'https://help.aliyun.com/zh/model-studio/get-api-key',
    'aliyun-embedding': 'https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api',
    'aliyun-video': 'https://help.aliyun.com/zh/model-studio/text-to-video-api-reference',
    'aliyun-speech': 'https://help.aliyun.com/zh/model-studio/cosyvoice-large-model-for-speech-synthesis',
    'tencent-sign': 'https://cloud.tencent.com/document/api/213/30654',
    'openssh-authorized': 'https://man.openbsd.org/sshd.8',
    'openssh-config': 'https://man.openbsd.org/sshd_config.5',
    'teleport-machine': 'https://goteleport.com/docs/machine-workload-identity/machine-id/',
    'mcp-security': 'https://modelcontextprotocol.io/docs/draft/tutorials/security/security_best_practices',
    'owasp-ssrf': 'https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html',
    'onepassword-env': 'https://www.1password.dev/cli/secrets-scripts',
}

class VisibleText(HTMLParser):
    def __init__(self):
        super().__init__(); self.parts = []; self.hidden = 0
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'): self.hidden += 1
    def handle_endtag(self, tag):
        if tag in ('script', 'style') and self.hidden: self.hidden -= 1
    def handle_data(self, text):
        if not self.hidden and text.strip(): self.parts.append(text.strip())

def fetch(item):
    name, url = item
    record = {'id': name, 'url': url, 'checked_at_utc': datetime.now(timezone.utc).isoformat()}
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (public documentation research)'})
        with urllib.request.urlopen(req, timeout=25) as response:
            body = response.read(12 * 1024 * 1024)
            record.update(status=response.status, resolved_url=response.url, content_type=response.headers.get('Content-Type'), bytes=len(body), sha256=sha256(body).hexdigest())
            if response.headers.get('Content-Encoding') == 'gzip' or body[:2] == b'\x1f\x8b':
                body = gzip.decompress(body)
        text = body.decode('utf-8', errors='replace')
        title = re.search(r'<title[^>]*>(.*?)</title>', text, re.S | re.I)
        record['title'] = title.group(1).strip() if title else None
        (SCRATCH / (name + '.raw')).write_text(text, encoding='utf-8')
        if 'html' in (record['content_type'] or ''):
            parser = VisibleText(); parser.feed(text); plain = '\n'.join(parser.parts)
        else: plain = text
        (SCRATCH / (name + '.txt')).write_text(plain, encoding='utf-8')
        record['visible_chars'] = len(plain)
        record['body_verified'] = False  # A human/agent must inspect content; HTTP 200 alone is not verification.
    except Exception as exc:
        record['error'] = str(exc)
    return record

if __name__ == '__main__':
    SCRATCH.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=5) as pool:
        records = list(pool.map(fetch, URLS.items()))
    (ROOT / 'public-link-checks.json').write_text(json.dumps(records, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    for r in records:
        print(json.dumps({k:r.get(k) for k in ['id','status','resolved_url','title','visible_chars','error']}, ensure_ascii=False))
