import { createServer } from 'node:http';
import os from 'node:os';
import process from 'node:process';
import v8 from 'node:v8';
import { statfs } from 'node:fs/promises';
import { SpeechClient } from '@google-cloud/speech';

const port = Number(process.env.PORT || 8080);
const startedAt = Date.now();
const startedHrtime = process.hrtime.bigint();
const speechClient = new SpeechClient();
const speechRequestTimes = new Map();
const safeEnvKeys = [
  'CNB_GROUP_ID', 'CNB_STACK_ID', 'CNB_USER_ID', 'GAE_APPLICATION',
  'GAE_DEPLOYMENT_ID', 'GAE_ENV', 'GAE_INSTANCE', 'GAE_MEMORY_MB',
  'GAE_RUNTIME', 'GAE_SERVICE', 'GAE_VERSION', 'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_RUNTIME', 'HOME', 'LANG', 'LANGUAGE', 'LC_ALL', 'NODE_ENV',
  'NODE_OPTIONS', 'NO_UPDATE_NOTIFIER', 'PATH', 'PORT', 'PWD',
];

function htmlEscape(value) {
  return String(value ?? '—').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

function clientIp(req) {
  // App Engine supplies X-Forwarded-For. Its first address is the original client;
  // forwarded headers are proxy-provided and should not be used for authentication.
  const forwarded = req.headers['x-forwarded-for'];
  return forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress || 'unknown';
}

async function collectInfo(req) {
  let disk = { available: false, error: 'Filesystem information unavailable' };
  try {
    const stats = await statfs('/');
    const blockSize = Number(stats.bsize);
    disk = {
      available: true,
      filesystem: '/',
      totalBytes: Number(stats.blocks) * blockSize,
      freeBytes: Number(stats.bfree) * blockSize,
      availableBytes: Number(stats.bavail) * blockSize,
    };
  } catch (error) {
    disk = { available: false, error: error.message };
  }

  const cpus = os.cpus();
  const memory = process.memoryUsage();
  const env = Object.fromEntries(safeEnvKeys
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]));
  const forwardedProto = req.headers['x-forwarded-proto'];
  const forwardedFor = req.headers['x-forwarded-for'];

  return {
    generatedAt: new Date().toISOString(),
    server: {
      nodeVersion: process.version,
      nodeVersions: process.versions,
      platform: process.platform,
      architecture: process.arch,
      hostname: os.hostname(),
      processId: process.pid,
      uptimeSeconds: process.uptime(),
      appUptimeSeconds: Number(process.hrtime.bigint() - startedHrtime) / 1e9,
      startedAt: new Date(startedAt).toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
    },
    cpu: {
      logicalCores: cpus.length,
      model: cpus[0]?.model || 'unknown',
      speedMHz: cpus[0]?.speed || null,
      loadAverage1m5m15m: os.loadavg(),
      note: 'Container-visible values; CPU/load metrics may reflect the managed runtime rather than a dedicated host.',
    },
    memory: {
      hostTotalBytes: os.totalmem(),
      hostFreeBytes: os.freemem(),
      processRssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      v8HeapLimitBytes: v8.getHeapStatistics().heap_size_limit,
      note: 'Host totals are what the runtime exposes and may not equal your instance quota.',
    },
    disk,
    request: {
      clientIp: clientIp(req),
      method: req.method,
      path: req.url,
      host: req.headers.host || null,
      protocol: forwardedProto ? forwardedProto.split(',')[0].trim() : null,
      userAgent: req.headers['user-agent'] || null,
      acceptLanguage: req.headers['accept-language'] || null,
      forwardedFor: forwardedFor || null,
      note: 'Client IP is inferred from proxy headers and can be spoofed outside trusted-proxy handling; do not use it for access control.',
    },
    environment: {
      values: env,
      availableVariableNames: Object.keys(process.env).filter((key) => !safeEnvKeys.includes(key)).sort(),
      note: 'Only an allowlist of non-secret environment values is shown. All other environment values are hidden to avoid exposing credentials or tokens.',
    },
  };
}

