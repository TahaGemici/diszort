// CLI denemesi: terminal istemcisi (cli/, Go) gerçek sunucuda, gerçek Chromium'la aynı kanalda.
//
// CLI kendi süreci olarak çalışır; komutlar stdin'den yazılır, çıktısı okunur (terminal değilken satır
// satır çalışır). Denenen:
//   - giriş: anahtar bağlantısıyla; ayar dosyası programın yanında (0600), anahtar içinde
//   - kapıyı çalma: Chromium'daki kişinin isteği CLI'da görünür, /kabul ile içeri alınır
//   - yazı: iki yönde
//   - ses: CLI ↔ Chromium iki yönde (CLI hoparlöre gerçekten çalıyor), kayıplara karşı yedek (RED) iki yönde
//   - ses paylaşımı: CLI bilgisayardaki uygulamaların sesini paylaşır (kendi çaldığı hariç), Chromium alır
//   - ekran paylaşımı (Xvfb varsa): CLI ekranını paylaşır, Chromium görüntüyü çözer
//   - dosya: Chromium → CLI (indirilenin özeti aynı), CLI → Chromium (resim önizlemesi)
//   - program: --surum, ayar dosyasıyla adres vermeden açılış
//
//   node test/cli.js                       kendi sunucusunu açar (node sunucu/sunucu.js, geçici veri)
//   node test/cli.js http://adres:port     çalışan sunucuya bağlanır (ILK_ANAHTAR gerekir)
//   CLI_IKILI=cikti/diszort-linux-x64 node test/cli.js   derlenmiş programla (yoksa cli/'den derlenir)
//
// Gerekenler: playwright + Chromium, PulseAudio (deneme kendi PulseAudio'sunu sanal aygıtlarla
// başlatır; yoksa atlanır, CLI_ZORUNLU=1 ise hata), ekran için Xvfb (yoksa o deneme atlanır).
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const KOK = path.resolve(__dirname, '..');
const zorunlu = process.env.CLI_ZORUNLU === '1';
const atla = (neden) => {
	console.log(`CLI denemesi atlandı: ${neden}`);
	process.exit(zorunlu ? 1 : 0);
};
let chromium;
try {
	({ chromium } = require('playwright'));
} catch {
	atla('playwright kurulu değil (npm install --no-save playwright && npx playwright install chromium)');
}
if (spawnSync('pulseaudio', ['--version']).status !== 0) atla('PulseAudio yok (sudo apt install pulseaudio pulseaudio-utils)');

const ANAHTAR = process.env.ILK_ANAHTAR || 'a1b2c3d4'.repeat(16);
const DIS_ADRES = process.argv[2] || process.env.ADRES || '';
const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const gecici = fs.mkdtempSync(path.join(os.tmpdir(), 'diszort-cli-'));

// ---------------------------------------------------------------- deneme düzeni

let gecen = 0;
const SECILI = process.env.DENEME ? new RegExp(process.env.DENEME) : null;
async function dene(ad, fn) {
	if (SECILI && !SECILI.test(ad)) return console.log(`atla ${ad} (DENEME süzgeci)`);
	const t0 = Date.now();
	try {
		await fn();
		gecen++;
		console.log(`ok   ${ad} (${((Date.now() - t0) / 1000).toFixed(1)} sn)`);
	} catch (e) {
		process.exitCode = 1;
		console.error('HATA ' + ad + '\n     ' + (e && e.stack ? e.stack : e));
		console.error('     CLI çıktısının sonu:\n' + cikti.slice(-25).map((s) => '     | ' + s).join('\n'));
	}
}
async function kosul(aciklama, fn, ms = 20000, aralik = 100) {
	const son = Date.now() + ms;
	let v;
	while (Date.now() < son) {
		try {
			v = await fn();
			if (v) return v;
		} catch (e) {
			v = e;
		}
		await bekle(aralik);
	}
	throw new Error(`beklenen olmadı (${ms} ms): ${aciklama}; son: ${v instanceof Error ? v.message : JSON.stringify(v)}`);
}

// ---------------------------------------------------------------- sunucu

