// Çalışan bir Ses Kanalı'nı dışarıdan dener: web sayfası, sağlık, /api/ice, signaling (oda, mesh mesajları,
// doluluk, aynı ad), STUN ve TURN (geçici şifreyle aktarım alma; yanlış şifreyle alamama).
// Bağımlılık: Node 22+ yerleşik WebSocket'i kullanır; eski Node'da depodaki ws paketini (npm install).
//
//   node test/dene.js [http://127.0.0.1:8080]
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const WebSocket = globalThis.WebSocket || require('ws');

const ADRES = (process.argv[2] || process.env.ADRES || 'http://127.0.0.1:8080').replace(/\/$/, '');
const WS_ADRES = ADRES.replace(/^http/, 'ws') + '/rtc';
const TURN_HOST = process.env.TURN_HOST || '127.0.0.1';

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
		ws.bekle = (kosul, ms = 3000) => {
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
		ws.yolla = (o) => ws.send(JSON.stringify(o));
		ws.onopen = () => coz(ws);
		ws.onerror = () => red(new Error('WebSocket açılamadı: ' + WS_ADRES));
	});
}

async function gir(oda, ad, id) {
	const ws = await istemci();
	ws.yolla({ type: 'join', room: oda, name: ad, id });
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

	await dene('web sayfası', async () => {
		const r = await fetch(ADRES + '/');
		assert.equal(r.status, 200);
		assert.match(r.headers.get('content-type'), /text\/html/);
		assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/);
		assert.match(await r.text(), /Ses Kanalı/);
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
		console.log('     sürüm', s.surum);
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

	const oda = 'deneme-' + crypto.randomBytes(4).toString('hex');

	await dene('signaling: giriş, mesh mesajları, çıkış', async () => {
		const a = await gir(oda, 'ayse', 'a1');
		const j1 = await a.bekle('joined');
		assert.deepEqual(j1.peers, []);
		assert.ok(j1.max >= 2);
		const b = await gir(oda, 'bora', 'b1');
		assert.deepEqual((await b.bekle('joined')).peers, ['ayse']);
		assert.equal((await a.bekle('peer-joined')).name, 'bora');
		b.yolla({ type: 'sdp', to: 'ayse', sdp: { type: 'offer', sdp: 'v=0' } });
		const s = await a.bekle('sdp');
		assert.equal(s.from, 'bora');
		assert.equal(s.sdp.type, 'offer');
		a.yolla({ type: 'ice', to: 'bora', ice: { candidate: 'x' } });
		assert.equal((await b.bekle('ice')).from, 'ayse');
		b.yolla({ type: 'ping' });
		await b.bekle('pong');
		b.close();
		assert.equal((await a.bekle('peer-left')).name, 'bora');
		a.close();
	});

	await dene('signaling: aynı ad reddedilir, aynı sekme yeniden bağlanabilir', async () => {
		const a = await gir(oda + 'x', 'can', 's1');
		await a.bekle('joined');
		const b = await gir(oda + 'x', 'can', 's2');
		assert.match((await b.bekle('error')).message, /zaten var/);
		b.close();
		const a2 = await gir(oda + 'x', 'can', 's1'); // aynı sekme, yeni bağlantı
		assert.deepEqual((await a2.bekle('joined')).peers, []);
		a2.close();
		a.close();
	});

	await dene('signaling: oda dolunca reddedilir', async () => {
		const max = Number(process.env.MAX_KISI || 10);
		const acik = [];
		for (let i = 0; i < max; i++) {
			const w = await gir(oda + 'd', 'k' + i, 'd' + i);
			await w.bekle('joined');
			acik.push(w);
		}
		const fazla = await gir(oda + 'd', 'fazla', 'f');
		assert.match((await fazla.bekle('error')).message, /dolu/);
		for (const w of [...acik, fazla]) w.close();
	});

	console.log(process.exitCode ? 'BAŞARISIZ' : `Hepsi geçti (${gecen}).`);
	setTimeout(() => process.exit(), 200);
})();
