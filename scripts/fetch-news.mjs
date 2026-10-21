// 간호·의료 뉴스를 Google 뉴스 RSS에서 모아 news.json 에 누적 저장한다.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEP_DAYS = 14;
const PER_CATEGORY = 15;

const CATEGORIES = [
  { id: 'nursing', name: '간호', queries: ['간호사', '간호법', '간호협회 OR 간호계', '간호인력 OR 간호대학'] },
  { id: 'policy', name: '의료정책', queries: ['보건복지부 의료', '의료개혁 OR 의대 정원', '건강보험 수가'] },
  { id: 'hospital', name: '병원·현장', queries: ['병원 의료진', '상급종합병원 OR 대학병원', '응급실 OR 중환자실'] },
  { id: 'tech', name: '의료기술·AI', queries: ['의료 AI', '디지털헬스케어 OR 원격의료'] },
];

export const kstDate = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);

const decode = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
};

async function search(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' when:1d')}&hl=ko&gl=KR&ceid=KR:ko`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (nursing-news personal reader)' } });
  if (!res.ok) throw new Error(`${res.status} ${query}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const source = tag(item, 'source');
    let title = tag(item, 'title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    return { title, link: tag(item, 'link'), source, published: new Date(tag(item, 'pubDate')).toISOString() };
  });
}

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36' };
const timeout = (ms) => AbortSignal.timeout(ms);

// Google 뉴스 링크 → 실제 기사 주소
async function resolveGoogleLink(link) {
  const id = link.match(/\/articles\/([^?]+)/)?.[1];
  if (!id) throw new Error('잘못된 링크');
  const page = await (await fetch(`https://news.google.com/articles/${id}`, { headers: UA, signal: timeout(8000) })).text();
  const sig = page.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sig || !ts) throw new Error('서명 없음');
  const payload = [[['Fbv4je', JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, +ts, sig])]]];
  const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'f.req=' + encodeURIComponent(JSON.stringify(payload)),
    signal: timeout(8000),
  });
  const text = await res.text();
  return JSON.parse(JSON.parse(text.split('\n\n')[1])[0][2])[1];
}

const meta = (html, name) => {
  const m =
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i'));
  return m ? decode(m[1]) : '';
};

// 팝업에 보여줄 기사 정보: 실제 주소, 요약, 대표 이미지, 앱 안(iframe)에서 열 수 있는지
export async function resolveArticle(link) {
  const url = await resolveGoogleLink(link);
  const res = await fetch(url, { headers: UA, signal: timeout(8000) });
  const buf = Buffer.from(await res.arrayBuffer());
  const charset =
    (res.headers.get('content-type') || '').match(/charset=([\w-]+)/i)?.[1] ||
    buf.subarray(0, 4096).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ||
    'utf-8';
  let html;
  try {
    html = new TextDecoder(charset).decode(buf.subarray(0, 300_000));
  } catch {
    html = buf.subarray(0, 300_000).toString('utf8');
  }
  const xfo = (res.headers.get('x-frame-options') || '').toLowerCase();
  const csp = res.headers.get('content-security-policy') || '';
  const finalUrl = res.url || url;
  let image = meta(html, 'og:image') || meta(html, 'twitter:image');
  if (image) image = new URL(image, finalUrl).href.replace(/^http:/, 'https:');
  return {
    url: finalUrl,
    description: (meta(html, 'og:description') || meta(html, 'description')).replace(/\s+/g, ' ').slice(0, 300),
    image,
    embeddable: finalUrl.startsWith('https:') && (!xfo || xfo === 'allowall') && !/frame-ancestors/i.test(csp),
  };
}

// 제목 앞부분이 같은 기사(통신사 전재 등)는 하나만 남긴다.
const key = (title) => title.replace(/[\s\[\]【】()"'“”‘’·…,.!?]/g, '').slice(0, 22);

export async function readNews(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return { days: [] };
  }
}

export async function updateNews(file) {
  const now = new Date();
  const date = kstDate(now);
  const seen = new Set();
  const categories = [];

  for (const cat of CATEGORIES) {
    const results = await Promise.allSettled(cat.queries.map(search));
    results.filter((r) => r.status === 'rejected').forEach((r) => console.warn('skip:', r.reason.message));
    const items = results
      .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
      .sort((a, b) => b.published.localeCompare(a.published))
      .filter((it) => {
        const k = key(it.title);
        if (!it.title || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, PER_CATEGORY);
    categories.push({ id: cat.id, name: cat.name, items });
  }
  const total = categories.reduce((n, c) => n + c.items.length, 0);
  if (!total) throw new Error('기사를 하나도 가져오지 못했습니다');
  console.log(`${date} 뉴스 ${total}건 수집`);

  // 주요 뉴스 카드(분야별 첫 기사)에는 사진·요약을 미리 붙여 둔다.
  await Promise.allSettled(
    categories.filter((c) => c.items[0]).map(async (c) => Object.assign(c.items[0], await resolveArticle(c.items[0].link)))
  );

  const { days } = await readNews(file);
  const data = {
    days: [{ date, updatedAt: now.toISOString(), categories }, ...days.filter((d) => d.date !== date)].slice(0, KEEP_DAYS),
  };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data));
  return data;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  updateNews(fileURLToPath(new URL('../data/news.json', import.meta.url))).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
