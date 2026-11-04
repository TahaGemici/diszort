// Gerçek tarayıcı denemesi: Playwright + Chromium, sahte mikrofon (konuşmaya benzeyen sentetik ses).
// Arayüzün kendisiyle (tıklayarak) girer, sesli kanalda gerçek WebRTC bağlantılarını ölçer:
//   - beyaz liste: anahtar bağlantısıyla giriş, kapıyı çalma + kabul
//   - üç kişilik mesh: herkes herkesi duyuyor mu (gelen sesin ENERJİSİ artıyor mu, yalnızca bayt değil)
//   - gönderilen bit hızı (Opus tavanı), susturma / sağırlaştırma, çık-gir, sayfa yenileme
//   - mikrofon izi biterse (aygıt çıkarıldı) kendiliğinden yeniden bağlanma
//   - sunucu yeniden başlarken P2P sesin KESİLMEMESİ ve herkesin kendiliğinden geri dönmesi
//   - yalnızca TURN (relay) ile bağlantı; sunucu (ve coturn) yeniden başlayınca taze şifreyle kurtarma
//   - aynı anahtarla ikinci sekme: oturum devri
//
//   node test/tarayici.js                    kendi sunucusunu (node sunucu/sunucu.js) geçici veriyle açar
//   node test/tarayici.js http://adres:port  çalışan sunucuya bağlanır (ILK_ANAHTAR gerekir;
//                                            YENIDEN_BASLAT='komut' verilirse yeniden başlatma denenir)
//
// Gerekenler: playwright (npm install --no-save playwright && npx playwright install chromium),
// coturn (yoksa TURN denemeleri atlanır). Sunucu başlatırken TURN_ADRESI makinenin IP'si olmalı:
// Chromium mikrofon izni varken 127.0.0.1'deki STUN/TURN'ü kullanmıyor (kendiliğinden bulunur).
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');

let chromium;
try {
	({ chromium } = require('playwright'));
} catch {
	console.log('playwright kurulu değil; tarayıcı denemesi atlandı (npm install --no-save playwright && npx playwright install chromium).');
	process.exit(process.env.TARAYICI_ZORUNLU === '1' ? 1 : 0);
}

const KOK = path.resolve(__dirname, '..');
const ANAHTAR = process.env.ILK_ANAHTAR || 'a1b2c3d4'.repeat(16);
const DIS_ADRES = process.argv[2] || process.env.ADRES || '';
const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- sunucu (kendi açtığımız)

function icIp() {
	for (const liste of Object.values(os.networkInterfaces())) {
		for (const a of liste || []) if (a.family === 'IPv4' && !a.internal) return a.address;
	}
	return '127.0.0.1';
}

let sunucuSureci = null;
let veriKlasoru = '';
const PORT = 18000 + Math.floor(Math.random() * 1000);
const TURN_PORT = 23000 + Math.floor(Math.random() * 1000);
const ADRES = DIS_ADRES ? DIS_ADRES.replace(/\/$/, '') : `http://127.0.0.1:${PORT}`;
let turnVar = true;

