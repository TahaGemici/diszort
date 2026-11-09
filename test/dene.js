// Çalışan bir Diszort sunucusunu dışarıdan dener: beyaz liste (anahtar, kapıyı çalma, kabul/red, atma,
// giriş freni), web sayfası, sağlık, TURN şifresi (yalnızca oturumla), yazılı sohbet (gönderme, geçmiş,
// hız sınırı), P2P dosya paylaşımı (kayıt, kimin sunduğu, sahiplik, tanışma mesajları; dosya sunucuya
// gelmez), sesli kanal signaling'i (mesh mesajları, oturum/yenile iletimi, doluluk, aynı ad, kopunca
// askıda kalma ve geri dönme), yayın (ekranlı/ekransız paylaşım durumu, izle), veritabanı boyutu ve sohbet
// temizliği (yalnızca denemenin kendi kanalında), STUN ve TURN (geçici şifreyle aktarım; yanlış
// şifreyle alamama).
// Bağımlılık: Node 22+ yerleşik WebSocket'i kullanır; eski Node'da depodaki ws paketini (npm install).
//
//   node test/dene.js [http://127.0.0.1:8080]
//
// Not: yazılı sohbet denemeleri gerçek veritabanına birkaç "(deneme)" mesajı ve küçük bir dosya
// bırakır; üretimde çalıştırmadan önce bunu bil.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const WebSocket = globalThis.WebSocket || require('ws');
// Yoklamalara (ping) yanıt vermeyen istemci için ws paketi gerekir (yerleşik WebSocket kendiliğinden
// yanıt verir). Yoksa o deneme atlanır.
let WsPaketi = null;
try {
	WsPaketi = require('ws');
} catch {}

const ADRES = (process.argv[2] || process.env.ADRES || 'http://127.0.0.1:8080').replace(/\/$/, '');
const WS_ADRES = ADRES.replace(/^http/, 'ws') + '/rtc';
const TURN_HOST = process.env.TURN_HOST || '127.0.0.1';
// Beyaz liste: testler yönetici anahtarıyla girer, diğer istemcileri o onaylar.
const ANAHTAR = process.env.ILK_ANAHTAR || '';
const YAZI_KANAL = process.env.YAZI_KANAL || 'genel';
const SES_KANAL = process.env.SES_KANAL || 'sesli-sohbet';

let gecen = 0;
async function dene(ad, fn) {
	try {
		// Beyaz liste şişmesin: her testten önce önceki testlerin kişilerini at.
		if (yonetici && onaylananlar.size >= 4) await kisileriTemizle();
		await new Promise((r) => setTimeout(r, 120)); // önceki testin bağlantıları sunucuda kapansın
		await fn();
		gecen++;
		console.log('ok   ' + ad);
	} catch (e) {
		console.error('HATA ' + ad + '\n     ' + (e && e.stack ? e.stack : e));
		process.exitCode = 1;
	}
}

// ---------------------------------------------------------------- WebSocket yardımcıları

// secenek verilirse ws paketiyle açılır (ör. { autoPong: false }: yoklamalara yanıt vermeyen istemci).
function istemci(secenek) {
	return new Promise((coz, red) => {
		const ws = secenek ? new WsPaketi(WS_ADRES, secenek) : new WebSocket(WS_ADRES);
		const gelen = [];
		const bekleyen = [];
		ws.onmessage = (e) => {
			const m = JSON.parse(e.data);
			const i = bekleyen.findIndex((b) => b.kosul(m));
			if (i >= 0) bekleyen.splice(i, 1)[0].coz(m);
			else gelen.push(m);
		};
		ws.bekle = (kosul, ms = 4000) => {
			if (typeof kosul === 'string') {
				const tur = kosul;
				kosul = (m) => m.type === tur;
			}
			const i = gelen.findIndex(kosul);
			if (i >= 0) return Promise.resolve(gelen.splice(i, 1)[0]);
			return new Promise((c, r) => {
				const b = { kosul, coz: (m) => (clearTimeout(t), c(m)) };
				const t = setTimeout(() => {
					bekleyen.splice(bekleyen.indexOf(b), 1);
					r(new Error('mesaj gelmedi: ' + kosul));
				}, ms);
				bekleyen.push(b);
			});
		};
		ws.topla = () => gelen.splice(0);
		ws.yolla = (o) => ws.send(JSON.stringify(o));
		// Düzgün istemci gibi kapat: sesli kanaldaysa önce 'ses-cik' (sekme kapanırken arayüz de
		// böyle yapar). Ağ kopması gibi sessiz kapanış için ws.kopar().
		const kapat = ws.close.bind(ws);
		ws.kopar = kapat;
		ws.close = () => {
			try {
				if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ses-cik' }));
			} catch {}
			kapat();
		};
		ws.onopen = () => coz(ws);
		ws.onerror = () => red(new Error('WebSocket açılamadı: ' + WS_ADRES));
	});
}

// Beyaz liste testleri: yönetici istemcisi kapıyı çalanları onaylar.
let yonetici = null;
const onaylananlar = new Set(); // testte beyaz listeye eklenen adlar (sonunda atılır)

// Sunucu TÜM giriş denemelerini tek bir global aralıkla sınırlar (üretimde 10 sn). Testler bu
// aralığa kendiliğinden uyar: aralığı /saglik'tan okur ve giriş mesajlarını ona göre seyreltir.
let girisAralik = null;
let sonGiris = 0;
async function girisAraligi() {
	if (girisAralik === null) {
		try {
			girisAralik = Number((await (await fetch(ADRES + '/saglik')).json()).girisAralikMs) || 0;
		} catch {
			girisAralik = 0;
		}
	}
	return girisAralik;
}

async function girisGonder(ws, mesaj) {
	const aralik = await girisAraligi();
	const bekle = sonGiris + aralik + 50 - Date.now();
	sonGiris = Date.now() + Math.max(0, bekle);
	if (bekle > 0) await new Promise((r) => setTimeout(r, bekle));
	ws.yolla(mesaj);
}

async function yoneticiGir() {
	if (!ANAHTAR) throw new Error('ILK_ANAHTAR verilmedi; beyaz liste testleri için gerekli');
	const ws = await istemci();
	await girisGonder(ws, { type: 'giris', ad: 'yonetici', id: 'adm', anahtar: ANAHTAR });
	const h = await ws.bekle('hazir');
	ws.hazir = h;
	ws.anahtar = ANAHTAR;
	return ws;
}

// Kapıyı çal → yönetici onaylasın → 'hazir' gelsin. anahtar verilirse doğrudan giriş denenir.
async function gir(ad, id, anahtar, secenek) {
	const ws = await istemci(secenek);
	ws.anahtar = anahtar || '';
	await girisGonder(ws, { type: 'giris', ad, id, anahtar: ws.anahtar });
	const ilk = await ws.bekle((m) => m.type === 'hazir' || m.type === 'giris-red' || m.type === 'bekleniyor');
	if (ilk.type === 'hazir') {
		ws.hazir = ilk;
		return ws;
	}
	if (ilk.type === 'giris-red') {
		ws.red = ilk;
		throw new Error('giriş reddedildi: ' + ilk.message);
	}
	// Kapıyı çaldı: yönetici onaylasın.
	const istek = await yonetici.bekle((m) => m.type === 'giris-istegi' && m.ad === ad);
	yonetici.yolla({ type: 'giris-karari', id: istek.id, kabul: true });
	ws.hazir = await ws.bekle('hazir');
	ws.anahtar = ws.hazir.anahtar || ws.anahtar;
	onaylananlar.add(ad);
	return ws;
}

// Kapıyı çal, kararı verilmeden bekle (testin kendisi karar verir).
async function kapiCal(ad, id) {
	const ws = await istemci();
	await girisGonder(ws, { type: 'giris', ad, id });
	ws.bekleniyor = await ws.bekle((m) => m.type === 'bekleniyor' || m.type === 'giris-red');
	return ws;
}

// Beyaz listeyi sor ve yönetici dışındaki herkesi at (önceki çalıştırmalardan kalanlar dahil).
async function hepsiniAt() {
	if (!yonetici) return;
	yonetici.yolla({ type: 'beyaz-liste' });
	const liste = await yonetici.bekle('beyaz-liste');
	for (const k of liste.kisiler || []) {
		if (k.ad === yonetici.hazir.ad) continue;
		yonetici.yolla({ type: 'at', ad: k.ad });
		await new Promise((r) => setTimeout(r, 40));
	}
	onaylananlar.clear();
	// Gerçekten temizlendi mi? (atma hız sınırına takılmış olabilir)
	yonetici.yolla({ type: 'beyaz-liste' });
	const son = await yonetici.bekle('beyaz-liste');
	const kalan = (son.kisiler || []).filter((k) => k.ad !== yonetici.hazir.ad).map((k) => k.ad);
	if (kalan.length) throw new Error('beyaz liste temizlenemedi: ' + kalan.join(', '));
	}