function renderPage(info) {
  const { server, cpu, memory, disk, request, environment } = info;
  const row = (label, value) => `<tr><th>${htmlEscape(label)}</th><td>${htmlEscape(value)}</td></tr>`;
  const bytes = (value) => `${formatBytes(value)} (${Number(value).toLocaleString()} bytes)`;
  const envRows = Object.entries(environment.values).map(([key, value]) => row(key, value)).join('');
  const envNames = environment.availableVariableNames.join(', ') || 'None';
  const cpuLoad = cpu.loadAverage1m5m15m.join(' / ') || 'Not available on this platform';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Server information</title>
<style>
:root{font:16px/1.5 system-ui,sans-serif;color-scheme:light dark}body{max-width:1100px;margin:2rem auto;padding:0 1rem;background:Canvas;color:CanvasText}h1{margin-bottom:.2rem}h2{margin:0 0 .6rem}.muted,.note{color:GrayText}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,450px),1fr));gap:1rem}section{border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:12px;padding:1rem;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:.35rem .5rem;border-top:1px solid color-mix(in srgb,CanvasText 12%,transparent)}th{width:38%;font-weight:600}code{overflow-wrap:anywhere}#refresh{font-variant-numeric:tabular-nums}
</style>
</head><body>
<h1>Server information</h1><p class="muted">Live runtime and request diagnostics. Refreshed <span id="refresh">${htmlEscape(info.generatedAt)}</span></p>
<div class="grid">
<section><h2>Runtime</h2><table>
${row('Node.js', server.nodeVersion)}${row('Node component versions', JSON.stringify(server.nodeVersions))}${row('Platform / architecture', `${server.platform} / ${server.architecture}`)}${row('Hostname', server.hostname)}${row('Process ID', server.processId)}${row('Process uptime', formatDuration(server.uptimeSeconds))}${row('App instance uptime', formatDuration(server.appUptimeSeconds))}${row('Process started at (UTC)', server.startedAt)}${row('Timezone / locale', `${server.timezone} / ${server.locale}`)}
</table></section>
<section><h2>CPU</h2><table>
${row('Logical CPUs visible', cpu.logicalCores)}${row('CPU model', cpu.model)}${row('Reported speed', cpu.speedMHz ? `${cpu.speedMHz} MHz` : 'Not reported')}${row('Load average (1 / 5 / 15 min)', cpuLoad)}
</table><p class="note">${htmlEscape(cpu.note)}</p></section>
<section><h2>Memory</h2><table>
${row('Host-visible total', bytes(memory.hostTotalBytes))}${row('Host-visible free', bytes(memory.hostFreeBytes))}${row('Process RSS', bytes(memory.processRssBytes))}${row('V8 heap used / allocated', `${formatBytes(memory.heapUsedBytes)} / ${formatBytes(memory.heapTotalBytes)}`)}${row('V8 heap limit', bytes(memory.v8HeapLimitBytes))}${row('External memory', bytes(memory.externalBytes))}${row('Array buffers', bytes(memory.arrayBuffersBytes))}
</table><p class="note">${htmlEscape(memory.note)}</p></section>
<section><h2>Filesystem</h2><table>
${disk.available ? `${row('Filesystem path', disk.filesystem)}${row('Reported total', bytes(disk.totalBytes))}${row('Free', bytes(disk.freeBytes))}${row('Available to process', bytes(disk.availableBytes))}` : row('Status', disk.error)}
</table><p class="note">Container filesystem stats are runtime-specific and may not represent persistent storage.</p></section>
<section><h2>Current request / client</h2><table>
${row('Client IP (proxy-reported)', request.clientIp)}${row('Method / path', `${request.method} ${request.path}`)}${row('Host', request.host)}${row('Forwarded protocol', request.protocol)}${row('User-Agent', request.userAgent)}${row('Accept-Language', request.acceptLanguage)}${row('X-Forwarded-For', request.forwardedFor)}
</table><p class="note">${htmlEscape(request.note)}</p></section>
<section><h2>Environment</h2><table>${envRows || row('Allowlisted values', 'None provided')}</table><p class="note">${htmlEscape(environment.note)}</p><details><summary>Environment variable names only</summary><p><code>${htmlEscape(envNames)}</code></p></details></section>
</div>
<script>setInterval(async()=>{try{const r=await fetch('/api/info',{cache:'no-store'});if(r.ok){const d=await r.json();document.getElementById('refresh').textContent=d.generatedAt}}catch{}} ,5000)</script>
</body></html>`;
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => tooLarge ? reject(Object.assign(new Error('Áudio excede o limite de 3 MB.'), { statusCode: 413 })) : resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const homePage = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>Início</title><style>:root{font:16px/1.5 system-ui,sans-serif;color-scheme:light dark}body{max-width:760px;margin:3rem auto;padding:0 1rem;background:Canvas;color:CanvasText}main{border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:16px;padding:2rem}a{display:block;margin:.7rem 0}</style></head><body><main><h1>Início</h1><p>Selecione uma página:</p><nav><a href="/transcribe">Gravação e transcrição de áudio</a><a href="/info">Informações do servidor</a></nav></main></body></html>`;

