// Railway용 서버: docs/ 정적 파일 + /news.json 제공, 매일 07:00 KST 뉴스 갱신.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateNews, readNews, kstDate } from './scripts/fetch-news.mjs';

const PORT = process.env.PORT || 3000;
const DATA_FILE = join(process.env.DATA_DIR || './data', 'news.json');
const STATIC = fileURLToPath(new URL('./docs/', import.meta.url));
const UPDATE_HOUR_KST = 7;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

let updating = null;
const refresh = () =>
  (updating ??= updateNews(DATA_FILE)
    .catch((e) => console.error('뉴스 갱신 실패:', e.message))
    .finally(() => (updating = null)));

// 오늘 07시(KST)가 지났는데 오늘자 데이터가 없으면 갱신한다. (서버가 잠들었다 깨어난 경우 대비)
async function ensureFresh() {
  const { days } = await readNews(DATA_FILE);
  const kstHour = (new Date().getUTCHours() + 9) % 24;
  const stale = !days.length || (days[0].date !== kstDate() && kstHour >= UPDATE_HOUR_KST);
  if (stale) await refresh();
}

function scheduleDaily() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(UPDATE_HOUR_KST - 9 + 24, 0, 0, 0); // 07:00 KST = 22:00 UTC (전날)
  while (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  while (next - now > 86400e3) next.setUTCDate(next.getUTCDate() - 1);
  setTimeout(() => refresh().finally(scheduleDaily), next - now);
  console.log('다음 갱신:', next.toISOString());
}

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    if (path === '/news.json') {
      await ensureFresh();
      res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify(await readNews(DATA_FILE)));
    }
    if (path === '/refresh' && req.method === 'POST') {
      await refresh();
      res.writeHead(204);
      return res.end();
    }
    const file = normalize(join(STATIC, path.endsWith('/') ? path + 'index.html' : path));
    if (!file.startsWith(normalize(STATIC))) throw new Error('forbidden');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`listening on ${PORT}`);
  ensureFresh();
  scheduleDaily();
});
