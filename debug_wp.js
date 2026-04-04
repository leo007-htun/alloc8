const Bytez = require('bytez.js');
const sdk = new Bytez('c83895ef7c4ccca7c35e864c70115b8d');

async function fetchUrlText(url, maxChars = 1200) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const html = await res.text();
    let text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    return text.slice(0, maxChars);
  } catch (e) {
    return null;
  }
}

(async () => {
  const content = await fetchUrlText('https://www.ljmu.ac.uk/about-us/news/articles/2026/4/1/police-chiefs-wellbeing');
  const db = require('better-sqlite3')('data.sqlite');
  const wps = db.prepare('SELECT id, name FROM wps ORDER BY sort_order').all();
  const wpLines = wps.map(w => `${w.id}: ${w.name}`).join('\n');
  
  const prompt = `You are a strict evaluator rating a consortium partner for project Work Packages.
BASE YOUR SCORES ONLY ON THE URL CONTENT PROVIDED BELOW.
If the URL content does not clearly demonstrate expertise directly related to a Work Package, give a LOW score (1.0-2.0).
Do NOT assume the partner is good at everything because they are a university or company. Be critical and evidence-based.

Partner: LJMU
Type: university

Evidence (URL content excerpts):
URL 1: https://www.ljmu.ac.uk/about-us/news/articles/2026/4/1/police-chiefs-wellbeing
Description: Police wellbeing article
Content excerpt: ${content}

Work Packages to rate (1.0 = no relevance, 5.0 = highly relevant):
${wpLines}

Reply with ONLY Work Package ID and score on separate lines like:
1:2.0
2:4.5
No other text.`;

  console.log('Prompt length:', prompt.length);
  const model = sdk.model('Qwen/Qwen3-0.6B');
  const result = await model.run([{ role: 'user', content: prompt }]);
  
  if (result.error) {
    console.log('Error:', result.error);
    return;
  }
  
  let text = result.output;
  if (typeof text === 'object' && text !== null) text = text.content || text.text || JSON.stringify(text);
  if (typeof text !== 'string') text = String(text);
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  text = text.trim();
  
  console.log('Raw output:');
  console.log(text);
  console.log('---');
  const lines = text.split('\n').filter(l => l.trim() && l.includes(':'));
  console.log('Parsed lines:', lines.length);
  console.log(lines);
})();
