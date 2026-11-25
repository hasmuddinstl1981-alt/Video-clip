import express from 'express';
import rateLimit from 'express-rate-limit';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { nanoid } from 'nanoid';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);
const PORT = process.env.PORT || 8080;
const DATA = process.env.DATA_DIR || './data';
const MAX_MIN = +(process.env.MAX_VIDEO_MINUTES || 60);
const MAX_JOBS = +(process.env.MAX_CONCURRENT_JOBS || 2);
const KEEP_MS = +(process.env.RETENTION_HOURS || 24) * 3600e3;
const openai = new OpenAI();
const claude = new Anthropic();
const jobs = new Map();
const queue = [];
let active = 0;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));

const YT = /^https?:\/\/((www|m)\.)?(youtube\.com\/(watch\?v=|shorts\/|live\/)|youtu\.be\/)[\w-]{11}/;

app.post('/api/jobs', rateLimit({ windowMs: 3600e3, limit: 10 }), (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!YT.test(url)) return res.status(400).json({ error: 'Enter a valid YouTube video link.' });
  if (!req.body?.permission) return res.status(400).json({ error: 'Confirm you own this video or have permission to use it.' });
  const id = nanoid(12);
  jobs.set(id, { id, url, status: 'queued', step: 'Waiting in line', progress: 0, clips: [], created: Date.now() });
  queue.push(id);
  pump();
  res.json({ id });
});

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found or expired.' });
  res.json({ status: j.status, step: j.step, progress: j.progress, clips: j.clips, error: j.error });
});

app.get('/files/:id/:file', async (req, res) => {
  const { id, file } = req.params;
  if (!jobs.has(id) || !/^short-\d\.mp4$/.test(file)) return res.sendStatus(404);
  const p = path.resolve(DATA, id, file);
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  res.type('video/mp4').sendFile(p);
});

function pump() {
  while (active < MAX_JOBS && queue.length) {
    const id = queue.shift();
    active++;
    process_(jobs.get(id)).catch(e => {
      console.error(e);
      Object.assign(jobs.get(id), { status: 'error', error: e.userMessage || 'Something went wrong while processing this video. Try again.' });
    }).finally(() => { active--; pump(); });
  }
}

const fail = m => Object.assign(new Error(m), { userMessage: m });
const set = (j, step, progress) => Object.assign(j, { status: 'processing', step, progress });

async function process_(j) {
  const dir = path.resolve(DATA, j.id);
  await fs.mkdir(dir, { recursive: true });
  const src = path.join(dir, 'source.mp4');

  set(j, 'Downloading video', 5);
  const dl = ['-f', 'bv*[height<=480]+ba/b[height<=480]', '--merge-output-format', 'mp4', '--no-playlist',
    '--match-filter', `duration<=${MAX_MIN * 60}`, '-o', src, j.url];
  if (process.env.YTDLP_COOKIES) dl.unshift('--cookies', process.env.YTDLP_COOKIES);
  try { await run('yt-dlp', dl, { maxBuffer: 1e7, timeout: 15 * 60e3 }); }
  catch { throw fail(`Couldn't download this video. It may be private, age-restricted, or longer than ${MAX_MIN} minutes.`); }
  try { await fs.access(src); } catch { throw fail(`This video is longer than ${MAX_MIN} minutes.`); }

  set(j, 'Listening to the audio', 20);
  const audio = path.join(dir, 'audio.mp3');
  await run('ffmpeg', ['-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', audio]);
  const tr = await openai.audio.transcriptions.create({
    file: (await import('node:fs')).createReadStream(audio), model: 'whisper-1',
    response_format: 'verbose_json', timestamp_granularities: ['word', 'segment'],
  });
  if (!tr.segments?.length) throw fail('No speech found in this video, so there is nothing to caption.');
  const dur = tr.duration || tr.segments.at(-1).end;

  set(j, 'Finding the best moments', 40);
  const lines = tr.segments.map(s => `[${s.start.toFixed(1)}] ${s.text.trim()}`).join('\n');
  const msg = await claude.messages.create({
    model: 'claude-sonnet-5-5', max_tokens: 2000,
    system: 'You are a viral short-form video editor. Reply with JSON only.',
    messages: [{ role: 'user', content:
`Video length: ${dur.toFixed(0)}s. Transcript with start times in seconds:
${lines}

Pick the 6 most engaging, self-contained moments for YouTube Shorts (fewer only if the video is too short). Each must be 20-55 seconds, start at the beginning of a sentence, end at a natural stop, and not overlap another. Write a punchy on-screen hook (max 8 words) for each.
Return: [{"start":number,"end":number,"hook":"string","reason":"string"}]` }],
  });
  let picks;
  try { picks = JSON.parse(msg.content[0].text.match(/\[[\s\S]*\]/)[0]); } catch { throw fail('The AI returned an unreadable result. Try again.'); }
  picks = picks.filter(p => p.end > p.start && p.start >= 0 && p.start < dur).slice(0, 6)
    .map(p => ({ ...p, end: Math.min(p.end, p.start + 58, dur) }));
  if (!picks.length) throw fail('No strong moments found in this video.');

  const words = tr.words || [];
  for (let i = 0; i < picks.length; i++) {
    set(j, `Creating Short ${i + 1} of ${picks.length}`, 50 + Math.round((i / picks.length) * 48));
    const p = picks[i], n = i + 1;
    await fs.writeFile(path.join(dir, `c${n}.ass`), ass(words, p));
    await run('ffmpeg', ['-y', '-ss', String(p.start), '-t', String(p.end - p.start), '-i', 'source.mp4',
      '-vf', `crop=ih*9/16:ih,scale=480:1920,setsar=1,ass=c${n}.ass:fontsdir=/usr/share/fonts`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', `short-${n}.mp4`],
      { cwd: dir, maxBuffer: 1e7, timeout: 10 * 60e3 });
    j.clips.push({ file: `short-${n}.mp4`, hook: p.hook, duration: Math.round(p.end - p.start) });
  }
  await fs.rm(src, { force: true });
  Object.assign(j, { status: 'done', step: 'Done', progress: 100 });
}

const t = s => { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = (s % 60).toFixed(2).padStart(5, '0'); return `${h}:${String(m).padStart(2, '0')}:${x}`; };
const clean = w => w.replace(/[{}\\\n]/g, '').trim();

function ass(words, p) {
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: 480
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Cap,DejaVu Sans,84,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,2,2,60,60,430,1
Style: Hook,DejaVu Sans,66,&H0066E6FF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,2,8,70,70,230,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;
  const ev = [`Dialogue: 1,${t(0)},${t(Math.min(3, p.end - p.start))},Hook,,0,0,0,,${clean(p.hook || '').toUpperCase()}`];
  const w = words.filter(x => x.start >= p.start - 0.05 && x.end <= p.end + 0.05);
  for (let i = 0; i < w.length; i += 3) {
    const g = w.slice(i, i + 3);
    const s = g[0].start - p.start;
    const e = (w[i + 3]?.start ?? g.at(-1).end + 0.2) - p.start;
    ev.push(`Dialogue: 0,${t(Math.max(0, s))},${t(Math.max(s + 0.2, e))},Cap,,0,0,0,,${g.map(x => clean(x.word)).join(' ').toUpperCase()}`);
  }
  return head + ev.join('\n') + '\n';
}

setInterval(async () => {
  for (const [id, j] of jobs) if (Date.now() - j.created > KEEP_MS && j.status !== 'processing') {
    jobs.delete(id); await fs.rm(path.resolve(DATA, id), { recursive: true, force: true });
  }
}, 3600e3);

await fs.mkdir(DATA, { recursive: true });
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
