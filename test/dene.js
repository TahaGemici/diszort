// Çalışan bir Ses Kanalı'nı dışarıdan dener: web sayfası, sağlık, /api/ice, yazılı sohbet
// (gönderme, geçmiş, hız sınırı), dosya paylaşımı (yetki, yükleme, indirme), sesli kanal
// signaling'i (mesh mesajları, doluluk, aynı ad), STUN ve TURN (geçici şifreyle aktarım;
// yanlış şifreyle alamama).
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

const ADRES = (process.argv[2] || process.env.ADRES || 'http://127.0.0.1:8080').replace(/\/$/, '');
const WS_ADRES = ADRES.replace(/^http/, 'ws') + '/rtc';
const TURN_HOST = process.env.TURN_HOST || '127.0.0.1';
const YAZI_KANAL = process.env.YAZI_KANAL || 'genel';
const SES_KANAL = process.env.SES_KANAL || 'sesli-sohbet';

let gecen = 0;
async function dene(ad, fn) {
	try {
		await fn();
		gecen++;
		console.log('ok   ' + ad);
	} catch (e) {
		console.error('HATA ' + ad + '\n     ' + (e && e.stack ? e.stack : e));
		process.exitCode = 1;
	}
}

// ---------------------------------------------------------------- WebSocket yardımcıları

function istemci() {
	return new Promise((coz, red) => {
		const ws = new WebSocket(WS_ADRES);
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
		ws.onopen = () => coz(ws);
		ws.onerror = () => red(new Error('WebSocket açılamadı: ' + WS_ADRES));
	});
}