let sunucu = null;
let ADRES = DIS_ADRES.replace(/\/$/, '');
async function sunucuBaslat() {
	if (ADRES) return;
	const veri = path.join(gecici, 'sunucu');
	fs.mkdirSync(veri);
	const port = 19000 + Math.floor(Math.random() * 900);
	sunucu = spawn(process.execPath, [path.join(KOK, 'sunucu/sunucu.js')], {
		env: { ...process.env, AYAR_DOSYASI: path.join(veri, 'yok.env'), VERI_KLASORU: veri, PORT: String(port), TURN_PORT: String(port + 1000), ILK_ANAHTAR: ANAHTAR, GIRIS_ARALIK_MS: '200', GIRIS_KOVA: '5', TANI: '0' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let gunluk = '';
	sunucu.stdout.on('data', (d) => (gunluk += d));
	sunucu.stderr.on('data', (d) => (gunluk += d));
	await kosul('sunucu açıldı', () => /Diszort çalışıyor/.test(gunluk) || (sunucu.exitCode !== null && Promise.reject(new Error(gunluk))), 15000);
	ADRES = `http://127.0.0.1:${port}`;
}

// ---------------------------------------------------------------- ses: kendi PulseAudio'muz
//
// CLI: hoparlörü diszort_hoparlor, mikrofonu diszort_mik (diszort_mikkaynak'a çalınan ses). Chromium'un
// çaldıkları ayrı bir çıkışa gider (diszort_tarayici): CLI'nın hoparlörünü ölçmeye karışmasın.

const PULSE = path.join(gecici, 'pulse');
const pulseOrtami = { ...process.env, XDG_RUNTIME_DIR: PULSE, PULSE_RUNTIME_PATH: path.join(PULSE, 'pulse') };
delete pulseOrtami.PULSE_SERVER;
function pulseBaslat() {
	fs.mkdirSync(PULSE, { mode: 0o700 });
	const r = spawnSync(
		'pulseaudio',
		[
			'-n',
			'--daemonize=yes',
			'--exit-idle-time=-1',
			'--use-pid-file=yes',
			'--log-target=file:' + path.join(PULSE, 'pulse.log'),
			'--load=module-native-protocol-unix',
			'--load=module-null-sink sink_name=diszort_hoparlor rate=48000 channels=2 sink_properties=device.description=Deneme-Hoparlor',
			'--load=module-null-sink sink_name=diszort_mikkaynak rate=48000 channels=2 sink_properties=device.description=Deneme-Mik-Kaynagi',
			'--load=module-null-sink sink_name=diszort_tarayici rate=48000 channels=2 sink_properties=device.description=Deneme-Tarayici',
			'--load=module-remap-source master=diszort_mikkaynak.monitor source_name=diszort_mik source_properties=device.description=Deneme-Mikrofon',
		],
		{ env: pulseOrtami, encoding: 'utf8' },
	);
	if (r.status !== 0) throw new Error('PulseAudio başlamadı: ' + r.stderr + (fs.existsSync(path.join(PULSE, 'pulse.log')) ? fs.readFileSync(path.join(PULSE, 'pulse.log'), 'utf8').slice(-800) : ''));
	spawnSync('pactl', ['set-default-sink', 'diszort_hoparlor'], { env: pulseOrtami });
	spawnSync('pactl', ['set-default-source', 'diszort_mik'], { env: pulseOrtami });
}
function pulseDurdur() {
	spawnSync('pulseaudio', ['--kill'], { env: pulseOrtami });
}
// Bir aygıta wav'ı döngüde çal (ayrı bir uygulama gibi); dönüş: durdur().
function cal(aygit, dosya, ad = 'deneme') {
	let p = null;
	let bitti = false;
	const basla = () => {
		p = spawn('paplay', ['--device=' + aygit, '--client-name=' + ad, dosya], { env: pulseOrtami, stdio: 'ignore' });
		p.on('exit', () => !bitti && setTimeout(basla, 10));
	};
	basla();
	return () => {
		bitti = true;
		if (p) p.kill();
	};
}
// Aygıttan ms kadar kaydet: { rmsDb, sesliOran } (20 ms pencerelerde sessiz olmayanların oranı).
function kaydet(aygit, ms) {
	return new Promise((coz) => {
		const p = spawn('parec', ['--device=' + aygit, '--rate=48000', '--channels=1', '--format=float32le', '--latency-msec=20'], { env: pulseOrtami });
		const parcalar = [];
		p.stdout.on('data', (d) => parcalar.push(d));
		setTimeout(() => p.kill('SIGINT'), ms);
		p.on('exit', () => {
			const b = Buffer.concat(parcalar);
			const n = Math.floor(b.length / 4);
			let e = 0;
			let sesli = 0;
			let pencere = 0;
			for (let w = 0; w + 960 <= n; w += 960) {
				let pe = 0;
				for (let i = 0; i < 960; i++) pe += b.readFloatLE((w + i) * 4) ** 2;
				e += pe;
				pencere++;
				if (Math.sqrt(pe / 960) > 0.003) sesli++;
			}
			coz({ rmsDb: 10 * Math.log10(e / Math.max(1, n) + 1e-12), sesliOran: sesli / Math.max(1, pencere) });
		});
	});
}

// Konuşmaya benzeyen sinyal (48 kHz mono; test/tarayici.js'teki ile aynı).
function konusmaWav(dosya, saniye = 12, { perde: perdeTaban = 140, hece: heceHizi = 3.7, tohum: ilkTohum = 7 } = {}) {
	const HIZ = 48000;
	const N = HIZ * saniye;
	const v = Buffer.alloc(44 + N * 2);
	let faz = 0;
	let tohum = ilkTohum;
	const rastgele = () => ((tohum = (Math.imul(tohum, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
	for (let i = 0; i < N; i++) {
		const t = i / HIZ;
		const perde = perdeTaban + 45 * Math.sin(2 * Math.PI * 0.37 * t) + 20 * Math.sin(2 * Math.PI * 2.3 * t);
		faz += (2 * Math.PI * perde) / HIZ;
		let s = 0;
		for (let h = 1; h <= 24; h++) {
			const f = h * perde;
			const formant = Math.exp(-(((f - 500) / 300) ** 2)) + 0.6 * Math.exp(-(((f - 1500) / 400) ** 2)) + 0.35 * Math.exp(-(((f - 2600) / 500) ** 2));
			s += (Math.sin(h * faz) / h) * (0.25 + formant);
		}
		const hece = Math.max(0, Math.sin(2 * Math.PI * heceHizi * t)) ** 0.6;
		const cumle = t % 4 < 3.4 ? 1 : 0.02;
		s = s * hece * cumle * 0.35 + rastgele() * 0.01;
		v.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * 32767))), 44 + i * 2);
	}
	wavBasligi(v, N, 1);
	fs.writeFileSync(dosya, v);
}
// Stereo müzik: solda 500 Hz, sağda 800 Hz (bilgisayarda çalan bir uygulama).
function muzikWav(dosya, saniye = 10) {
	const N = 48000 * saniye;
	const v = Buffer.alloc(44 + N * 4);
	for (let i = 0; i < N; i++) {
		v.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 500 * i) / 48000)), 44 + i * 4);
		v.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 800 * i) / 48000)), 46 + i * 4);
	}
	wavBasligi(v, N, 2);
	fs.writeFileSync(dosya, v);
}
function wavBasligi(v, N, kanal) {
	v.write('RIFF', 0);
	v.writeUInt32LE(36 + N * 2 * kanal, 4);
	v.write('WAVEfmt ', 8);
	v.writeUInt32LE(16, 16);
	v.writeUInt16LE(1, 20);
	v.writeUInt16LE(kanal, 22);
	v.writeUInt32LE(48000, 24);
	v.writeUInt32LE(48000 * 2 * kanal, 28);
	v.writeUInt16LE(2 * kanal, 32);
	v.writeUInt16LE(16, 34);
	v.write('data', 36);
	v.writeUInt32LE(N * 2 * kanal, 40);
}
// Küçük geçerli bir PNG (Chromium önizlemede gösterebilsin).
function png(dosya, w = 24, h = 16) {
	const crcTablo = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (b) => {
		let c = 0xffffffff;
		for (const x of b) c = crcTablo[(c ^ x) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const parca = (tur, veri) => {
		const b = Buffer.alloc(12 + veri.length);
		b.writeUInt32BE(veri.length, 0);
		b.write(tur, 4);
		veri.copy(b, 8);
		b.writeUInt32BE(crc(b.subarray(4, 8 + veri.length)), 8 + veri.length);
		return b;
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const ham = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ham.set([x * 10, y * 15, 200], y * (w * 3 + 1) + 1 + x * 3);
	fs.writeFileSync(dosya, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), parca('IHDR', ihdr), parca('IDAT', zlib.deflateSync(ham)), parca('IEND', Buffer.alloc(0))]));
}
const ozet = (dosya) => crypto.createHash('sha256').update(fs.readFileSync(dosya)).digest('hex');

