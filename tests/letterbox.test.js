'use strict';
// Mixed footage: full-frame 16:9 clips and clips with black bars baked in must come out identical (no bars).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('../src/main/paths');
const { Cache } = require('../src/cache/cache');
const { Scanner } = require('../src/media/scanner');
const ff = require('../src/media/ffmpeg');
const TL = require('../src/timeline/model');
const { resolveSettings } = require('../src/export/presets');
const { renderProject } = require('../src/rendering/renderer');

const ok = spawnSync(paths.ffmpegPath(), ['-version']).status === 0;

test('black bars are detected and removed so mixed clips look uniform', { skip: !ok && 'ffmpeg not runnable', timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ams-lb-'));
  const run = (args) => { const r = spawnSync(paths.ffmpegPath(), ['-v', 'error', '-y', ...args]); assert.strictEqual(r.status, 0, String(r.stderr)); };
  fs.mkdirSync(path.join(tmp, 'moving'));
  run(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-t', '6', '-pix_fmt', 'yuv420p', path.join(tmp, 'moving', 'full.mp4')]);
  run(['-f', 'lavfi', '-i', 'testsrc2=size=1280x536:rate=25', '-vf', 'pad=1280:720:0:92:black', '-t', '6', '-pix_fmt', 'yuv420p', path.join(tmp, 'moving', 'cinema.mp4')]);
  const cache = new Cache(path.join(tmp, 'cache'));
  const cfg = paths.loadConfig(), presets = paths.loadPresets();
  const items = await new Scanner(cache, cfg).scan([path.join(tmp, 'moving')], 'moving');
  const full = items.find((i) => i.name === 'full.mp4'), cin = items.find((i) => i.name === 'cinema.mp4');
  assert.strictEqual(full.bars, null, 'full-frame clip must have no bars');
  assert.ok(cin.bars && Math.abs(cin.bars.y - 92 / 720) < 0.01 && Math.abs(cin.bars.h - 536 / 720) < 0.01, JSON.stringify(cin.bars));

  const tl = TL.create(25);
  const mk = (m, start) => TL.addClip(tl, { kind: 'video', track: 'V1', mediaId: m.id, src: m.path, name: m.name, srcDur: m.duration, srcIn: 0, start, dur: 3, bars: m.bars });
  mk(full, 0); mk(cin, 3);
  const enc = await ff.detectEncoders();
  const base = { mode: 'fast', res: 720, fps: 25, aspect: '16:9', container: 'mp4', codec: 'h264', hw: 'off' };
  for (const [autoCrop, expectBars] of [[true, false], [false, true]]) {
    const s = resolveSettings({ ...base, autoCrop }, presets, enc);
    const out = path.join(tmp, `out-${autoCrop}.mp4`);
    await renderProject({ timeline: tl, settings: s, outPath: out, cache, totalDur: 6 });
    // inspect the second half (the cinema clip) of the OUTPUT for black bars
    const r = spawnSync(paths.ffmpegPath(), ['-hide_banner', '-ss', '3.5', '-i', out, '-t', '1', '-vf', 'cropdetect=limit=24:round=2:reset=0', '-f', 'null', '-']);
    const m = [...String(r.stderr).matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].pop();
    const [, w, h] = m.map(Number);
    if (expectBars) assert.ok(h < 700, 'with auto-crop off the bars remain (h=' + h + ')');
    else assert.ok(h >= 716 && w >= 1276, 'bars must be gone, detected content ' + w + 'x' + h);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});
