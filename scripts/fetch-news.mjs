// 매일 아침 간호·의료 뉴스를 Google 뉴스 RSS에서 모아 docs/news.json 에 저장한다.
import { readFile, writeFile } from 'node:fs/promises';

const OUT = new URL('../docs/news.json', import.meta.url);
const KEEP_DAYS = 14;
const PER_CATEGORY = 15;

const CATEGORIES = [
  { id: 'nursing', name: '간호', queries: ['간호사', '간호법', '간호협회 OR 간호계', '간호인력 OR 간호대학'] },
  { id: 'policy', name: '의료정책', queries: ['보건복지부 의료', '의료개혁 OR 의대 정원', '건강보험 수가'] },
  { id: 'hospital', name: '병원·현장', queries: ['병원 의료진', '상급종합병원 OR 대학병원', '응급실 OR 중환자실'] },
  { id: 'tech', name: '의료기술·AI', queries: ['의료 AI', '디지털헬스케어 OR 원격의료'] },
];

const decode = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();

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

// 제목 앞부분이 같은 기사(통신사 전재 등)는 하나만 남긴다.
const key = (title) => title.replace(/[\s\[\]【】()"'“”‘’·…,.!?]/g, '').slice(0, 22);

async function main() {
  const now = new Date();
  const date = new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10); // KST 날짜
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
    console.log(`${cat.name}: ${items.length}건`);
  }

  let days = [];
  try {
    days = JSON.parse(await readFile(OUT, 'utf8')).days ?? [];
  } catch {}
  days = [{ date, updatedAt: now.toISOString(), categories }, ...days.filter((d) => d.date !== date)].slice(0, KEEP_DAYS);
  await writeFile(OUT, JSON.stringify({ days }, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