// ---------------------------------------------------------------- ekran: Xvfb

let xvfb = null;
let EKRAN = '';
async function xvfbBaslat() {
	if (spawnSync('which', ['Xvfb']).status !== 0) return false;
	const no = 90 + Math.floor(Math.random() * 9);
	xvfb = spawn('Xvfb', [':' + no, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
	EKRAN = ':' + no;
	await bekle(800);
	if (xvfb.exitCode !== null) return false;
	// Ekranda değişen bir şey olsun (kodlayıcı boş kareleri atlamasın): renkli arka plan.
	spawnSync('xsetroot', ['-solid', 'steelblue'], { env: { ...process.env, DISPLAY: EKRAN } });
	return true;
}

// ---------------------------------------------------------------- CLI süreci

let cli = null;
let cikti = [];
let PROGRAM = '';
let klasor = '';
const ev = path.join(gecici, 'ev');

function programHazirla() {
	klasor = path.join(gecici, 'program');
	fs.mkdirSync(klasor, { recursive: true });
	PROGRAM = path.join(klasor, 'diszort');
	if (process.env.CLI_IKILI) {
		fs.copyFileSync(path.resolve(process.env.CLI_IKILI), PROGRAM);
	} else {
		if (!fs.existsSync(path.join(KOK, 'cli/gurultu/rnnoise_w2c.c'))) spawnSync('sh', [path.join(KOK, 'cli/gurultu/uret.sh')], { stdio: 'inherit' });
		const r = spawnSync('go', ['build', '-o', PROGRAM, '.'], { cwd: path.join(KOK, 'cli'), stdio: 'inherit' });
		if (r.status !== 0) atla('CLI derlenemedi (go, libopus-dev, libvpx-dev, libyuv-dev, wabt gerekir) ya da CLI_IKILI verilmedi');
	}
	fs.chmodSync(PROGRAM, 0o755);
}

function cliBaslat(argv = [], ek = {}) {
	cikti = [];
	const ortam = { ...pulseOrtami, HOME: ev, DISZORT_BETIK: '1', ...(process.env.DISZORT_PROFIL ? { DISZORT_PROFIL: process.env.DISZORT_PROFIL } : {}), ...ek };
	delete ortam.XDG_CONFIG_HOME;
	if (EKRAN) ortam.DISPLAY = EKRAN;
	else delete ortam.DISPLAY;
	delete ortam.WAYLAND_DISPLAY;
	cli = spawn('./diszort', argv, { cwd: klasor, env: ortam, stdio: ['pipe', 'pipe', 'pipe'] });
	readline.createInterface({ input: cli.stdout }).on('line', (s) => cikti.push(s));
	readline.createInterface({ input: cli.stderr }).on('line', (s) => cikti.push('[stderr] ' + s));
	return cli;
}
const cliYaz = (s) => cli.stdin.write(s + '\n');
// cliBekle: çıktıda kalıba uyan satır (bas: bu sıradan sonrası).
async function cliBekle(kalip, ms = 20000, bas = 0) {
	return kosul('CLI çıktısında ' + kalip, () => cikti.slice(bas).find((s) => kalip.test(s)), ms);
}
async function cliDurum() {
	const bas = cikti.length;
	cliYaz('/durum json');
	const s = await cliBekle(/^DURUM /, 5000, bas);
	return JSON.parse(s.slice(6));
}
// Sürecin işlemci (tek çekirdeğin yüzdesi) ve bellek kullanımı (ms boyunca).
async function kaynakOlc(pid, ms = 5000) {
	const oku = () => {
		const a = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
		return Number(a[11]) + Number(a[12]);
	};
	const hz = 100;
	const t0 = Date.now();
	const c0 = oku();
	await bekle(ms);
	const c1 = oku();
	const rss = Number((fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/) || [])[1] || 0) / 1024;
	return { cpu: ((c1 - c0) / hz / ((Date.now() - t0) / 1000)) * 100, rss };
}
async function cliKapat() {
	if (!cli || cli.exitCode !== null) return;
	cliYaz('/çık');
	cli.stdin.end();
	await kosul('CLI kapandı', () => cli.exitCode !== null, 8000).catch(() => cli.kill('SIGKILL'));
}

// Chromium'daki sayfanın eşlerinin istatistikleri (sayfanın kendi değişkenlerinden).
const OLCUM = `(async () => {
	const s = {};
	for (const [ad, es] of esler) {
		const o = { durum: es.pc ? es.pc.connectionState : 'yok' };
		const oku = async (n, tur) => { let b = null; let r = null; if (n) { r = await n.getStats(); r.forEach((x) => { if (x.type === tur) b = x; }); } return [b, r]; };
		if (es.pc && es.tr) {
			const [g, r] = await oku(es.tr.receiver, 'inbound-rtp');
			if (g) {
				o.enerji = g.totalAudioEnergy || 0;
				o.bayt = g.bytesReceived || 0;
				o.paket = g.packetsReceived || 0;
				o.uydurulan = (g.concealedSamples || 0) - (g.silentConcealedSamples || 0);
				o.ornek = g.totalSamplesReceived || 0;
			}
			o.gidenRed = redAnlasildi(es.tr, 'giden');
			const [y] = await oku(es.trSes && es.trSes.receiver, 'inbound-rtp');
			o.yayinEnerji = y ? y.totalAudioEnergy || 0 : 0;
			const [v] = await oku(es.trGoruntu && es.trGoruntu.receiver, 'inbound-rtp');
			if (v) Object.assign(o, { kare: v.framesDecoded || 0, genislik: v.frameWidth || 0, yukseklik: v.frameHeight || 0, goruntuKodek: (r && v.codecId && r.get(v.codecId)) ? r.get(v.codecId).mimeType : '' });
		}
		s[ad] = o;
	}
	return JSON.stringify(s);
})()`;
let sayfa = null;
const olcTarayici = async () => JSON.parse(await sayfa.evaluate(OLCUM));
async function farki(olc, ad, alan, ms = 3000) {
	const a = (await olc())[ad] || {};
	await bekle(ms);
	const b = (await olc())[ad] || {};
	return (b[alan] || 0) - (a[alan] || 0);
}

let tarayici = null;
const tarayiciHatalari = [];

// ---------------------------------------------------------------- denemeler

(async () => {
	pulseBaslat();
	await sunucuBaslat();
	programHazirla();
	const ekranVar = await xvfbBaslat();
	const konusma = path.join(gecici, 'konusma.wav');
	const konusma2 = path.join(gecici, 'konusma2.wav');
	const muzik = path.join(gecici, 'muzik.wav');
	konusmaWav(konusma);
	konusmaWav(konusma2, 12, { perde: 205, hece: 4.3, tohum: 99 });
	muzikWav(muzik);
	fs.mkdirSync(path.join(ev, 'Downloads'), { recursive: true });

	tarayici = await chromium.launch({
		args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + konusma2, '--autoplay-policy=no-user-gesture-required'],
		env: { ...pulseOrtami, PULSE_SINK: 'diszort_tarayici' },
	});
	const ctx = await tarayici.newContext({ permissions: ['microphone'] });
	sayfa = await ctx.newPage();
	sayfa.on('pageerror', (e) => tarayiciHatalari.push(e.message));
	const ADI = 'web' + crypto.randomBytes(2).toString('hex');
	console.log(`CLI denemesi: ${ADRES} (Chromium ${tarayici.version()}, kişi ${ADI}; program ${(fs.statSync(PROGRAM).size / 1e6).toFixed(1)} MB${ekranVar ? '' : '; Xvfb yok: ekran denenmez'})`);

	await dene('giriş: anahtar bağlantısıyla; ayar dosyası programın yanında, anahtar içinde', async () => {
		// Ses aygıtları ayar dosyasından (kullanıcı /ayar mik ile seçer).
		fs.writeFileSync(path.join(klasor, 'diszort.json'), JSON.stringify({ sunucu: ADRES, ses: { mik: 'diszort_mik', hoparlor: 'diszort_hoparlor', mikSeviye: 100, esik: 10, kalite: 96, yayinSes: 192, mikRed: true, yayinRed: true, sesler: true, kare: 15 } }));
		cliBaslat([ADRES + '/#anahtar=' + ANAHTAR]);
		await cliBekle(/^Girdin: taha/);
		await cliBekle(/── #genel ──/);
		const ayar = JSON.parse(fs.readFileSync(path.join(klasor, 'diszort.json'), 'utf8'));
		assert.equal(ayar.anahtar, ANAHTAR, 'anahtar ayar dosyasına yazılmalı');
		assert.equal(ayar.ad, 'taha');
		assert.equal(fs.statSync(path.join(klasor, 'diszort.json')).mode & 0o777, 0o600, 'ayar dosyası yalnızca kullanıcıya açık olmalı');
		assert.deepEqual(fs.readdirSync(klasor).sort(), ['diszort', 'diszort.json'], 'programın yanında yalnızca ayar dosyası olmalı');
	});

	await dene('kapıyı çalma: Chromium\'daki kişinin isteği CLI\'da; /kabul ile içeri alınır', async () => {
		await sayfa.goto(ADRES + '/');
		await sayfa.fill('#ad', ADI);
		await sayfa.click('#gir');
		await cliBekle(new RegExp(`! ${ADI} girmek istiyor`));
		cliYaz('/kabul ' + ADI);
		await sayfa.waitForSelector('#uygulama:not([hidden])', { timeout: 20000 });
		await cliBekle(new RegExp(`${ADI} içeri alındı`));
	});

	await dene('yazı: CLI\'dan Chromium\'a, Chromium\'dan CLI\'a', async () => {
		const metin = 'terminalden merhaba ' + crypto.randomBytes(3).toString('hex') + ' 😀';
		cliYaz(metin);
		await kosul('Chromium mesajı gördü', () => sayfa.evaluate((m) => [...document.querySelectorAll('#mesajlar .metin')].some((e) => e.textContent === m), metin));
		const yanit = 'tarayıcıdan selam @taha ' + crypto.randomBytes(3).toString('hex');
		await sayfa.fill('#metin', yanit);
		await sayfa.press('#metin', 'Enter');
		await cliBekle(new RegExp(ADI + ': ' + yanit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	});

	await dene('komut konsolu: ./diszort komut açık programa bağlanır; yazılan komut olarak çalışır, mesaj olarak gitmez; ikinci kopya açılmaz', async () => {
		const ortam = { ...process.env, HOME: ev, DISZORT_BETIK: '1' };
		const konsol = spawn('./diszort', ['komut'], { cwd: klasor, env: ortam, stdio: ['pipe', 'pipe', 'pipe'] });
		const kc = [];
		readline.createInterface({ input: konsol.stdout }).on('line', (s) => kc.push(s));
		try {
			await kosul('konsol bağlandı', () => kc.some((s) => /Diszort'a bağlandı/.test(s)));
			const bas = kc.length;
			konsol.stdin.write('durum json\n');
			const s = await kosul('konsolda "durum json" (başında / yok)', () => kc.slice(bas).find((x) => /^DURUM /.test(x)));
			assert.equal(JSON.parse(s.slice(6)).ben, 'taha');
			const gitmemeli = 'konsoldan gitmemeli ' + crypto.randomBytes(3).toString('hex');
			konsol.stdin.write(gitmemeli + '\n');
			await kosul('düz yazı konsolda komut sayılır', () => kc.slice(bas).some((x) => /Bilinmeyen komut/.test(x)));
			await bekle(500);
			assert.ok(!(await sayfa.evaluate((m) => [...document.querySelectorAll('#mesajlar .metin')].some((e) => e.textContent.includes(m)), gitmemeli)), 'konsola yazılan mesaj olarak gitti');
			const ikinci = spawnSync('./diszort', [], { cwd: klasor, env: ortam, input: '', encoding: 'utf8', timeout: 10000 });
			assert.notEqual(ikinci.status, 0, 'aynı klasörde ikinci kopya açıldı');
			assert.match(ikinci.stderr, /zaten açık/);
		} finally {
			konsol.kill();
		}
	});

	let durCal = cal('diszort_mikkaynak', konusma);
	await dene('ses: CLI ↔ Chromium iki yönde; CLI hoparlöre çalıyor; kayıplara karşı yedek (RED) iki yönde', async () => {
		cliYaz('/ses Sesli Sohbet');
		await cliBekle(/Sesli Sohbet kanalına girdin/);
		await sayfa.locator('#ses-kanallari .kanal', { hasText: 'Sesli Sohbet' }).click();
		await kosul('CLI ↔ Chromium bağlı', async () => {
			const c = (await cliDurum()).esler[ADI];
			const t = (await olcTarayici()).taha;
			return c && c.durum === 'connected' && t && t.durum === 'connected';
		}, 30000);
		await bekle(1500);
		const tarayiciDuyuyor = await farki(olcTarayici, 'taha', 'enerji');
		const once = (await cliDurum()).esler[ADI].mik || {};
		const hoparlor = await kaydet('diszort_hoparlor.monitor', 3000);
		const sonra = (await cliDurum()).esler[ADI];
		const t = (await olcTarayici()).taha;
		// RED: Chromium alırken kodeği Opus diye bildirir (Chromium'un kendi RED'inde de böyle); RED açıkken
		// her paket bir öncekini de taşır: paket başına bayt kapalıyken olanın ~iki katı.
		const paketBasina = async () => {
			const a = (await olcTarayici()).taha;
			await bekle(2000);
			const b = (await olcTarayici()).taha;
			return { bayt: (b.bayt - a.bayt) / Math.max(1, b.paket - a.paket), uydurulan: (b.uydurulan - a.uydurulan) / Math.max(1, b.ornek - a.ornek) };
		};
		const redli = await paketBasina();
		cliYaz('/ayar red kapalı');
		await bekle(500);
		const redsiz = await paketBasina();
		cliYaz('/ayar red açık');
		console.log(`     Chromium ← CLI enerji +${tarayiciDuyuyor.toFixed(3)}; paket başına ${redli.bayt.toFixed(0)} B (RED'siz ${redsiz.bayt.toFixed(0)} B), uydurulan %${(redli.uydurulan * 100).toFixed(1)}; CLI ← Chromium ${sonra.mik.alinan - (once.alinan || 0)} paket (RED'li ${sonra.mik.red}), uydurulan ${sonra.mik.uydurulan}; CLI'nın hoparlörü ${hoparlor.rmsDb.toFixed(1)} dBFS, %${Math.round(hoparlor.sesliOran * 100)} sesli; bağlantı ${sonra.tip} ${sonra.rttMs} ms`);
		const k = await kaynakOlc(cli.pid);
		console.log(`     CLI iki kişilik görüşmede: işlemci tek çekirdeğin %${k.cpu.toFixed(1)}'i, bellek ${k.rss.toFixed(0)} MB`);
		assert.ok(tarayiciDuyuyor > 0.02, 'Chromium CLI\'ı duymuyor');
		assert.ok(sonra.mik.alinan - (once.alinan || 0) > 100, 'CLI Chromium\'dan ses almıyor');
		assert.ok(hoparlor.rmsDb > -45 && hoparlor.sesliOran > 0.2, 'CLI gelen sesi hoparlöre çalmıyor');
		assert.ok(redli.bayt > redsiz.bayt * 1.5, `CLI → Chromium RED'li gitmeli (paket başına ${redli.bayt.toFixed(0)} B, RED'siz ${redsiz.bayt.toFixed(0)} B)`);
		assert.ok(redli.uydurulan < 0.05, 'Chromium CLI\'ın sesini çözerken çok uyduruyor');
		assert.ok(sonra.mik.red > 0 && t.gidenRed, 'Chromium → CLI RED\'li gitmeli');
		assert.equal(sonra.gidenRed, true);
		assert.match(sonra.tip, /P2P|TURN/);
	});

	await dene('yankı engelleme: hoparlörden mikrofona dönen ses (oda) /ayar yankı açıkken Chromium\'a geri gitmez', async () => {
		durCal(); // CLI'nın kendi konuşması dursun: mikrofona yalnızca hoparlörün yankısı gelsin
		const modul = spawnSync('pactl', ['load-module', 'module-loopback', 'source=diszort_hoparlor.monitor', 'sink=diszort_mikkaynak', 'latency_msec=30'], { env: pulseOrtami, encoding: 'utf8' }).stdout.trim();
		assert.match(modul, /^\d+$/, 'loopback modülü yüklenemedi');
		try {
			cliYaz('/ayar eşik kapalı'); // eşik yankıyı gizlemesin: yalnızca yankı engelleme ölçülsün
			await bekle(2500);
			const kapali = await farki(olcTarayici, 'taha', 'enerji', 3000);
			cliYaz('/ayar yankı açık');
			await bekle(4000); // mikrofon yeniden açılır, süzgeç oturur
			let acik = await farki(olcTarayici, 'taha', 'enerji', 3000);
			if (acik >= kapali / 5) {
				// Süzgecin oturması makineye göre değişir (yerelde bir kez 4 sn yetmedi): bir kez daha ölç.
				await bekle(3000);
				acik = await farki(olcTarayici, 'taha', 'enerji', 3000);
			}
			console.log(`     Chromium'a geri dönen kendi sesi: yankı engelleme kapalıyken enerji +${kapali.toFixed(4)}, açıkken +${acik.toFixed(4)} (${(10 * Math.log10(kapali / Math.max(acik, 1e-9))).toFixed(1)} dB)`);
			assert.ok(kapali > 0.005, 'yankı oluşmadı (deneme düzeni)');
			assert.ok(acik < kapali / 5, 'yankı engellenmedi');
		} finally {
			spawnSync('pactl', ['unload-module', modul], { env: pulseOrtami });
			cliYaz('/ayar yankı kapalı');
			cliYaz('/ayar eşik 10');
		}
	});

	await dene('ses paylaşımı: CLI uygulamaların sesini paylaşır (kendi çaldığı hariç), Chromium alır', async () => {
		const durMuzik = cal('diszort_hoparlor', muzik, 'muzikcalar');
		try {
			cliYaz('/paylaş ses');
			await kosul('CLI paylaşıyor ve uygulamayı yakaladı', async () => {
				const d = await cliDurum();
				return d.yayin.ses && (d.yayin.uygulamalar || []).includes('muzikcalar');
			}, 15000);
			const d = await cliDurum();
			assert.ok(!(d.yayin.uygulamalar || []).some((a) => /diszort/i.test(a)), 'Diszort kendi çaldığını paylaşmamalı: ' + d.yayin.uygulamalar);
			await kosul('Chromium paylaşımı görüyor', () => sayfa.evaluate(() => !!document.querySelector('#yayinlar .yayin-kart[data-ad="taha"]')), 15000);
			await bekle(1000);
			const yayin = await farki(olcTarayici, 'taha', 'yayinEnerji');
			console.log(`     Chromium ← CLI paylaşımın sesi enerji +${yayin.toFixed(3)} (paylaşılan: ${d.yayin.uygulamalar.join(', ')})`);
			assert.ok(yayin > 0.02, 'Chromium paylaşılan sesi almıyor');
			cliYaz('/paylaş dur');
			await kosul('paylaşım bitti', async () => !(await cliDurum()).yayin.ses);
		} finally {
			durMuzik();
		}
	});

	if (ekranVar) {
		await dene('ekran paylaşımı: CLI ekranını (X11) paylaşır, Chromium görüntüyü çözer', async () => {
			cliYaz('/paylaş ekran');
			await cliBekle(/Ekranın paylaşılıyor/, 15000);
			await kosul('Chromium kareleri çözüyor', async () => {
				const t = (await olcTarayici()).taha;
				return t && t.kare > 10 && t.genislik > 0;
			}, 30000);
			const t = (await olcTarayici()).taha;
			const k1 = t.kare;
			await bekle(2000);
			const k2 = (await olcTarayici()).taha.kare;
			const d = await cliDurum();
			console.log(`     ${d.yayin.bilgi}; Chromium ${t.genislik}×${t.yukseklik} ${t.goruntuKodek}, ${((k2 - k1) / 2).toFixed(1)} kare/sn`);
			assert.equal(t.genislik, 1280);
			assert.ok(k2 - k1 >= 10, 'kareler akmıyor');
			cliYaz('/paylaş dur');
			await kosul('paylaşım bitti', async () => !(await cliDurum()).yayin.ekran);
		});
	}

	await dene('dosya: Chromium → CLI (indirilenin özeti aynı), CLI → Chromium (resim önizlemesi)', async () => {
		const veri = crypto.randomBytes(3 * 1024 * 1024);
		const beklenen = crypto.createHash('sha256').update(veri).digest('hex');
		await sayfa.evaluate((b64) => {
			const ikili = atob(b64);
			const v = new Uint8Array(ikili.length);
			for (let i = 0; i < ikili.length; i++) v[i] = ikili.charCodeAt(i);
			dosyalariPaylas([new File([v], 'chromiumdan.bin', { type: 'application/octet-stream' })]);
		}, veri.toString('base64'));
		await cliBekle(/\[\d+\] chromiumdan\.bin/);
		cliYaz('/indir chromiumdan.bin');
		const satir = await cliBekle(/İndirildi: /, 30000);
		const inen = satir.replace(/^.*İndirildi: /, '').replace(/ · .*$/, '');
		assert.equal(inen, path.join(ev, 'Downloads', 'chromiumdan.bin'));
		assert.equal(ozet(inen), beklenen, 'indirilen dosyanın içeriği farklı');
		const resim = path.join(gecici, 'cliden.png');
		png(resim);
		cliYaz('/dosya ' + resim);
		await kosul('Chromium önizlemeyi (CLI\'dan doğrudan) aldı', () => sayfa.evaluate(() => {
			const r = [...document.querySelectorAll('#mesajlar .p2p-dosya img.onizleme')].pop();
			return !!r && r.complete && r.naturalWidth === 24;
		}), 30000);
	});

	await dene('program: --surum; adres vermeden ayar dosyasındaki sunucuya bağlanır', async () => {
		await cliKapat();
		const surum = spawnSync('./diszort', ['--surum'], { cwd: klasor, encoding: 'utf8' }).stdout.trim();
		assert.match(surum, /^Diszort /);
		const mesaj = 'yeniden açılan programdan ' + crypto.randomBytes(3).toString('hex');
		cliBaslat([]);
		await cliBekle(/^Girdin: taha/);
		cliYaz(mesaj);
		await kosul('Chromium mesajı gördü', () => sayfa.evaluate((m) => [...document.querySelectorAll('#mesajlar .metin')].some((e) => e.textContent === m), mesaj));
		assert.equal(JSON.parse(fs.readFileSync(path.join(klasor, 'diszort.json'), 'utf8')).sunucu, new URL(ADRES).origin);
		console.log(`     ${surum}`);
	});

	if (tarayiciHatalari.length) {
		process.exitCode = 1;
		console.error('HATA Chromium\'da sayfa hataları:\n     ' + tarayiciHatalari.slice(0, 10).join('\n     '));
	}
	await bitir();
	console.log(process.exitCode ? 'CLI denemeleri BAŞARISIZ.' : `CLI denemeleri geçti (${gecen}).`);
	process.exit(process.exitCode || 0);
})().catch(async (h) => {
	console.error('CLI denemesi çöktü:', h);
	await bitir().catch(() => {});
	process.exit(1);
});

async function bitir() {
	await cliKapat().catch(() => {});
	if (tarayici) await tarayici.close().catch(() => {});
	if (sunucu) {
		sunucu.kill('SIGTERM');
		await bekle(300);
	}
	if (xvfb) xvfb.kill();
	pulseDurdur();
	fs.rmSync(gecici, { recursive: true, force: true });
}
