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
  
  const batches = [];
  for (let i = 0; i < wps.length; i += 2) {
    batches.push(wps.slice(i, i + 2));
  }
  
  const allScores = [];
  for (const batch of batches) {
    const wpLines = batch.map(w => `${w.id}: ${w.name}`).join('\n');
    const prompt = `Rate LJMU for these Work Packages based ONLY on this URL content about police wellbeing.
If NO clear connection, score 1.0. Be strict.

URL content: ${content}

Work Packages:
${wpLines}

Return ONLY:
${batch[0].id}:1.0
${batch[1] ? batch[1].id + ':1.0' : ''}
No other text.`;

    console.log('Sending batch:', batch.map(w => w.id).join(','));
    const model = sdk.model('Qwen/Qwen3-0.6B');
    const result = await model.run([{ role: 'user', content: prompt }]);
    
    let text = result.output;
    if (typeof text === 'object' && text !== null) text = text.content || text.text || JSON.stringify(text);
    if (typeof text !== 'string') text = String(text);
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    
    console.log('Raw:', text);
    const lines = text.split('\n').filter(l => l.trim() && l.includes(':'));
    lines.forEach(line => {
      const [idPart, scorePart] = line.split(':');
      allScores.push({ id: parseInt(idPart.trim()), score: parseFloat(scorePart.trim()) });
    });
    
    if (batches.indexOf(batch) < batches.length - 1) {
      await new Promise(r => setTimeout(r, 4000));
    }
  }
  
  console.log('All scores:', allScores);
})();