// Testte eklenen kişileri temizle (beyaz liste şişmesin).
async function kisileriTemizle() {
	for (const ad of [...onaylananlar]) {
		yonetici.yolla({ type: 'at', ad });
		await new Promise((r) => setTimeout(r, 40));
		onaylananlar.delete(ad);
	}
}

// ---------------------------------------------------------------- STUN/TURN yardımcıları

const COOKIE = 0x2112a442;

function stunMesaj(tur, ozellikler, kimlik, anahtar) {
	const parcalar = [];
	for (const [t, deger] of ozellikler) {
		const b = Buffer.alloc(4 + Math.ceil(deger.length / 4) * 4);
		b.writeUInt16BE(t, 0);
		b.writeUInt16BE(deger.length, 2);
		deger.copy(b, 4);
		parcalar.push(b);
	}
	let govde = Buffer.concat(parcalar);
	const bas = Buffer.alloc(20);
	bas.writeUInt16BE(tur, 0);
	bas.writeUInt32BE(COOKIE, 4);
	kimlik.copy(bas, 8);
	if (anahtar) {
		// MESSAGE-INTEGRITY: uzunluk alanı bu özelliği de sayar, HMAC ondan önceki her şeyin üstünden.
		bas.writeUInt16BE(govde.length + 24, 2);
		const mi = crypto.createHmac('sha1', anahtar).update(Buffer.concat([bas, govde])).digest();
		const ozellik = Buffer.alloc(24);
		ozellik.writeUInt16BE(0x0008, 0);
		ozellik.writeUInt16BE(20, 2);
		mi.copy(ozellik, 4);
		govde = Buffer.concat([govde, ozellik]);
	}
	bas.writeUInt16BE(govde.length, 2);
	return Buffer.concat([bas, govde]);
}

function stunCoz(m) {
	const sonuc = { tur: m.readUInt16BE(0), kimlik: m.subarray(8, 20), ozellik: new Map() };
	let i = 20;
	while (i + 4 <= m.length) {
		const t = m.readUInt16BE(i);
		const u = m.readUInt16BE(i + 2);
		sonuc.ozellik.set(t, m.subarray(i + 4, i + 4 + u));
		i += 4 + Math.ceil(u / 4) * 4;
	}
	return sonuc;
}

function xorAdres(deger) {
	const port = deger.readUInt16BE(2) ^ (COOKIE >>> 16);
	const ip = [0, 1, 2, 3].map((k) => deger[4 + k] ^ ((COOKIE >>> (24 - 8 * k)) & 0xff)).join('.');
	return `${ip}:${port}`;
}

function udpSor(soket, port, mesaj, ms = 2000) {
	return new Promise((coz, red) => {
		const t = setTimeout(() => (soket.off('message', al), red(new Error('UDP yanıt yok'))), ms);
		const al = (m) => {
			if (m.length >= 20 && m.subarray(8, 20).equals(mesaj.subarray(8, 20))) {
				clearTimeout(t);
				soket.off('message', al);
				coz(stunCoz(m));
			}
		};
		soket.on('message', al);
		soket.send(mesaj, port, TURN_HOST);
	});
}

const REQUESTED_TRANSPORT = [0x0019, Buffer.from([17, 0, 0, 0])];

async function turnAl(port, kullanici, sifre) {
	const soket = dgram.createSocket('udp4');
	try {
		const ilk = await udpSor(soket, port, stunMesaj(0x0003, [REQUESTED_TRANSPORT], crypto.randomBytes(12)));
		assert.equal(ilk.tur, 0x0113, 'kimliksiz aktarım isteği reddedilmeli');
		assert.equal(ilk.ozellik.get(0x0009).readUInt8(3), 1, 'hata 401 olmalı'); // ERROR-CODE sayı kısmı
		const realm = ilk.ozellik.get(0x0014);
		const nonce = ilk.ozellik.get(0x0015);
		const anahtar = crypto.createHash('md5').update(`${kullanici}:${realm}:${sifre}`).digest();
		const ikinci = await udpSor(
			soket,
			port,
			stunMesaj(
				0x0003,
				[REQUESTED_TRANSPORT, [0x0006, Buffer.from(kullanici)], [0x0014, realm], [0x0015, nonce]],
				crypto.randomBytes(12),
				anahtar,
			),
		);
		return ikinci;
	} finally {
		soket.close();
	}
}

// ---------------------------------------------------------------- denemeler