// Adı al ve 'hazir' yanıtını bekle.
async function gir(ad, id) {
	const ws = await istemci();
	ws.yolla({ type: 'giris', ad, id });
	ws.hazir = await ws.bekle('hazir');
	return ws;
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
	let jeton = '';
	const kimlik = 'deneme-' + crypto.randomBytes(4).toString('hex');

	await dene('web sayfası', async () => {
		const r = await fetch(ADRES + '/');
		assert.equal(r.status, 200);
		assert.match(r.headers.get('content-type'), /text\/html/);
		assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/);
		const sayfa = await r.text();
		assert.match(sayfa, /Ses Kanalı/);
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
		assert.equal(s.turn, 'çalışıyor');
		assert.equal(s.veritabani, 'açık');
		assert.equal(typeof s.mesaj, 'number');
		assert.equal(typeof s.dosya, 'number');
		console.log('     sürüm', s.surum, '· mesaj', s.mesaj, '· dosya', s.dosya);
	});

	await dene('/api/ice geçici TURN şifresi verir', async () => {
		ice = await (await fetch(ADRES + '/api/ice')).json();
		assert.equal(ice.iceServers.length, 2);
		const t = ice.iceServers[1];
		assert.match(t.urls[0], /^turn:.+:\d+\?transport=udp$/);
		assert.match(t.username, /^\d+:[0-9a-f]+$/);
		assert.ok(Number(t.username.split(':')[0]) > Date.now() / 1000 + 3600, 'şifre en az bir saat geçerli olmalı');
		turnPort = Number(t.urls[0].match(/:(\d+)\?/)[1]);
		const ikinci = await (await fetch(ADRES + '/api/ice')).json();
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

	await dene('giriş: kanal listesi ve yazma jetonu', async () => {
		const a = await gir('ayse-' + kimlik, 'a1');
		assert.equal(a.hazir.ad, 'ayse-' + kimlik);
		assert.ok(a.hazir.max >= 2);
		assert.ok(a.hazir.dosyaMb >= 1);
		jeton = a.hazir.jeton;
		assert.match(jeton, /^[0-9a-f]{32}$/);
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

	await dene('dosya: jetonsuz yükleme reddedilir', async () => {
		const r = await fetch(ADRES + '/api/yukle?kanal=' + YAZI_KANAL, {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain', 'X-Dosya-Adi': 'a.txt' },
			body: 'x',
		});
		assert.equal(r.status, 401);
	});

	await dene('dosya: yüklenir, sohbete düşer ve indirilebilir', async () => {
		const a = await gir('dosyaci-' + kimlik, 'd1');
		const icerik = Buffer.from('deneme dosyası ' + kimlik);
		const ad = 'deneme dosyası ' + kimlik + '.txt';
		const r = await fetch(ADRES + '/api/yukle?kanal=' + YAZI_KANAL, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer ' + a.hazir.jeton,
				'Content-Type': 'text/plain; charset=utf-8',
				'X-Dosya-Adi': encodeURIComponent(ad),
			},
			body: icerik,
		});
		assert.equal(r.status, 200, 'yükleme başarılı olmalı');
		const sonuc = await r.json();
		assert.match(sonuc.id, /^[0-9a-f]{18}$/);
		assert.equal(sonuc.boyut, icerik.length);
		assert.equal(sonuc.ad, ad);

		// Aynı bağlantıya sohbet mesajı olarak da yayınlanır.
		const m = await a.bekle((x) => x.type === 'yazi' && x.mesaj.dosya && x.mesaj.dosya.id === sonuc.id);
		assert.equal(m.kanal, YAZI_KANAL);
		assert.equal(m.mesaj.dosya.ad, ad);
		assert.equal(m.mesaj.ad, 'dosyaci-' + kimlik);

		const indir = await fetch(ADRES + '/dosya/' + sonuc.id);
		assert.equal(indir.status, 200);
		assert.equal(indir.headers.get('x-content-type-options'), 'nosniff');
		assert.match(indir.headers.get('content-disposition') || '', /attachment/);
		assert.deepEqual(Buffer.from(await indir.arrayBuffer()), icerik, 'içerik aynı');

		assert.equal((await fetch(ADRES + '/dosya/' + 'a'.repeat(18))).status, 404);
		a.close();
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

		b.yolla({ type: 'sdp', to: 'ayse-' + kimlik, sdp: { type: 'offer', sdp: 'v=0' } });
		const s = await a.bekle('sdp');
		assert.equal(s.from, 'bora-' + kimlik);
		assert.equal(s.sdp.type, 'offer');
		a.yolla({ type: 'ice', to: 'bora-' + kimlik, ice: { candidate: 'x' } });
		assert.equal((await b.bekle('ice')).from, 'ayse-' + kimlik);

		b.yolla({ type: 'ping' });
		await b.bekle('pong');
		b.close();
		assert.equal((await a.bekle((m) => m.type === 'ses-kisi-cikti' && m.ad === 'bora-' + kimlik)).kanal, SES_KANAL);
		a.close();
	});

	await dene('sesli kanal: aynı ad reddedilir, aynı sekme yeniden bağlanabilir', async () => {
		const a = await gir('can-' + kimlik, 's1');
		const b = await istemci();
		b.yolla({ type: 'giris', ad: 'can-' + kimlik, id: 's2' });
		assert.match((await b.bekle('hata')).message, /kullanılıyor/);
		b.close();
		const a2 = await gir('can-' + kimlik, 's1'); // aynı sekme, yeni bağlantı
		assert.equal(a2.hazir.ad, 'can-' + kimlik);
		a2.close();
		a.close();
	});

	await dene('sesli kanal dolunca reddedilir', async () => {
		const max = Number(process.env.MAX_KISI || 10);
		const acik = [];
		for (let i = 0; i < max; i++) {
			const w = await gir('k' + i + '-' + kimlik, 'd' + i);
			w.yolla({ type: 'ses-gir', kanal: SES_KANAL });
			await w.bekle('ses-girdi');
			acik.push(w);
		}
		const fazla = await gir('fazla-' + kimlik, 'f');
		fazla.yolla({ type: 'ses-gir', kanal: SES_KANAL });
		assert.match((await fazla.bekle('hata')).message, /dolu/);
		for (const w of [...acik, fazla]) w.close();
	});


	// --- kanal yönetimi (ekle / sil) ve çık-gir

	const kanalBekle = (ws, kosul) => ws.bekle((m) => m.type === 'kanallar' && kosul(m.kanallar));

	await dene('kanal: yazılı kanal eklenir, mesaj alır, silinince mesajları da gider', async () => {
		const a = await gir('kanalci-' + kimlik, 'k1');
		const ad = 'deneme ' + crypto.randomBytes(3).toString('hex');
		a.yolla({ type: 'kanal-ekle', tur: 'yazi', ad });
		const liste = await kanalBekle(a, (ks) => ks.some((k) => k.ad === ad && k.tur === 'yazi'));
		const kanal = liste.kanallar.find((k) => k.ad === ad);
		assert.match(kanal.id, /^[a-z0-9-]+$/, 'kanal kimliği sadeleştirilmiş olmalı');

		const metin = 'kanal denemesi ' + kimlik;
		a.yolla({ type: 'yazi', kanal: kanal.id, metin });
		await a.bekle((m) => m.type === 'yazi' && m.mesaj.metin === metin);

		a.yolla({ type: 'gecmis', kanal: kanal.id });
		const g = await a.bekle((m) => m.type === 'gecmis' && m.kanal === kanal.id);
		assert.equal(g.mesajlar.length, 1, 'yeni kanalın geçmişi kendi mesajını içerir');

		a.yolla({ type: 'kanal-sil', kanal: kanal.id });
		await kanalBekle(a, (ks) => !ks.some((k) => k.id === kanal.id));
		a.yolla({ type: 'gecmis', kanal: kanal.id });
		assert.match((await a.bekle('hata')).message, /Bilinmeyen kanal/, 'silinen kanalın geçmişi yok');
		a.close();
	});

	await dene('kanal: sesli kanal eklenir, silinince içindekiler çıkarılır', async () => {
		const a = await gir('sesli-a-' + kimlik, 'v1');
		const b = await gir('sesli-b-' + kimlik, 'v2');
		const ad = 'deneme ses ' + crypto.randomBytes(3).toString('hex');
		a.yolla({ type: 'kanal-ekle', tur: 'ses', ad });
		const liste = await kanalBekle(a, (ks) => ks.some((k) => k.ad === ad && k.tur === 'ses'));
		const kanal = liste.kanallar.find((k) => k.ad === ad);

		a.yolla({ type: 'ses-gir', kanal: kanal.id });
		assert.equal((await a.bekle((m) => m.type === 'ses-girdi' && m.kanal === kanal.id)).kanal, kanal.id);
		b.yolla({ type: 'ses-gir', kanal: kanal.id });
		await b.bekle((m) => m.type === 'ses-girdi' && m.kanal === kanal.id);

		a.yolla({ type: 'kanal-sil', kanal: kanal.id });
		assert.equal((await a.bekle('ses-kapatildi')).kanal, kanal.id, 'silinen kanaldaki kişi çıkarılır');
		assert.equal((await b.bekle('ses-kapatildi')).kanal, kanal.id);
		await kanalBekle(a, (ks) => !ks.some((k) => k.id === kanal.id));
		a.close();
		b.close();
	});

	await dene('kanal: aynı ad, geçersiz tür ve olmayan kanal reddedilir', async () => {
		const a = await gir('kural-' + kimlik, 'r1');
		const ad = 'kural ' + crypto.randomBytes(3).toString('hex');
		a.yolla({ type: 'kanal-ekle', tur: 'yazi', ad });
		const liste = await kanalBekle(a, (ks) => ks.some((k) => k.ad === ad));
		const kanal = liste.kanallar.find((k) => k.ad === ad);

		a.yolla({ type: 'kanal-ekle', tur: 'yazi', ad });
		assert.match((await a.bekle('hata')).message, /zaten var/);
		a.yolla({ type: 'kanal-ekle', tur: 'video', ad: 'x' });
		assert.match((await a.bekle('hata')).message, /türü/);
		a.yolla({ type: 'kanal-ekle', tur: 'yazi', ad: '   ' });
		assert.match((await a.bekle('hata')).message, /adı gerekli/);
		a.yolla({ type: 'kanal-sil', kanal: 'boyle-bir-kanal-yok' });
		assert.match((await a.bekle('hata')).message, /bulunamadı/);

		a.yolla({ type: 'kanal-sil', kanal: kanal.id });
		await kanalBekle(a, (ks) => !ks.some((k) => k.id === kanal.id));
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

	console.log(process.exitCode ? 'BAŞARISIZ' : `Hepsi geçti (${gecen}).`);
	setTimeout(() => process.exit(), 200);
})();
