// Gerçek tarayıcı denemesi: Playwright + Chromium, sahte mikrofon (konuşmaya benzeyen sentetik ses).
// Arayüzün kendisiyle (tıklayarak) girer, sesli kanalda gerçek WebRTC bağlantılarını ölçer:
//   - beyaz liste: anahtar bağlantısıyla giriş, kapıyı çalma + kabul
//   - üç kişilik mesh: herkes herkesi duyuyor mu (gelen sesin ENERJİSİ artıyor mu, yalnızca bayt değil);
//     mert ayrı bir tarayıcıda başka bir sesle konuşur
//   - gönderilen bit hızı (Opus tavanı), kayıplara karşı yedek (RED: mikrofon ve paylaşım kanalında, iki
//     yönde, teklif eden de yanıtlayan da), susturma / sağırlaştırma, çık-gir, sayfa yenileme
//   - mikrofon izi biterse (aygıt çıkarıldı) kendiliğinden yeniden bağlanma
//   - sohbette dipte kalma (ses kartı açıkken, ekran/klavye küçülünce) ve uzun resim büyüteci
//   - ölü bağlantı: sunucu yanıt vermezken (dondurulmuş) sayfa öne gelince fark edilmesi, P2P sesin
//     sürmesi, sunucu dönünce kendiliğinden bağlanma (DONDUR/COZ ile dış sunucuda da)
//   - sunucu yeniden başlarken P2P sesin KESİLMEMESİ ve herkesin kendiliğinden geri dönmesi
//   - yalnızca TURN (relay) ile bağlantı; sunucu (ve coturn) yeniden başlayınca taze şifreyle kurtarma
//   - aynı anahtarla ikinci sekme: oturum devri
//   - sorunsuz bağlantıda yanlış "Bağlantı zayıf" uyarısı çıkmaması
//   - P2P dosya: resim önizlemesi doğrudan paylaşandan; 24 MB dosya ortada bağlantısı koparılsa da
//     kaldığı yerden eksiksiz gelir (içerik özeti aynı), iki kişi aynı anda indirir
//   - ekransız paylaşım (bilgisayarın sesi): yakalama sürer ama yalnızca ses gider (stereo, yüksek bit
//     hızı); ekran yeniden seçmeden gösterilip gizlenir; dinleyen kendi için susturur
//   - ekran paylaşımı ses vermeyen tarayıcı (Firefox gibi): ekransız paylaşımın sesi bir ses aygıtından
//     (mikrofonla aynı anda, tarayıcının ses işlemleri kapalı); ekran sonradan eklenir, ekran bitince ses sürer
//   - ses aygıtından paylaşımda kanaldakilerin konuşması paylaşılan sesten çıkarılır (geri döngü taklidi:
//     müzik + çalınanın gecikmiş kopyası): konuşma ≥25 dB azalır, müzik bozulmaz, gecikme sıçrayınca
//     süzgeç yeni yere geçer, kimse konuşmuyorken ses olduğu gibi gider
//   - ekran paylaşımı (bilgisayar sesiyle): izleyene görüntü gider, görüntüyü kapatana gitmez
//
//   node test/tarayici.js                    kendi sunucusunu (node sunucu/sunucu.js) geçici veriyle açar
//   node test/tarayici.js http://adres:port  çalışan sunucuya bağlanır (ILK_ANAHTAR gerekir;
//                                            YENIDEN_BASLAT='komut' verilirse yeniden başlatma denenir)
//   DENEME='giriş|üç kişilik|...' node test/tarayici.js   yalnızca adı uyan denemeler
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
// Kendi açtığımız sunucunun ayarları. Giriş kovası üretimdeki gibi 1; aralık denemeler hızlı geçsin
// diye 1 sn (yeniden başlatma denemesi üretim aralığına, 10 sn'ye geçer). Ortam değişkeniyle
// değiştirilebilir (ör. GIRIS_KOVA=10: testlerde kova arttırılabilir).
const sunucuOrtami = {
	GIRIS_ARALIK_MS: process.env.GIRIS_ARALIK_MS || '1000',
	GIRIS_KOVA: process.env.GIRIS_KOVA || '1',
	SES_ASKI_MS: process.env.SES_ASKI_MS || '20000',
};

async function sunucuBaslat() {
	if (DIS_ADRES) return;
	if (!veriKlasoru) veriKlasoru = fs.mkdtempSync(path.join(os.tmpdir(), 'diszort-tarayici-'));
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
			...sunucuOrtami,
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
		if (/Diszort çalışıyor/.test(gunluk)) break;
		if (sunucuSureci.exitCode !== null) throw new Error('sunucu açılamadı:\n' + gunluk);
		await bekle(100);
	}
	if (!/Diszort çalışıyor/.test(gunluk)) throw new Error('sunucu zamanında açılmadı:\n' + gunluk);
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

// ek: kendi açtığımız sunucuda bundan sonraki ayarlar (dış sunucuda yok sayılır).
async function sunucuyuYenidenBaslat(ek = {}) {
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
	Object.assign(sunucuOrtami, ek);
	await sunucuBaslat();
}
const yenidenBaslatilabilir = () => !DIS_ADRES || !!process.env.YENIDEN_BASLAT;

// Sunucuyu dondur / çöz: süreç durur ama bağlantılar açık kalır (yanıt vermeyen sunucu). Telefonun
// uykudan uyanınca bulduğu "açık görünen ama ölü" bağlantının benzeri. Dış sunucuda DONDUR/COZ
// komutları (ör. sudo docker pause diszort / sudo docker unpause diszort) gerekir.
const dondurulabilir = () => !DIS_ADRES || (!!process.env.DONDUR && !!process.env.COZ);
function sunucuyuDondur() {
	if (DIS_ADRES) execSync(process.env.DONDUR, { stdio: 'inherit' });
	else process.kill(sunucuSureci.pid, 'SIGSTOP');
}
function sunucuyuCoz() {
	if (DIS_ADRES) execSync(process.env.COZ, { stdio: 'inherit' });
	else process.kill(sunucuSureci.pid, 'SIGCONT');
}

// ---------------------------------------------------------------- deneme düzeni

