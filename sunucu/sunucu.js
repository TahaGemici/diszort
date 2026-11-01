// Ses Kanalı sunucusu. Tek süreç:
//   - web sayfasını sunar (web/),
//   - /rtc WebSocket'inde tarayıcıların birbirini bulmasını sağlar (WebRTC signaling, mesh),
//   - coturn'ü (STUN/TURN) başlatıp izler ve tarayıcılara geçici TURN şifresi verir (/api/ice).
// Ses tarayıcılar arasında doğrudan (P2P) akar; doğrudan bağlanamayanlar TURN üzerinden geçer.
//
// Ayarlar .env'den okunur (sunucuda /var/lib/chat/.env, konteynerde /veri/.env); hepsi isteğe bağlı.
// Kendi bilgisayarında:  npm install && node sunucu/sunucu.js   ->  http://127.0.0.1:8080
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const { WebSocketServer, WebSocket } = require('ws');

// ---------------------------------------------------------------- ayarlar

const KOK = path.resolve(__dirname, '..');
const AYAR_DOSYASI = process.env.AYAR_DOSYASI || path.join(KOK, '.env');
const WEB_KLASORU = process.env.WEB_KLASORU || path.join(KOK, 'web');

function envOku(dosya) {
	const sonuc = {};
	let metin;
	try {
		metin = fs.readFileSync(dosya, 'utf8');
	} catch (e) {
		if (e.code === 'ENOENT') return sonuc;
		throw e;
	}
	for (const satir of metin.split(/\r?\n/)) {
		const m = satir.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
		if (!m) continue;
		let deger = m[2];
		if (/^".*"$/.test(deger) || /^'.*'$/.test(deger)) deger = deger.slice(1, -1);
		else deger = deger.replace(/\s+#.*$/, '');
		sonuc[m[1]] = deger;
	}
	return sonuc;
}

const dosyadaki = envOku(AYAR_DOSYASI);
function ayar(ad, varsayilan = '') {
	const deger = (process.env[ad] ?? dosyadaki[ad] ?? '').trim();
	return deger === '' ? varsayilan : deger;
}
function sayiAyar(ad, varsayilan, enAz, enCok) {
	const metin = ayar(ad, String(varsayilan));
	const sayi = Number(metin);
	if (!Number.isInteger(sayi) || sayi < enAz || sayi > enCok) {
		console.error(`Ayar hatası: ${ad}=${metin} (${enAz}..${enCok} arası bir tam sayı olmalı; ${AYAR_DOSYASI})`);
		process.exit(1);
	}
	return sayi;
}
function ipv4mu(metin) {
	return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(metin) && metin.split('.').every((p) => Number(p) <= 255);
}
function icIpBul() {
	for (const liste of Object.values(os.networkInterfaces())) {
		for (const a of liste || []) if (a.family === 'IPv4' && !a.internal) return a.address;
	}
	return '';
}
function surumBul() {
	// Docker imajı sürümü SURUM ortam değişkeniyle verir (Dockerfile: ARG SURUM);
	// kendi bilgisayarında "yerel" görünür.
	if (process.env.SURUM) return process.env.SURUM;
	try {
		const metin = fs.readFileSync('/usr/lib/os-release', 'utf8');
		const m = metin.match(/^IMAGE_VERSION=["']?([^"'\n]*)/m);
		if (m && /^IMAGE_ID=["']?chat["']?$/m.test(metin)) return m[1];
	} catch {}
	return 'yerel';
}

const HOST = ayar('HOST', '127.0.0.1');
const PORT = sayiAyar('PORT', 8080, 1, 65535);
const MAX_KISI = sayiAyar('MAX_KISI', 10, 2, 50);
const TURN_PORT = sayiAyar('TURN_PORT', 3478, 1, 65535);
const RELAY_MIN_PORT = sayiAyar('RELAY_MIN_PORT', 49152, 1024, 65535);
const RELAY_MAX_PORT = sayiAyar('RELAY_MAX_PORT', 61000, RELAY_MIN_PORT, 65535);
const DIS_IP = ayar('DIS_IP');
const IC_IP = ayar('IC_IP') || icIpBul();
const TURN_ADRESI = ayar('TURN_ADRESI') || DIS_IP; // tarayıcıya verilen STUN/TURN adresi (boşsa sayfanın adresi)
const SURUM = surumBul();

for (const [ad, deger] of [['DIS_IP', DIS_IP], ['IC_IP', IC_IP]]) {
	if (deger && !ipv4mu(deger)) {
		console.error(`Ayar hatası: ${ad}=${deger} bir IPv4 adresi değil (${AYAR_DOSYASI})`);
		process.exit(1);
	}
}

// TURN şifreleri bu sırdan türetilir (coturn "use-auth-secret"). Her açılışta yenisi üretilir:
// coturn da her açılışta yeniden başladığı için eski şifrelere gerek kalmaz; diskte saklanacak sır yoktur.
const TURN_SIRRI = crypto.randomBytes(32).toString('hex');
const TURN_SURESI = 24 * 60 * 60; // verilen TURN şifresi bu kadar saniye geçerli (uzun görüşmeler kopmasın)

// ---------------------------------------------------------------- web dosyaları

const TURLER = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.png': 'image/png',
	'.json': 'application/json',
	'.txt': 'text/plain; charset=utf-8',
};

// Web klasörü açılışta belleğe alınır: yalnızca buradaki dosyalar sunulur (yol oyunu yapılamaz).
const dosyalar = new Map();
(function webYukle(klasor, onek) {
	for (const g of fs.readdirSync(klasor, { withFileTypes: true })) {
		const tam = path.join(klasor, g.name);
		if (g.isDirectory()) webYukle(tam, onek + g.name + '/');
		else if (g.isFile()) {
			const govde = fs.readFileSync(tam);
			dosyalar.set(onek + g.name, {
				govde,
				tur: TURLER[path.extname(g.name).toLowerCase()] || 'application/octet-stream',
				etag: '"' + crypto.createHash('sha256').update(govde).digest('base64url').slice(0, 22) + '"',
			});
		}
	}
})(WEB_KLASORU, '/');
if (!dosyalar.has('/index.html')) {
	console.error(`Web klasöründe index.html yok: ${WEB_KLASORU}`);
	process.exit(1);
}

const GUVENLIK_BASLIKLARI = {
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'no-referrer',
	'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
	'Content-Security-Policy':
		"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
		"media-src 'self' blob:; connect-src 'self' wss: ws:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function yanit(res, kod, govde, basliklar = {}) {
	res.writeHead(kod, { ...GUVENLIK_BASLIKLARI, ...basliklar });
	res.end(govde);
}

function dosyaSun(req, res, yol) {
	const d = dosyalar.get(yol === '/' ? '/index.html' : yol);
	if (!d) return yanit(res, 404, 'Bulunamadı\n', { 'Content-Type': 'text/plain; charset=utf-8' });
	// no-cache: tarayıcı saklar ama her seferinde sorar; güncellemeden sonra eski sayfa kalmaz.
	const basliklar = { 'Content-Type': d.tur, 'Cache-Control': 'no-cache', ETag: d.etag };
	if (req.headers['if-none-match'] === d.etag) return yanit(res, 304, undefined, basliklar);
	basliklar['Content-Length'] = d.govde.length;
	yanit(res, 200, req.method === 'HEAD' ? undefined : d.govde, basliklar);
}

// ---------------------------------------------------------------- STUN/TURN (coturn)

let turnDurumu = 'kapalı'; // 'açılıyor' | 'çalışıyor' | 'kapalı'
let turn = null;
let kapaniyor = false;

function turnAyarDosyasi() {
	const klasor = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-'));
	const satirlar = [
		`listening-port=${TURN_PORT}`,
		'listening-ip=0.0.0.0',
		IC_IP ? `relay-ip=${IC_IP}` : null,
		// Bulut sunucusu NAT arkasında: TURN, aktarım adresini dış IP olarak duyurur.
		DIS_IP && IC_IP && DIS_IP !== IC_IP ? `external-ip=${DIS_IP}/${IC_IP}` : null,
		`min-port=${RELAY_MIN_PORT}`,
		`max-port=${RELAY_MAX_PORT}`,
		'fingerprint',
		'use-auth-secret',
		`static-auth-secret=${TURN_SIRRI}`,
		'realm=ses-kanali',
		// Kötüye kullanıma karşı: kullanıcı başına ve toplam aktarım sayısı, aktarım başına bant genişliği.
		'user-quota=24',
		'total-quota=240',
		'max-bps=96000',
		'stale-nonce=600',
		'no-cli',
		'no-tls',
		'no-dtls',
		'no-tcp-relay',
		'no-multicast-peers',
		'no-software-attribute',
		// Sunucunun iç ağına ve kendisine aktarım yapılmasın.
		'denied-peer-ip=0.0.0.0-0.255.255.255',
		'denied-peer-ip=10.0.0.0-10.255.255.255',
		'denied-peer-ip=100.64.0.0-100.127.255.255',
		'denied-peer-ip=127.0.0.0-127.255.255.255',
		'denied-peer-ip=169.254.0.0-169.254.255.255',
		'denied-peer-ip=172.16.0.0-172.31.255.255',
		'denied-peer-ip=192.0.0.0-192.0.0.255',
		'denied-peer-ip=192.168.0.0-192.168.255.255',
		'denied-peer-ip=198.18.0.0-198.19.255.255',
		'denied-peer-ip=::1',
		'denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
		'denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
		'log-file=stdout',
		'simple-log',
		`pidfile=${path.join(klasor, 'turnserver.pid')}`,
		`userdb=${path.join(klasor, 'turndb')}`,
	].filter(Boolean);
	const dosya = path.join(klasor, 'turnserver.conf');
	fs.writeFileSync(dosya, satirlar.join('\n') + '\n', { mode: 0o600 });
	return dosya;
}

function satirSatir(akis, yaz) {
	let artik = '';
	akis.setEncoding('utf8');
	akis.on('data', (parca) => {
		const satirlar = (artik + parca).split('\n');
		artik = satirlar.pop();
		for (const s of satirlar) if (s.trim()) yaz(s);
	});
}

function turnBaslat() {
	turnDurumu = 'açılıyor';
	turn = spawn('turnserver', ['-c', turnAyarDosyasi()], { stdio: ['ignore', 'pipe', 'pipe'] });
	turn.on('error', (e) => {
		turn = null;
		turnDurumu = 'kapalı';
		if (e.code === 'ENOENT') console.warn('[turn] coturn (turnserver) bulunamadı; STUN/TURN kapalı. Kur: sudo apt install coturn');
		else console.error('[turn] başlatılamadı:', e.message);
	});
	satirSatir(turn.stdout, (s) => console.log('[turn] ' + s.replace(/^\d+: /, '')));
	satirSatir(turn.stderr, (s) => console.log('[turn] ' + s));
	turn.on('exit', (kod, sinyal) => {
		const vardi = turnDurumu !== 'kapalı';
		turn = null;
		turnDurumu = 'kapalı';
		if (kapaniyor || !vardi) return;
		// coturn düştüyse sunucu da çıkar; systemd konteyneri iki saniye sonra yeniden başlatır.
		console.error(`[turn] coturn beklenmedik şekilde kapandı (${sinyal || kod}); sunucu da kapanıyor.`);
		process.exit(1);
	});
}

// coturn'e STUN "Binding" isteği gönderip yanıt verdiğini doğrular.
function stunYokla(port, ms = 400) {
	return new Promise((coz) => {
		const soket = dgram.createSocket('udp4');
		const kimlik = crypto.randomBytes(12);
		const bitti = (sonuc) => {
			clearTimeout(zaman);
			soket.close();
			coz(sonuc);
		};
		const zaman = setTimeout(() => bitti(false), ms);
		soket.on('error', () => bitti(false));
		soket.on('message', (m) => {
			if (m.length >= 20 && m.readUInt16BE(0) === 0x0101 && m.subarray(8, 20).equals(kimlik)) bitti(true);
		});
		const istek = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]), kimlik]);
		soket.send(istek, port, '127.0.0.1');
	});
}