const transcriptionPage = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Transcrição de voz</title>
<style>
:root{font:16px/1.5 system-ui,sans-serif;color-scheme:light dark}body{max-width:760px;margin:3rem auto;padding:0 1rem;background:Canvas;color:CanvasText}main{border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:16px;padding:clamp(1rem,4vw,2rem)}h1{margin-top:0}label{display:block;margin:.8rem 0 .3rem}select,button{font:inherit;padding:.65rem .9rem;border-radius:8px;border:1px solid color-mix(in srgb,CanvasText 30%,transparent);background:Canvas;color:CanvasText}button{cursor:pointer;font-weight:650}button:disabled{opacity:.55;cursor:not-allowed}#transcript,textarea{min-height:6rem;width:100%;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:anywhere;padding:1rem;border-radius:10px;background:color-mix(in srgb,CanvasText 6%,Canvas);color:CanvasText;font:inherit}#status,.muted{color:GrayText}.interim{opacity:.7}nav{margin-top:1.5rem}
</style>
</head><body><main>
<h1>Transcrição de voz</h1>
<p>Pressione <strong>Gravar</strong>, fale e pressione <strong>Parar e transcrever</strong>. O áudio será enviado ao Google Cloud Speech-to-Text e o texto aparecerá após o processamento. Cada gravação é limitada a 55 segundos.</p>
<label for="language">Idioma do reconhecimento</label>
<select id="language"><option value="pt-BR">Português (Brasil)</option><option value="en-US">English (US)</option><option value="es-ES">Español</option></select>
<p><button id="toggle" type="button">Gravar</button> <span id="status" role="status" aria-live="polite">Pronto.</span></p>
<label><input id="serverProcessing" type="checkbox" checked> Habilitar processamento server-side (Google Cloud Speech-to-Text)</label>
<label><input id="removeSilence" type="checkbox" checked> Remover pausas longas antes de enviar o áudio</label>
<p id="audioDurations" class="muted" aria-live="polite">Duração do áudio: aguardando gravação.</p>
<h2>Texto reconhecido</h2><div id="transcript" aria-live="polite">Sua transcrição aparecerá aqui.</div>
<h2>Transcrição em tempo real (navegador)</h2><textarea id="liveTranscript" rows="5" readonly placeholder="A fala aparecerá aqui enquanto você grava."></textarea>
<h2>Transcrição do servidor (Google Cloud)</h2><textarea id="serverTranscript" rows="5" readonly placeholder="Após parar a gravação, o resultado do Google aparecerá aqui."></textarea>
<p class="muted">É necessário permitir o microfone. O áudio gravado é enviado ao Google para transcrição e não é armazenado por esta aplicação. O uso da API pode gerar cobrança acima da cota gratuita vigente.</p>
<nav><a href="/">Início</a> · <a href="/info">Informações do servidor</a></nav>
</main>
<script>
(() => {
  const button = document.getElementById('toggle');
  const status = document.getElementById('status');
  const output = document.getElementById('transcript');
  const language = document.getElementById('language');
  const serverProcessing = document.getElementById('serverProcessing');
  const removeSilence = document.getElementById('removeSilence');
  let stream;
  let audioContext;
  let processor;
  let chunks = [];
  let recording = false;
  let sampleRate = 48000;
  let timer;
  let recognition;
  const durations = document.getElementById('audioDurations');

  function setStatus(message) { status.textContent = message; }
  function stopTracks() { if (stream) stream.getTracks().forEach((track) => track.stop()); stream = null; }

  function removeSilentParts(floatChunks, sampleRate) {
    const samples = new Float32Array(floatChunks.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of floatChunks) { samples.set(part, offset); offset += part.length; }
    const frameSize = Math.max(1, Math.floor(sampleRate * 0.02));
    const threshold = 0.012;
    const keep = new Uint8Array(Math.ceil(samples.length / frameSize));
    for (let frame = 0; frame < keep.length; frame += 1) {
      const start = frame * frameSize;
      const end = Math.min(samples.length, start + frameSize);
      let peak = 0;
      for (let i = start; i < end; i += 1) peak = Math.max(peak, Math.abs(samples[i]));
      if (peak >= threshold) {
        // Preserve 200 ms around speech to avoid clipping consonants and natural pauses.
        const padding = Math.ceil(0.2 * sampleRate / frameSize);
        for (let p = Math.max(0, frame - padding); p <= Math.min(keep.length - 1, frame + padding); p += 1) keep[p] = 1;
      }
    }
    const result = [];
    for (let frame = 0; frame < keep.length; frame += 1) {
      if (!keep[frame]) continue;
      const start = frame * frameSize;
      result.push(samples.slice(start, Math.min(samples.length, start + frameSize)));
    }
    return result;
  }

  function makeWav(floatChunks, sampleRate) {
    const sourceLength = floatChunks.reduce((sum, part) => sum + part.length, 0);
    const ratio = sampleRate / 16000;
    const outputLength = Math.floor(sourceLength / ratio);
    const buffer = new ArrayBuffer(44 + outputLength * 2);
    const view = new DataView(buffer);
    const writeString = (offset, text) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
    writeString(0, 'RIFF'); view.setUint32(4, 36 + outputLength * 2, true);
    writeString(8, 'WAVE'); writeString(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeString(36, 'data'); view.setUint32(40, outputLength * 2, true);
    let sourceOffset = 0;
    let chunkIndex = 0;
    for (let i = 0; i < outputLength; i += 1) {
      const position = i * ratio;
      while (chunkIndex < floatChunks.length - 1 && sourceOffset + floatChunks[chunkIndex].length <= position) {
        sourceOffset += floatChunks[chunkIndex].length;
        chunkIndex += 1;
      }
      const local = position - sourceOffset;
      const current = floatChunks[chunkIndex][Math.floor(local)] || 0;
      const next = floatChunks[chunkIndex][Math.min(Math.floor(local) + 1, floatChunks[chunkIndex].length - 1)] || 0;
      const sample = current + (next - current) * (local % 1);
      view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767), true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  async function stopRecording() {
    if (!recording) return;
    recording = false;
    clearTimeout(timer);
    if (recognition) { recognition.onresult = null; try { recognition.stop(); } catch {} recognition = null; }
    if (processor) { processor.disconnect(); processor.onaudioprocess = null; processor = null; }
    if (audioContext) { await audioContext.close(); audioContext = null; }
    stopTracks();
    if (!serverProcessing.checked) {
      chunks = [];
      button.disabled = false;
      button.textContent = 'Gravar';
      setStatus('Gravação concluída; processamento server-side desabilitado.');
      return;
    }
    button.disabled = true;
    button.textContent = 'Transcrevendo…';
    setStatus('Enviando áudio para o Google Speech-to-Text…');
    try {
      const originalSamples = chunks.reduce((sum, part) => sum + part.length, 0);
      const audioChunks = removeSilence.checked ? removeSilentParts(chunks, sampleRate) : chunks;
      const processedSamples = audioChunks.reduce((sum, part) => sum + part.length, 0);
      const seconds = (value) => (value / sampleRate).toFixed(2) + ' s';
      durations.textContent = 'Duração original: ' + seconds(originalSamples) + ' · após remoção de pausas: ' + seconds(processedSamples);
      const wav = makeWav(audioChunks, sampleRate);
      if (!wav.size || wav.size > 3_000_000) throw new Error('Áudio vazio ou maior que o limite permitido.');
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'audio/wav', 'x-language-code': language.value },
        body: wav,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Erro HTTP ' + response.status);
      output.textContent = result.transcript || 'Nenhuma fala reconhecida. Tente falar mais perto do microfone.';
      document.getElementById('serverTranscript').value = result.transcript || '';
      setStatus(result.transcript ? 'Transcrição concluída.' : 'Áudio processado, mas nenhuma fala foi reconhecida.');
    } catch (error) {
      setStatus('Falha na transcrição: ' + error.message);
    } finally {
      chunks = [];
      button.disabled = false;
      button.textContent = 'Gravar';
    }
  }

  button.addEventListener('click', async () => {
    if (recording) { await stopRecording(); return; }
    if (!navigator.mediaDevices?.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
      setStatus('Este navegador não oferece captura de áudio compatível.');
      return;
    }
    output.textContent = '';
    document.getElementById('liveTranscript').value = '';
    document.getElementById('serverTranscript').value = '';
    durations.textContent = 'Duração do áudio: gravando…';
    setStatus('Solicitando acesso ao microfone…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioContext = new AudioContextClass({ sampleRate: 48000 });
      await audioContext.resume();
      sampleRate = audioContext.sampleRate;
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognition) {
        recognition = new SpeechRecognition();
        recognition.lang = language.value;
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.onresult = (event) => {
          document.getElementById('liveTranscript').value = Array.from(event.results)
            .map((result) => result[0]?.transcript || '').join(' ');
        };
        recognition.onerror = () => {};
        recognition.start();
      } else {
        document.getElementById('liveTranscript').value = 'Este navegador não oferece reconhecimento de fala em tempo real.';
      }
      const source = audioContext.createMediaStreamSource(stream);
      processor = audioContext.createScriptProcessor(4096, 1, 1);
      chunks = [];
      processor.onaudioprocess = (event) => {
        if (!recording) return;
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
        event.outputBuffer.getChannelData(0).fill(0);
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
      recording = true;
      button.textContent = 'Parar e transcrever';
      setStatus('Gravando; fale agora…');
      timer = setTimeout(() => { setStatus('Limite de 55 segundos atingido; transcrevendo…'); stopRecording(); }, 55000);
    } catch (error) {
      stopTracks();
      if (audioContext) { await audioContext.close(); audioContext = null; }
      setStatus('Não foi possível acessar o microfone: ' + error.message + '. Confira as permissões do iPhone.');
    }
  });
})();
</script></body></html>`;

createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/' || pathname === '/transcribe') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(pathname === '/' ? homePage : transcriptionPage);
      return;
    }
    if (pathname === '/info') {
      const info = await collectInfo(req);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(renderPage(info));
      return;
    }
    if (pathname === '/api/transcribe' && req.method === 'POST') {
      const languageCode = ['pt-BR', 'en-US', 'es-ES'].includes(req.headers['x-language-code']) ? req.headers['x-language-code'] : 'pt-BR';
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      if (!contentType.startsWith('audio/wav')) {
        res.writeHead(415, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Formato de áudio inválido; envie WAV PCM.' }));
        return;
      }
      try {
        const audio = await readRequestBody(req, 3_000_000);
        if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
          throw Object.assign(new Error('O áudio recebido não é um WAV válido.'), { statusCode: 400 });
        }
        const channels = audio.readUInt16LE(22);
        const sampleRate = audio.readUInt32LE(24);
        const bitsPerSample = audio.readUInt16LE(34);
        const dataBytes = audio.readUInt32LE(40);
        const durationSeconds = dataBytes / (sampleRate * channels * bitsPerSample / 8);
        if (audio.readUInt16LE(20) !== 1 || channels !== 1 || sampleRate !== 16000 || bitsPerSample !== 16 || dataBytes !== audio.length - 44 || durationSeconds > 55) {
          throw Object.assign(new Error('Formato inválido ou gravação excede 55 segundos.'), { statusCode: 400 });
        }
        const clientAddress = req.headers['x-appengine-user-ip'] || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        const recentRequests = (speechRequestTimes.get(clientAddress) || []).filter((time) => now - time < 60 * 60 * 1000);
        if (recentRequests.length >= 20) {
          throw Object.assign(new Error('Limite de 20 transcrições por hora atingido para este cliente.'), { statusCode: 429 });
        }
        recentRequests.push(now);
        speechRequestTimes.set(clientAddress, recentRequests);
        if (speechRequestTimes.size > 10000) speechRequestTimes.clear();
        const [response] = await speechClient.recognize({
          audio: { content: audio.toString('base64') },
          config: {
            encoding: 'LINEAR16',
            sampleRateHertz: 16000,
            audioChannelCount: 1,
            languageCode,
            enableAutomaticPunctuation: true,
            model: 'latest_short',
          },
        });
        const transcript = (response.results || [])
          .map((result) => result.alternatives?.[0]?.transcript || '')
          .filter(Boolean)
          .join(' ');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ transcript }));
      } catch (error) {
        console.error('Speech transcription failed:', error.message);
        const statusCode = error.statusCode || 502;
        res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: [400, 413, 429].includes(statusCode) ? error.message : `Falha no Google Speech-to-Text (${error.code || 'erro'}). Confira a API, as permissões e as cotas do projeto.` }));
      }
      return;
    }
    if (pathname === '/api/info') {
      const info = await collectInfo(req);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(info));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found\n');
  } catch (error) {
    console.error('Failed to render page:', error);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Unable to render page.\n');
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`Listening on port ${port}`);
});