async function sunucuBaslat() {
	if (DIS_ADRES) return;
	if (!veriKlasoru) veriKlasoru = fs.mkdtempSync(path.join(os.tmpdir(), 'ses-kanali-tarayici-'));
	const ip = icIp();
	sunucuSureci = spawn(process.execPath, [path.join(KOK, 'sunucu/sunucu.js')], {
		env: {
			...process.env,
			AYAR_DOSYASI: path.join(veriKlasoru, 'yok.env'),
			VERI_KLASORU: veriKlasoru,
			PORT: String(PORT),
			TURN_PORT: String(TURN_PORT),
			TURN_ADRESI: process.env.TURN_ADRESI || ip,
			ILK_ANAHTAR: ANAHTAR,
			GIRIS_ARALIK_MS: process.env.GIRIS_ARALIK_MS || '10000', // üretimdeki fren: kova yetmeli
			GIRIS_KOVA: process.env.GIRIS_KOVA || '10',
			SES_ASKI_MS: process.env.SES_ASKI_MS || '20000',
			TANI: process.env.TANI || '0',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let gunluk = '';
	sunucuSureci.stdout.on('data', (d) => {
		gunluk += d;
		if (process.env.SUNUCU_GUNLUK) process.stdout.write('  [sunucu] ' + d);
	});
	sunucuSureci.stderr.on('data', (d) => {
		gunluk += d;
		if (process.env.SUNUCU_GUNLUK) process.stdout.write('  [sunucu!] ' + d);
	});
	for (let i = 0; i < 80; i++) {
		if (/Ses Kanalı çalışıyor/.test(gunluk)) break;
		if (sunucuSureci.exitCode !== null) throw new Error('sunucu açılamadı:\n' + gunluk);
		await bekle(100);
	}
	if (!/Ses Kanalı çalışıyor/.test(gunluk)) throw new Error('sunucu zamanında açılmadı:\n' + gunluk);
	turnVar = !/STUN\/TURN kapalı/.test(gunluk);
}

async function sunucuDurdur() {
	if (!sunucuSureci) return;
	const p = sunucuSureci;
	sunucuSureci = null;
	const bitti = new Promise((r) => p.once('exit', r));
	p.kill('SIGTERM');
	await Promise.race([bitti, bekle(5000)]);
}

async function sunucuyuYenidenBaslat(aradaBekle = 0) {
	if (DIS_ADRES) {
		execSync(process.env.YENIDEN_BASLAT, { stdio: 'inherit' });
		for (let i = 0; i < 60; i++) {
			try {
				if ((await fetch(ADRES + '/saglik')).ok) return;
			} catch {}
			await bekle(500);
		}
		throw new Error('sunucu yeniden başlamadı');
	}
	await sunucuDurdur();
	if (aradaBekle) await bekle(aradaBekle);
	await sunucuBaslat();
}
const yenidenBaslatilabilir = () => !DIS_ADRES || !!process.env.YENIDEN_BASLAT;

// ---------------------------------------------------------------- deneme düzeni

let gecen = 0;
let atlanan = 0;
async function dene(ad, fn) {
	const t0 = Date.now();
	try {
		await fn();
		gecen++;
		console.log(`ok   ${ad} (${((Date.now() - t0) / 1000).toFixed(1)} sn)`);
	} catch (e) {
		process.exitCode = 1;
		console.error('HATA ' + ad + '\n     ' + (e && e.stack ? e.stack : e));
		for (const k of kisiler) {
			try {
				console.error(`     [${k.ad}] ` + JSON.stringify(await durumu(k)));
			} catch {}
		}
	}
}
function atla(ad, neden) {
	atlanan++;
	console.log(`atla ${ad} (${neden})`);
}

async function bekleKosul(aciklama, fn, ms = 20000, aralik = 250) {
	const son = Date.now() + ms;
	let sonDeger;
	while (Date.now() < son) {
		try {
			sonDeger = await fn();
			if (sonDeger) return sonDeger;
		} catch (e) {
			sonDeger = e;
		}
		await bekle(aralik);
	}
	throw new Error(`beklenen olmadı (${ms} ms): ${aciklama}; son: ${sonDeger instanceof Error ? sonDeger.message : JSON.stringify(sonDeger)}`);
}

// ---------------------------------------------------------------- sahte mikrofon sesi

// Konuşmaya benzeyen sinyal (48 kHz mono): değişen perdede harmonikler, hece ritmi, kısa duraklamalar.
function konusmaWav(dosya, saniye = 12) {
	const HIZ = 48000;
	const N = HIZ * saniye;
	const v = Buffer.alloc(44 + N * 2);
	let faz = 0;
	let tohum = 7;
	const rastgele = () => ((tohum = (tohum * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
	for (let i = 0; i < N; i++) {
		const t = i / HIZ;
		const perde = 140 + 45 * Math.sin(2 * Math.PI * 0.37 * t) + 20 * Math.sin(2 * Math.PI * 2.3 * t);
		faz += (2 * Math.PI * perde) / HIZ;
		let s = 0;
		for (let h = 1; h <= 24; h++) {
			const f = h * perde;
			const formant = Math.exp(-(((f - 500) / 300) ** 2)) + 0.6 * Math.exp(-(((f - 1500) / 400) ** 2)) + 0.35 * Math.exp(-(((f - 2600) / 500) ** 2));
			s += (Math.sin(h * faz) / h) * (0.25 + formant);
		}
		const hece = Math.max(0, Math.sin(2 * Math.PI * 3.7 * t)) ** 0.6;
		const cumle = t % 4 < 3.4 ? 1 : 0.02;
		s = s * hece * cumle * 0.35 + rastgele() * 0.01;
		v.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * 32767))), 44 + i * 2);
	}
	v.write('RIFF', 0);
	v.writeUInt32LE(36 + N * 2, 4);
	v.write('WAVEfmt ', 8);
	v.writeUInt32LE(16, 16);
	v.writeUInt16LE(1, 20);
	v.writeUInt16LE(1, 22);
	v.writeUInt32LE(HIZ, 24);
	v.writeUInt32LE(HIZ * 2, 28);
	v.writeUInt16LE(2, 32);
	v.writeUInt16LE(16, 34);
	v.write('data', 36);
	v.writeUInt32LE(N * 2, 40);
	fs.writeFileSync(dosya, v);
}

// ---------------------------------------------------------------- tarayıcı yardımcıları

let tarayici;
const kisiler = [];

async function kisiAc(ad, { zorlaTurn = false } = {}) {
	const ctx = await tarayici.newContext({ permissions: ['microphone'] });
	const sayfa = await ctx.newPage();
	const k = { ad, ctx, sayfa, hatalar: [] };
	sayfa.on('pageerror', (e) => k.hatalar.push(e.message));
	sayfa.on('console', (m) => {
		// Sunucu kapalıyken tarayıcının yazdığı ağ uyarıları hata sayılmaz (beklenen durum).
		if (m.type() === 'error' && !/Failed to load resource|favicon|WebSocket connection to .* failed/.test(m.text())) k.hatalar.push(m.text());
	});
	if (zorlaTurn) await ctx.addInitScript(() => localStorage.setItem('zorla-turn', '1'));
	kisiler.push(k);
	return k;
}

async function kisiKapat(k) {
	await k.ctx.close().catch(() => {});
	kisiler.splice(kisiler.indexOf(k), 1);
}

const goruneneKadar = (k, secici, ms = 20000) => k.sayfa.locator(secici).first().waitFor({ state: 'visible', timeout: ms });

async function yoneticiGir(k) {
	await k.sayfa.goto(ADRES + '/#anahtar=' + ANAHTAR);
	await goruneneKadar(k, '#uygulama');
}

async function kapidanGir(k, yonetici) {
	await k.sayfa.goto(ADRES + '/');
	await k.sayfa.fill('#ad', k.ad);
	await k.sayfa.click('#gir');
	const kart = yonetici.sayfa.locator('#istekler .istek', { hasText: k.ad });
	await kart.waitFor({ timeout: 30000 });
	await kart.getByRole('button', { name: 'Kabul et' }).click();
	await goruneneKadar(k, '#uygulama', 30000);
}

async function sesliyeGir(k, kanal = 'Sesli Sohbet') {
	await k.sayfa.locator('#ses-kanallari .kanal', { hasText: kanal }).click();
	await goruneneKadar(k, '#ses-karti');
}

// Sayfadaki ses durumunu oku (ana.js'in üst düzey değişkenleri sayfa betiğinden görünür).
function durumu(k) {
	return k.sayfa.evaluate(async () => {
		const sonuc = { bagliyim, sesKanal, mik: mikrofon ? mikrofon.getAudioTracks()[0].readyState : null, esler: {} };
		for (const [ad, es] of esler) {
			const o = { durum: es.pc ? es.pc.connectionState : 'yok', oturum: es.oturum, caliyor: !!(es.ses && es.ses.srcObject && !es.ses.paused) };
			if (es.pc) {
				const r = await es.pc.getStats();
				r.forEach((s) => {
					if (s.type === 'inbound-rtp' && s.kind === 'audio') Object.assign(o, { gelenBayt: s.bytesReceived || 0, enerji: s.totalAudioEnergy || 0 });
					if (s.type === 'outbound-rtp' && s.kind === 'audio') Object.assign(o, { gidenBayt: s.bytesSent || 0 });
					if (s.type === 'transport' && s.selectedCandidatePairId) {
						const c = r.get(s.selectedCandidatePairId);
						const y = c && r.get(c.localCandidateId);
						const u = c && r.get(c.remoteCandidateId);
						o.tip = y && u ? (y.candidateType === 'relay' || u.candidateType === 'relay' ? 'TURN' : 'P2P') : null;
					}
				});
			}
			sonuc.esler[ad] = o;
		}
		return sonuc;
	});
}

// k, ad'ın sesini gerçekten alana kadar bekle (bağlantı "connected" görünse de ses akmıyor olabilir:
// ör. TURN yeniden başladı, eski bağlantı birkaç saniye daha bağlı görünür).
async function sesGelenekadar(k, ad, ms = 60000) {
	return bekleKosul(`${k.ad} ← ${ad} ses akıyor`, async () => {
		const o = await sesOlc(k, ad, 1500);
		return o.enerji > SES_VAR / 2 ? o : false;
	}, ms, 100);
}

// k, adlar'daki herkese bağlı mı (connected) ve onların sesini çalıyor mu?
async function baglantilarHazir(k, adlar, ms = 30000) {
	return bekleKosul(`${k.ad} → ${adlar.join(', ')} bağlı`, async () => {
		const d = await durumu(k);
		return adlar.every((ad) => d.esler[ad] && d.esler[ad].durum === 'connected' && d.esler[ad].caliyor) ? d : false;
	}, ms);
}

// ms boyunca k'nin ad'dan aldığı ses: enerji ve bayt artışı, giden kbps.
async function sesOlc(k, ad, ms = 2500) {
	const d1 = await durumu(k);
	await bekle(ms);
	const d2 = await durumu(k);
	const a = d1.esler[ad] || {};
	const b = d2.esler[ad] || {};
	return {
		enerji: (b.enerji || 0) - (a.enerji || 0),
		gelenKbps: (((b.gelenBayt || 0) - (a.gelenBayt || 0)) * 8) / ms,
		gidenKbps: (((b.gidenBayt || 0) - (a.gidenBayt || 0)) * 8) / ms,
		tip: b.tip,
		oturum: b.oturum,
	};
}
const SES_VAR = 0.02; // 2,5 sn'de konuşma ~0,3-1; sessizlik ~0
const SES_YOK = 0.002;

async function duyuyor(k, ad, aciklama) {
	const o = await sesOlc(k, ad);
	assert.ok(o.enerji > SES_VAR, `${aciklama || k.ad + ' → ' + ad}: ses gelmiyor (enerji ${o.enerji.toFixed(4)}, ${o.gelenKbps.toFixed(1)} kbps)`);
	return o;
}

async function sidebarKisileri(k, kanal = 'Sesli Sohbet') {
	return k.sayfa.evaluate((kanal) => {
		const k = kanallar.find((x) => x.ad === kanal);
		return k ? (k.kisiler || []).map((p) => p.ad).sort() : [];
	}, kanal);
}

// ---------------------------------------------------------------- denemeler

(async () => {
	const wav = path.join(os.tmpdir(), `ses-kanali-konusma-${process.pid}.wav`);
	konusmaWav(wav);
	await sunucuBaslat();
	tarayici = await chromium.launch({
		executablePath: process.env.CHROMIUM_YOLU || undefined,
		args: [
			'--use-fake-ui-for-media-stream',
			'--use-fake-device-for-media-stream',
			'--use-file-for-fake-audio-capture=' + wav,
			'--autoplay-policy=no-user-gesture-required',
		],
	});
	console.log(`tarayıcı denemesi: ${ADRES} (${tarayici.version()})`);

	const taha = await kisiAc('taha');
	const zeynep = await kisiAc('zeynep');
	const mert = await kisiAc('mert');

	await dene('giriş: anahtar bağlantısı ve kapıyı çalma (arayüzden)', async () => {
		await yoneticiGir(taha);
		assert.equal(await taha.sayfa.textContent('#ben-ad'), 'taha');
		assert.equal(await taha.sayfa.evaluate(() => location.hash.includes('anahtar')), false, 'anahtar adres çubuğundan silinmeli');
		await kapidanGir(zeynep, taha);
		await kapidanGir(mert, taha);
		assert.match(await zeynep.sayfa.evaluate(() => localStorage.getItem('anahtar')), /^[0-9a-f]{128}$/);
		await bekleKosul('üye listesi 3 çevrimiçi', async () => (await taha.sayfa.locator('#uye-listesi .uye:not(.cevrimdisi)').count()) === 3);
	});

	await dene('ses: üç kişilik mesh, herkes herkesi duyuyor (gerçek ses enerjisi)', async () => {
		await sesliyeGir(taha);
		await sesliyeGir(zeynep);
		await sesliyeGir(mert);
		await baglantilarHazir(taha, ['zeynep', 'mert']);
		await baglantilarHazir(zeynep, ['taha', 'mert']);
		await baglantilarHazir(mert, ['taha', 'zeynep']);
		for (const [k, adlar] of [[taha, ['zeynep', 'mert']], [zeynep, ['taha', 'mert']], [mert, ['taha', 'zeynep']]]) {
			for (const ad of adlar) await duyuyor(k, ad);
		}
		assert.deepEqual(await sidebarKisileri(taha), ['mert', 'taha', 'zeynep']);
		assert.equal(await taha.sayfa.locator('#ses-kisiler .ses-kisi').count(), 3, 'ses kartında 3 kişi (kendisi dahil)');
	});

	await dene('ses kalitesi: Opus ~96 kbps gönderiliyor (varsayılan tarayıcıda ~30 kbps kalıyordu)', async () => {
		const o = await sesOlc(taha, 'zeynep', 4000);
		console.log(`     taha → zeynep giden ${o.gidenKbps.toFixed(1)} kbps, zeynep → taha gelen ${o.gelenKbps.toFixed(1)} kbps (${o.tip})`);
		assert.ok(o.gidenKbps > 70, 'giden bit hızı düşük: ' + o.gidenKbps.toFixed(1));
		assert.ok(o.gelenKbps > 70, 'gelen bit hızı düşük: ' + o.gelenKbps.toFixed(1));
		const fmtp = await taha.sayfa.evaluate(() => esler.get('zeynep').pc.remoteDescription.sdp.match(/a=fmtp:\d+ .*maxaveragebitrate=\d+.*/)?.[0] || '');
		assert.match(fmtp, /useinbandfec=1/);
		assert.match(fmtp, /maxaveragebitrate=96000/);
	});

	await dene('susturma ve sağırlaştırma: ses gerçekten kesiliyor, diğerlerine simge gidiyor', async () => {
		await zeynep.sayfa.click('#ben-mikrofon');
		await bekle(700);
		const sessiz = await sesOlc(taha, 'zeynep');
		assert.ok(sessiz.enerji < SES_YOK, 'susturulan mikrofondan ses gelmemeli: ' + sessiz.enerji.toFixed(5));
		await duyuyor(taha, 'mert', 'susturma yalnızca zeynep\'i etkilemeli');
		await bekleKosul('taha zeynep için mikrofon-kapalı simgesini görüyor', () =>
			taha.sayfa.evaluate(() => !!document.querySelector('#ses-kisiler .ses-kisi[data-ad="zeynep"].sessiz .durum-ikon svg')),
		);
		await zeynep.sayfa.click('#ben-mikrofon');
		await bekle(700);
		await duyuyor(taha, 'zeynep', 'mikrofon açılınca ses dönmeli');
		// Sağırlaştır: gelen ses öğeleri susar, mikrofon da kapanır.
		await mert.sayfa.click('#ben-sagir');
		await bekle(700);
		assert.ok(await mert.sayfa.evaluate(() => [...esler.values()].every((e) => e.ses.muted)), 'sağırken gelen sesler kapalı olmalı');
		assert.ok((await sesOlc(taha, 'mert')).enerji < SES_YOK, 'sağırlaştırılan kişinin mikrofonu da kapanmalı');
		await mert.sayfa.click('#ben-sagir');
		await bekle(700);
		await duyuyor(taha, 'mert');
		assert.equal(await mert.sayfa.evaluate(() => [...esler.values()].some((e) => e.ses.muted)), false);
	});

	await dene('kişi başı ses seviyesi kalıcı', async () => {
		const kaydirici = taha.sayfa.locator('#ses-kisiler .ses-kisi[data-ad="mert"] input.ses-seviye');
		await kaydirici.fill('40');
		assert.equal(await taha.sayfa.evaluate(() => esler.get('mert').ses.volume), 0.4);
		assert.equal(await taha.sayfa.evaluate(() => localStorage.getItem('ses-seviye-mert')), '40');
		await kaydirici.fill('100');
	});

	await dene('çık-gir: ayrılan çıkar, geri gelen yeniden duyulur', async () => {
		await mert.sayfa.click('#ben-kapat');
		await bekleKosul('taha mert\'i kanaldan düşürdü', async () => !(await durumu(taha)).esler.mert);
		await bekleKosul('kenar çubuğunda 2 kişi', async () => (await sidebarKisileri(taha)).length === 2);
		assert.equal(await mert.sayfa.evaluate(() => mikrofon), null, 'ayrılınca mikrofon bırakılmalı');
		await sesliyeGir(mert);
		await baglantilarHazir(mert, ['taha', 'zeynep']);
		await duyuyor(mert, 'taha');
		await duyuyor(zeynep, 'mert');
	});

	await dene('mikrofon izi biterse (aygıt çıkarıldı) kendiliğinden yeniden alınır', async () => {
		await zeynep.sayfa.evaluate(() => {
			const iz = mikrofon.getAudioTracks()[0];
			iz.stop();
			iz.dispatchEvent(new Event('ended'));
		});
		await bekleKosul('zeynep yeni mikrofon aldı', () => zeynep.sayfa.evaluate(() => !!mikrofon && mikrofon.getAudioTracks()[0].readyState === 'live'), 10000);
		await bekle(800);
		await duyuyor(taha, 'zeynep', 'yeni mikrofon izi eşlere bağlanmalı');
	});

	await dene('sayfa yenileme: anahtarla kendiliğinden girer, kanala dönünce bağlantılar yeniden kurulur', async () => {
		await mert.sayfa.reload();
		await goruneneKadar(mert, '#uygulama', 30000);
		await bekleKosul('mert kanaldan düştü (taha)', async () => !(await durumu(taha)).esler.mert);
		await sesliyeGir(mert);
		await baglantilarHazir(mert, ['taha', 'zeynep']);
		await baglantilarHazir(taha, ['zeynep', 'mert']);
		await duyuyor(taha, 'mert');
		await duyuyor(mert, 'zeynep');
	});

	if (yenidenBaslatilabilir()) {
		await dene('sunucu yeniden başlarken P2P ses kesilmez, herkes kendiliğinden geri döner (10 sn fren + kova)', async () => {
			const once = {};
			for (const k of [taha, zeynep, mert]) once[k.ad] = await durumu(k);
			// Sunucu kapalıyken (3 sn) ses akmaya devam etmeli.
			const durdur = DIS_ADRES ? null : sunucuDurdur();
			if (durdur) {
				await durdur;
				await bekleKosul('istemciler kopuşu fark etti', async () => !(await durumu(taha)).bagliyim, 8000);
				const arada = await sesOlc(taha, 'zeynep', 3000);
				assert.ok(arada.enerji > SES_VAR, 'sunucu kapalıyken P2P ses sürmeli: ' + arada.enerji.toFixed(4));
				await sunucuBaslat();
			} else {
				await sunucuyuYenidenBaslat();
			}
			for (const k of [taha, zeynep, mert]) {
				await bekleKosul(`${k.ad} sunucuya geri döndü`, async () => (await durumu(k)).bagliyim, 40000);
			}
			await bekleKosul('kanalda yine 3 kişi', async () => (await sidebarKisileri(taha)).length === 3, 30000);
			for (const k of [taha, zeynep, mert]) assert.equal(await k.sayfa.isVisible('#giris-ekrani'), false, `${k.ad} giriş ekranına atılmamalı`);
			await baglantilarHazir(taha, ['zeynep', 'mert']);
			await baglantilarHazir(zeynep, ['taha', 'mert']);
			const sonra = await durumu(taha);
			if (!DIS_ADRES) {
				// Doğrudan (P2P) bağlantılar yeniden kurulmadan sürmeli: oturum kimliği aynı kalır.
				for (const ad of ['zeynep', 'mert']) {
					if (once.taha.esler[ad].tip === 'P2P') assert.equal(sonra.esler[ad].oturum, once.taha.esler[ad].oturum, `taha↔${ad} bağlantısı baştan kurulmamalı`);
				}
			}
			await duyuyor(taha, 'zeynep');
			await duyuyor(mert, 'taha');
		});
	} else atla('sunucu yeniden başlatma', 'YENIDEN_BASLAT verilmedi');

	await dene('aynı anahtarla ikinci sekme oturumu devralır; ilk sekme "bu sekmede devam et" der', async () => {
		const ikinci = await zeynep.ctx.newPage();
		try {
			await ikinci.goto(ADRES + '/');
			await ikinci.locator('#uygulama').waitFor({ state: 'visible', timeout: 30000 });
			await goruneneKadar(zeynep, '#burada-devam', 10000);
			assert.match(await zeynep.sayfa.textContent('#giris-durum'), /başka bir sekmede/);
			assert.equal(await zeynep.sayfa.evaluate(() => mikrofon), null, 'devredilen sekmede mikrofon kapanmalı');
			await ikinci.close();
			await zeynep.sayfa.click('#burada-devam');
			await goruneneKadar(zeynep, '#uygulama', 30000);
			await sesliyeGir(zeynep);
			await baglantilarHazir(zeynep, ['taha', 'mert']);
		} finally {
			if (!ikinci.isClosed()) await ikinci.close();
		}
	});

	if (turnVar) {
		await dene('yalnızca TURN (relay): bağlanır, ses iki yönde akar', async () => {
			for (const k of [zeynep, mert]) await k.sayfa.click('#ben-kapat');
			const ayse = await kisiAc('ayse', { zorlaTurn: true });
			const bora = await kisiAc('bora', { zorlaTurn: true });
			await kapidanGir(ayse, taha);
			await kapidanGir(bora, taha);
			await taha.sayfa.click('#ben-kapat');
			await sesliyeGir(ayse, 'Müzik');
			await sesliyeGir(bora, 'Müzik');
			await baglantilarHazir(ayse, ['bora'], 40000);
			const o = await duyuyor(ayse, 'bora');
			assert.equal(o.tip, 'TURN', 'zorla TURN: bağlantı relay üzerinden olmalı');
			await duyuyor(bora, 'ayse');
			if (yenidenBaslatilabilir()) {
				// coturn da yeniden başlar (yeni sır): eski aktarım ölür, taze şifreyle kurtarılmalı.
				const oncekiOturum = (await durumu(ayse)).esler.bora.oturum;
				const t0 = Date.now();
				await sunucuyuYenidenBaslat();
				await bekleKosul('ayse geri döndü', async () => (await durumu(ayse)).bagliyim, 40000);
				const o2 = await sesGelenekadar(ayse, 'bora');
				console.log(`     TURN yeniden başladıktan ${((Date.now() - t0) / 1000).toFixed(1)} sn sonra ses yeniden akıyor (oturum ${o2.oturum === oncekiOturum ? 'aynı: ICE yenilendi' : 'yeni'})`);
				assert.equal(o2.tip, 'TURN');
				await sesGelenekadar(bora, 'ayse', 20000);
			}
			await kisiKapat(ayse);
			await kisiKapat(bora);
		});
	} else atla('yalnızca TURN', 'coturn yok');

	await dene('sayfada beklenmedik JavaScript hatası yok', async () => {
		for (const k of kisiler) assert.deepEqual(k.hatalar, [], `${k.ad} sayfasında hata`);
	});

	await tarayici.close();
	await sunucuDurdur();
	fs.rmSync(wav, { force: true });
	if (veriKlasoru) fs.rmSync(veriKlasoru, { recursive: true, force: true });
	console.log(process.exitCode ? 'BAŞARISIZ' : `Tarayıcı denemeleri geçti (${gecen}${atlanan ? `, ${atlanan} atlandı` : ''}).`);
	process.exit(process.exitCode || 0);
})().catch(async (e) => {
	console.error(e);
	await sunucuDurdur().catch(() => {});
	process.exit(1);
});
