// CLI denemesi: tarayıcısız istemci (cli/) gerçek sunucuda, gerçek Chromium'la aynı kanalda.
//
// CLI web istemcisinin kendisini çalıştırır (kabuk) ve arayüzünü terminale çizer; bu deneme ikisini
// birlikte, ekranın metnini okuyarak ve tuş/fare olaylarını terminalden gönderir gibi sınar:
//   - giriş: anahtar bağlantısıyla; arayüz kanalları ve kişiyi çiziyor
//   - kapıyı çalma: Chromium'daki kişinin isteği CLI'da görünür, klavyeyle (Tab, Enter) kabul edilir
//   - yazı: CLI'da klavyeyle yazılan Chromium'a, Chromium'un yazdığı CLI ekranına
//   - ses: CLI ↔ Chromium iki yönde (gelen sesin enerjisi; CLI'da hoparlöre gerçekten çalınıyor),
//     kayıplara karşı yedek (RED) iki yönde
//   - ekransız paylaşım: CLI bilgisayarın sesini (PulseAudio "Monitor of …") paylaşır, Chromium alır
//   - dosya: Chromium → CLI (indirilen dosyanın özeti aynı), CLI → Chromium (resim önizlemesi)
//   - sunucu güncellenince sayfanın kendini yenilemesi: CLI sayfayı yeniden kurar, sesli kanala döner
//   - derlenmiş program (CLI_IKILI verilirse): tek dosya, kendi klasöründe ayar dosyasıyla giriş
//     yapar ve klavyeden mesaj gönderir
//
//   node test/cli.js                       kendi sunucusunu açar (node sunucu/sunucu.js, geçici veri)
//   node test/cli.js http://adres:port     çalışan sunucuya bağlanır (ILK_ANAHTAR gerekir)
//   CLI_IKILI=cikti/diszort-linux-x64 node test/cli.js   derlenmiş programı da dener
//
// Gerekenler: cli/ bağımlılıkları (cd cli && npm ci), playwright + Chromium, PulseAudio (deneme
// kendi PulseAudio'sunu sanal aygıtlarla başlatır; yoksa atlanır, CLI_ZORUNLU=1 ise hata).
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { PassThrough, Writable } = require('node:stream');

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
let Kabuk, gomuluVarliklar, Terminal, Arayuz, Goruntu;
try {
	({ Kabuk } = require('../cli/kabuk/kabuk'));
	({ gomuluVarliklar } = require('../cli/varlik'));
	({ Terminal } = require('../cli/arayuz/terminal'));
	({ Arayuz } = require('../cli/arayuz/arayuz'));
	({ Goruntu } = require('../cli/arayuz/goruntu'));
} catch (h) {
	atla('cli/ bağımlılıkları kurulu değil (cd cli && npm ci): ' + h.message);
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
		if (arayuz) console.error('     ekran:\n' + ekranMetni().replace(/^/gm, '     | '));
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

const PULSE = path.join(gecici, 'pulse');
const pulseOrtami = { ...process.env, XDG_RUNTIME_DIR: PULSE, PULSE_RUNTIME_PATH: path.join(PULSE, 'pulse') };
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
			'--load=module-remap-source master=diszort_mikkaynak.monitor source_name=diszort_mik source_properties=device.description=Deneme-Mikrofon',
		],
		{ env: pulseOrtami, encoding: 'utf8' },
	);
	if (r.status !== 0) throw new Error('PulseAudio başlamadı: ' + r.stderr + (fs.existsSync(path.join(PULSE, 'pulse.log')) ? fs.readFileSync(path.join(PULSE, 'pulse.log'), 'utf8').slice(-800) : ''));
	// Kabuk bu süreçte: ses sunucusunu buradan bulur.
	Object.assign(process.env, { XDG_RUNTIME_DIR: pulseOrtami.XDG_RUNTIME_DIR, PULSE_RUNTIME_PATH: pulseOrtami.PULSE_RUNTIME_PATH });
	delete process.env.PULSE_SERVER;
}
function pulseDurdur() {
	spawnSync('pulseaudio', ['--kill'], { env: pulseOrtami });
}
// Bir aygıta wav'ı döngüde çal; dönüş: durdur().
function cal(aygit, dosya) {
	let p = null;
	let bitti = false;
	const basla = () => {
		p = spawn('paplay', ['--device=' + aygit, dosya], { env: pulseOrtami, stdio: 'ignore' });
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
// Stereo müzik: solda 500 Hz, sağda 800 Hz (bilgisayarın sesi yerine).
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

// ---------------------------------------------------------------- CLI (kabuk + arayüz, sahte terminal)

let kabuk = null;
let arayuz = null;
let terminal = null;
const kabukHatalari = [];
function sahteTerminal(W, H) {
	const girdi = new PassThrough();
	girdi.isTTY = false;
	const cikti = new Writable({ write: (c, e, cb) => cb() });
	cikti.columns = W;
	cikti.rows = H;
	const t = new Terminal({ girdi, cikti });
	t.gonder = (s) => girdi.write(s);
	return t;
}
function ekranMetni() {
	arayuz.ciz();
	const e = arayuz.ekran;
	const satirlar = [];
	for (let y = 0; y < e.yukseklik; y++) {
		let s = '';
		for (let x = 0; x < e.genislik; x++) s += e.kar[y * e.genislik + x];
		satirlar.push(s.replace(/\s+$/, ''));
	}
	return satirlar.join('\n');
}
const $ = (id) => kabuk.document.getElementById(id);
// Ekranda (arayüzün çizdiği) bir öğeye fareyle tıkla.
async function fareyleTikla(bul, aciklama) {
	arayuz.ciz();
	const t = arayuz.hedefler.find((h) => h.h && bul(h.h));
	assert.ok(t, `ekranda yok: ${aciklama}`);
	const x = t.x + Math.floor(t.g / 2) + 1;
	terminal.gonder(`\x1b[<0;${x};${t.y + 1}M\x1b[<0;${x};${t.y + 1}m`);
	await bekle(150);
}
// Odak (Tab ile) istenen öğeye gelene kadar.
async function tablaGit(kosulu, enCok = 80) {
	for (let i = 0; i < enCok; i++) {
		const a = kabuk.document.activeElement;
		if (a && kosulu(a)) return i;
		terminal.gonder('\t');
		await bekle(40);
	}
	throw new Error('odak istenen öğeye gelmedi');
}
// Eşin mikrofon kanalının istatistikleri (sayfanın kendi değişkenlerinden; tarayıcıda da kabukta da aynı).
const OLCUM = `(async () => {
	const s = {};
	for (const [ad, es] of esler) {
		const o = { durum: es.pc ? es.pc.connectionState : 'yok', caliyor: !!(es.ses && es.ses.srcObject && !es.ses.paused) };
		const oku = async (n, tur) => { let b = null; if (n) (await n.getStats()).forEach((x) => { if (x.type === tur) b = x; }); return b; };
		if (es.pc && es.tr) {
			const g = await oku(es.tr.receiver, 'inbound-rtp');
			if (g) Object.assign(o, { enerji: g.totalAudioEnergy || 0, bayt: g.bytesReceived || 0 });
			o.red = redAnlasildi(es.tr, 'giden');
			const y = await oku(es.trSes && es.trSes.receiver, 'inbound-rtp');
			o.yayinEnerji = y ? y.totalAudioEnergy || 0 : 0;
		}
		s[ad] = o;
	}
	return JSON.stringify(s);
})()`;
const olcCli = async () => JSON.parse(await kabuk.window.eval(OLCUM));
const olcTarayici = async () => JSON.parse(await sayfa.evaluate(OLCUM));
async function enerjiFarki(olc, ad, alan = 'enerji', ms = 3000) {
	const a = (await olc())[ad] || {};
	await bekle(ms);
	const b = (await olc())[ad] || {};
	return (b[alan] || 0) - (a[alan] || 0);
}

// ---------------------------------------------------------------- tarayıcı

let tarayici = null;
let sayfa = null;
const tarayiciHatalari = [];

// ---------------------------------------------------------------- denemeler

(async () => {
	pulseBaslat();
	await sunucuBaslat();
	const konusma = path.join(gecici, 'konusma.wav');
	const konusma2 = path.join(gecici, 'konusma2.wav');
	const muzik = path.join(gecici, 'muzik.wav');
	konusmaWav(konusma);
	konusmaWav(konusma2, 12, { perde: 205, hece: 4.3, tohum: 99 });
	muzikWav(muzik);
	// İndirilenler bu klasöre (kabuk ev dizininin İndirilenler'ini kullanır).
	const ev = path.join(gecici, 'ev');
	fs.mkdirSync(path.join(ev, 'Downloads'), { recursive: true });
	process.env.HOME = ev;
	delete process.env.XDG_CONFIG_HOME;

	tarayici = await chromium.launch({
		args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + konusma2, '--autoplay-policy=no-user-gesture-required'],
	});
	const ctx = await tarayici.newContext({ permissions: ['microphone'] });
	sayfa = await ctx.newPage();
	sayfa.on('pageerror', (e) => tarayiciHatalari.push(e.message));
	const ADI = 'cli' + crypto.randomBytes(2).toString('hex'); // Chromium'daki kişi (her koşuda yeni ad)
	console.log(`CLI denemesi: ${ADRES} (Chromium ${tarayici.version()}, kişi ${ADI})`);

	await dene('giriş: anahtar bağlantısıyla; arayüz kanalları ve kişiyi terminale çiziyor', async () => {
		kabuk = new Kabuk({
			sunucu: ADRES + '/#anahtar=' + ANAHTAR,
			depo: { 'ses-ayarlari': JSON.stringify({ mikId: 'diszort_mik', cikisId: 'diszort_hoparlor' }) },
			varliklar: gomuluVarliklar(),
			gunluk: (...a) => {
				const s = a.map((x) => (x && x.stack ? x.stack.split('\n').slice(0, 3).join(' | ') : typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
				if (/sayfa|yakalanmamış|hata|AudioWorklet/i.test(s) && !/konsol\.(log|info|debug)/.test(s)) kabukHatalari.push(s.slice(0, 400));
			},
		});
		await kabuk.baslat();
		terminal = sahteTerminal(120, 34);
		arayuz = new Arayuz({ kabuk, terminal, surum: 'deneme' });
		arayuz.goruntu = new Goruntu({ kabuk, arayuz });
		arayuz.baslat();
		await kosul('uygulama ekranı', () => !$('uygulama').hidden);
		await bekle(300);
		const e = ekranMetni();
		assert.match(e, /Yazılı Kanallar/);
		assert.match(e, /Sesli Kanallar/);
		assert.match(e, /# genel/);
		assert.equal(kabuk.window.location.hash.includes('anahtar'), false, 'anahtar adresten silinmeli');
		assert.match(kabuk.depo.anahtar || '', /^[0-9a-f]{128}$/, 'anahtar depoya (ayar dosyasına) yazılmalı');
	});

	await dene('kapıyı çalma: Chromium\'daki kişinin isteği CLI ekranında; klavyeyle (Tab, Enter) kabul edilir', async () => {
		await sayfa.goto(ADRES + '/');
		await sayfa.fill('#ad', ADI);
		await sayfa.click('#gir');
		await kosul('istek CLI ekranında', () => ekranMetni().includes(`${ADI} girmek istiyor`));
		await tablaGit((a) => a.textContent === 'Kabul et');
		terminal.gonder('\r');
		await sayfa.waitForSelector('#uygulama:not([hidden])', { timeout: 20000 });
		await kosul('CLI üye listesinde', () => ekranMetni().includes(ADI));
	});

	await dene('yazı: CLI\'da klavyeyle yazılan Chromium\'a, Chromium\'un yazdığı CLI ekranına', async () => {
		const metin = 'terminalden merhaba ' + crypto.randomBytes(3).toString('hex') + ' 😀';
		$('metin').focus();
		terminal.gonder(metin);
		await bekle(100);
		terminal.gonder('\r');
		await kosul('Chromium mesajı gördü', () => sayfa.evaluate((m) => [...document.querySelectorAll('#mesajlar .metin')].some((e) => e.textContent === m), metin));
		assert.equal($('metin').value, '', 'gönderince mesaj kutusu boşalmalı');
		const yanit = 'tarayıcıdan selam ' + crypto.randomBytes(3).toString('hex');
		await sayfa.fill('#metin', yanit);
		await sayfa.press('#metin', 'Enter');
		await kosul('CLI ekranında', () => ekranMetni().includes(yanit));
	});

	const durCal = cal('diszort_mikkaynak', konusma);
	await dene('ses: CLI ↔ Chromium iki yönde; CLI hoparlöre çalıyor; kayıplara karşı yedek (RED) iki yönde', async () => {
		await fareyleTikla((el) => el.classList.contains('kanal') && /Sesli Sohbet/.test(el.textContent), 'Sesli Sohbet');
		await kosul('CLI sesli kanalda', () => !$('ses-karti').hidden);
		await sayfa.locator('#ses-kanallari .kanal', { hasText: 'Sesli Sohbet' }).click();
		await kosul('CLI → Chromium bağlı ve çalıyor', async () => {
			const o = (await olcCli())[ADI];
			return o && o.durum === 'connected' && o.caliyor;
		}, 30000);
		await kosul('Chromium → CLI bağlı', async () => {
			const o = (await olcTarayici()).taha;
			return o && o.durum === 'connected';
		}, 30000);
		await bekle(1000);
		const cliDuyuyor = await enerjiFarki(olcCli, ADI);
		const tarayiciDuyuyor = await enerjiFarki(olcTarayici, 'taha');
		const hoparlor = await kaydet('diszort_hoparlor.monitor', 3000);
		console.log(`     CLI ← Chromium enerji +${cliDuyuyor.toFixed(3)}, Chromium ← CLI +${tarayiciDuyuyor.toFixed(3)}; CLI'nın hoparlörü ${hoparlor.rmsDb.toFixed(1)} dBFS, %${Math.round(hoparlor.sesliOran * 100)} sesli`);
		assert.ok(cliDuyuyor > 0.02, 'CLI Chromium\'u duymuyor');
		assert.ok(tarayiciDuyuyor > 0.02, 'Chromium CLI\'ı duymuyor');
		assert.ok(hoparlor.rmsDb > -45 && hoparlor.sesliOran > 0.2, 'CLI gelen sesi hoparlöre çalmıyor');
		assert.equal((await olcCli())[ADI].red, true, 'CLI → Chromium RED\'li gitmeli');
		assert.equal((await olcTarayici()).taha.red, true, 'Chromium → CLI RED\'li gitmeli');
		assert.match(ekranMetni(), /P2P|TURN/, 'ses kartında bağlantı türü');
	});

	await dene('ekransız paylaşım: CLI bilgisayarın sesini (Monitor of …) paylaşır, Chromium alır', async () => {
		const durMuzik = cal('diszort_hoparlor', muzik);
		try {
			await fareyleTikla((el) => el.id === 'yayin-ac', 'paylaş düğmesi');
			await kosul('paylaşım menüsü açık', () => !$('yayin-menu').hidden);
			await fareyleTikla((el) => el.classList.contains('yayin-menu-oge') && /Ekransız paylaş/.test(el.textContent), 'Ekransız paylaş');
			await kosul('CLI paylaşıyor', () => kabuk.window.eval('!!yayin.ses && yayin.ekransiz'), 15000);
			const aygit = kabuk.window.eval('yayin.aygitAdi');
			assert.match(aygit, /Monitor of Deneme-Hoparlor/, 'çıkışın monitörü kendiliğinden seçilmeli');
			await kosul('Chromium\'da yayın kartı', () => sayfa.evaluate(() => !!document.querySelector('#yayinlar .yayin-kart[data-ad="taha"]')));
			await bekle(1000);
			const yayin = await enerjiFarki(olcTarayici, 'taha', 'yayinEnerji');
			console.log(`     Chromium ← CLI paylaşımın sesi enerji +${yayin.toFixed(3)} (aygıt: ${aygit})`);
			assert.ok(yayin > 0.02, 'Chromium paylaşılan sesi almıyor');
			await fareyleTikla((el) => el.id === 'yayin-ac', 'paylaş düğmesi');
			await fareyleTikla((el) => el.classList.contains('yayin-menu-oge') && /Paylaşımı durdur/.test(el.textContent), 'Paylaşımı durdur');
			await kosul('paylaşım bitti', () => kabuk.window.eval('!yayin.ses'));
		} finally {
			durMuzik();
		}
	});
	durCal();

	await dene('dosya: Chromium → CLI (indirilen dosyanın özeti aynı), CLI → Chromium (resim önizlemesi)', async () => {
		const veri = crypto.randomBytes(3 * 1024 * 1024);
		const beklenen = crypto.createHash('sha256').update(veri).digest('hex');
		await sayfa.evaluate((b64) => {
			const ikili = atob(b64);
			const v = new Uint8Array(ikili.length);
			for (let i = 0; i < ikili.length; i++) v[i] = ikili.charCodeAt(i);
			dosyalariPaylas([new File([v], 'chromiumdan.bin', { type: 'application/octet-stream' })]);
		}, veri.toString('base64'));
		await kosul('CLI dosya kartını gördü', () => ekranMetni().includes('chromiumdan.bin'));
		await kosul('İndir düğmesi açık', () => {
			arayuz.ciz();
			return arayuz.hedefler.some((h) => h.h && h.h.textContent === 'İndir' && !h.h.disabled);
		});
		await fareyleTikla((el) => el.textContent === 'İndir' && !!el.closest('.p2p-dosya'), 'İndir');
		const inen = path.join(ev, 'Downloads', 'chromiumdan.bin');
		await kosul('dosya indi', () => fs.existsSync(inen) && fs.statSync(inen).size === veri.length, 30000);
		assert.equal(ozet(inen), beklenen, 'indirilen dosyanın içeriği farklı');
		// Mesajın içindeki kart değişti (indirildi): ekranda da güncel olmalı (mesajların çizimi saklanır).
		await kosul('CLI ekranında "indirildi"', () => /chromiumdan\.bin[\s\S]*indirildi/.test(ekranMetni()), 5000);
		const resim = path.join(gecici, 'cliden.png');
		png(resim);
		assert.ok(kabuk.dosyalariBirak([resim]), 'bırakılan dosya paylaşılmalı');
		await kosul('Chromium önizlemeyi (CLI\'dan doğrudan) aldı', () => sayfa.evaluate(() => {
			const r = [...document.querySelectorAll('#mesajlar .p2p-dosya img.onizleme')].pop();
			return !!r && r.complete && r.naturalWidth === 24;
		}), 30000);
	});

	await dene('sunucu güncellenince (sayfa kendini yeniler): CLI sayfayı yeniden kurar, sesli kanala döner, yazılan kalır', async () => {
		const eski = kabuk.window;
		$('metin').value = 'yarım kalan taslak';
		kabuk.window.eval('surumYenile()');
		await kosul('yeni sayfa kuruldu ve girildi', () => kabuk.window !== eski && !$('uygulama').hidden, 30000);
		await kosul('sesli kanala döndü', () => !!kabuk.window.eval('sesKanal'), 20000);
		assert.equal($('metin').value, 'yarım kalan taslak', 'yazılan mesaj yenilemeden sonra geri gelmeli');
		await kosul('Chromium\'la ses yeniden bağlandı', async () => {
			const o = (await olcCli())[ADI];
			return o && o.durum === 'connected' && o.caliyor;
		}, 30000);
		assert.match(ekranMetni(), /Sesli Sohbet/);
	});

	if (process.env.CLI_IKILI) {
		await dene('derlenmiş program: tek dosya, kendi klasöründe ayar dosyasıyla giriş yapar ve klavyeden mesaj gönderir', async () => {
			const klasor = path.join(gecici, 'program');
			fs.mkdirSync(klasor);
			const program = path.join(klasor, 'diszort');
			fs.copyFileSync(path.resolve(process.env.CLI_IKILI), program);
			fs.chmodSync(program, 0o755);
			// Oturum programa geçecek: kabuk önce kapanır.
			await kabuk.kapat();
			arayuz.bitir();
			arayuz = null;
			const mesaj = 'derlenmiş programdan ' + crypto.randomBytes(3).toString('hex');
			// Kullanıcı gibi: kendi klasöründe, göreli yolla (./diszort).
			const r = spawnSync('./diszort', [ADRES + '/#anahtar=' + ANAHTAR], { cwd: klasor, env: { ...process.env, DISZORT_DENEME: '1', DISZORT_DENEME_MESAJ: mesaj, COLUMNS: '100', LINES: '24' }, encoding: 'utf8', timeout: 90000 });
			assert.equal(r.status, 0, 'program başarısız: ' + (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-1500));
			assert.match(r.stdout, /DENEME: TAMAM/);
			assert.deepEqual(fs.readdirSync(klasor).sort(), ['diszort', 'diszort.json'], 'programın yanında yalnızca ayar dosyası olmalı');
			assert.equal(fs.statSync(path.join(klasor, 'diszort.json')).mode & 0o777, 0o600, 'ayar dosyası (anahtar içerir) yalnızca kullanıcıya açık olmalı');
			const surum = spawnSync('./diszort', ['--surum'], { cwd: klasor, encoding: 'utf8' }).stdout.trim();
			// Adres verilmeden: ayar dosyasındaki sunucuya bağlanır (programın adı adres sanılmamalı).
			const r2 = spawnSync('./diszort', [], { cwd: klasor, env: { ...process.env, DISZORT_DENEME: '1', COLUMNS: '100', LINES: '24' }, encoding: 'utf8', timeout: 90000 });
			assert.equal(r2.status, 0, 'ayar dosyasıyla açılamadı: ' + (r2.stdout || '').slice(-800) + (r2.stderr || '').slice(-800));
			assert.equal(JSON.parse(fs.readFileSync(path.join(klasor, 'diszort.json'), 'utf8')).sunucu, new URL(ADRES).origin, 'ayar dosyasındaki sunucu değişmemeli');
			console.log(`     ${surum}; ${(fs.statSync(program).size / 1e6).toFixed(1)} MB`);
			await kosul('Chromium programın mesajını gördü', () => sayfa.evaluate((m) => [...document.querySelectorAll('#mesajlar .metin')].some((e) => e.textContent === m), mesaj));
		});
	}

	if (kabukHatalari.length) {
		process.exitCode = 1;
		console.error('HATA kabukta sayfa hataları:\n     ' + kabukHatalari.slice(0, 10).join('\n     '));
	}
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
	if (kabuk) await kabuk.kapat().catch(() => {});
	if (arayuz) arayuz.bitir();
	if (tarayici) await tarayici.close().catch(() => {});
	if (sunucu) {
		sunucu.kill('SIGTERM');
		await bekle(300);
	}
	pulseDurdur();
	fs.rmSync(gecici, { recursive: true, force: true });
}