(async () => {
	let ice;
	let turnPort;
	const kimlik = 'deneme-' + crypto.randomBytes(4).toString('hex');


	await dene('beyaz liste: yönetici anahtarıyla giriş', async () => {
		if (!ANAHTAR) throw new Error('ILK_ANAHTAR yok (test ortamı: .env veya ortam değişkeni)');
		yonetici = await yoneticiGir();
		assert.equal(yonetici.hazir.ad, 'taha', 'ilk anahtarın sahibi YONETICI_ADI olmalı');
		// TURN şifresi yalnızca oturum açana: 'hazir' içinde gelir.
		assert.ok(yonetici.hazir.ice && Array.isArray(yonetici.hazir.ice.iceServers), 'hazir.ice gelmeli');
		await hepsiniAt(); // önceki çalıştırmalardan kalan kişileri temizle
		assert.ok(yonetici.hazir.beyazListe >= 1);
		assert.ok(Array.isArray(yonetici.hazir.beyazListeAdlari), 'hazir.beyazListeAdlari dizi olmalı');
	});

	await dene('beyaz liste: anahtarsız giriş izin ister, kabul edilince anahtar verilir', async () => {
		const ws = await istemci();
		await girisGonder(ws, { type: 'giris', ad: 'ayse-' + kimlik, id: 'a1' });
		const bekle = await ws.bekle('bekleniyor');
		assert.equal(bekle.anahtarGecersiz, false);
		const istek = await yonetici.bekle((m) => m.type === 'giris-istegi' && m.ad === 'ayse-' + kimlik);
		yonetici.yolla({ type: 'giris-karari', id: istek.id, kabul: true });
		const h = await ws.bekle('hazir');
		assert.match(h.anahtar, /^[0-9a-f]{128}$/, 'kişiye özel anahtar üretilmeli (512 bit)');
		assert.equal(h.ad, 'ayse-' + kimlik);
		// Çevrimdışı beyaz liste üyeleri arayüzde görünsün diye adlar da gelir.
		assert.ok(Array.isArray(h.beyazListeAdlari), 'hazir.beyazListeAdlari dizi olmalı');
		assert.ok(h.beyazListeAdlari.includes('ayse-' + kimlik), 'yeni onaylanan kişi beyaz liste adlarında olmalı');
		assert.ok(h.beyazListeAdlari.includes('taha'), 'yönetici beyaz liste adlarında olmalı');
		ws.close();
		onaylananlar.add('ayse-' + kimlik);

		// Aynı anahtarla yeniden bağlan: izin sorulmadan girer.
		const ws2 = await istemci();
		await girisGonder(ws2, { type: 'giris', ad: 'baska-ad', id: 'a2', anahtar: h.anahtar });
		const h2 = await ws2.bekle('hazir');
		assert.equal(h2.ad, 'ayse-' + kimlik, 'ad anahtardan gelir (yazılan ad yok sayılır)');
		assert.equal(h2.anahtar, h.anahtar, 'geçerli anahtar aynen döner (yenisi üretilmez)');
		ws2.close();
	});

	await dene('beyaz liste: istek reddedilirse girilemez', async () => {
		const ws = await istemci();
		await girisGonder(ws, { type: 'giris', ad: 'reddedilen-' + kimlik, id: 'r1' });
		await ws.bekle('bekleniyor');
		const istek = await yonetici.bekle((m) => m.type === 'giris-istegi' && m.ad === 'reddedilen-' + kimlik);
		yonetici.yolla({ type: 'giris-karari', id: istek.id, kabul: false });
		const red = await ws.bekle('giris-red');
		assert.match(red.message, /reddedildi/);
		assert.equal(red.kod, 'reddedildi', 'red nedeni kodla da gelmeli (istemci yeniden denemeyi buna göre seçer)');
		ws.close();
	});

	await dene('beyaz liste: geçersiz anahtar kapıyı çaldırır (anahtarGecersiz)', async () => {
		const ws = await istemci();
		await girisGonder(ws, { type: 'giris', ad: 'sahte-' + kimlik, id: 's1', anahtar: 'f'.repeat(128) });
		const bekle = await ws.bekle('bekleniyor');
		assert.equal(bekle.anahtarGecersiz, true, 'geçersiz anahtar bildirilmeli');
		ws.close();
		// Bekleyen istek bağlantı kapanınca düşmeli.
		await new Promise((r) => setTimeout(r, 200));
	});

	await dene('beyaz liste: içeride kimse yokken kapı çalınamaz', async () => {
		// Yönetici dışındaki herkesi at, sonra yöneticiyi de kapat → kimse kalmadığında red.
		await kisileriTemizle();
		yonetici.close();
		// Sunucunun bağlantıyı kapatmasını bekle (çevrimiçi 0 olana kadar).
		for (let i = 0; i < 40; i++) {
			const s = await (await fetch(ADRES + '/saglik')).json();
			if (!s.cevrimici) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		try {
			const ws = await istemci();
			await girisGonder(ws, { type: 'giris', ad: 'gec-kalan-' + kimlik, id: 'g1' });
			const red = await ws.bekle('giris-red');
			assert.match(red.message, /kimse yok/);
			assert.equal(red.kod, 'kimse-yok');
			ws.close();
		} finally {
			yonetici = await yoneticiGir(); // geri al
		}
	});

	await dene('beyaz liste: atılan kişinin anahtarı iptal edilir', async () => {
		const ws = await gir('atilan-' + kimlik, 'x1');
		const anahtari = ws.anahtar;
		assert.ok(anahtari);
		ws.close();
		yonetici.yolla({ type: 'at', ad: 'atilan-' + kimlik });
		await new Promise((r) => setTimeout(r, 200));
		onaylananlar.delete('atilan-' + kimlik);

		// Eski anahtar artık geçersiz → kapıyı çalmak zorunda.
		const ws2 = await istemci();
		await girisGonder(ws2, { type: 'giris', ad: 'atilan-' + kimlik, id: 'x2', anahtar: anahtari });
		const bekle = await ws2.bekle('bekleniyor');
		assert.equal(bekle.anahtarGecersiz, true, 'iptal edilen anahtar geçersiz olmalı');
		ws2.close();
	});

	await dene('giriş freni: tüm denemeler tek kovadan (sunucu geneli), kova boşalınca bekleme süresi söylenir', async () => {
		const aralik = await girisAraligi();
		assert.ok(aralik > 0, 'fren kapalı (GIRIS_ARALIK_MS=0); bu deneme freni doğrulayamaz');
		const s = await (await fetch(ADRES + '/saglik')).json();
		const kova = Number(s.girisKova) || 1;
		const ws = await istemci();
		// 1) İlk deneme aralığa uyarak gönderilir (sunucu kabul eder, "Ad gerekli" der).
		await girisGonder(ws, { type: 'giris', ad: '', id: 'fr1' });
		const ilk = await ws.bekle('giris-red');
		assert.match(ilk.message, /Ad gerekli/);
		assert.equal(ilk.kod, 'ad');
		// 2) Beklemeden art arda: kova boşalınca sunucu reddeder ve ne kadar bekleneceğini söyler.
		for (let i = 0; i < kova + 1; i++) ws.yolla({ type: 'giris', ad: '', id: 'fr1' });
		const fren = await ws.bekle((m) => m.type === 'giris-red' && m.kod === 'fren');
		assert.match(fren.message, /saniye sonra tekrar dene/);
		assert.ok(fren.bekle > 0 && fren.bekle <= aralik, 'bekle (ms) 0 ile aralık arasında olmalı: ' + fren.bekle);
		// 3) Söylenen süre kadar bekleyince yeniden girilebilir (istemci bunu kendiliğinden yapar).
		await new Promise((r) => setTimeout(r, fren.bekle + 30));
		ws.topla();
		ws.yolla({ type: 'giris', ad: '', id: 'fr1' });
		assert.equal((await ws.bekle('giris-red')).kod, 'ad', 'bekleme sonrası deneme freni geçmeli');
		sonGiris = Date.now(); // sonraki testlerin girişleri aralığa uysun
		ws.close();
	});

	await dene('beyaz liste: eski biçim anahtar (48 hex) reddedilir', async () => {
		const ws = await istemci();
		await girisGonder(ws, { type: 'giris', ad: 'eskianahtar-' + kimlik, id: 'e1', anahtar: 'a'.repeat(48) });
		const bekle = await ws.bekle((m) => m.type === 'bekleniyor' || m.type === 'giris-red');
		assert.equal(bekle.anahtarGecersiz, true, 'yalnızca 512 bit anahtar kabul edilmeli');
		ws.close();
		await new Promise((r) => setTimeout(r, 200));
	});

	await dene('beyaz liste: kişi limiti arttırılıp azaltılabilir', async () => {
		const once = yonetici.hazir.maxKullanici;
		const hedef = once >= 50 ? once - 1 : once + 1;
		yonetici.yolla({ type: 'kisi-limiti', deger: hedef });
		const degisti = await yonetici.bekle((m) => m.type === 'kimler' && m.maxKullanici === hedef);
		assert.equal(degisti.maxKullanici, hedef, 'limit değişmeli');
		// Sınır dışı değer reddedilir.
		yonetici.yolla({ type: 'kisi-limiti', deger: 1 });
		const hata = await yonetici.bekle((m) => m.type === 'hata' && /arasında/.test(m.message || ''));
		assert.ok(hata, 'sınır dışı değer reddedilmeli');
		// Geri al (değer veritabanına yazılır, yeniden başlatmada korunur).
		yonetici.yolla({ type: 'kisi-limiti', deger: once });
		await yonetici.bekle((m) => m.type === 'kimler' && m.maxKullanici === once);
	});

	await dene('web sayfası', async () => {
		const r = await fetch(ADRES + '/');
		assert.equal(r.status, 200);
		assert.match(r.headers.get('content-type'), /text\/html/);
		assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/);
		const sayfa = await r.text();
		assert.match(sayfa, /Diszort/);
		// Arayüz vaadi: yazılı + sesli kanalların ikisi de sayfada olmalı.
		assert.match(sayfa, /Yazılı Kanallar/);
		assert.match(sayfa, /Sesli Kanallar/);
		for (const d of ['/ana.js', '/stil.css', '/favicon.svg', '/favicon.ico']) {
			assert.equal((await fetch(ADRES + d)).status, 200, d);
		}
		assert.equal((await fetch(ADRES + '/../../etc/passwd')).status, 404);
		assert.equal((await fetch(ADRES + '/yok.html')).status, 404);
	});

	await dene('sağlık', async () => {
		const r = await fetch(ADRES + '/saglik');
		assert.equal(r.status, 200);
		const s = await r.json();
		assert.equal(s.durum, 'tamam');
		assert.ok(s.girisKova >= 1, 'girisKova');
		assert.equal(typeof s.sesAskiMs, 'number');
		assert.equal(s.turn, 'çalışıyor');
		assert.equal(s.veritabani, 'açık');
		assert.equal(typeof s.mesaj, 'number');
		assert.equal(typeof s.dosya, 'number');
		assert.ok(s.veritabaniBayt > 0, 'veritabanı boyutu (bayt) bildirilmeli');
		console.log('     sürüm', s.surum, '· mesaj', s.mesaj, '· dosya', s.dosya, '· veritabanı', s.veritabaniBayt, 'bayt');
	});

	// Telefon arka planda ağı bir süre bekletince (yoklamalara yanıt yok) sunucu hemen düşürmemeli.
	// Bu istemci yoklamalara yanıt vermez ve hiçbir şey göndermez; aradaki denemeler sürerken bekler,
	// "sesli kanal dolunca" denemesinden önce denetlenir (süre eklemesin diye).
	let uykucu = null;
	await dene('nabız: yoklamalara yanıt vermeyen istemci girer (denetimi aşağıda)', async () => {
		if (!WsPaketi) return console.log('     (ws paketi yok; nabız denemesi atlanacak)');
		uykucu = await gir('uykucu-' + kimlik, 'u1', '', { autoPong: false });
		uykucu.basla = Date.now();
		onaylananlar.delete('uykucu-' + kimlik); // aradaki temizliklerde atılmasın
	});

	await dene('TURN şifresi yalnızca oturumu olana verilir (hazir içinde, ice-iste ile tazelenir)', async () => {
		// Oturumsuz bağlantı şifre alamaz (TURN sunucusu dışarıdan gelenlere ücretsiz aktarıcı olmasın).
		const anonim = await istemci();
		anonim.yolla({ type: 'ice-iste' });
		await assert.rejects(anonim.bekle('ice-sunuculari', 800), /mesaj gelmedi/, 'oturumsuz istekte şifre gelmemeli');
		anonim.close();
		ice = yonetici.hazir.ice;
		assert.equal(ice.iceServers.length, 2);
		const t = ice.iceServers[1];
		assert.match(t.urls[0], /^turn:.+:\d+\?transport=udp$/);
		assert.ok(t.urls.some((u) => /\?transport=tcp$/.test(u)), 'UDP kapalı ağlar için TCP yedeği olmalı');
		assert.match(t.username, /^\d+:[0-9a-f]+$/);
		assert.ok(Number(t.username.split(':')[0]) > Date.now() / 1000 + 3600, 'şifre en az bir saat geçerli olmalı');
		turnPort = Number(t.urls[0].match(/:(\d+)\?/)[1]);
		// Tazelenir (uzun açık kalan sekme / sunucu yeniden başladıktan sonra): her istekte yeni kullanıcı.
		yonetici.yolla({ type: 'ice-iste' });
		const ikinci = (await yonetici.bekle('ice-sunuculari')).ice;
		assert.equal(ikinci.iceServers.length, 2);
		assert.notEqual(ikinci.iceServers[1].username, t.username, 'her istekte yeni kullanıcı');
	});

	await dene('STUN yanıt veriyor', async () => {
		const soket = dgram.createSocket('udp4');
		try {
			const y = await udpSor(soket, turnPort, stunMesaj(0x0001, [], crypto.randomBytes(12)));
			assert.equal(y.tur, 0x0101);
			assert.ok(y.ozellik.has(0x0020), 'XOR-MAPPED-ADDRESS var');
		} finally {
			soket.close();
		}
	});

	await dene('TURN: geçici şifreyle aktarım alınır', async () => {
		const t = ice.iceServers[1];
		const y = await turnAl(turnPort, t.username, t.credential);
		assert.equal(y.tur, 0x0103, 'Allocate başarılı olmalı (0x0103), gelen: 0x' + y.tur.toString(16));
		const relay = xorAdres(y.ozellik.get(0x0016));
		console.log('     aktarım adresi', relay);
		if (process.env.DIS_IP) assert.ok(relay.startsWith(process.env.DIS_IP + ':'), 'aktarım adresi dış IP olmalı');
	});

	await dene('TURN: yanlış şifreyle aktarım alınmaz', async () => {
		const t = ice.iceServers[1];
		const y = await turnAl(turnPort, t.username, 'yanlis' + t.credential);
		assert.equal(y.tur, 0x0113);
		const s = await turnAl(turnPort, '1000:eski', t.credential); // süresi geçmiş kullanıcı
		assert.equal(s.tur, 0x0113);
	});

	await dene('giriş: kanal listesi', async () => {
		const a = await gir('ayse-' + kimlik, 'a1');
		assert.equal(a.hazir.ad, 'ayse-' + kimlik);
		assert.ok(a.hazir.max >= 2);
		assert.ok(Array.isArray(a.hazir.sunulanDosyalar), 'hazir.sunulanDosyalar dizi olmalı');
		const turler = new Map(a.hazir.kanallar.map((k) => [k.id, k.tur]));
		assert.equal(turler.get(YAZI_KANAL), 'yazi');
		assert.equal(turler.get(SES_KANAL), 'ses');
		assert.ok(a.hazir.kanallar.filter((k) => k.tur === 'yazi').length >= 1);
		assert.ok(a.hazir.kanallar.filter((k) => k.tur === 'ses').length >= 1);
		a.close();
	});

	await dene('yazılı sohbet: gönderilir, herkese iletilir, geçmişten okunur', async () => {
		const a = await gir('ayse-' + kimlik, 'a1');
		const b = await gir('bora-' + kimlik, 'b1');
		const metin = 'deneme mesajı ' + kimlik;
		a.yolla({ type: 'yazi', kanal: YAZI_KANAL, metin });

		const aEcho = await a.bekle((m) => m.type === 'yazi' && m.mesaj.metin === metin);
		const bEcho = await b.bekle((m) => m.type === 'yazi' && m.mesaj.metin === metin);
		assert.equal(aEcho.kanal, YAZI_KANAL);
		assert.equal(bEcho.mesaj.ad, 'ayse-' + kimlik, 'gönderen adı sunucudan gelir');
		assert.ok(bEcho.mesaj.id > 0);
		assert.ok(Math.abs(bEcho.mesaj.zaman - Date.now()) < 60000);

		// Geçmiş: mesaj veritabanından gelmeli (yeni bağlantı da görür).
		const c = await gir('candan-' + kimlik, 'c1');
		c.yolla({ type: 'gecmis', kanal: YAZI_KANAL });
		const g = await c.bekle('gecmis');
		assert.equal(g.kanal, YAZI_KANAL);
		assert.equal(typeof g.bitti, 'boolean');
		assert.ok(g.mesajlar.some((m) => m.metin === metin), 'gönderilen mesaj geçmişte olmalı');
		const sira = g.mesajlar.map((m) => m.id);
		assert.deepEqual(sira, [...sira].sort((x, y) => x - y), 'geçmiş eskiden yeniye sıralı');
		for (const w of [a, b, c]) w.close();
	});

	await dene('yazılı sohbet: boş mesaj yok sayılır, hız sınırı çalışır', async () => {
		const a = await gir('hizli-' + kimlik, 'h1');
		a.yolla({ type: 'yazi', kanal: YAZI_KANAL, metin: '   ' });
		for (let i = 0; i < 20; i++) a.yolla({ type: 'yazi', kanal: YAZI_KANAL, metin: 'hız ' + i + ' ' + kimlik });
		const hata = await a.bekle('hata', 5000);
		assert.match(hata.message, /hızlı/);
		assert.ok(!a.topla().some((m) => m.type === 'yazi' && m.mesaj.metin.trim() === ''), 'boş mesaj kaydedilmemeli');
		a.close();
	});

	await dene('dosya (P2P): kaydı sohbete düşer, içeriği sunucuda yok; kimin sunduğu herkese duyurulur', async () => {
		const a = await gir('p2p-a-' + kimlik, 'p1');
		const b = await gir('p2p-b-' + kimlik, 'p2');
		const id = crypto.randomBytes(12).toString('hex');
		const ad = 'büyük dosya ' + kimlik + '.zip';
		const boyut = 7 * 1024 ** 3; // 7 GB: sınır yok
		a.topla();
		b.topla();
		a.yolla({ type: 'dosya-paylas', kanal: YAZI_KANAL, id, ad, boyut, tur: 'application/zip' });
		const m = await b.bekle((x) => x.type === 'yazi' && x.mesaj.dosya && x.mesaj.dosya.id === id);
		assert.equal(m.kanal, YAZI_KANAL);
		assert.equal(m.mesaj.ad, 'p2p-a-' + kimlik, 'paylaşan adı sunucudan gelir');
		assert.equal(m.mesaj.dosya.ad, ad);
		assert.equal(m.mesaj.dosya.boyut, boyut, 'boyut sınırı yok');
		assert.equal(m.mesaj.dosya.tur, 'application/zip');
		// Paylaşan bağlıyken dosya "sunuluyor" görünür.
		const durum = await b.bekle((x) => x.type === 'dosya-durum' && x.sunulan.includes(id));
		assert.ok(durum.sunulan.includes(id));
		// Geçmişten okununca da kaydı gelir.
		b.yolla({ type: 'gecmis', kanal: YAZI_KANAL });
		const g = await b.bekle('gecmis');
		const kayit = g.mesajlar.find((x) => x.dosya && x.dosya.id === id);
		assert.ok(kayit && kayit.dosya.ad === ad && kayit.dosya.boyut === boyut, 'geçmişte dosya kaydı');
		// Geçersiz kimlik ve boş dosya reddedilir; aynı kimlik ikinci kez kullanılamaz.
		a.yolla({ type: 'dosya-paylas', kanal: YAZI_KANAL, id: 'xyz', ad: 'a', boyut: 1 });
		assert.match((await a.bekle('hata')).message, /kimliği/);
		a.yolla({ type: 'dosya-paylas', kanal: YAZI_KANAL, id: crypto.randomBytes(12).toString('hex'), ad: 'a', boyut: 0 });
		assert.match((await a.bekle('hata')).message, /Boş/);
		a.yolla({ type: 'dosya-paylas', kanal: YAZI_KANAL, id, ad: 'aynı', boyut: 5 });
		assert.match((await a.bekle('hata')).message, /paylaşılamadı/);
		// Paylaşan ayrılınca dosya artık sunulmuyor.
		a.close();
		await b.bekle((x) => x.type === 'dosya-durum' && !x.sunulan.includes(id));
		b.close();
		// Aynı kişi (aynı anahtarla) geri gelip bildirince yeniden sunulur; başkasının dosyası sunulamaz.
		const a2 = await gir('x', 'p1', a.anahtar);
		const c = await gir('p2p-c-' + kimlik, 'p3');
		c.yolla({ type: 'dosya-sun', idler: [id] });
		assert.deepEqual((await c.bekle('dosya-sun')).idler, [], 'başkasının dosyası sunulamaz');
		a2.yolla({ type: 'dosya-sun', idler: [id, 'f'.repeat(24)] });
		assert.deepEqual((await a2.bekle('dosya-sun')).idler, [id], 'yalnızca kendi paylaştığı ve sohbette duran dosya');
		await c.bekle((x) => x.type === 'dosya-durum' && x.sunulan.includes(id));
		a2.close();
		c.close();
	});

	await dene('dosya (P2P): tanışma mesajları iki kişi arasında iletilir; çevrimdışına "ulaşılamadı" döner', async () => {
		const a = await gir('sinyal-a-' + kimlik, 'n1');
		const b = await gir('sinyal-b-' + kimlik, 'n2');
		a.yolla({ type: 'dosya-sinyal', to: 'sinyal-b-' + kimlik, veri: { tur: 'teklif', bag: 'abc12345', sdp: { type: 'offer', sdp: 'v=0' } } });
		const s = await b.bekle('dosya-sinyal');
		assert.equal(s.from, 'sinyal-a-' + kimlik, 'gönderen adı sunucudan gelir');
		assert.equal(s.veri.tur, 'teklif');
		assert.equal(s.veri.bag, 'abc12345');
		b.yolla({ type: 'dosya-sinyal', to: 'sinyal-a-' + kimlik, veri: { tur: 'yanit', bag: 'abc12345', sdp: { type: 'answer', sdp: 'v=0' } } });
		assert.equal((await a.bekle('dosya-sinyal')).veri.tur, 'yanit');
		// Sesli kanalda olmak gerekmez; çevrimdışı hedefe hemen "ulaşılamadı".
		a.yolla({ type: 'dosya-sinyal', to: 'boyle-biri-yok', veri: { tur: 'teklif', bag: 'zz9' } });
		const u = await a.bekle('dosya-sinyal');
		assert.equal(u.from, 'boyle-biri-yok');
		assert.equal(u.veri.tur, 'ulasilamadi');
		assert.equal(u.veri.bag, 'zz9');
		a.close();
		b.close();
	});

	await dene('sesli kanal: giriş, mesh mesajları, çıkış', async () => {
		const a = await gir('ayse-' + kimlik, 'a1');
		a.yolla({ type: 'ses-gir', kanal: SES_KANAL });
		const g1 = await a.bekle('ses-girdi');
		assert.equal(g1.kanal, SES_KANAL);
		assert.deepEqual(g1.kisiler, []);

		const b = await gir('bora-' + kimlik, 'b1');
		b.yolla({ type: 'ses-gir', kanal: SES_KANAL });
		const g2 = await b.bekle('ses-girdi');
		assert.deepEqual(g2.kisiler, ['ayse-' + kimlik], 'kanaldaki diğer kişiler bildirilir');
		assert.equal((await a.bekle((m) => m.type === 'ses-kisi-girdi' && m.ad === 'bora-' + kimlik)).kanal, SES_KANAL);

		assert.ok(g2.ice && g2.ice.iceServers, 'ses-girdi taze ICE sunucularını taşımalı');
		assert.equal(g2.devam, false);

		b.yolla({ type: 'sdp', to: 'ayse-' + kimlik, sdp: { type: 'offer', sdp: 'v=0' }, oturum: 'o1abc' });
		const s = await a.bekle('sdp');
		assert.equal(s.from, 'bora-' + kimlik);
		assert.equal(s.sdp.type, 'offer');
		assert.equal(s.oturum, 'o1abc', 'oturum kimliği iletilmeli');
		a.yolla({ type: 'ice', to: 'bora-' + kimlik, ice: { candidate: 'x' }, oturum: 'o1abc' });
		const i = await b.bekle('ice');
		assert.equal(i.from, 'ayse-' + kimlik);
		assert.equal(i.oturum, 'o1abc');
		// yenile: yanıtlayan taraf "bağlantıyı yeniden kur" der; geçersiz oturum değeri ayıklanır.
		a.yolla({ type: 'yenile', to: 'bora-' + kimlik, oturum: 'bozuk oturum <>' });
		const y = await b.bekle('yenile');
		assert.equal(y.from, 'ayse-' + kimlik);
		assert.equal(y.oturum, undefined, 'geçersiz oturum iletilmemeli');
		// Kanal dışındaki birine iletilmez.
		a.yolla({ type: 'sdp', to: 'taha', sdp: { type: 'offer', sdp: 'v=0' } });
		await new Promise((r) => setTimeout(r, 150));
		assert.ok(!yonetici.topla().some((m) => m.type === 'sdp'), 'kanalda olmayana sdp gitmemeli');

		b.yolla({ type: 'ping' });
		await b.bekle('pong');
		b.close(); // ses-cik + kapanış: hemen çıkar
		assert.equal((await a.bekle((m) => m.type === 'ses-kisi-cikti' && m.ad === 'bora-' + kimlik, 1500)).kanal, SES_KANAL);
		a.close();
	});

	await dene('sesli kanal: bağlantısı kopan askıda kalır, geri dönünce ses kesilmeden devam eder', async () => {
		const saglik = await (await fetch(ADRES + '/saglik')).json();
		const aski = Number(saglik.sesAskiMs) || 0;
		assert.ok(aski > 0, 'SES_ASKI_MS=0: askı kapalı');
		const a = await gir('aski-a-' + kimlik, 'q1');
		const b = await gir('aski-b-' + kimlik, 'q2');
		a.yolla({ type: 'ses-gir', kanal: SES_KANAL });
		await a.bekle('ses-girdi');
		b.yolla({ type: 'ses-gir', kanal: SES_KANAL });
		await b.bekle('ses-girdi');
		await a.bekle((m) => m.type === 'ses-kisi-girdi' && m.ad === 'aski-b-' + kimlik);

		// b ağdan kopar (ses-cik yok): a'ya hemen "çıktı" denmez, b askıda görünür.
		b.kopar();
		const liste = await a.bekle((m) => m.type === 'kanallar' && m.kanallar.some((k) => (k.kisiler || []).some((p) => p.ad === 'aski-b-' + kimlik && p.askida)));
		assert.ok(liste, 'kopan kişi askıda işaretlenmeli');
		assert.ok(!a.topla().some((m) => m.type === 'ses-kisi-cikti'), 'askıdaki kişi için hemen ses-kisi-cikti gitmemeli');

		// b aynı anahtar + sekmeyle geri gelir ve kanala devam eder.
		const b2 = await istemci();
		await girisGonder(b2, { type: 'giris', ad: '', id: 'q2', anahtar: b.anahtar, ses: SES_KANAL });
		await b2.bekle('hazir');
		b2.yolla({ type: 'ses-gir', kanal: SES_KANAL, devam: true });
		const g = await b2.bekle('ses-girdi');
		assert.equal(g.devam, true);
		assert.deepEqual(g.kisiler, ['aski-a-' + kimlik]);
		const geri = await a.bekle((m) => m.type === 'ses-kisi-girdi' && m.ad === 'aski-b-' + kimlik);
		assert.equal(geri.devam, true, 'diğerleri bağlantıyı sürdürsün diye devam:true iletilmeli');
		assert.ok(!a.topla().some((m) => m.type === 'ses-kisi-cikti'), 'geri dönüşte ses-kisi-cikti gitmemeli');

		// Geri gelip kanala DEVAM ETMEYEN kişinin askıdaki yeri hemen boşalır.
		b2.kopar();
		await a.bekle((m) => m.type === 'kanallar' && m.kanallar.some((k) => (k.kisiler || []).some((p) => p.ad === 'aski-b-' + kimlik && p.askida)));
		const b3 = await istemci();
		await girisGonder(b3, { type: 'giris', ad: '', id: 'q2', anahtar: b.anahtar, ses: '' });
		await b3.bekle('hazir');
		assert.equal((await a.bekle((m) => m.type === 'ses-kisi-cikti' && m.ad === 'aski-b-' + kimlik, 1500)).kanal, SES_KANAL);

		// Hiç dönmeyenin yeri askı süresi dolunca boşalır.
		if (aski <= 5000) {
			b3.yolla({ type: 'ses-gir', kanal: SES_KANAL });
			await b3.bekle('ses-girdi');
			await a.bekle((m) => m.type === 'ses-kisi-girdi' && m.ad === 'aski-b-' + kimlik);
			b3.kopar();
			const cikti = await a.bekle((m) => m.type === 'ses-kisi-cikti' && m.ad === 'aski-b-' + kimlik, aski + 3000);
			assert.equal(cikti.kanal, SES_KANAL, 'askı süresi dolunca çıkarılmalı');
		} else {
			console.log(`     (askı süresi ${aski} ms; süre dolumu denemesi atlandı — SES_ASKI_MS<=5000 ile çalıştır)`);
			b3.close();
		}
		a.close();
	});

	await dene('sesli kanal: aynı ad reddedilir, aynı sekme anahtarla yeniden bağlanır', async () => {
		const a = await gir('can-' + kimlik, 's1');
		const b = await istemci();
		await girisGonder(b, { type: 'giris', ad: 'can-' + kimlik, id: 's2' });
		const red = await b.bekle('giris-red');
		assert.match(red.message, /kullanılıyor/);
		assert.equal(red.kod, 'ad-kullaniliyor');
		b.close();
		const a2 = await gir('can-' + kimlik, 's1', a.anahtar); // aynı sekme + anahtar → doğrudan giriş
		assert.equal(a2.hazir.ad, 'can-' + kimlik);
		// Aynı anahtar BAŞKA sekmeden: son giren kazanır, eskisine haber verilir (eskiden "başka
		// cihazdan bağlı" diye reddediliyordu; ağ değişince kopan bağlantı bir dakika kilitliyordu).
		const a3 = await gir('can-' + kimlik, 's3', a.anahtar);
		assert.equal(a3.hazir.ad, 'can-' + kimlik);
		const devir = await a2.bekle('oturum-devralindi');
		assert.match(devir.message, /başka/);
		a3.close();
		a.close();
	});

	await dene('beyaz liste: aynı isteği iki kişi aynı anda kabul ederse tek anahtar verilir', async () => {
		const ikinci = await gir('onayci-' + kimlik, 'o1');
		const ws = await istemci();
		await girisGonder(ws, { type: 'giris', ad: 'cift-' + kimlik, id: 'c1' });
		await ws.bekle('bekleniyor');
		const i1 = await yonetici.bekle((m) => m.type === 'giris-istegi' && m.ad === 'cift-' + kimlik);
		await ikinci.bekle((m) => m.type === 'giris-istegi' && m.id === i1.id);
		yonetici.yolla({ type: 'giris-karari', id: i1.id, kabul: true });
		ikinci.yolla({ type: 'giris-karari', id: i1.id, kabul: true });
		const h = await ws.bekle('hazir');
		assert.match(h.anahtar, /^[0-9a-f]{128}$/);
		onaylananlar.add('cift-' + kimlik);
		await new Promise((r) => setTimeout(r, 300));
		assert.ok(!ws.topla().some((m) => m.type === 'hazir'), 'ikinci bir hazir (ikinci anahtar) gelmemeli');
		// Verilen anahtar geçerli olmalı (ikinci kabul onu ezmemeli).
		ws.close();
		const tekrar = await gir('x', 'c2', h.anahtar);
		assert.equal(tekrar.hazir.ad, 'cift-' + kimlik);
		tekrar.close();
		ikinci.close();
	});

	await dene('beyaz liste: sonradan gelene bekleyen istekler gösterilir; kayıtlı ad işaretlenir', async () => {
		const ws = await istemci();
		await girisGonder(ws, { type: 'giris', ad: 'sonra-' + kimlik, id: 'n1' });
		await ws.bekle('bekleniyor');
		const istek = await yonetici.bekle((m) => m.type === 'giris-istegi' && m.ad === 'sonra-' + kimlik);
		assert.equal(istek.kayitli, false);
		// İstek varken giren kişi de onu görmeli.
		const gelen = await gir('yeni-gelen-' + kimlik, 'n2');
		const ona = await gelen.bekle((m) => m.type === 'giris-istegi' && m.id === istek.id);
		assert.equal(ona.ad, 'sonra-' + kimlik);
		yonetici.yolla({ type: 'giris-karari', id: istek.id, kabul: false });
		await ws.bekle('giris-red');
		ws.close();
		// Beyaz listedeki bir adla kapı çalınırsa (yeni cihaz / taklit) kayitli:true gelir.
		const taklit = await istemci();
		await girisGonder(taklit, { type: 'giris', ad: 'yeni-gelen-' + kimlik, id: 'n3' });
		assert.match((await taklit.bekle('giris-red')).message, /kullanılıyor/, 'çevrimiçi adla kapı çalınamaz');
		taklit.close();
		gelen.close();
		await new Promise((r) => setTimeout(r, 200));
		const taklit2 = await istemci();
		await girisGonder(taklit2, { type: 'giris', ad: 'yeni-gelen-' + kimlik, id: 'n4' });
		await taklit2.bekle('bekleniyor');
		const kayitliIstek = await yonetici.bekle((m) => m.type === 'giris-istegi' && m.ad === 'yeni-gelen-' + kimlik);
		assert.equal(kayitliIstek.kayitli, true, 'beyaz listedeki ad için kayitli:true');
		yonetici.yolla({ type: 'giris-karari', id: kayitliIstek.id, kabul: false });
		taklit2.close();
	});

	await dene('nabız: ~30 sn yoklamalara yanıt vermeyen (arka plandaki telefon) düşürülmez', async () => {
		if (!uykucu) return console.log('     (atlandı)');
		// Eski sunucu ilk kaçırılan yoklamada (15-30 sn) düşürüyordu; şimdi art arda 3 yoklama (~45 sn).
		const kalan = uykucu.basla + 32000 - Date.now();
		if (kalan > 0) await new Promise((r) => setTimeout(r, kalan));
		assert.equal(uykucu.readyState, 1, 'yanıtsız kalan bağlantı 32 sn içinde kapatılmamalı');
		uykucu.yolla({ type: 'ping' });
		await uykucu.bekle('pong');
		uykucu.close();
		yonetici.yolla({ type: 'at', ad: 'uykucu-' + kimlik });
		await new Promise((r) => setTimeout(r, 100));
	});

	await dene('sesli kanal dolunca reddedilir', async () => {
		const max = Number(process.env.MAX_KISI || 10);
		// Beyaz liste limiti bu testin kişi sayısına yetmiyorsa geçici olarak yükselt (sonunda geri alınır).
		const kisiLimiti = yonetici.hazir.maxKullanici;
		const gecici = Math.min(50, max + 3);
		if (kisiLimiti < max + 2) {
			yonetici.yolla({ type: 'kisi-limiti', deger: gecici });
			await yonetici.bekle((m) => m.type === 'kimler' && m.maxKullanici === gecici);
		}
		// Hayalet üye kalmasın: sesli kanallar boşalana kadar bekle.
		for (let i = 0; i < 40; i++) {
			const s = await (await fetch(ADRES + '/saglik')).json();
			if (!s.kisi) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const acik = [];
		for (let i = 0; i < max; i++) {
			const w = await gir('k' + i + '-' + kimlik, 'd' + i);
			w.yolla({ type: 'ses-gir', kanal: SES_KANAL });
			await w.bekle('ses-girdi');
			acik.push(w);
		}
		const fazla = await gir('fazla-' + kimlik, 'f');
		// Başka bir sesli kanaldayken dolu kanala geçmeye çalışan, olduğu kanalda kalmalı.
		const baska = fazla.hazir.kanallar.find((k) => k.tur === 'ses' && k.id !== SES_KANAL);
		if (baska) {
			fazla.yolla({ type: 'ses-gir', kanal: baska.id });
			await fazla.bekle((m) => m.type === 'ses-girdi' && m.kanal === baska.id);
		}
		fazla.yolla({ type: 'ses-gir', kanal: SES_KANAL });
		const dolu = await fazla.bekle('hata');
		assert.match(dolu.message, /dolu/);
		assert.equal(dolu.kod, 'ses-dolu');
		if (baska) {
			fazla.yolla({ type: 'ses-gir', kanal: baska.id });
			const yine = await fazla.bekle((m) => m.type === 'ses-girdi' && m.kanal === baska.id);
			assert.equal(yine.devam, true, 'dolu kanala geçemeyen eski kanalında kalmalı');
		}
		for (const w of [...acik, fazla]) w.close();
		// Geçici olarak yükseltilen kişi limitini geri al.
		if (kisiLimiti < max + 2) {
			yonetici.yolla({ type: 'kisi-limiti', deger: kisiLimiti });
			await yonetici.bekle((m) => m.type === 'kimler' && m.maxKullanici === kisiLimiti);
		}
	});


	// --- kanal yönetimi (ekle / sil) ve çık-gir

	// Tampondaki eski 'kanallar' mesajları (ör. kanal eklenmeden önceki yayın) yanlışlıkla eşleşmesin:
	// önce tampon boşaltılır, sonra yalnızca yeni gelen yayın beklenir.
	const kanalBekle = (ws, kosul) => {
		ws.topla();
		return ws.bekle((m) => m.type === 'kanallar' && kosul(m.kanallar));
	};
	const kanalIslem = (ws, ileti, kosul) => {
		ws.topla();
		ws.yolla(ileti);
		return ws.bekle((m) => m.type === 'kanallar' && kosul(m.kanallar));
	};

	await dene('kanal: yazılı kanal eklenir, mesaj alır, silinince mesajları da gider', async () => {
		const a = await gir('kanalci-' + kimlik, 'k1');
		const ad = 'deneme ' + crypto.randomBytes(3).toString('hex');
		const liste = await kanalIslem(a, { type: 'kanal-ekle', tur: 'yazi', ad }, (ks) => ks.some((k) => k.ad === ad && k.tur === 'yazi'));
		const kanal = liste.kanallar.find((k) => k.ad === ad);
		assert.match(kanal.id, /^[a-z0-9-]+$/, 'kanal kimliği sadeleştirilmiş olmalı');

		const metin = 'kanal denemesi ' + kimlik;
		a.yolla({ type: 'yazi', kanal: kanal.id, metin });
		await a.bekle((m) => m.type === 'yazi' && m.mesaj.metin === metin);

		a.yolla({ type: 'gecmis', kanal: kanal.id });
		const g = await a.bekle((m) => m.type === 'gecmis' && m.kanal === kanal.id);
		assert.equal(g.mesajlar.length, 1, 'yeni kanalın geçmişi kendi mesajını içerir');

		await kanalIslem(a, { type: 'kanal-sil', kanal: kanal.id }, (ks) => !ks.some((k) => k.id === kanal.id));
		a.yolla({ type: 'gecmis', kanal: kanal.id });
		assert.match((await a.bekle('hata')).message, /Bilinmeyen kanal/, 'silinen kanalın geçmişi yok');
		a.close();
	});

	await dene('kanal: sesli kanal eklenir, silinince içindekiler çıkarılır', async () => {
		const a = await gir('sesli-a-' + kimlik, 'v1');
		const b = await gir('sesli-b-' + kimlik, 'v2');
		const ad = 'deneme ses ' + crypto.randomBytes(3).toString('hex');
		const liste = await kanalIslem(a, { type: 'kanal-ekle', tur: 'ses', ad }, (ks) => ks.some((k) => k.ad === ad && k.tur === 'ses'));
		const kanal = liste.kanallar.find((k) => k.ad === ad);

		a.yolla({ type: 'ses-gir', kanal: kanal.id });
		assert.equal((await a.bekle((m) => m.type === 'ses-girdi' && m.kanal === kanal.id)).kanal, kanal.id);
		b.yolla({ type: 'ses-gir', kanal: kanal.id });
		await b.bekle((m) => m.type === 'ses-girdi' && m.kanal === kanal.id);

		a.yolla({ type: 'kanal-sil', kanal: kanal.id });
		assert.equal((await a.bekle('ses-kapatildi')).kanal, kanal.id, 'silinen kanaldaki kişi çıkarılır');
		assert.equal((await b.bekle('ses-kapatildi')).kanal, kanal.id);
		// Silme yayını ses-kapatildi'den hemen sonra gelir; tamponda olabilir, boşaltmadan bekle.
		await a.bekle((m) => m.type === 'kanallar' && !m.kanallar.some((k) => k.id === kanal.id));
		a.close();
		b.close();
	});

	await dene('kanal: aynı ad, geçersiz tür ve olmayan kanal reddedilir', async () => {
		const a = await gir('kural-' + kimlik, 'r1');
		const ad = 'kural ' + crypto.randomBytes(3).toString('hex');
		const liste = await kanalIslem(a, { type: 'kanal-ekle', tur: 'yazi', ad }, (ks) => ks.some((k) => k.ad === ad));
		const kanal = liste.kanallar.find((k) => k.ad === ad);

		a.yolla({ type: 'kanal-ekle', tur: 'yazi', ad });
		assert.match((await a.bekle('hata')).message, /zaten var/);
		a.yolla({ type: 'kanal-ekle', tur: 'video', ad: 'x' });
		assert.match((await a.bekle('hata')).message, /türü/);
		a.yolla({ type: 'kanal-ekle', tur: 'yazi', ad: '   ' });
		assert.match((await a.bekle('hata')).message, /adı gerekli/);
		a.yolla({ type: 'kanal-sil', kanal: 'boyle-bir-kanal-yok' });
		assert.match((await a.bekle('hata')).message, /bulunamadı/);

		await kanalIslem(a, { type: 'kanal-sil', kanal: kanal.id }, (ks) => !ks.some((k) => k.id === kanal.id));
		a.close();
	});

	await dene('sesli kanal: çık-gir sonrası yeniden bağlanır', async () => {
		const a = await gir('donen-a-' + kimlik, 'x1');
		const b = await gir('donen-b-' + kimlik, 'x2');
		a.yolla({ type: 'ses-gir', kanal: SES_KANAL });
		await a.bekle('ses-girdi');
		b.yolla({ type: 'ses-gir', kanal: SES_KANAL });
		await b.bekle('ses-girdi');
		await a.bekle((m) => m.type === 'ses-kisi-girdi' && m.ad === 'donen-b-' + kimlik);

		a.yolla({ type: 'ses-cik' });
		assert.equal((await b.bekle((m) => m.type === 'ses-kisi-cikti' && m.ad === 'donen-a-' + kimlik)).kanal, SES_KANAL);

		a.yolla({ type: 'ses-gir', kanal: SES_KANAL });
		const yeniden = await a.bekle((m) => m.type === 'ses-girdi' && m.kanal === SES_KANAL);
		assert.deepEqual(yeniden.kisiler, ['donen-b-' + kimlik], 'yeniden girişte kanaldaki kişiler bildirilir');
		await b.bekle((m) => m.type === 'ses-kisi-girdi' && m.ad === 'donen-a-' + kimlik);

		// Yeniden girişten sonra da teklif/ICE aynı kanal içinde iletilir.
		b.yolla({ type: 'sdp', to: 'donen-a-' + kimlik, sdp: { type: 'offer', sdp: 'v=0' } });
		assert.equal((await a.bekle((m) => m.type === 'sdp' && m.from === 'donen-b-' + kimlik)).sdp.type, 'offer');
		a.yolla({ type: 'ice', to: 'donen-b-' + kimlik, ice: { candidate: 'y' } });
		assert.equal((await b.bekle((m) => m.type === 'ice' && m.from === 'donen-a-' + kimlik)).ice.candidate, 'y');
		a.close();
		b.close();
	});

	await dene('yayın: ekranlı/ekransız paylaşım kanal durumunda görünür, izle iletilir, kanaldan çıkınca biter, yeniden bağlanınca geri gelir', async () => {
		const yayinci = 'yayinci-' + kimlik;
		const a = await gir(yayinci, 'w1');
		const b = await gir('izleyici-' + kimlik, 'w2');
		a.yolla({ type: 'ses-gir', kanal: SES_KANAL });
		await a.bekle('ses-girdi');
		b.yolla({ type: 'ses-gir', kanal: SES_KANAL });
		await b.bekle('ses-girdi');
		const kisi = (m, ad) => ((m.kanallar.find((k) => k.id === SES_KANAL) || {}).kisiler || []).find((p) => p.ad === ad);
		b.topla();
		a.yolla({ type: 'yayin', yayin: { goruntu: true, ses: true, fazlalik: 'x' } });
		const m1 = await b.bekle((m) => m.type === 'kanallar' && kisi(m, yayinci) && kisi(m, yayinci).yayin);
		assert.deepEqual(kisi(m1, yayinci).yayin, { goruntu: true, ses: true }, 'yalnızca görüntü/ses bilgisi duyurulur');
		// Ekransız: görüntü gitmiyor, yalnızca ses.
		a.yolla({ type: 'yayin', yayin: { goruntu: false, ses: true } });
		const m1b = await b.bekle((m) => m.type === 'kanallar' && kisi(m, yayinci) && kisi(m, yayinci).yayin && !kisi(m, yayinci).yayin.goruntu);
		assert.deepEqual(kisi(m1b, yayinci).yayin, { goruntu: false, ses: true });
		// İzle/kapat yalnızca aynı sesli kanaldaki yayıncıya iletilir.
		b.yolla({ type: 'izle', to: yayinci, izle: false });
		const iz = await a.bekle('izle');
		assert.equal(iz.from, 'izleyici-' + kimlik);
		assert.equal(iz.izle, false);
		// Sesli kanalda olmayan yayın bayrağı koyamaz.
		const c = await gir('disarida-' + kimlik, 'w3');
		c.yolla({ type: 'yayin', yayin: { goruntu: true, ses: false } });
		c.yolla({ type: 'izle', to: yayinci, izle: false });
		await new Promise((r) => setTimeout(r, 200));
		assert.ok(!a.topla().some((m) => m.type === 'izle'), 'kanal dışından izle iletilmemeli');
		// Bağlantısı kopan yayıncı geri gelince (devam) bayrakları ses-gir ile geri gelir.
		a.kopar();
		await b.bekle((m) => m.type === 'kanallar' && kisi(m, yayinci) && kisi(m, yayinci).askida);
		const a2 = await istemci();
		await girisGonder(a2, { type: 'giris', ad: '', id: 'w1', anahtar: a.anahtar, ses: SES_KANAL });
		await a2.bekle('hazir');
		b.topla();
		a2.yolla({ type: 'ses-gir', kanal: SES_KANAL, devam: true, yayin: { goruntu: false, ses: true } });
		await a2.bekle('ses-girdi');
		const m2 = await b.bekle((m) => m.type === 'kanallar' && kisi(m, yayinci) && !kisi(m, yayinci).askida);
		assert.deepEqual(kisi(m2, yayinci).yayin, { goruntu: false, ses: true }, 'yeniden bağlanınca ekransız paylaşım sürüyor görünmeli');
		// Ne görüntü ne ses: paylaşım yok sayılır.
		a2.yolla({ type: 'yayin', yayin: { goruntu: false, ses: false } });
		const m2b = await b.bekle((m) => m.type === 'kanallar' && kisi(m, yayinci) && !kisi(m, yayinci).yayin);
		assert.ok(!kisi(m2b, yayinci).yayin);
		a2.yolla({ type: 'yayin', yayin: { goruntu: true, ses: false } });
		await b.bekle((m) => m.type === 'kanallar' && kisi(m, yayinci) && kisi(m, yayinci).yayin);
		// Kanaldan çıkıp yeniden girince bayrak kalmaz.
		a2.yolla({ type: 'ses-cik' });
		a2.yolla({ type: 'ses-gir', kanal: SES_KANAL });
		await a2.bekle((m) => m.type === 'ses-girdi' && !m.devam);
		const m3 = await b.bekle((m) => m.type === 'kanallar' && kisi(m, yayinci) && !kisi(m, yayinci).yayin);
		assert.ok(!kisi(m3, yayinci).yayin);
		assert.ok(m3.kanallar.every((k) => !(k.kisiler || []).some((p) => p.ad === 'disarida-' + kimlik)));
		for (const w of [a2, b, c]) w.close();
	});

	await dene('veritabanı: boyut bilgisi; sohbet temizleme yalnızca seçilen mesajları siler, beyaz liste ve kanallar kalır', async () => {
		const a = await gir('temizlik-' + kimlik, 'z1');
		// Denemenin kendi kanalı: gerçek sohbete dokunulmaz.
		const ad = 'temizlik ' + crypto.randomBytes(3).toString('hex');
		const liste = await kanalIslem(a, { type: 'kanal-ekle', tur: 'yazi', ad }, (ks) => ks.some((k) => k.ad === ad));
		const kanal = liste.kanallar.find((k) => k.ad === ad);
		for (let i = 0; i < 5; i++) a.yolla({ type: 'yazi', kanal: kanal.id, metin: 'silinecek ' + i });
		for (let i = 0; i < 5; i++) await a.bekle((m) => m.type === 'yazi' && m.kanal === kanal.id);
		const did = crypto.randomBytes(12).toString('hex');
		a.yolla({ type: 'dosya-paylas', kanal: kanal.id, id: did, ad: 'x.bin', boyut: 10 });
		await a.bekle((m) => m.type === 'yazi' && m.mesaj.dosya && m.mesaj.dosya.id === did);
		a.yolla({ type: 'sunucu-bilgi' });
		const b1 = await a.bekle('sunucu-bilgi');
		assert.ok(b1.veritabani > 0, 'veritabanı boyutu');
		assert.ok(b1.mesaj >= 6 && typeof b1.dosya === 'number' && typeof b1.bosAlan === 'number');
		a.yolla({ type: 'gecmis', kanal: YAZI_KANAL });
		const gOnce = await a.bekle((m) => m.type === 'gecmis' && m.kanal === YAZI_KANAL);
		a.yolla({ type: 'sohbet-temizle', kanal: kanal.id, gun: 3 });
		assert.match((await a.bekle('hata')).message, /süre/);
		// "1 günden eski": yeni mesajlara dokunulmaz.
		a.yolla({ type: 'sohbet-temizle', kanal: kanal.id, gun: 1 });
		assert.equal((await a.bekle('sohbet-temizlendi')).silinen, 0);
		await a.bekle('sunucu-bilgi');
		// Hepsi: kanalın 6 mesajı (dosya kaydı dahil) silinir.
		a.yolla({ type: 'sohbet-temizle', kanal: kanal.id, gun: 0 });
		const t = await a.bekle('sohbet-temizlendi');
		assert.equal(t.kanal, kanal.id);
		assert.equal(t.silinen, 6);
		assert.equal(t.ad, 'temizlik-' + kimlik);
		const b2 = await a.bekle('sunucu-bilgi');
		assert.ok(b2.mesaj <= b1.mesaj - 6, `mesaj sayısı düşmeli: ${b1.mesaj} → ${b2.mesaj}`);
		a.yolla({ type: 'gecmis', kanal: kanal.id });
		assert.equal((await a.bekle((m) => m.type === 'gecmis' && m.kanal === kanal.id)).mesajlar.length, 0, 'kanal yerinde, mesajları silinmiş');
		a.yolla({ type: 'dosya-sun', idler: [did] });
		assert.deepEqual((await a.bekle('dosya-sun')).idler, [], 'mesajı silinen dosya artık sunulamaz');
		// Başka kanallara ve beyaz listeye dokunulmadı.
		a.yolla({ type: 'gecmis', kanal: YAZI_KANAL });
		const gSonra = await a.bekle((m) => m.type === 'gecmis' && m.kanal === YAZI_KANAL);
		assert.deepEqual(gSonra.mesajlar.map((m) => m.id), gOnce.mesajlar.map((m) => m.id), 'başka kanalın mesajları kalmalı');
		yonetici.yolla({ type: 'beyaz-liste' });
		const bl = await yonetici.bekle('beyaz-liste');
		assert.ok(bl.kisiler.some((k) => k.ad === 'temizlik-' + kimlik), 'beyaz liste değişmemeli');
		await kanalIslem(a, { type: 'kanal-sil', kanal: kanal.id }, (ks) => !ks.some((k) => k.id === kanal.id));
		a.close();
	});


	await dene('beyaz liste: dolu iken yeni kişi alınmaz', async () => {
		await hepsiniAt();
		const saglik = await (await fetch(ADRES + '/saglik')).json();
		const max = Number(saglik.maxKullanici || 10);
		const eklenen = [];
		for (let i = 0; i < max - 1; i++) {
			const ad = `dolu${i}-` + kimlik;
			const ws = await istemci();
			await girisGonder(ws, { type: 'giris', ad, id: 'd' + i });
			const ilk = await ws.bekle((m) => ['bekleniyor', 'giris-red'].includes(m.type));
			if (ilk.type !== 'bekleniyor') throw new Error('dolu döngüsü ' + i + ': ' + JSON.stringify(ilk));
			const istek = await yonetici.bekle((m) => m.type === 'giris-istegi' && m.ad === ad);
			yonetici.yolla({ type: 'giris-karari', id: istek.id, kabul: true });
			await ws.bekle('hazir');
			ws.close();
			eklenen.push(ad);
		}
		// Liste doldu: kapıyı çalan kişi içeriye bile sorulmadan reddedilir.
		const ws = await istemci();
		await girisGonder(ws, { type: 'giris', ad: 'fazla-' + kimlik, id: 'f1' });
		assert.match((await ws.bekle('giris-red')).message, /dolu/);
		ws.close();
		await hepsiniAt();
	});

	await kisileriTemizle();
	console.log(process.exitCode ? 'BAŞARISIZ' : `Hepsi geçti (${gecen}).`);
	setTimeout(() => process.exit(), 200);
})();
