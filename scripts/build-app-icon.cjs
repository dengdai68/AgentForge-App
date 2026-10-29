// Convert the supplied, unmodified PNG into committed native icon sizes.
// No browser, network, redraw, or operator configuration is involved.
const { mkdtemp, mkdir, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

  async function build() {
    if (process.platform !== 'darwin') throw new Error('Icon generation requires macOS iconutil; generated assets are committed.');
    const scratch = await mkdtemp(join(tmpdir(), 'agentforge-icon-'));
    try {
      const png = resolve('web/icons/application.png');
      const source = await readFile(png);
      if (source.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || source.readUInt32BE(16) !== source.readUInt32BE(20) || source.readUInt32BE(16) < 1024) throw new Error('Application icon must be a square PNG of at least 1024px.');
      const iconset = join(scratch, 'application.iconset'); await mkdir(iconset);
      for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
        execFileSync('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), png, '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
      }
      execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', resolve('apps/electron/application.icns')]);
      console.log('Generated application.icns from the unchanged application.png');
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  build().catch(error => { console.error(error); process.exitCode = 1; });
