// Cloudflare Pages Function: GET /api/tts?text=ആന  ->  audio/mpeg
// Speaks any Malayalam text with Azure's neural voice, so words added later work too.
// Needs two settings on the Pages project: AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.
// Optional: AZURE_VOICE (default ml-IN-SobhanaNeural; the male voice is ml-IN-MidhunNeural).

const MAX_LEN = 60;
const ALLOWED = /^[ഀ-ൿ‌‍ A-Za-z0-9.,!?'\-]+$/;   // Malayalam, Latin letters, digits, basic punctuation

const xml = s => s.replace(/[<>&"']/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'}[c]));
const json = (o, status) => new Response(JSON.stringify(o), {status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}});

// Safari asks for audio in byte ranges, so answer those properly.
function reply(buf, range) {
  const size = buf.byteLength;
  const base = {'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400'};
  const m = /^bytes=(\d*)-(\d*)$/.exec(range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
    let end = m[1] === '' ? size - 1 : (m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1));
    if (start < 0) start = 0;
    if (start >= size || start > end) return new Response(null, {status: 416, headers: {'Content-Range': `bytes */${size}`}});
    return new Response(buf.slice(start, end + 1), {status: 206, headers: {...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1)}});
  }
  return new Response(buf, {status: 200, headers: {...base, 'Content-Length': String(size)}});
}

export async function onRequestGet(context) {
  const {request, env} = context;
  const url = new URL(request.url);
  const text = (url.searchParams.get('text') || '').trim();
  if (!text || text.length > MAX_LEN) return json({error: 'text must be 1 to ' + MAX_LEN + ' characters'}, 400);
  if (!ALLOWED.test(text)) return json({error: 'unsupported characters'}, 400);
  if (!env.AZURE_SPEECH_KEY || !env.AZURE_SPEECH_REGION) return json({error: 'speech is not set up on this site yet'}, 501);

  const voice = env.AZURE_VOICE || 'ml-IN-SobhanaNeural';
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(url.origin + '/api/tts?v=1&voice=' + encodeURIComponent(voice) + '&text=' + encodeURIComponent(text));

  // 1. already made? serve it without calling Azure again
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return reply(await hit.arrayBuffer(), request.headers.get('Range'));
  }

  // 2. make it
  const ssml = `<speak version="1.0" xml:lang="ml-IN"><voice xml:lang="ml-IN" name="${xml(voice)}"><prosody rate="-15%">${xml(text)}</prosody></voice></speak>`;
  let res;
  try {
    res = await fetch(`https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'akshara-kali'
      },
      body: ssml
    });
  } catch (e) { return json({error: 'could not reach the speech service'}, 502); }
  if (!res.ok) return json({error: 'speech service said ' + res.status}, 502);

  const buf = await res.arrayBuffer();
  if (cache) {
    const stored = new Response(buf, {headers: {'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=2592000'}});
    context.waitUntil(cache.put(cacheKey, stored));
  }
  return reply(buf, request.headers.get('Range'));
}