async function turnHazirBekle() {
	for (let i = 0; i < 40 && turnDurumu === 'açılıyor'; i++) {
		if (await stunYokla(TURN_PORT)) {
			turnDurumu = 'çalışıyor';
			return true;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	return turnDurumu === 'çalışıyor';
}

function iceSunuculari(req) {
	if (turnDurumu !== 'çalışıyor') return { iceServers: [] };
	let adres = TURN_ADRESI;
	if (!adres) {
		// Dış IP ayarlanmadıysa tarayıcı sayfayı hangi adresten açtıysa onu kullanır.
		const host = String(req.headers.host || '');
		adres = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
	}
	if (adres.includes(':') && !adres.startsWith('[')) adres = `[${adres}]`;
	const kullanici = `${Math.floor(Date.now() / 1000) + TURN_SURESI}:${crypto.randomBytes(6).toString('hex')}`;
	const sifre = crypto.createHmac('sha1', TURN_SIRRI).update(kullanici).digest('base64');
	return {
		iceServers: [
			{ urls: [`stun:${adres}:${TURN_PORT}`] },
			{ urls: [`turn:${adres}:${TURN_PORT}?transport=udp`], username: kullanici, credential: sifre },
		],
	};
}

// ---------------------------------------------------------------- signaling (WebSocket /rtc)
//
// İstemci -> sunucu:  {type:'join', room, name}   {type:'sdp', to, sdp}   {type:'ice', to, ice}   {type:'ping'}
// Sunucu -> istemci:  {type:'joined', room, peers:[isim...], max}   {type:'peer-joined', name}
//                     {type:'peer-left', name}   {type:'sdp', from, sdp}   {type:'ice', from, ice}
//                     {type:'error', message}   {type:'pong'}

const odalar = new Map(); // oda adı -> Map<isim, ws>
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

function gonder(ws, nesne) {
	if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(nesne));
}
function herkese(oda, nesne, haric) {
	for (const ws of (odalar.get(oda) || new Map()).values()) if (ws !== haric) gonder(ws, nesne);
}
function ayril(ws) {
	if (!ws.oda) return;
	const uyeler = odalar.get(ws.oda);
	if (uyeler && uyeler.get(ws.isim) === ws) {
		uyeler.delete(ws.isim);
		console.log(`[kanal] ${ws.oda}: ${ws.isim} çıktı (${uyeler.size}/${MAX_KISI})`);
		if (uyeler.size === 0) odalar.delete(ws.oda);
		else herkese(ws.oda, { type: 'peer-left', name: ws.isim });
	}
	ws.oda = null;
	ws.isim = null;
}

function katil(ws, m) {
	const oda = String(m.room ?? '').trim().slice(0, 64);
	const isim = String(m.name ?? '').trim().slice(0, 32) || 'misafir';
	if (!oda) return gonder(ws, { type: 'error', message: 'Oda adı gerekli.' });
	if (ws.oda === oda && ws.isim === isim) return;
	const kimlik = String(m.id ?? '').slice(0, 64);
	const uyeler = odalar.get(oda) || new Map();
	const eski = uyeler.get(isim);
	if (eski && eski !== ws) {
		// Aynı sekme yeniden bağlandıysa (ağ değişti, sunucu bağlantısı koptu) eski bağlantı düşürülür.
		if (!kimlik || eski.kimlik !== kimlik) return gonder(ws, { type: 'error', message: `"${isim}" adı bu odada zaten var; başka bir ad seç.` });
		ayril(eski);
		eski.terminate();
	}
	if (uyeler.size >= MAX_KISI) return gonder(ws, { type: 'error', message: `Oda dolu (en fazla ${MAX_KISI} kişi).` });
	ayril(ws);
	ws.kimlik = kimlik;
	const digerleri = [...uyeler.keys()];
	uyeler.set(isim, ws);
	odalar.set(oda, uyeler);
	ws.oda = oda;
	ws.isim = isim;
	console.log(`[kanal] ${oda}: ${isim} girdi (${uyeler.size}/${MAX_KISI})`);
	gonder(ws, { type: 'joined', room: oda, peers: digerleri, max: MAX_KISI });
	herkese(oda, { type: 'peer-joined', name: isim }, ws);
}

wss.on('connection', (ws) => {
	ws.oda = null;
	ws.isim = null;
	ws.canli = true;
	ws.on('pong', () => (ws.canli = true));
	ws.on('message', (veri, ikili) => {
		if (ikili) return;
		let m;
		try {
			m = JSON.parse(veri.toString());
		} catch {
			return;
		}
		if (!m || typeof m !== 'object') return;
		switch (m.type) {
			case 'join':
				katil(ws, m);
				break;
			case 'sdp':
			case 'ice': {
				// Mesh: her mesaj tek bir kişiye ('to') gider.
				if (!ws.oda) return;
				const hedef = odalar.get(ws.oda)?.get(String(m.to));
				if (!hedef || hedef === ws) return;
				gonder(hedef, m.type === 'sdp' ? { type: 'sdp', from: ws.isim, sdp: m.sdp } : { type: 'ice', from: ws.isim, ice: m.ice });
				break;
			}
			case 'ping':
				gonder(ws, { type: 'pong' });
				break;
		}
	});
	ws.on('close', () => ayril(ws));
	ws.on('error', () => ayril(ws));
});

// Kopan bağlantıları (telefon uykuya geçti, ağ değişti...) 30 saniyede bir temizle.
const nabiz = setInterval(() => {
	for (const ws of wss.clients) {
		if (!ws.canli) {
			ws.terminate();
			continue;
		}
		ws.canli = false;
		ws.ping();
	}
}, 30000);

// ---------------------------------------------------------------- HTTP

const sunucu = http.createServer((req, res) => {
	let yol;
	try {
		yol = decodeURIComponent(new URL(req.url, 'http://x').pathname);
	} catch {
		return yanit(res, 400, 'Hatalı istek\n', { 'Content-Type': 'text/plain; charset=utf-8' });
	}
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		return yanit(res, 405, 'İzin yok\n', { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
	}
	if (yol === '/saglik') {
		const kisi = [...odalar.values()].reduce((t, u) => t + u.size, 0);
		const iyi = turnDurumu === 'çalışıyor' || turn === null;
		return yanit(res, iyi ? 200 : 503, JSON.stringify({ durum: iyi ? 'tamam' : 'sorunlu', surum: SURUM, turn: turnDurumu, oda: odalar.size, kisi }) + '\n', {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
		});
	}
	if (yol === '/api/ice') {
		return yanit(res, 200, JSON.stringify(iceSunuculari(req)), {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
		});
	}
	dosyaSun(req, res, yol);
});

sunucu.on('upgrade', (req, soket, bas) => {
	let yol = '';
	try {
		yol = new URL(req.url, 'http://x').pathname;
	} catch {}
	if (yol !== '/rtc') {
		soket.destroy();
		return;
	}
	wss.handleUpgrade(req, soket, bas, (ws) => wss.emit('connection', ws, req));
});

function kapat(sinyal) {
	if (kapaniyor) return;
	kapaniyor = true;
	console.log(`Kapanıyor (${sinyal}).`);
	clearInterval(nabiz);
	for (const ws of wss.clients) ws.close(1001, 'sunucu kapanıyor');
	sunucu.close();
	const bitir = () => process.exit(0);
	if (turn) {
		turn.once('exit', bitir);
		turn.kill('SIGTERM');
		setTimeout(bitir, 3000).unref();
	} else bitir();
}
process.on('SIGTERM', () => kapat('SIGTERM'));
process.on('SIGINT', () => kapat('SIGINT'));

sunucu.on('error', (e) => {
	console.error(`HTTP ${HOST}:${PORT} açılamadı: ${e.message}`);
	process.exit(1);
});

turnBaslat();
sunucu.listen(PORT, HOST, async () => {
	const turnTamam = await turnHazirBekle();
	if (!turnTamam && turn) {
		console.error(`[turn] coturn UDP ${TURN_PORT}'te yanıt vermiyor.`);
		process.exit(1);
	}
	const turnBilgi = turnTamam
		? `STUN/TURN udp/${TURN_PORT} (aktarım ${RELAY_MIN_PORT}-${RELAY_MAX_PORT}, dış IP ${DIS_IP || 'yok'}, iç IP ${IC_IP || 'yok'})`
		: 'STUN/TURN kapalı';
	console.log(`Ses kanalı çalışıyor: http://${HOST}:${PORT}  sürüm ${SURUM}, oda başına en fazla ${MAX_KISI} kişi, ${turnBilgi}`);
});