let gecen = 0;
let atlanan = 0;
// DENEME='giriş|üç kişilik|konuşması' gibi bir düzenli ifade verilirse yalnızca adı uyan denemeler
// çalışır (geliştirirken; sonrakiler öncekilerin kurduğu duruma dayandığı için kurulumu da seç).
const SECILI = process.env.DENEME ? new RegExp(process.env.DENEME) : null;
async function dene(ad, fn) {
	if (SECILI && !SECILI.test(ad)) return atla(ad, 'DENEME süzgeci');
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
// ses: { perde (Hz), hece (Hz), tohum } — ikinci tarayıcıdaki kişi başka bir sesle konuşur.
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
let tarayici2; // mert başka bir sesle konuşsun diye ayrı tarayıcı (sahte mikrofon tarayıcı başına tek kayıt)
const kisiler = [];

async function kisiAc(ad, { zorlaTurn = false, ikinci = false } = {}) {
	const ctx = await (ikinci ? tarayici2 : tarayici).newContext({ permissions: ['microphone'] });
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

// Sayfadaki ses durumunu oku (ana.js'in üst düzey değişkenleri sayfa betiğinden görünür). Her kanal
// (mikrofon, yayın sesi, görüntü) kendi alıcı/gönderici istatistiğinden okunur: bağlantıda birden
// çok ses kaydı vardır.
function durumu(k) {
	return k.sayfa.evaluate(async () => {
		const sonuc = { bagliyim, sesKanal, mik: mikrofon ? mikrofon.getAudioTracks()[0].readyState : null, esler: {} };
		const oku = async (nesne, tur) => {
			let bulunan = null;
			let tip = null;
			if (!nesne) return { kayit: null, tip };
			const r = await nesne.getStats();
			r.forEach((s) => {
				if (s.type === tur) bulunan = s;
				if (s.type === 'transport' && s.selectedCandidatePairId) {
					const c = r.get(s.selectedCandidatePairId);
					const y = c && r.get(c.localCandidateId);
					const u = c && r.get(c.remoteCandidateId);
					tip = y && u ? (y.candidateType === 'relay' || u.candidateType === 'relay' ? 'TURN' : 'P2P') : null;
				}
			});
			return { kayit: bulunan, tip };
		};
		for (const [ad, es] of esler) {
			const o = { durum: es.pc ? es.pc.connectionState : 'yok', oturum: es.oturum, caliyor: !!(es.ses && es.ses.srcObject && !es.ses.paused) };
			if (es.pc && es.tr) {
				const gelen = await oku(es.tr.receiver, 'inbound-rtp');
				const giden = await oku(es.tr.sender, 'outbound-rtp');
				if (gelen.kayit) Object.assign(o, { gelenBayt: gelen.kayit.bytesReceived || 0, enerji: gelen.kayit.totalAudioEnergy || 0 });
				if (giden.kayit) o.gidenBayt = giden.kayit.bytesSent || 0;
				o.tip = gelen.tip || giden.tip;
				const ys = await oku(es.trSes && es.trSes.receiver, 'inbound-rtp');
				const ysg = await oku(es.trSes && es.trSes.sender, 'outbound-rtp');
				const g = await oku(es.trGoruntu && es.trGoruntu.receiver, 'inbound-rtp');
				const gg = await oku(es.trGoruntu && es.trGoruntu.sender, 'outbound-rtp');
				o.yayinEnerji = ys.kayit ? ys.kayit.totalAudioEnergy || 0 : 0;
				o.yayinGelenBayt = ys.kayit ? ys.kayit.bytesReceived || 0 : 0;
				o.yayinGidenBayt = ysg.kayit ? ysg.kayit.bytesSent || 0 : 0;
				o.kare = g.kayit ? g.kayit.framesDecoded || 0 : 0;
				o.kareGenislik = g.kayit ? g.kayit.frameWidth || 0 : 0;
				o.goruntuGidenBayt = gg.kayit ? gg.kayit.bytesSent || 0 : 0;
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

// Mesaj alanının dibine uzaklık (px) ve "Yeni mesaj ↓" düğmesi görünüyor mu.
function dipDurumu(k) {
	return k.sayfa.evaluate(() => {
		const a = document.getElementById('mesaj-alani');
		return { fark: Math.round(a.scrollHeight - a.scrollTop - a.clientHeight), dugme: !document.getElementById('yeni-mesaj').hidden, adet: mesajVerisi.length };
	});
}
const mesajYaz = (k, metin) => k.sayfa.evaluate((metin) => gonder({ type: 'yazi', kanal: aktifKanal, metin }), metin);
async function mesajGelene(k, adet) {
	await bekleKosul(`${k.ad} ${adet} mesaj gördü`, async () => (await dipDurumu(k)).adet >= adet, 10000, 100);
	await bekle(300); // kaydırma/yerleşim otursun
	return dipDurumu(k);
}

async function sidebarKisileri(k, kanal = 'Sesli Sohbet') {
	return k.sayfa.evaluate((kanal) => {
		const k = kanallar.find((x) => x.ad === kanal);
		return k ? (k.kisiler || []).map((p) => p.ad).sort() : [];
	}, kanal);
}

// ---------------------------------------------------------------- denemeler

(async () => {
	const wav = path.join(os.tmpdir(), `diszort-konusma-${process.pid}.wav`);
	konusmaWav(wav);
	// İkinci ses (mert): başka perde ve hece hızı. Herkes aynı kaydı çalınca kanaldakilerin sesini
	// çıkarma denemesinde bir kişinin referansı ötekinin yankısıyla da ilintili olurdu (gerçekte olmaz).
	const wav2 = path.join(os.tmpdir(), `diszort-konusma2-${process.pid}.wav`);
	konusmaWav(wav2, 12, { perde: 205, hece: 4.3, tohum: 99 });
	await sunucuBaslat();
	const ac = (dosya) =>
		chromium.launch({
			executablePath: process.env.CHROMIUM_YOLU || undefined,
			args: [
				'--use-fake-ui-for-media-stream',
				'--use-fake-device-for-media-stream',
				'--use-file-for-fake-audio-capture=' + dosya,
				'--autoplay-policy=no-user-gesture-required',
				// Ekran paylaşımı: seçim penceresi yerine sahte ekran (ve sahte sistem sesi).
				'--auto-select-desktop-capture-source=Entire screen',
			],
		});
	tarayici = await ac(wav);
	tarayici2 = await ac(wav2);
	console.log(`tarayıcı denemesi: ${ADRES} (${tarayici.version()})`);

	const taha = await kisiAc('taha');
	const zeynep = await kisiAc('zeynep');
	const mert = await kisiAc('mert', { ikinci: true });

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
		// Bağlantı türü ortadaki kartta: doğrudan (P2P) yeşil, turuncu değil.
		await bekleKosul('P2P bilgisi göründü', () => taha.sayfa.evaluate(() => /P2P/.test(document.querySelector('#ses-kisiler .ses-kisi[data-ad="zeynep"] .ses-istatistik').textContent)));
		assert.equal(await taha.sayfa.evaluate(() => document.querySelectorAll('#ses-kisiler .ses-istatistik.turn').length), 0, 'P2P bağlantı turuncu görünmemeli');
	});

	await dene('sohbet: ses kartı açıkken ve ekran küçülünce (telefon klavyesi) yeni mesajda dipte kalınır; yukarı bakan bölünmez', async () => {
		// Kaydırılacak kadar mesaj (kişi başı 10 sn'de 12 mesaj sınırı: iki kişiden).
		const a0 = (await dipDurumu(taha)).adet;
		for (let i = 0; i < 10; i++) await mesajYaz(zeynep, `doldurma ${i}\nikinci satır\nüçüncü satır`);
		for (let i = 10; i < 20; i++) await mesajYaz(mert, `doldurma ${i}\nikinci satır\nüçüncü satır`);
		let d = await mesajGelene(taha, a0 + 20);
		assert.ok(d.fark <= 2 && !d.dugme, 'ses kartı açıkken gelen mesajlarda dipte kalınmalı: ' + JSON.stringify(d));
		// Klavye açıldı gibi: görünen alan küçülür (kaydırma olayı olmadan dip aşağıda kalırdı).
		await taha.sayfa.setViewportSize({ width: 1280, height: 420 });
		await bekle(400);
		assert.ok((await dipDurumu(taha)).fark <= 2, 'alan küçülünce dipte kalınmalı');
		await mesajYaz(zeynep, 'klavye açıkken gelen');
		d = await mesajGelene(taha, a0 + 21);
		assert.ok(d.fark <= 2 && !d.dugme, 'alan küçükken gelen mesajda dibe inilmeli: ' + JSON.stringify(d));
		await taha.sayfa.setViewportSize({ width: 1280, height: 720 });
		await bekle(400);
		// Yukarı kaydıran okurken bölünmez: düğme çıkar, düğmeyle dibe iner.
		await taha.sayfa.mouse.move(640, 300);
		await taha.sayfa.mouse.wheel(0, -600);
		await bekle(600);
		await mesajYaz(mert, 'yukarıdayken gelen');
		d = await mesajGelene(taha, a0 + 22);
		assert.ok(d.fark > 300 && d.dugme, 'yukarı bakan aşağı çekilmemeli, "yeni mesaj" düğmesi çıkmalı: ' + JSON.stringify(d));
		await taha.sayfa.click('#yeni-mesaj');
		await bekle(300);
		assert.ok((await dipDurumu(taha)).fark <= 2, 'düğme dibe indirmeli');
	});

	await dene('resim büyüteci: uzun dikey resim tam genişlikte açılır, aşağı kaydırılabilir (eskiden altı kesiliyordu)', async () => {
		const a0 = (await dipDurumu(taha)).adet;
		await zeynep.sayfa.evaluate(async () => {
			const c = document.createElement('canvas');
			c.width = 500;
			c.height = 3600;
			const x = c.getContext('2d');
			const g = x.createLinearGradient(0, 0, 0, c.height);
			g.addColorStop(0, '#e44');
			g.addColorStop(1, '#44e');
			x.fillStyle = g;
			x.fillRect(0, 0, c.width, c.height);
			const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
			// P2P: resim sunucuya yüklenmez; diğerleri önizlemeyi doğrudan zeynep'ten alır.
			dosyalariPaylas([new File([blob], 'uzun.png', { type: 'image/png' })]);
		});
		await mesajGelene(taha, a0 + 1);
		const resim = taha.sayfa.locator('#mesajlar img.onizleme').last();
		await bekleKosul('önizleme yüklendi', () => resim.evaluate((r) => r.complete && r.naturalWidth > 0));
		await bekle(400);
		assert.ok((await dipDurumu(taha)).fark <= 2, 'resim yüklenince dipte kalınmalı');
		await resim.click();
		await bekleKosul('büyüteç tam genişlikte açıldı', () => taha.sayfa.evaluate(() => !document.getElementById('buyutec').hidden && document.getElementById('buyutec').classList.contains('tam')));
		const k = await taha.sayfa.evaluate(() => {
			const k = document.getElementById('buyutec-kaydir');
			return { sh: k.scrollHeight, ch: k.clientHeight };
		});
		assert.ok(k.sh > k.ch * 2, 'uzun resim kaydırılabilir olmalı: ' + JSON.stringify(k));
		await taha.sayfa.mouse.move(640, 360);
		await taha.sayfa.mouse.wheel(0, 4000);
		await bekleKosul('büyüteçte aşağı kaydı', () => taha.sayfa.evaluate(() => document.getElementById('buyutec-kaydir').scrollTop > 1500), 5000);
		await taha.sayfa.keyboard.press('Escape');
		await bekleKosul('büyüteç kapandı', () => taha.sayfa.evaluate(() => document.getElementById('buyutec').hidden), 5000);
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

	await dene('kayıplara karşı yedek (RED): mikrofon ve paylaşım kanalında iki yönde de anlaşılıyor, her paket bir öncekinin kopyasını taşıyor', async () => {
		// Teklif eden (taha > mert, zeynep > taha) ve yanıtlayan taraf: gönderilen kodek RED, SDP'de RED önde.
		const durumlar = await Promise.all(
			[taha, zeynep, mert].map((k) =>
				k.sayfa.evaluate(() =>
					[...esler.values()].map((e) => ({
						ad: e.ad,
						teklifci: e.teklifci,
						mik: e.tr.sender.getParameters().codecs.map((c) => c.mimeType)[0],
						yayin: e.trSes.sender.getParameters().codecs.map((c) => c.mimeType)[0],
						sira: (e.pc.remoteDescription.sdp.match(/m=audio \d+ \S+ (\d+)/g) || []).map((m) => m.split(' ').pop()),
						red: (e.pc.remoteDescription.sdp.match(/a=rtpmap:(\d+) red\/48000/) || [])[1],
					})),
				),
			),
		);
		for (const [i, liste] of durumlar.entries()) {
			for (const x of liste) {
				const kim = `${['taha', 'zeynep', 'mert'][i]} → ${x.ad} (${x.teklifci ? 'teklif eden' : 'yanıtlayan'})`;
				assert.equal(x.mik, 'audio/red', `${kim}: mikrofon RED'le gitmeli`);
				assert.equal(x.yayin, 'audio/red', `${kim}: paylaşımın sesi RED'le gitmeli`);
				assert.ok(x.red && x.sira.length === 2 && x.sira.every((pt) => pt === x.red), `${kim}: karşının SDP'sinde RED önde olmalı: ${JSON.stringify(x)}`);
			}
		}
		// Hatta giden: Opus'un (~96 kbps) yaklaşık iki katı.
		const o = await sesOlc(taha, 'zeynep', 4000);
		console.log(`     RED'le taha → zeynep giden ${o.gidenKbps.toFixed(1)} kbps, gelen ${o.gelenKbps.toFixed(1)} kbps`);
		assert.ok(o.gidenKbps > 130 && o.gelenKbps > 130, 'RED yedeği gitmiyor gibi: ' + o.gidenKbps.toFixed(1) + ' / ' + o.gelenKbps.toFixed(1));
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

	await dene('bağlantı kalitesi: sorunsuz bağlantıda "Bağlantı zayıf" denmez, kimse kırmızı görünmez', async () => {
		for (let i = 0; i < 8; i++) {
			for (const k of [taha, zeynep, mert]) {
				const d = await k.sayfa.evaluate(() => ({
					panel: document.getElementById('ses-baglanti-durum').textContent + ' · ' + document.getElementById('ses-baglanti-kanal').textContent,
					kotu: [...document.querySelectorAll('#ses-kisiler .ses-istatistik.kotu')].map((e) => e.textContent),
				}));
				assert.ok(!/zayıf/.test(d.panel) && !d.kotu.length, `${k.ad}: ${d.panel} ${d.kotu.join(', ')}`);
			}
			await bekle(1000);
		}
	});

	await dene('P2P dosya: 24 MB, bağlantı ortada koparılsa da kaldığı yerden eksiksiz gelir; iki kişi aynı anda indirir', async () => {
		const BOYUT = 24 * 1024 * 1024;
		const { id, ozet } = await zeynep.sayfa.evaluate(async (n) => {
			const veri = new Uint8Array(n);
			for (let i = 0; i < n; i += 65536) crypto.getRandomValues(veri.subarray(i, i + 65536));
			const ozet = [...new Uint8Array(await crypto.subtle.digest('SHA-256', veri))].map((b) => b.toString(16).padStart(2, '0')).join('');
			dosyalariPaylas([new File([veri], 'buyuk.bin', { type: 'application/octet-stream' })]);
			return { id: [...paylasimlarim.keys()].at(-1), ozet };
		}, BOYUT);
		// taha tarayıcının dosya alanına (OPFS) yazar ve bağlantısı %30'da koparılır; mert belleğe yazar.
		await taha.sayfa.evaluate((id) => {
			localStorage.setItem('dosya-yazici', 'opfs');
			window.kopma = 0;
			const t = setInterval(() => {
				const a = indirmeler.get(id);
				if (a && a.bag && a.alinan > a.boyut * 0.3) {
					window.kopma = a.alinan;
					clearInterval(t);
					bagKapat(a.bag, 'deneme: bağlantı koparıldı');
				}
			}, 1);
		}, id);
		await mert.sayfa.evaluate(() => localStorage.setItem('dosya-yazici', 'bellek'));
		const t0 = Date.now();
		for (const k of [taha, mert]) {
			const d = k.sayfa.locator(`.p2p-dosya[data-dosya="${id}"] button`, { hasText: 'İndir' });
			await d.waitFor({ timeout: 15000 });
			await bekleKosul(`${k.ad}: İndir açıldı (zeynep sunuyor)`, () => d.isEnabled(), 10000);
			await d.click();
		}
		for (const k of [taha, mert]) {
			await bekleKosul(`${k.ad} dosyayı aldı`, () => k.sayfa.evaluate((id) => alinanlar.has(id), id), 90000, 250);
			const alinan = await k.sayfa.evaluate(async (id) => {
				const veri = await alinanlar.get(id).dosya.arrayBuffer();
				const ozet = [...new Uint8Array(await crypto.subtle.digest('SHA-256', veri))].map((b) => b.toString(16).padStart(2, '0')).join('');
				return { ozet, boyut: veri.byteLength };
			}, id);
			assert.equal(alinan.boyut, BOYUT, `${k.ad}: boyut`);
			assert.equal(alinan.ozet, ozet, `${k.ad}: içerik özeti farklı`);
		}
		const kopma = await taha.sayfa.evaluate(() => window.kopma);
		assert.ok(kopma > 0 && kopma < BOYUT, "taha'nın bağlantısı aktarım ortasında koparılmalıydı");
		console.log(`     ${((Date.now() - t0) / 1000).toFixed(1)} sn; taha'nın bağlantısı ${(kopma / 1048576).toFixed(1)} MB'da koparıldı, kaldığı yerden sürdü; ikisi de eksiksiz aldı`);
		await bekleKosul('aktarım panelleri kapandı', async () => {
			for (const k of [taha, mert, zeynep]) if (!(await k.sayfa.evaluate(() => document.getElementById('aktarimlar').hidden))) return false;
			return true;
		}, 10000);
		for (const k of [taha, mert]) await k.sayfa.evaluate(() => localStorage.removeItem('dosya-yazici'));
	});

	await dene('ekransız paylaşım: yakalama sürer ama yalnızca ses gider (stereo, yüksek bit hızı, mikrofondan ayrı); ekran yeniden seçmeden gösterilip gizlenir', async () => {
		// Sahte ekran yakalamanın sesi (test tarayıcısında sahte mikrofonla aynı konuşma kaydı) bilgisayarın sesi yerine geçer.
		await mert.sayfa.click('#yayin-ac');
		await mert.sayfa.locator('#yayin-menu button', { hasText: 'Ekransız paylaş' }).click();
		await bekleKosul('mert ekransız paylaşıyor (görüntü yakalaması sürüyor)', () => mert.sayfa.evaluate(() => !!yayin.ses && yayin.ekransiz && !!yayin.goruntu && yayin.goruntu.readyState === 'live'), 10000);
		await bekleKosul('ses herkese takıldı, görüntü kimseye', () => mert.sayfa.evaluate(() => [...esler.values()].every((e) => e.trSes.sender.track === yayin.ses && e.trGoruntu.sender.track === null)), 5000, 100);
		const kart = (k) =>
			k.sayfa.evaluate(() => {
				const e = document.querySelector('#yayinlar .yayin-kart[data-ad="mert"]');
				return e && { ekransiz: e.classList.contains('ekransiz'), sahneGizli: e.querySelector('.yayin-sahne').hidden, sesGizli: e.querySelector('.yayin-ses').hidden, isik: e.classList.contains('ses-var') };
			});
		for (const k of [taha, zeynep]) {
			await bekleKosul(`${k.ad}: mert'in ekransız yayın kartı (görüntüsüz, ses satırlı)`, async () => {
				const x = await kart(k);
				return x && x.ekransiz && x.sahneGizli && !x.sesGizli;
			}, 10000);
		}
		assert.equal(await taha.sayfa.evaluate(() => document.querySelectorAll('#ses-kanallari .ses-uyesi').length), 3, 'kanalda ayrı (sanal) kişi yok');
		await bekleKosul('taha ← mert paylaşımın sesi akıyor (ayrı kanalda)', async () => {
			const d1 = await durumu(taha);
			await bekle(1500);
			const d2 = await durumu(taha);
			return d2.esler.mert.yayinEnerji - d1.esler.mert.yayinEnerji > SES_VAR / 2;
		}, 20000, 100);
		await bekleKosul("taha'da mert'in kartı ses geldikçe ışıyor", async () => (await kart(taha)).isik, 10000);
		const bolum = await mert.sayfa.evaluate(() => esler.get('taha').pc.remoteDescription.sdp.split('m=audio').slice(1)[1] || '');
		assert.match(bolum, /stereo=1/, 'paylaşımın sesi stereo anlaşılmalı');
		const d1 = await durumu(mert);
		await bekle(3000);
		const d2 = await durumu(mert);
		const kbps = ((d2.esler.taha.yayinGidenBayt - d1.esler.taha.yayinGidenBayt) * 8) / 3000;
		const kare = d2.esler.taha.goruntuGidenBayt - d1.esler.taha.goruntuGidenBayt;
		console.log(`     ekransız paylaşımın sesi mert → taha ${kbps.toFixed(1)} kbps (stereo Opus, tavan 160); görüntü ${kare} bayt`);
		assert.ok(kbps > 48, 'paylaşımın ses bit hızı düşük: ' + kbps.toFixed(1));
		assert.ok(kare === 0, 'ekransızken görüntü gönderilmemeli: ' + kare + ' bayt');
		await duyuyor(taha, 'mert', 'paylaşırken mikrofon da ayrıca duyulmalı');
		// taha paylaşımın sesini kendi için susturur: yalnızca onda susar, mert göndermeye devam eder.
		const sus = taha.sayfa.locator('#yayinlar .yayin-kart[data-ad="mert"] .yayin-ses button.sus');
		await sus.click();
		assert.equal(await taha.sayfa.evaluate(() => esler.get('mert').yayinSesOgesi.muted), true, "taha'da susmalı");
		assert.ok(await mert.sayfa.evaluate(() => !!esler.get('taha').trSes.sender.track), 'susturmak yalnızca yerel: mert göndermeye devam etmeli');
		await sus.click();
		// Ekranı göster: aynı yakalamanın görüntüsü yeniden seçmeden gider.
		await mert.sayfa.locator('#yayinlar .yayin-kart.ben button', { hasText: 'Ekranı göster' }).click();
		for (const k of [taha, zeynep]) {
			await bekleKosul(`${k.ad} mert'in ekranını görüyor`, () =>
				k.sayfa.evaluate(() => {
					const v = document.querySelector('#yayinlar .yayin-kart[data-ad="mert"] video');
					return !!v && v.videoWidth > 0 && !v.paused;
				}),
			);
		}
		// Ekranı gizle: görüntü durur, ses ve yakalama sürer.
		await mert.sayfa.locator('#yayinlar .yayin-kart.ben button', { hasText: 'Ekranı gizle' }).click();
		await bekleKosul('mert artık görüntü göndermiyor', () => mert.sayfa.evaluate(() => [...esler.values()].every((e) => e.trGoruntu.sender.track === null)), 5000, 100);
		await bekle(500);
		const h1 = await durumu(taha);
		await bekle(1500);
		const h2 = await durumu(taha);
		assert.ok(h2.esler.mert.kare - h1.esler.mert.kare <= 2, 'ekran gizlenince kare gelmemeli');
		assert.ok(h2.esler.mert.yayinEnerji - h1.esler.mert.yayinEnerji > SES_VAR / 2, 'ekran gizlenince ses sürmeli');
		assert.equal(await mert.sayfa.evaluate(() => yayin.goruntu.readyState), 'live', 'yakalama sürmeli');
		// Durdur: kart herkesten kalkar, izler çıkar.
		await mert.sayfa.locator('#yayinlar .yayin-kart.ben button', { hasText: 'Durdur' }).click();
		await bekleKosul('ekransız paylaşım herkeste kalktı', async () => {
			for (const k of [taha, zeynep, mert]) if (await k.sayfa.evaluate(() => !!document.querySelector('#yayinlar .yayin-kart'))) return false;
			return true;
		}, 10000);
		await bekleKosul('mert artık ses ve görüntü göndermiyor', () => mert.sayfa.evaluate(() => [...esler.values()].every((e) => !e.trGoruntu.sender.track && !e.trSes.sender.track)), 5000, 100);
	});

	await dene('ekran paylaşımı ses vermeyen tarayıcı (Firefox gibi): ekransız paylaşımın sesi ses aygıtından; ekran sonradan eklenir, ekran bitince ses sürer', async () => {
		// Firefox ve Safari ekran yakalamasının ses kısıtlarını tanımaz (ve ses vermez): zeynep'te öyle
		// görünsün. Bilgisayarın sesi ("Monitor of …") yerine Chromium'un sahte ses aygıtı seçilir.
		await zeynep.sayfa.evaluate(() => {
			const asil = navigator.mediaDevices.getSupportedConstraints.bind(navigator.mediaDevices);
			window.asilKisitlar = asil;
			navigator.mediaDevices.getSupportedConstraints = () => {
				const d = { ...asil() };
				delete d.suppressLocalAudioPlayback;
				delete d.restrictOwnAudio;
				return d;
			};
		});
		await zeynep.sayfa.click('#yayin-ac');
		await zeynep.sayfa.locator('#yayin-menu button', { hasText: 'Ekransız paylaş' }).click();
		await goruneneKadar(zeynep, '#ses-kaynagi');
		await bekleKosul('ses aygıtları listelendi', () => zeynep.sayfa.evaluate(() => !document.getElementById('ses-kaynagi-aygit').disabled), 10000);
		assert.equal(await zeynep.sayfa.evaluate(() => yayinVar()), false, 'aygıt seçilmeden paylaşım başlamamalı (seçim penceresi de açılmamalı)');
		const secenekler = await zeynep.sayfa.evaluate(() => [...document.getElementById('ses-kaynagi-aygit').options].map((o) => ({ ad: o.textContent, id: o.value })));
		const aygit = secenekler.find((o) => /Fake Audio Input 1/.test(o.ad));
		assert.ok(aygit, 'sahte ses aygıtı listelenmeli: ' + secenekler.map((o) => o.ad).join(' | '));
		await zeynep.sayfa.selectOption('#ses-kaynagi-aygit', aygit.id);
		assert.equal(await zeynep.sayfa.locator('#ses-kaynagi input[type=checkbox]').count(), 0, 'paylaşım penceresinde yankı engelleme seçeneği olmamalı');
		// Denemede herkesin mikrofonu ve sahte ses aygıtı aynı konuşma kaydını çalıyor: kaydırmaları
		// birbirine yakın düşerse çıkarıcı onu "yankı" sanabilirdi. zeynep taha ile mert'i kendi için
		// sustursun (çalmadığı ses çıkarılmaz); çıkarmanın kendisi bir sonraki denemede.
		await zeynep.sayfa.evaluate(() => {
			for (const ad of ['taha', 'mert']) {
				esler.get(ad).susturuldu = true;
				esSesUygula(esler.get(ad));
			}
		});
		await zeynep.sayfa.click('#ses-kaynagi-paylas');
		await bekleKosul('zeynep ses aygıtından ekransız paylaşıyor', () => zeynep.sayfa.evaluate((id) => !!yayin.ses && yayin.aygit === id && !yayin.goruntu && yayin.ekransiz && yayin.ses.readyState === 'live', aygit.id), 10000);
		assert.equal(await zeynep.sayfa.evaluate(() => !!yayin.yanki && yayin.ses === yayin.yanki.iz && yayin.hamSes === yayin.yanki.ham), true, 'giden iz kanaldakilerin sesini çıkaranın çıkışı olmalı');
		const ayarlari = await zeynep.sayfa.evaluate(() => yayin.hamSes.getSettings());
		assert.equal(ayarlari.deviceId, aygit.id, 'ses seçilen aygıttan alınmalı');
		assert.equal(ayarlari.echoCancellation, false, 'tarayıcının yankı engellemesi kapalı olmalı (müziği eşikle kesiyordu)');
		assert.equal(ayarlari.noiseSuppression, false, 'gürültü bastırma müziği bozar');
		assert.equal(ayarlari.autoGainControl, false, 'otomatik kazanç müziği bozar');
		assert.notEqual(await zeynep.sayfa.evaluate(() => mikrofon.getAudioTracks()[0].readyState), 'ended', 'mikrofon sürmeli');
		await bekleKosul('aygıtın sesi herkese takıldı, görüntü kimseye', () => zeynep.sayfa.evaluate(() => [...esler.values()].every((e) => e.trSes.sender.track === yayin.ses && e.trGoruntu.sender.track === null)), 5000, 100);
		const kart = (k) =>
			k.sayfa.evaluate(() => {
				const e = document.querySelector('#yayinlar .yayin-kart[data-ad="zeynep"]');
				return e && { ekransiz: e.classList.contains('ekransiz'), sesGizli: e.querySelector('.yayin-ses').hidden };
			});
		for (const k of [taha, mert]) {
			await bekleKosul(`${k.ad}: zeynep'in ekransız yayın kartı`, async () => {
				const x = await kart(k);
				return x && x.ekransiz && !x.sesGizli;
			}, 10000);
			await bekleKosul(`${k.ad} ← zeynep paylaşımın sesi akıyor`, async () => {
				const d1 = await durumu(k);
				await bekle(1500);
				const d2 = await durumu(k);
				return d2.esler.zeynep.yayinEnerji - d1.esler.zeynep.yayinEnerji > SES_VAR / 2;
			}, 20000, 100);
		}
		const bolum = await zeynep.sayfa.evaluate(() => esler.get('taha').pc.remoteDescription.sdp.split('m=audio').slice(1)[1] || '');
		assert.match(bolum, /stereo=1/, 'paylaşımın sesi stereo anlaşılmalı');
		const d1 = await durumu(zeynep);
		await bekle(3000);
		const d2 = await durumu(zeynep);
		const kbps = ((d2.esler.taha.yayinGidenBayt - d1.esler.taha.yayinGidenBayt) * 8) / 3000;
		const kare = d2.esler.taha.goruntuGidenBayt - d1.esler.taha.goruntuGidenBayt;
		console.log(`     ses aygıtından paylaşım zeynep → taha ${kbps.toFixed(1)} kbps; görüntü ${kare} bayt`);
		assert.ok(kbps > 48, 'paylaşımın ses bit hızı düşük: ' + kbps.toFixed(1));
		assert.ok(kare === 0, 'ekransızken görüntü gönderilmemeli: ' + kare + ' bayt');
		await duyuyor(taha, 'zeynep', 'paylaşırken mikrofon da ayrıca duyulmalı');
		// Ekranı göster: seçim penceresi bir kez açılır (denemede kendiliğinden "Entire screen").
		await zeynep.sayfa.locator('#yayinlar .yayin-kart.ben button', { hasText: 'Ekranı göster' }).click();
		for (const k of [taha, mert]) {
			await bekleKosul(`${k.ad} zeynep'in ekranını görüyor`, () =>
				k.sayfa.evaluate(() => {
					const v = document.querySelector('#yayinlar .yayin-kart[data-ad="zeynep"] video');
					return !!v && v.videoWidth > 0 && !v.paused;
				}),
			);
		}
		assert.equal(await zeynep.sayfa.evaluate((id) => yayin.aygit === id && yayin.ses.readyState === 'live', aygit.id), true, 'ses yine aygıttan gelmeli');
		// Tarayıcının "Paylaşımı durdur"u ekranı bitirir: ses aygıttan geldiği için paylaşım ekransız sürer.
		await zeynep.sayfa.evaluate(() => {
			const g = yayin.goruntu;
			g.dispatchEvent(new Event('ended'));
			g.stop();
		});
		await bekleKosul('ekran bitince zeynep ekransız paylaşmayı sürdürüyor', () => zeynep.sayfa.evaluate(() => !yayin.goruntu && !!yayin.ses && yayin.ekransiz && [...esler.values()].every((e) => e.trGoruntu.sender.track === null && e.trSes.sender.track === yayin.ses)), 5000, 100);
		for (const k of [taha, mert]) {
			await bekleKosul(`${k.ad}: zeynep'in kartı yeniden ekransız`, async () => {
				const x = await kart(k);
				return x && x.ekransiz && !x.sesGizli;
			}, 10000);
		}
		await zeynep.sayfa.evaluate(() => (window.paylasilanIz = yayin.ses));
		await zeynep.sayfa.locator('#yayinlar .yayin-kart.ben button', { hasText: 'Durdur' }).click();
		await bekleKosul('paylaşım herkeste kalktı', async () => {
			for (const k of [taha, zeynep, mert]) if (await k.sayfa.evaluate(() => !!document.querySelector('#yayinlar .yayin-kart'))) return false;
			return true;
		}, 10000);
		await bekleKosul('zeynep artık paylaşım sesi göndermiyor, aygıt bırakıldı', () => zeynep.sayfa.evaluate(() => window.paylasilanIz.readyState === 'ended' && [...esler.values()].every((e) => !e.trGoruntu.sender.track && !e.trSes.sender.track)), 5000, 100);
		await duyuyor(taha, 'zeynep', 'paylaşım bitince mikrofon sürmeli');
		await zeynep.sayfa.evaluate(() => {
			navigator.mediaDevices.getSupportedConstraints = window.asilKisitlar;
			for (const ad of ['taha', 'mert']) {
				esler.get(ad).susturuldu = false;
				esSesUygula(esler.get(ad));
			}
		});
	});

	await dene('ses aygıtından paylaşım: kanaldakilerin konuşması paylaşılan sesten çıkarılır, müzik eşiksiz ve kesilmeden gider', async () => {
		// zeynep yine Firefox gibi. Bilgisayarın sesi ("Monitor of …") yerine sayfada kurulan sahte bir
		// aygıt: müzik + zeynep'in çaldığı seslerin (taha ile mert'in konuşması) gecikmiş, 0,8'le
		// ölçeklenmiş kopyası — gerçek geri döngü gibi. Her akışın gecikmesi ayrı (taha 73,1 ms, mert
		// 75,8 ms): tarayıcı her akışı kendi tamponundan çalar (Chromium + PulseAudio'da iki kişinin sesi
		// 128 örnek farkla geliyordu). Hepsi tek WebAudio grafiğinde: sahte aygıtın izi çıkarıcıya düğüm
		// olarak bağlanır, uzak akışların kaynak düğümleri ortaktır (Chrome'un MediaStream tamponları
		// gecikmeyi kendiliğinden oynatıp denemeyi rastlantıya bağlamasın; gecikme sıçraması aşağıda
		// bilerek denenir).
		await zeynep.sayfa.evaluate(() => {
			const ac = sesBaglami();
			const asilKaynak = ac.createMediaStreamSource.bind(ac);
			const ortak = new Map();
			window.asilKaynak = asilKaynak;
			ac.createMediaStreamSource = (akis) => {
				const iz = akis.getAudioTracks()[0];
				if (window.sahte && iz === window.sahte.iz) return window.sahte.cikis;
				if (!iz) return asilKaynak(akis);
				if (!ortak.has(iz.id)) ortak.set(iz.id, asilKaynak(akis));
				return ortak.get(iz.id);
			};
			const asil = navigator.mediaDevices.getSupportedConstraints.bind(navigator.mediaDevices);
			window.asilKisitlar = asil;
			navigator.mediaDevices.getSupportedConstraints = () => {
				const d = { ...asil() };
				delete d.suppressLocalAudioPlayback;
				delete d.restrictOwnAudio;
				return d;
			};
			window.asilGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
			navigator.mediaDevices.getUserMedia = async (k) => {
				const a = k && k.audio;
				if (!a || !a.deviceId || a.echoCancellation !== false) return window.asilGum(k);
				const muzik = ac.createGain();
				muzik.gain.value = 0; // önce yalnızca yankı
				const birlesik = ac.createChannelMerger(2);
				for (const [f, kanal] of [[196, 0], [293.66, 1], [440, 0], [329.63, 1], [523.25, 0]]) {
					const o = ac.createOscillator();
					o.type = 'triangle';
					o.frequency.value = f;
					const g = ac.createGain();
					g.gain.value = 0.05;
					o.connect(g);
					g.connect(birlesik, 0, kanal);
					o.start();
				}
				birlesik.connect(muzik);
				const yanki = ac.createGain();
				yanki.gain.value = 0.8;
				const gecikmeler = {};
				for (const [ad, sn] of [['taha', 0.0731], ['mert', 0.0758]]) {
					const es = esler.get(ad);
					const gecikme = ac.createDelay(1);
					gecikme.delayTime.value = sn;
					gecikme.connect(yanki);
					for (const o of [es.ses, es.yayinSesOgesi]) if (o && o.srcObject && !o.muted) ac.createMediaStreamSource(o.srcObject).connect(gecikme);
					gecikmeler[ad] = gecikme;
				}
				const cikis = ac.createGain();
				muzik.connect(cikis);
				yanki.connect(cikis);
				const hedef = ac.createMediaStreamDestination();
				cikis.connect(hedef);
				window.sahte = { muzik, gecikmeler, cikis, iz: hedef.stream.getAudioTracks()[0] };
				return hedef.stream;
			};
			// Düğümlerin ms boyunca ortalama gücü (AnalyserNode, tek kanala indirilmiş).
			window.gucOlc = async (dugumler, ms) => {
				const olcer = dugumler.map((d) => {
					const a = ac.createAnalyser();
					a.fftSize = 2048;
					d.connect(a);
					return { d, a, top: 0, say: 0 };
				});
				const veri = new Float32Array(2048);
				const son = performance.now() + ms;
				while (performance.now() < son) {
					await new Promise((r) => setTimeout(r, 40));
					for (const x of olcer) {
						x.a.getFloatTimeDomainData(veri);
						let t = 0;
						for (const v of veri) t += v * v;
						x.top += t / veri.length;
						x.say++;
					}
				}
				for (const x of olcer) x.d.disconnect(x.a);
				return olcer.map((x) => x.top / Math.max(1, x.say));
			};
		});
		await zeynep.sayfa.click('#yayin-ac');
		await zeynep.sayfa.locator('#yayin-menu button', { hasText: 'Ekransız paylaş' }).click();
		await goruneneKadar(zeynep, '#ses-kaynagi');
		await bekleKosul('ses aygıtları listelendi', () => zeynep.sayfa.evaluate(() => !document.getElementById('ses-kaynagi-aygit').disabled), 10000);
		await zeynep.sayfa.click('#ses-kaynagi-paylas');
		try {
			await bekleKosul('zeynep sahte aygıttan, çıkarıcıyla paylaşıyor', () => zeynep.sayfa.evaluate(() => !!window.sahte && !!yayin.yanki && yayin.ses === yayin.yanki.iz && yayin.hamSes === window.sahte.iz), 10000);
			const t0 = Date.now();
			// İki kişinin mikrofon akışının yuvası: ikisinin de süzgeci kendi gecikmesinde kurulmalı.
			const yuvaGecikmeleri = () =>
				zeynep.sayfa.evaluate(() => {
					const o = {};
					for (const ad of ['taha', 'mert']) {
						const r = yayin.yanki.referans.get(esler.get(ad).ses.srcObject);
						const s = r && yayin.yanki.suzgecler.get(r.yuva);
						o[ad] = s ? s.gecikmeMs : null;
					}
					return o;
				});
			const kilit = await bekleKosul('iki kişinin de gecikmesi bulundu, süzgeçleri kuruldu', async () => {
				const g = await yuvaGecikmeleri();
				return g.taha && g.mert ? g : false;
			}, 20000, 200);
			const kilitSn = (Date.now() - t0) / 1000;
			const db = (a, b) => 10 * Math.log10(a / b);
			// Ölçülenler: yakalanan (sahte aygıt), giden (çıkarıcının çıkışı), müzik.
			const olc = (ms) => zeynep.sayfa.evaluate((ms) => gucOlc([window.sahte.cikis, yayin.yanki.dugum, window.sahte.muzik], ms), ms);
			// 1) Yalnızca yankı (müzik yok): giden seste kanaldakilerin konuşması kalmamalı.
			await bekle(1500);
			const [yakalananA, gidenA] = await olc(3000);
			const azalmaA = db(yakalananA, gidenA);
			// 2) Müzik + yankı (müzik yankıyla aynı güçte): giden ≈ müzik (yankı çıkarılmış, müzik bozulmamış).
			await zeynep.sayfa.evaluate(() => (window.sahte.muzik.gain.value = 1));
			const [, , birim] = await olc(600);
			await zeynep.sayfa.evaluate((g) => (window.sahte.muzik.gain.value = g), Math.sqrt(yakalananA / birim));
			await bekle(1500);
			const [yakalananB, gidenB, muzikB] = await olc(3000);
			// 3) taha'nın gecikmesi sıçrıyor (ör. tarayıcı o akışın tamponunu büyüttü): onun süzgeci birkaç
			// saniyede yeni yere geçer, mert'inki yerinde kalır.
			await zeynep.sayfa.evaluate(() => (window.sahte.gecikmeler.taha.delayTime.value = 0.0853));
			const t1 = Date.now();
			const sicrama = await bekleKosul('sıçramadan sonra taha\'nın süzgeci yeni gecikmede', async () => {
				const g = await yuvaGecikmeleri();
				return g.taha > 83 && g.taha < 88 ? g : false;
			}, 15000, 200);
			const sicramaSn = (Date.now() - t1) / 1000;
			await bekle(1500);
			const [yakalananD, gidenD, muzikD] = await olc(3000);
			// 4) Kimse konuşmuyor: giden, yakalananın ta kendisi (eşik yok, işlem yok).
			for (const k of [taha, mert]) await k.sayfa.evaluate(() => mikDegistir());
			await bekle(1500);
			const [yakalananC, gidenC] = await olc(2500);
			for (const k of [taha, mert]) await k.sayfa.evaluate(() => mikDegistir());
			const ozet = await zeynep.sayfa.evaluate(() => yankiOzeti());
			const denemeler = await zeynep.sayfa.evaluate(() => yayin.yanki.denemeler);
			console.log(
				`     süzgeçler ${kilitSn.toFixed(1)} sn'de: gecikme taha ${kilit.taha} ms, mert ${kilit.mert} ms; yalnızca yankı: ${azalmaA.toFixed(1)} dB azaldı; ` +
					`müzik+yankı: yakalanan müziğin ${db(yakalananB, muzikB).toFixed(1)} dB üstünde, giden ${db(gidenB, muzikB).toFixed(2)} dB; ` +
					`taha'nınki 85,3 ms'ye sıçrayınca ${sicramaSn.toFixed(1)} sn'de yeniden (mert ${sicrama.mert} ms), sonra giden ${db(gidenD, muzikD).toFixed(2)} dB (yakalanan ${db(yakalananD, muzikD).toFixed(1)} dB); ` +
					`kimse konuşmuyorken giden/yakalanan ${db(gidenC, yakalananC).toFixed(2)} dB; özet ${JSON.stringify(ozet)}`,
			);
			if (process.env.AYRINTI) console.log('     tahmin denemeleri: ' + JSON.stringify(denemeler));
			assert.ok(kilitSn < 8, 'süzgeç birkaç saniyede kurulmalı: ' + kilitSn.toFixed(1) + ' sn; ' + JSON.stringify(denemeler));
			assert.ok(Math.abs(kilit.taha - 73.1) < 0.5 && Math.abs(kilit.mert - 75.8) < 0.5, 'her kişinin gecikmesi ayrı bulunmalı (73,1 / 75,8 ms): ' + JSON.stringify(kilit));
			assert.ok(Math.abs(sicrama.mert - 75.8) < 0.5, 'sıçrama yalnızca taha\'nın süzgecini taşımalı: ' + JSON.stringify(sicrama));
			assert.ok(azalmaA > 25, 'kanaldakilerin konuşması en az 25 dB azalmalı: ' + azalmaA.toFixed(1));
			assert.ok(db(yakalananB, muzikB) > 2, 'denemenin kendisi: yakalanan seste yankı müzik kadar güçlü olmalı');
			assert.ok(Math.abs(db(gidenB, muzikB)) < 0.5, 'müzik çalarken giden ≈ müzik olmalı (yankı çıkmış, müzik bozulmamış): ' + db(gidenB, muzikB).toFixed(2));
			assert.ok(sicramaSn < 8, 'gecikme sıçrayınca süzgeç birkaç saniyede yeni yere geçmeli: ' + sicramaSn.toFixed(1));
			assert.ok(Math.abs(db(gidenD, muzikD)) < 0.5, 'sıçramadan sonra da giden ≈ müzik olmalı: ' + db(gidenD, muzikD).toFixed(2));
			assert.ok(Math.abs(db(gidenC, yakalananC)) < 0.1, 'kimse konuşmuyorken ses olduğu gibi gitmeli: ' + db(gidenC, yakalananC).toFixed(2));
			// Dinleyen paylaşımın sesini (müziği) alıyor.
			await bekleKosul('taha ← zeynep paylaşımın sesi akıyor', async () => {
				const d1 = await durumu(taha);
				await bekle(1500);
				const d2 = await durumu(taha);
				return d2.esler.zeynep.yayinEnerji - d1.esler.zeynep.yayinEnerji > SES_VAR / 2;
			}, 15000, 100);
		} finally {
			// Başarısız olsa da paylaşım kapansın (sonraki denemeler kartsız başlar).
			await zeynep.sayfa.evaluate(() => {
				if (yayinVar()) yayinDurdur();
				navigator.mediaDevices.getSupportedConstraints = window.asilKisitlar;
				navigator.mediaDevices.getUserMedia = window.asilGum;
				delete sesBaglami().createMediaStreamSource;
				if (window.sahte) window.sahte.cikis.disconnect();
			});
			for (const k of [taha, mert]) await k.sayfa.evaluate(() => ayar.mikKapali && mikDegistir());
		}
		await bekleKosul('paylaşım bitti, çıkarıcı kapandı', () => zeynep.sayfa.evaluate(() => !yayinVar() && yayin.yanki === null && window.sahte.iz.readyState === 'ended'), 10000);
		await bekleKosul('kart herkesten kalktı', async () => {
			for (const k of [taha, zeynep, mert]) if (await k.sayfa.evaluate(() => !!document.querySelector('#yayinlar .yayin-kart'))) return false;
			return true;
		}, 10000);
	});

	await dene('ekran paylaşımı: izleyene görüntü gider, görüntüyü kapatana gitmez', async () => {
		await taha.sayfa.click('#yayin-ac');
		await taha.sayfa.locator('#yayin-menu button', { hasText: 'Ekranını paylaş' }).click();
		await bekleKosul('taha ekranını paylaşıyor', () => taha.sayfa.evaluate(() => !!yayin.goruntu && !yayin.ekransiz), 10000);
		for (const k of [zeynep, mert]) {
			await bekleKosul(`${k.ad} taha'nın ekranını görüyor`, () =>
				k.sayfa.evaluate(() => {
					const v = document.querySelector('#yayinlar .yayin-kart[data-ad="taha"] video');
					return !!v && v.videoWidth > 0 && !v.paused;
				}),
			);
		}
		const z1 = await durumu(zeynep);
		await bekle(1500);
		const z2 = await durumu(zeynep);
		assert.ok(z2.esler.taha.kare > z1.esler.taha.kare, 'zeynep kare almalı');
		console.log(`     ekran ${z2.esler.taha.kareGenislik} px genişlikte; zeynep 1,5 sn'de ${z2.esler.taha.kare - z1.esler.taha.kare} kare aldı`);
		await mert.sayfa.locator('#yayinlar .yayin-kart[data-ad="taha"] button', { hasText: 'Görüntüyü kapat' }).click();
		await bekleKosul("taha mert'e görüntü göndermiyor", () => taha.sayfa.evaluate(() => esler.get('mert').trGoruntu.sender.track === null), 10000);
		await bekle(500);
		const m1 = await durumu(mert);
		await bekle(1500);
		const m2 = await durumu(mert);
		assert.ok(m2.esler.taha.kare - m1.esler.taha.kare <= 2, 'görüntüyü kapatana kare gelmemeli');
		const z3 = await durumu(zeynep);
		await bekle(1500);
		const z4 = await durumu(zeynep);
		assert.ok(z4.esler.taha.kare > z3.esler.taha.kare, 'zeynep görmeye devam etmeli');
		await taha.sayfa.locator('#yayinlar .yayin-kart.ben button', { hasText: 'Durdur' }).click();
		await bekleKosul('yayın herkeste kalktı', async () => {
			for (const k of [zeynep, mert]) if (await k.sayfa.evaluate(() => !!document.querySelector('#yayinlar .yayin-kart'))) return false;
			return true;
		}, 10000);
		// İzlerin çıkarılması (replaceTrack) eşzamansız biter; yüklü makinede sunucunun duyurusundan sonra
		// tamamlanabilir: bekle (hiç çıkmazsa yine başarısız olur).
		await bekleKosul('taha artık görüntü ve ses göndermiyor', () => taha.sayfa.evaluate(() => [...esler.values()].every((e) => !e.trGoruntu.sender.track && !e.trSes.sender.track)), 5000, 100);
		assert.equal(await mert.sayfa.evaluate(() => esler.get('taha').izliyorum), true, 'bir sonraki yayın yine kendiliğinden izlenmeli');
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

	if (dondurulabilir()) {
		await dene('ölü bağlantı: sunucu yanıt vermezken sayfa öne gelince fark edilir, P2P ses sürer, sunucu dönünce kendiliğinden bağlanılır', async () => {
			const once = await durumu(taha);
			sunucuyuDondur();
			try {
				// Telefon uyandı: sayfa öne geldi. Bağlantı açık görünür ama sunucu yanıt vermez.
				await taha.sayfa.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
				await bekleKosul('taha ölü bağlantıyı fark etti', async () => !(await durumu(taha)).bagliyim, 12000);
				await duyuyor(taha, 'zeynep', 'sunucu yanıt vermezken P2P ses');
			} finally {
				sunucuyuCoz();
			}
			await bekleKosul('taha kendiliğinden geri bağlandı', async () => (await durumu(taha)).bagliyim, 30000);
			await bekleKosul('kanalda yine 3 kişi', async () => (await sidebarKisileri(zeynep)).length === 3, 20000);
			await baglantilarHazir(taha, ['zeynep', 'mert']);
			const sonra = await durumu(taha);
			for (const ad of ['zeynep', 'mert']) {
				if (once.esler[ad].tip === 'P2P') assert.equal(sonra.esler[ad].oturum, once.esler[ad].oturum, `taha↔${ad} bağlantısı baştan kurulmamalı`);
			}
			await duyuyor(taha, 'mert');
			await duyuyor(zeynep, 'taha');
		});
	} else atla('ölü bağlantı', 'DONDUR/COZ verilmedi');

	if (yenidenBaslatilabilir()) {
		await dene('sunucu yeniden başlarken P2P ses kesilmez, herkes kendiliğinden geri döner (üretim freni: 10 sn\'de 1)', async () => {
			const once = {};
			for (const k of [taha, zeynep, mert]) once[k.ad] = await durumu(k);
			// Sunucu kapalıyken (3 sn) ses akmaya devam etmeli.
			const durdur = DIS_ADRES ? null : sunucuDurdur();
			if (durdur) {
				await durdur;
				await bekleKosul('istemciler kopuşu fark etti', async () => !(await durumu(taha)).bagliyim, 8000);
				const arada = await sesOlc(taha, 'zeynep', 3000);
				assert.ok(arada.enerji > SES_VAR, 'sunucu kapalıyken P2P ses sürmeli: ' + arada.enerji.toFixed(4));
				// Üretimdeki fren: 10 saniyede 1 giriş, kova 1 → üç kişi 10'ar saniye arayla döner.
				Object.assign(sunucuOrtami, { GIRIS_ARALIK_MS: '10000', GIRIS_KOVA: '1' });
				await sunucuBaslat();
			} else {
				await sunucuyuYenidenBaslat();
			}
			const t0 = Date.now();
			for (const k of [taha, zeynep, mert]) {
				await bekleKosul(`${k.ad} sunucuya geri döndü`, async () => (await durumu(k)).bagliyim, 45000);
			}
			await bekleKosul('kanalda yine 3 kişi', async () => (await sidebarKisileri(taha)).length === 3, 30000);
			console.log(`     üçü de ${((Date.now() - t0) / 1000).toFixed(1)} sn içinde döndü`);
			// Sırasını bekleyenin sesi bu arada kesilmemeli (P2P).
			await duyuyor(zeynep, 'mert', 'sırasını beklerken P2P ses');
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
			await bekleKosul('relay bağlantısı ortadaki kartta turuncu', () =>
				ayse.sayfa.evaluate(() => {
					const e = document.querySelector('#ses-kisiler .ses-kisi[data-ad="bora"] .ses-istatistik');
					return !!e && /TURN/.test(e.textContent) && e.classList.contains('turn') && getComputedStyle(e).color === 'rgb(245, 151, 59)';
				}),
			);
			if (yenidenBaslatilabilir()) {
				// coturn da yeniden başlar (yeni sır): eski aktarım ölür, taze şifreyle kurtarılmalı.
				const oncekiOturum = (await durumu(ayse)).esler.bora.oturum;
				const t0 = Date.now();
				// Hızlı frene dön: burada ölçülen istemcinin kurtarma hızı (beş kişinin sırayla girmesi değil).
				await sunucuyuYenidenBaslat({ GIRIS_ARALIK_MS: '1000' });
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
	await tarayici2.close();
	await sunucuDurdur();
	fs.rmSync(wav, { force: true });
	fs.rmSync(wav2, { force: true });
	if (veriKlasoru) fs.rmSync(veriKlasoru, { recursive: true, force: true });
	console.log(process.exitCode ? 'BAŞARISIZ' : `Tarayıcı denemeleri geçti (${gecen}${atlanan ? `, ${atlanan} atlandı` : ''}).`);
	process.exit(process.exitCode || 0);
})().catch(async (e) => {
	console.error(e);
	await sunucuDurdur().catch(() => {});
	process.exit(1);
});
