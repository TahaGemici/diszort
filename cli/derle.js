// Derleme: Diszort CLI'ı tek dosyalık programa çevirir (Linux x64).
//
//   cd cli && npm ci && node derle.js [--surum v26.11.15] [--commit abc1234] [--depo sahip/ad] [--cikti ../cikti]
//
// 1. cli/ ve bağımlılıkları (jsdom, WebRTC kitaplığının JS'i) esbuild'le tek bir JS dosyasına toplanır.
// 2. Programa gömülecekler: WebRTC'nin yerel kitaplığı (wrtc.node, sıkıştırılmış), web istemcisinin
//    dosyaları (web/: index.html, ana.js, gurultu.js, yanki.js, rnnoise.wasm) ve yapı bilgisi (sürüm).
// 3. Node'un "tek dosyalık uygulama" (SEA) özelliğiyle bunlar Node'un kendisine eklenir: çıkan dosya
//    tek başına çalışır, Node ya da başka bir şey kurmak gerekmez.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const CLI = __dirname;
const KOK = path.resolve(CLI, '..');
const arg = (ad, varsayilan) => {
	const i = process.argv.indexOf(ad);
	return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : varsayilan;
};
const SURUM = arg('--surum', process.env.SURUM || 'yerel');
const COMMIT = arg('--commit', process.env.COMMIT || gitCommit());
const DEPO = arg('--depo', process.env.GITHUB_REPOSITORY || '');
const CIKTI = path.resolve(arg('--cikti', path.join(KOK, 'cikti')));
const MIMARI = process.arch === 'arm64' ? 'arm64' : 'x64';
const AD = `diszort-linux-${MIMARI}`;
// Web istemcisinin programa gömülen dosyaları (sayfanın kendisi ve yüklediği modüller).
const WEB_DOSYALARI = ['index.html', 'ana.js', 'gurultu.js', 'yanki.js', 'rnnoise.wasm'];

function gitCommit() {
	try {
		return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: KOK, encoding: 'utf8' }).trim();
	} catch {
		return '';
	}
}

async function derle() {
	if (process.platform !== 'linux') throw new Error('Derleme Linux\'ta yapılır.');
	const esbuild = require('esbuild');
	const gecici = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'diszort-derle-'));
	fs.mkdirSync(CIKTI, { recursive: true });
	try {
		// 1. Tek JS dosyası.
		const paket = path.join(gecici, 'diszort.js');
		const sonuc = await esbuild.build({
			entryPoints: [path.join(CLI, 'diszort.js')],
			bundle: true,
			platform: 'node',
			target: 'node22',
			format: 'cjs',
			outfile: paket,
			minify: true,
			keepNames: true, // jsdom sınıf adlarına bakıyor
			legalComments: 'none',
			logLevel: 'warning',
			external: ['canvas', 'bufferutil', 'utf-8-validate'],
			plugins: [
				{
					name: 'diszort',
					setup(b) {
						// WebRTC'nin yerel parçası: programa gömülü kopyadan yüklenir.
						b.onResolve({ filter: /^\.\/binding$/ }, (a) => (a.importer.includes(path.join('@roamhq', 'wrtc')) ? { path: path.join(CLI, 'kabuk', 'yerel.js') } : null));
						// jsdom'un eşzamanlı XHR'si ayrı bir süreç dosyası ister (kullanılmıyor): yolu boş bırakılır.
						b.onLoad({ filter: /XMLHttpRequest-impl\.js$/ }, (a) => ({ contents: fs.readFileSync(a.path, 'utf8').replace('require.resolve("./xhr-sync-worker.js")', '""'), loader: 'js' }));
					},
				},
			],
		});
		if (sonuc.errors.length) throw new Error('esbuild hata verdi');

		// 2. Gömülecekler.
		const varliklar = {};
		const yerel = require.resolve(`@roamhq/wrtc-linux-${MIMARI}/wrtc.node`, { paths: [CLI] });
		const sikistirilmis = path.join(gecici, 'wrtc.node.gz');
		let yerelVeri = fs.readFileSync(yerel);
		try {
			// Hata ayıklama bilgisi atılır (~5 MB); strip yoksa olduğu gibi.
			const soyulmus = path.join(gecici, 'wrtc.node');
			execFileSync('strip', ['-s', '-o', soyulmus, yerel]);
			yerelVeri = fs.readFileSync(soyulmus);
		} catch {}
		fs.writeFileSync(sikistirilmis, zlib.gzipSync(yerelVeri, { level: 9 }));
		varliklar['wrtc.node.gz'] = sikistirilmis;
		for (const ad of WEB_DOSYALARI) varliklar['web/' + ad] = path.join(KOK, 'web', ad);
		const yapi = path.join(gecici, 'yapi.json');
		fs.writeFileSync(yapi, JSON.stringify({ surum: SURUM, commit: COMMIT, depo: DEPO }));
		varliklar['yapi.json'] = yapi;

		// 3. SEA: hazırlık dosyası, Node'un kopyasına eklenir.
		const ayar = path.join(gecici, 'sea.json');
		const blob = path.join(gecici, 'sea.blob');
		fs.writeFileSync(ayar, JSON.stringify({ main: paket, output: blob, disableExperimentalSEAWarning: true, useCodeCache: true, assets: varliklar }));
		execFileSync(process.execPath, ['--experimental-sea-config', ayar], { stdio: 'inherit' });
		const program = path.join(CIKTI, AD);
		fs.copyFileSync(process.execPath, program);
		fs.chmodSync(program, 0o755);
		try {
			execFileSync('strip', ['-s', program]);
		} catch {}
		const postject = require.resolve('postject/dist/cli.js', { paths: [CLI] });
		execFileSync(process.execPath, [postject, program, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: ['ignore', 'ignore', 'inherit'] });

		const veri = fs.readFileSync(program);
		const ozet = crypto.createHash('sha256').update(veri).digest('hex');
		fs.writeFileSync(path.join(CIKTI, 'surum.json'), JSON.stringify({ surum: SURUM, commit: COMMIT, sha256: { [AD]: ozet } }, null, '\t') + '\n');
		console.log(`${program}: ${(veri.length / 1e6).toFixed(1)} MB, sürüm ${SURUM} (${COMMIT || 'commit yok'}), sha256 ${ozet}`);
	} finally {
		fs.rmSync(gecici, { recursive: true, force: true });
	}
}

derle().catch((h) => {
	console.error('Derleme başarısız: ' + ((h && h.stack) || h));
	process.exit(1);
});
