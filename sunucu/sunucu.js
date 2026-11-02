// Ses Kanalı sunucusu — Discord'umsu tek sunucu: yazılı kanallar + sesli kanallar.
//   - web sayfasını sunar (web/),
//   - /rtc WebSocket'inde yazılı sohbeti iletir ve kaydeder (SQLite), sesli kanallar için
//     WebRTC signaling yapar (mesh: ses tarayıcılar arasında P2P akar),
//   - /api/yukle ile dosya alır (/veri/yuklemeler), /dosya/<id> ile sunar,
//   - coturn'ü (STUN/TURN) başlatıp izler ve tarayıcılara geçici TURN şifresi verir (/api/ice).
//
// Yalnızca yazılı kanallar diske yazılır; ses/görüntü kaydedilmez.
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
const veritabani = require('./veritabani');

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
const DOSYA_MB = sayiAyar('DOSYA_MB', 25, 1, 200);
// Beyaz liste: en fazla bu kadar kişi (ad) olabilir; her kişinin kendi anahtarı vardır.
// Varsayılan .env'den gelir; beyaz listedekiler çalışırken arttırıp azaltabilir (DB'de saklanır).
const KISI_LIMITI_VARSAYILAN = sayiAyar('MAX_KULLANICI', 10, 2, 50);
const MIN_KISI_LIMITI = 2;
const MAKS_KISI_LIMITI = 50;
let maxKullanici = KISI_LIMITI_VARSAYILAN;
const YONETICI_ADI = ayar('YONETICI_ADI', 'taha'); // beyaz liste boşken ilk anahtarı alacak kişi
// Kişiye özel anahtar: 64 rastgele bayt = 512 bit (128 hex karakter). Yalnızca bu biçimdeki
// anahtarlar kabul edilir; eski/kısa anahtarlar geçersiz sayılır (kapıyı çalma akışına düşer).
const ANAHTAR_BAYT = 64;
const ANAHTAR_UZUNLUK = ANAHTAR_BAYT * 2;
const ANAHTAR_KALIBI = /^[0-9a-f]{128}$/;
// Giriş freni: TÜM giriş denemeleri sunucu genelinde (tüm bağlantılar, tüm kişiler) bu aralıkla
// sınırlıdır — 10 saniyede 1. İlk deneme, yeni bağlantı, geçerli anahtar ayrımı YOKTUR.
// Yalnızca sunucu tarafında uygulanır; istemci kodu değiştirilerek aşılamaz.
const GIRIS_ARALIK_MS = sayiAyar('GIRIS_ARALIK_MS', 10000, 0, 600000);
let sonGirisDenemesi = 0; // sunucu geneli: son kabul edilen giriş denemesinin zamanı
const ILK_ANAHTAR = ayar('ILK_ANAHTAR'); // test/kurulum için sabit ilk anahtar (üretimde boş bırak)
const SITE_ADRESI = ayar('SITE_ADRESI', 'https://chat.tahagemici.com'); // ilk anahtar bağlantısında kullanılır
const TURN_PORT = sayiAyar('TURN_PORT', 3478, 1, 65535);
const RELAY_MIN_PORT = sayiAyar('RELAY_MIN_PORT', 49152, 1024, 65535);
const RELAY_MAX_PORT = sayiAyar('RELAY_MAX_PORT', 61000, RELAY_MIN_PORT, 65535);
const DIS_IP = ayar('DIS_IP');
const IC_IP = ayar('IC_IP') || icIpBul();
const TURN_ADRESI = ayar('TURN_ADRESI') || DIS_IP; // tarayıcıya verilen STUN/TURN adresi (boşsa sayfanın adresi)
const SURUM = surumBul();
const VERI_KLASORU = ayar('VERI_KLASORU') || (fs.existsSync('/veri') ? '/veri' : path.join(KOK, 'veri'));
const YUKLEME_KLASORU = path.join(VERI_KLASORU, 'yuklemeler');
const DOSYA_SINIRI = DOSYA_MB * 1024 * 1024;
const EN_AZ_BOS_ALAN = 300 * 1024 * 1024; // yükleme için sunucuda en az bu kadar boş yer kalsın

if (ILK_ANAHTAR && !ANAHTAR_KALIBI.test(ILK_ANAHTAR)) {
	console.error(`Ayar hatası: ILK_ANAHTAR ${ANAHTAR_UZUNLUK} karakterlik hex olmalı (512 bit) ya da boş bırakılmalı.`);
	process.exit(1);
}

for (const [ad, deger] of [['DIS_IP', DIS_IP], ['IC_IP', IC_IP]]) {
	if (deger && !ipv4mu(deger)) {
		console.error(`Ayar hatası: ${ad}=${deger} bir IPv4 adresi değil (${AYAR_DOSYASI})`);
		process.exit(1);
	}
}

// ---------------------------------------------------------------- kanallar
// Tek sunucu. Kanallar veritabanında tutulur (kanal tablosu); ilk açılışta aşağıdaki varsayılanlar
// yazılır. Kullanıcı arayüzden yazılı/sesli kanal ekleyip silebilir (hesap yok, herkes yapabilir).
// Yazılı kanalların geçmişi mesaj tablosunda kanal id'siyle saklanır.

const VARSAYILAN_KANALLAR = [
	{ id: 'genel', ad: 'genel', tur: 'yazi' },
	{ id: 'muhabbet', ad: 'muhabbet', tur: 'yazi' },
	{ id: 'sesli-sohbet', ad: 'Sesli Sohbet', tur: 'ses' },
	{ id: 'muzik', ad: 'Müzik', tur: 'ses' },
	{ id: 'oyun', ad: 'Oyun', tur: 'ses' },
];
const EN_FAZLA_KANAL = 40;
let kanallar = []; // [{id, ad, tur}] — veritabanından yüklenir, ekleme/silmede güncellenir

const yaziKanali = (id) => kanallar.find((k) => k.id === id && k.tur === 'yazi') || null;
const sesKanali = (id) => kanallar.find((k) => k.id === id && k.tur === 'ses') || null;

// "Sesli Sohbet" → "sesli-sohbet"; Türkçe harfler sadeleşir, gerisi tireden oluşur.
const TR_HARF = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };
function kanalKimligi(ad) {
	const sade = String(ad)
		.toLocaleLowerCase('tr')
		.replace(/[çğıöşüâîû]/g, (h) => TR_HARF[h] || h)
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 32);
	return sade || 'kanal';
}
function benzersizKimlik(ad) {
	const temel = kanalKimligi(ad);
	let aday = temel;
	for (let i = 2; kanallar.some((k) => k.id === aday) && i < 1000; i++) aday = `${temel}-${i}`;
	return aday;
}

// TURN şifreleri bu sırdan türetilir (coturn "use-auth-secret"). Her açılışta yenisi üretilir:
// coturn da her açılışta yeniden başladığı için eski şifrelere gerek kalmaz; diskte saklanacak sır yoktur.
const TURN_SIRRI = crypto.randomBytes(32).toString('hex');
const TURN_SURESI = 24 * 60 * 60;

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
		"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
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
		// Aktarım (relay) bant genişliği sınırı: 96 kbps gelen+giden toplamı için dar ve relay'li
		// görüşmelerde ses kesilmesine yol açıyordu; ses için bol, kötüye kullanıma karşı sınırlı.
		'max-bps=512000',
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
		// coturn düştüyse sunucu da çıkar; Docker konteyneri iki saniye sonra yeniden başlatır.
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

// ---------------------------------------------------------------- signaling + sohbet (/rtc)
//
// İstemci -> sunucu:
//   {type:'giris', ad, id}                     adı al (bir kez); 'hazir' yanıtı gelir
//   {type:'yazi', kanal, metin}                yazılı kanala mesaj gönder
//   {type:'gecmis', kanal, once}               eski mesajları iste (once: en eski bilinen id)
//   {type:'yaziyor', kanal}                    "yazıyor" göstergesi
//   {type:'ses-gir', kanal} / {type:'ses-cik'} sesli kanala gir/çık
//   {type:'sdp', to, sdp} / {type:'ice', to, ice}   WebRTC (aynı sesli kanaldaki kişiye)
//   {type:'sessiz', sessiz}                    mikrofon kapalı mı (diğerlerine gösterilir)
//   {type:'ping'}
// Sunucu -> istemci:
//   {type:'hazir', ad, kanallar, kimler, max, dosyaMb, jeton}
//   {type:'kanallar', kanallar} / {type:'kimler', kimler}
//   {type:'yazi', kanal, mesaj} / {type:'gecmis', kanal, mesajlar, bitti}
//   {type:'yaziyor', kanal, ad}
//   {type:'ses-girdi', kanal, kisiler} / {type:'ses-kisi-girdi', kanal, ad} / {type:'ses-kisi-cikti', kanal, ad}
//   {type:'sessiz', ad, sessiz}
//   {type:'sdp', from, sdp} / {type:'ice', from, ice}
//   {type:'hata', message} / {type:'pong'}

const sesliKanallar = new Map(); // kanal id -> Map<ad, ws>
const jetonlar = new Map(); // yükleme jetonu -> ws
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
let db = null;

function gonder(ws, nesne) {
	if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(nesne));
}
function herkes(nesne, haric) {
	for (const ws of wss.clients) if (ws !== haric && ws.ad) gonder(ws, nesne);
}
function kanalHerkes(kanal, nesne, haric) {
	for (const ws of (sesliKanallar.get(kanal) || new Map()).values()) if (ws !== haric) gonder(ws, nesne);
}

function kanalDurumu() {
	return kanallar.map((k) => {
		const o = { id: k.id, ad: k.ad, tur: k.tur };
		if (k.tur === 'ses') o.kisiler = [...(sesliKanallar.get(k.id) || new Map()).values()].map((ws) => ({ ad: ws.ad, sessiz: !!ws.sessiz }));
		return o;
	});
}
let beyazListeSayisi = 0; // son bilinen beyaz liste boyutu (yanıtlarda gösterilir)

function kimler() {
	const liste = [];
	for (const ws of wss.clients) if (ws.ad) liste.push({ ad: ws.ad, sessiz: !!ws.sessiz, ses: ws.sesKanal || null });
	return liste.sort((a, b) => a.ad.localeCompare(b.ad, 'tr'));
}
// Kim girdi/çıktı, hangi sesli kanalda kim var: herkese tek seferde.
function durumYayinla() {
	const kanallar = kanalDurumu();
	const kim = kimler();
	for (const ws of wss.clients) {
		if (!ws.ad) continue;
		gonder(ws, { type: 'kanallar', kanallar });
		gonder(ws, { type: 'kimler', kimler: kim, beyazListe: beyazListeSayisi, maxKullanici: maxKullanici });
	}
}

function sesCikar(ws) {
	const kanal = ws.sesKanal;
	if (!kanal) return;
	ws.sesKanal = null;
	const uyeler = sesliKanallar.get(kanal);
	if (uyeler && uyeler.get(ws.ad) === ws) {
		uyeler.delete(ws.ad);
		if (!uyeler.size) sesliKanallar.delete(kanal);
		else kanalHerkes(kanal, { type: 'ses-kisi-cikti', kanal, ad: ws.ad });
		console.log(`[ses] ${kanal}: ${ws.ad} çıktı`);
	}
}

// Bağlantı kapanınca adı ve sesli kanal üyeliğini bırak.
function ayril(ws) {
	const vardi = ws.ad || ws.sesKanal;
	sesCikar(ws);
	if (!ws.ad) return;
	const kimlik = ws.kimlik;
	ws.ad = null;
	if (ws.jeton) jetonlar.delete(ws.jeton);
	if (vardi) durumYayinla();
	return kimlik;
}

function adSahibi(ad) {
	for (const ws of wss.clients) if (ws.ad === ad) return ws;
	return null;
}

// ---------------------------------------------------------------- giriş: beyaz liste + kapıyı çalma
//
// Anahtarı olan (beyaz listedeki) kişi doğrudan girer. Anahtarı olmayan ya da anahtarı geçersiz olan
// kişi "kapıyı çalar": içerideki herkese sorulur, biri kabul ederse o kişiye özel yeni bir anahtar
// üretilir (istemci localStorage'ında saklar). Reddedilirse ya da kimse içeride değilse giremez.

const bekleyenler = new Map(); // istek id -> { ad, ip, zaman, ws, kimlik }
const kapiDenemeleri = new Map(); // ip -> { baslangic, adet } (dakikalık giriş denemesi sayacı)
const beklemeSuresi = 120000; // 2 dakika içinde karar verilmezse düşer

function temizAd(ham) {
	return String(ham ?? '')
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.trim()
		.slice(0, 32);
}

function oturumAc(ws, ad, kimlik, anahtar) {
	// Aynı adla açık başka bir bağlantı varsa (sekme yenilendi / yeniden onaylandı) onu düşür.
	const eski = adSahibi(ad);
	if (eski && eski !== ws) {
		ayril(eski);
		eski.terminate();
	}
	if (ws.jeton) jetonlar.delete(ws.jeton);
	ws.ad = ad;
	ws.kimlik = kimlik || '';
	ws.jeton = crypto.randomBytes(16).toString('hex');
	ws.yaziPencere = 0;
	ws.yaziAdet = 0;
	jetonlar.set(ws.jeton, ws);
	gonder(ws, {
		type: 'hazir',
		ad,
		kanallar: kanalDurumu(),
		kimler: kimler(),
		max: MAX_KISI,
		maxKullanici: maxKullanici,
		beyazListe: beyazListeSayisi,
		dosyaMb: DOSYA_MB,
		jeton: ws.jeton,
		anahtar: anahtar || undefined,
	});
	durumYayinla();
}

// Bekleyen isteği kapat ve herkese haber ver.
function istekKapat(id, kabul, ad) {
	const kayit = bekleyenler.get(id);
	if (!kayit) return null;
	bekleyenler.delete(id);
	kayit.ws.knockId = null;
	for (const x of wss.clients) if (x.ad) gonder(x, { type: 'istek-kapandi', id, kabul: !!kabul, ad: kayit.ad });
	return kayit;
}

async function kapiCal(ws, ad, anahtarGecersiz) {
	let kisiSayisi = 0;
	try {
		kisiSayisi = await db.kisiSayisi();
	} catch {}
	if (kisiSayisi >= maxKullanici) {
		return gonder(ws, { type: 'giris-red', message: `Sunucu dolu (en fazla ${maxKullanici} kişi).` });
	}
	const cevrimici = [...wss.clients].filter((x) => x.ad);
	if (!cevrimici.length) {
		return gonder(ws, { type: 'giris-red', message: 'Şu an içeride kimse yok; biraz sonra tekrar dene.' });
	}
	// Aynı IP'den istek yağmasın: aynı anda en fazla 3 bekleyen, dakikada en fazla 100 deneme.
	// (Aynı ev/NAT arkasındaki birkaç kişi birbirini engellemesin diye pencere geniş tutuldu.)
	const ip = ws.ip || '';
	if (ip) {
		const ayniIp = [...bekleyenler.values()].filter((b) => b.ip === ip);
		if (ayniIp.length >= 3) return gonder(ws, { type: 'giris-red', message: 'Çok fazla istek; biraz bekle.' });
		const simdi = Date.now();
		const kayit = kapiDenemeleri.get(ip) || { baslangic: simdi, adet: 0 };
		if (simdi - kayit.baslangic > 60000) {
			kayit.baslangic = simdi;
			kayit.adet = 0;
		}
		// Dakikada 600 deneme: insan trafiği için bol, otomatik flood için sınır.
		if (++kayit.adet > 600) {
			kapiDenemeleri.set(ip, kayit);
			return gonder(ws, { type: 'giris-red', message: 'Çok fazla giriş denemesi; bir dakika bekle.' });
		}
		kapiDenemeleri.set(ip, kayit);
	}
	// Aynı ad için eski bekleyen isteği düşür.
	for (const [id, b] of bekleyenler) if (b.ad === ad) istekKapat(id, false, ad);

	const id = crypto.randomBytes(6).toString('hex');
	bekleyenler.set(id, { ad, ip, zaman: Date.now(), ws, kimlik: ws.kimlik || '' });
	ws.knockId = id;
	gonder(ws, { type: 'bekleniyor', ad, anahtarGecersiz: !!anahtarGecersiz });
	for (const x of cevrimici) gonder(x, { type: 'giris-istegi', id, ad });
	console.log(`[kapı] ${ad} izin istiyor (${cevrimici.length} kişiye soruldu${anahtarGecersiz ? ', anahtar geçersiz' : ''})`);
}

// Giriş freni: sunucu genelinde tek sayaç. Her giriş denemesi (anahtarlı/anahtarsız, ilk deneme
// dahil) 10 saniyede 1'e tabidir. Bekleme sunucuda tutulmaz: istek hemen reddedilir, zamanlayıcı yok.
function girisFreni(simdi) {
	const kalan = GIRIS_ARALIK_MS - (simdi - sonGirisDenemesi);
	return kalan > 0 ? kalan : 0;
}

async function girisYap(ws, m) {
	const ad = temizAd(m.ad);
	const kimlik = String(m.id ?? '').slice(0, 64);
	const anahtar = String(m.anahtar ?? '').trim().slice(0, ANAHTAR_UZUNLUK);
	ws.kimlik = kimlik;

	// Önce fren: DB'ye bile gitmeden reddedilir.
	const simdi = Date.now();
	const kalan = girisFreni(simdi);
	if (kalan > 0) {
		return gonder(ws, { type: 'giris-red', message: `Çok sık deneme; ${Math.ceil(kalan / 1000)} saniye sonra tekrar dene.` });
	}
	sonGirisDenemesi = simdi;

	// 1) Geçerli anahtar → doğrudan giriş (ad, anahtarın sahibinden gelir).
	// Yalnızca 512 bit (128 hex) anahtarlar sorgulanır; eski biçimdeki anahtarlar geçersizdir.
	if (anahtar && ANAHTAR_KALIBI.test(anahtar)) {
		let kisi = null;
		try {
			kisi = await db.kisiAnahtarla(anahtar);
		} catch (e) {
			console.error('[beyaz liste] anahtar okunamadı:', e.message);
		}
		if (kisi) {
			const sahibi = adSahibi(kisi.ad);
			if (sahibi && sahibi !== ws) {
				// Aynı sekme yeniden bağlandıysa eski bağlantıyı düşür; başka cihazsa reddet.
				if (!kimlik || sahibi.kimlik !== kimlik) {
					return gonder(ws, { type: 'giris-red', message: `"${kisi.ad}" şu anda başka bir cihazdan bağlı.` });
				}
				ayril(sahibi);
				sahibi.terminate();
			}
			if (ws.ad && ws.ad !== kisi.ad) ayril(ws);
			oturumAc(ws, kisi.ad, kimlik, anahtar);
			console.log(`[giriş] ${kisi.ad} anahtarıyla girdi`);
			try {
				db.kisiSonGiris(kisi.ad);
			} catch {}
			return;
		}
	}

	// 2) Anahtarsız / geçersiz anahtar → kapıyı çal.
	if (!ad) {
		return gonder(ws, { type: 'giris-red', message: anahtar ? 'Anahtar geçersiz; adını yazıp izin iste.' : 'Ad gerekli.' });
	}
	const sahibi = adSahibi(ad);
	if (sahibi && sahibi !== ws && (!kimlik || sahibi.kimlik !== kimlik)) {
		return gonder(ws, { type: 'giris-red', message: `"${ad}" adı şu anda kullanılıyor; başka bir ad seç.` });
	}
	await kapiCal(ws, ad, !!anahtar);
}

// İçerideki biri kabul/red verir.
async function girisKarari(ws, m) {
	if (!ws.ad) return gonder(ws, { type: 'hata', message: 'Önce giriş yap.' });
	const id = String(m.id ?? '');
	const kayit = bekleyenler.get(id);
	if (!kayit) return gonder(ws, { type: 'hata', message: 'Bu giriş isteği artık geçerli değil.' });

	if (!m.kabul) {
		istekKapat(id, false, kayit.ad);
		gonder(kayit.ws, { type: 'giris-red', message: 'Giriş isteğin reddedildi.' });
		console.log(`[kapı] ${kayit.ad} reddedildi (${ws.ad})`);
		return;
	}

	let sayi = 0;
	let mevcut = null;
	try {
		sayi = await db.kisiSayisi();
		mevcut = await db.kisiAd(kayit.ad);
	} catch {}
	if (sayi >= maxKullanici && !mevcut) {
		gonder(ws, { type: 'hata', message: `Beyaz liste dolu (${sayi}/${maxKullanici}); önce birini at.` });
		istekKapat(id, false, kayit.ad);
		gonder(kayit.ws, { type: 'giris-red', message: `Sunucu dolu (en fazla ${maxKullanici} kişi).` });
		return;
	}

	const yeniAnahtar = crypto.randomBytes(ANAHTAR_BAYT).toString('hex');
	try {
		await db.kisiKaydet({ ad: kayit.ad, anahtar: yeniAnahtar });
	} catch (e) {
		console.error('[beyaz liste] kişi kaydedilemedi:', e.message);
		return gonder(ws, { type: 'hata', message: 'Kişi kaydedilemedi; tekrar dene.' });
	}
	beyazListeSayisi = mevcut ? sayi : sayi + 1;
	istekKapat(id, true, kayit.ad);
	if (kayit.ws.readyState !== WebSocket.OPEN) return;
	oturumAc(kayit.ws, kayit.ad, kayit.kimlik, yeniAnahtar);
	console.log(`[kapı] ${kayit.ad} kabul edildi (${ws.ad}) → anahtar verildi`);
}

// Beyaz listedekiler kişi limitini çalışırken arttırıp azaltabilir (DB'ye yazılır, yeniden başlatmada korunur).
async function kisiLimitiAyarla(ws, m) {
	if (!ws.ad) return gonder(ws, { type: 'hata', message: 'Önce giriş yap.' });
	const deger = Math.round(Number(m.deger));
	if (!Number.isFinite(deger) || deger < MIN_KISI_LIMITI || deger > MAKS_KISI_LIMITI) {
		return gonder(ws, { type: 'hata', message: `Kişi limiti ${MIN_KISI_LIMITI}–${MAKS_KISI_LIMITI} arasında olmalı.` });
	}
	if (deger === maxKullanici) return;
	const once = maxKullanici;
	try {
		await db.ayarYaz('kisi_limiti', deger);
	} catch (e) {
		console.error('[ayar] kişi limiti yazılamadı: ' + e.message);
		return gonder(ws, { type: 'hata', message: 'Kişi limiti kaydedilemedi; tekrar dene.' });
	}
	maxKullanici = deger;
	let sayi = 0;
	try {
		sayi = await db.kisiSayisi();
	} catch {}
	beyazListeSayisi = sayi || beyazListeSayisi;
	durumYayinla();
	console.log(`[beyaz liste] ${ws.ad} kişi limitini ${once} → ${deger} yaptı (kayıtlı kişi: ${sayi})`);
	if (deger < sayi) {
		gonder(ws, {
			type: 'hata',
			message: `Limit ${deger}; şu an ${sayi} kişi kayıtlı. Kimse atılmadı ama yeni girişler limitin altına inene kadar kapalı.`,
		});
	}
}

// Beyaz listeden at: anahtar iptal edilir, bağlantı düşürülür.
async function kisiAt(ws, m) {
	if (!ws.ad) return gonder(ws, { type: 'hata', message: 'Önce giriş yap.' });
	const ad = String(m.ad ?? '').trim().slice(0, 32);
	if (!ad) return gonder(ws, { type: 'hata', message: 'Kim atılacak?' });
	if (ad === ws.ad) return gonder(ws, { type: 'hata', message: 'Kendini atamazsın; çıkmak için sekmeyi kapat.' });
	if (!kisiHizi(ws)) return;
	let kayit = null;
	let sayi = 0;
	try {
		kayit = await db.kisiAd(ad);
		sayi = await db.kisiSayisi();
	} catch {}
	if (!kayit) return gonder(ws, { type: 'hata', message: 'Bu kişi beyaz listede değil.' });
	if (sayi <= 1) return gonder(ws, { type: 'hata', message: 'Son kişi atılamaz.' });
	try {
		await db.kisiSil(ad);
	} catch (e) {
		console.error('[beyaz liste] silinemedi:', e.message);
		return gonder(ws, { type: 'hata', message: 'Kişi silinemedi; tekrar dene.' });
	}
	beyazListeSayisi = Math.max(0, sayi - 1);
	const hedef = adSahibi(ad);
	console.log(`[beyaz liste] ${ws.ad} → ${ad} atıldı`);
	if (hedef) {
		gonder(hedef, { type: 'atildi', message: 'Sunucudan atıldın; tekrar girmek için izin istemen gerek.' });
		setTimeout(() => hedef.terminate(), 300);
	}
	durumYayinla();
}

async function yaziGonder(ws, m) {
	if (!ws.ad) return gonder(ws, { type: 'hata', message: 'Önce adını gir.' });
	const kanal = String(m.kanal ?? '');
	if (!yaziKanali(kanal)) return gonder(ws, { type: 'hata', message: 'Bilinmeyen kanal.' });
	let metin = String(m.metin ?? '')
		.replace(/\r\n/g, '\n')
		// Kontrol karakterleri (satır sonu ve sekme hariç) metne karışmasın.
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
		.trim();
	if (!metin) return;
	if (metin.length > 2000) metin = metin.slice(0, 2000);
	const simdi = Date.now();
	if (simdi - (ws.yaziPencere || 0) > 10000) {
		ws.yaziPencere = simdi;
		ws.yaziAdet = 0;
	}
	if (++ws.yaziAdet > 12) return gonder(ws, { type: 'hata', message: 'Çok hızlı yazıyorsun; birkaç saniye bekle.' });
	try {
		const mesaj = await db.mesajEkle({ kanal, ad: ws.ad, metin });
		herkes({ type: 'yazi', kanal, mesaj });
	} catch (e) {
		console.error('[veritabanı] mesaj yazılamadı:', e.message);
		gonder(ws, { type: 'hata', message: 'Mesaj kaydedilemedi; tekrar dene.' });
	}
}

async function gecmisGonder(ws, m) {
	const kanal = String(m.kanal ?? '');
	if (!yaziKanali(kanal)) return gonder(ws, { type: 'hata', message: 'Bilinmeyen kanal.' });
	const once = Number(m.once) > 0 ? Math.floor(Number(m.once)) : 0;
	try {
		const mesajlar = await db.mesajlar(kanal, once, 50);
		gonder(ws, { type: 'gecmis', kanal, mesajlar, bitti: mesajlar.length < 50 });
	} catch (e) {
		console.error('[veritabanı] geçmiş okunamadı:', e.message);
		gonder(ws, { type: 'hata', message: 'Sohbet geçmişi okunamadı.' });
	}
}

function sesGir(ws, m) {
	if (!ws.ad) return gonder(ws, { type: 'hata', message: 'Önce adını gir.' });
	const kanal = String(m.kanal ?? '');
	if (!sesKanali(kanal)) return gonder(ws, { type: 'hata', message: 'Bilinmeyen sesli kanal.' });
	if (ws.sesKanal === kanal) {
		return gonder(ws, { type: 'ses-girdi', kanal, kisiler: [...sesliKanallar.get(kanal).keys()].filter((a) => a !== ws.ad) });
	}
	sesCikar(ws);
	const uyeler = sesliKanallar.get(kanal) || new Map();
	if (uyeler.size >= MAX_KISI) {
		return gonder(ws, { type: 'hata', message: `Sesli kanal dolu (en fazla ${MAX_KISI} kişi).` });
	}
	const digerleri = [...uyeler.keys()];
	uyeler.set(ws.ad, ws);
	sesliKanallar.set(kanal, uyeler);
	ws.sesKanal = kanal;
	ws.sessiz = false;
	console.log(`[ses] ${kanal}: ${ws.ad} girdi (${uyeler.size}/${MAX_KISI})`);
	gonder(ws, { type: 'ses-girdi', kanal, kisiler: digerleri });
	kanalHerkes(kanal, { type: 'ses-kisi-girdi', kanal, ad: ws.ad }, ws);
	durumYayinla();
}

function sdpIlet(ws, m, tur) {
	if (!ws.sesKanal) return;
	const hedef = String(m.to ?? '');
	const uyeler = sesliKanallar.get(ws.sesKanal);
	const karsi = uyeler && uyeler.get(hedef);
	if (!karsi || karsi === ws) return;
	gonder(karsi, tur === 'sdp' ? { type: 'sdp', from: ws.ad, sdp: m.sdp } : { type: 'ice', from: ws.ad, ice: m.ice });
}


// --- kanal ekleme / silme (hesap yok: giriş yapan herkes yapabilir; saatte 10 işlemle sınırlı)

// Atma işlemleri kanal işlemlerinden ayrı sayılır (temizlik sırasında 10/dk sınırına takılmasın).
function kisiHizi(ws) {
	const simdi = Date.now();
	if (simdi - (ws.kisiPencere || 0) > 60000) {
		ws.kisiPencere = simdi;
		ws.kisiAdet = 0;
	}
	if (++ws.kisiAdet > 60) {
		gonder(ws, { type: 'hata', message: 'Çok sık atma işlemi; biraz bekle.' });
		return false;
	}
	return true;
}

function kanalHizi(ws) {
	const simdi = Date.now();
	if (simdi - (ws.kanalPencere || 0) > 60000) {
		ws.kanalPencere = simdi;
		ws.kanalAdet = 0;
	}
	if (++ws.kanalAdet > 10) {
		gonder(ws, { type: 'hata', message: 'Çok sık kanal işlemi; biraz bekle.' });
		return false;
	}
	return true;
}

async function kanalEkleHandler(ws, m) {
	if (!ws.ad) return gonder(ws, { type: 'hata', message: 'Önce adını gir.' });
	const tur = m.tur === 'ses' ? 'ses' : m.tur === 'yazi' ? 'yazi' : '';
	if (!tur) return gonder(ws, { type: 'hata', message: 'Kanal türü yazılı (yazi) ya da sesli (ses) olmalı.' });
	const ad = String(m.ad ?? '')
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.trim()
		.replace(/\s+/g, ' ')
		.slice(0, 24);
	if (!ad) return gonder(ws, { type: 'hata', message: 'Kanal adı gerekli.' });
	if (kanallar.length >= EN_FAZLA_KANAL) return gonder(ws, { type: 'hata', message: `En fazla ${EN_FAZLA_KANAL} kanal olabilir.` });
	if (kanallar.some((k) => k.tur === tur && k.ad.toLocaleLowerCase('tr') === ad.toLocaleLowerCase('tr'))) {
		return gonder(ws, { type: 'hata', message: 'Bu adda bir kanal zaten var.' });
	}
	if (!kanalHizi(ws)) return;
	const id = benzersizKimlik(ad);
	try {
		await db.kanalEkle({ id, ad, tur });
	} catch (e) {
		console.error('[kanal] eklenemedi:', e.message);
		return gonder(ws, { type: 'hata', message: 'Kanal eklenemedi; tekrar dene.' });
	}
	kanallar.push({ id, ad, tur });
	console.log(`[kanal] ${ws.ad} → +${tur} "${ad}" (${id}); toplam ${kanallar.length}`);
	durumYayinla();
}

async function kanalSilHandler(ws, m) {
	if (!ws.ad) return gonder(ws, { type: 'hata', message: 'Önce adını gir.' });
	const id = String(m.kanal ?? '');
	const kanal = kanallar.find((k) => k.id === id);
	if (!kanal) return gonder(ws, { type: 'hata', message: 'Kanal bulunamadı.' });
	const ayniTur = kanallar.filter((k) => k.tur === kanal.tur).length;
	if (ayniTur <= 1) {
		return gonder(ws, { type: 'hata', message: `Son ${kanal.tur === 'ses' ? 'sesli' : 'yazılı'} kanal silinemez.` });
	}
	if (!kanalHizi(ws)) return;

	kanallar = kanallar.filter((k) => k.id !== id);
	// Sesli kanaldaysa içindekileri çıkar.
	const uyeler = sesliKanallar.get(id);
	if (uyeler) {
		for (const uye of uyeler.values()) {
			uye.sesKanal = null;
			gonder(uye, { type: 'ses-kapatildi', kanal: id });
		}
		sesliKanallar.delete(id);
	}
	try {
		const dosyalar = await db.kanalSil(id);
		for (const d of dosyalar) {
			dosyaOnbellek.delete(d);
			fs.promises.unlink(path.join(YUKLEME_KLASORU, d)).catch(() => {});
		}
	} catch (e) {
		console.error('[kanal] silinemedi:', e.message);
		return gonder(ws, { type: 'hata', message: 'Kanal silinemedi; tekrar dene.' });
	}
	console.log(`[kanal] ${ws.ad} → -${kanal.tur} "${kanal.ad}" (${id}); toplam ${kanallar.length}`);
	durumYayinla();
}

wss.on('connection', (ws, req) => {
	ws.ip = String((req && req.headers && req.headers['x-forwarded-for']) || '')
		.split(',')[0]
		.trim() || (req && req.socket ? req.socket.remoteAddress : '') || '';
	ws.ad = null;
	ws.sesKanal = null;
	ws.sessiz = false;
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
			case 'giris':
				girisYap(ws, m);
				break;
			case 'giris-karari':
				girisKarari(ws, m);
				break;
			case 'giris-iptal':
				if (ws.knockId) istekKapat(ws.knockId, false, null);
				break;
			case 'at':
				kisiAt(ws, m);
				break;
			case 'kisi-limiti':
				kisiLimitiAyarla(ws, m);
				break;
			case 'beyaz-liste':
				if (!ws.ad) return;
				db.kisiler()
					.then((kisiler) => gonder(ws, { type: 'beyaz-liste', kisiler, maxKullanici: maxKullanici }))
					.catch(() => gonder(ws, { type: 'hata', message: 'Beyaz liste okunamadı.' }));
				break;
			case 'yazi':
				yaziGonder(ws, m);
				break;
			case 'gecmis':
				gecmisGonder(ws, m);
				break;
			case 'yaziyor':
				if (ws.ad && yaziKanali(String(m.kanal ?? ''))) {
					herkes({ type: 'yaziyor', kanal: String(m.kanal), ad: ws.ad }, ws);
				}
				break;
			case 'ses-gir':
				sesGir(ws, m);
				break;
			case 'kanal-ekle':
				kanalEkleHandler(ws, m);
				break;
			case 'kanal-sil':
				kanalSilHandler(ws, m);
				break;
			case 'ses-cik':
				sesCikar(ws);
				durumYayinla();
				break;
			case 'sdp':
			case 'ice':
				sdpIlet(ws, m, m.type);
				break;
			case 'sessiz':
				if (!ws.ad) return;
				ws.sessiz = !!m.sessiz;
				herkes({ type: 'sessiz', ad: ws.ad, sessiz: ws.sessiz });
				durumYayinla();
				break;
			case 'ping':
				gonder(ws, { type: 'pong' });
				break;
		}
	});
	ws.on('close', () => {
		if (ws.knockId) istekKapat(ws.knockId, false, null);
		ayril(ws);
	});
	ws.on('error', () => {
		if (ws.knockId) istekKapat(ws.knockId, false, null);
		ayril(ws);
	});
});

// Kapıda bekleyen istekler 2 dakikada bir düşsün (kimse karar vermezse).
const kapiZamanlayici = setInterval(() => {
	const simdi = Date.now();
	for (const [id, b] of bekleyenler) {
		if (simdi - b.zaman < beklemeSuresi) continue;
		istekKapat(id, false, b.ad);
		gonder(b.ws, { type: 'giris-red', message: 'İstek zaman aşımına düştü; tekrar dene.' });
	}
}, 15000);

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

// ---------------------------------------------------------------- dosya paylaşımı

// Yalnızca bu türler tarayıcıda doğrudan gösterilir; geri kalanı indirme olarak sunulur.
// (HTML/SVG gibi betik çalıştırabilen türler asla satır içi gösterilmez.)
const SATIR_ICI = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	mp3: 'audio/mpeg',
	ogg: 'audio/ogg',
	oga: 'audio/ogg',
	m4a: 'audio/mp4',
	wav: 'audio/wav',
	mp4: 'video/mp4',
	webm: 'video/webm',
};

const uzanti = (ad) => (String(ad).split('.').pop() || '').toLowerCase();
const dosyaOnbellek = new Map(); // id -> kayıt (her dosya için veritabanına gitmemek adına)

function guvenliAd(ham) {
	return (
		String(ham)
			.replace(/[\u0000-\u001f\u007f]/g, '')
			.replace(/[\\/]/g, '_')
			.replace(/^\.+/, '')
			.trim()
			.slice(0, 120) || 'dosya'
	);
}

function bosAlan() {
	try {
		const s = fs.statfsSync(VERI_KLASORU);
		return s.bavail * s.bsize;
	} catch {
		return Number.MAX_SAFE_INTEGER;
	}
}

function govdeOku(req, sinir) {
	return new Promise((coz, red) => {
		const parcalar = [];
		let toplam = 0;
		req.on('data', (p) => {
			toplam += p.length;
			if (toplam > sinir) {
				red(Object.assign(new Error('Dosya çok büyük'), { kod: 413 }));
				req.destroy();
				return;
			}
			parcalar.push(p);
		});
		req.on('end', () => coz(Buffer.concat(parcalar)));
		req.on('error', red);
	});
}

function jsonYanit(res, kod, nesne) {
	yanit(res, kod, JSON.stringify(nesne) + '\n', { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

async function yukle(req, res, sorgu) {
	const jeton = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
	const sahibi = jetonlar.get(jeton);
	if (!sahibi || !sahibi.ad) return jsonYanit(res, 401, { hata: 'Oturum bulunamadı; sayfayı yenile.' });
	const kanal = String(sorgu.get('kanal') || '');
	if (!yaziKanali(kanal)) return jsonYanit(res, 400, { hata: 'Bilinmeyen kanal.' });
	const bildirilen = Number(req.headers['content-length'] || 0);
	if (bildirilen > DOSYA_SINIRI) return jsonYanit(res, 413, { hata: `Dosya çok büyük (en fazla ${DOSYA_MB} MB).` });
	if (bosAlan() < EN_AZ_BOS_ALAN) return jsonYanit(res, 507, { hata: 'Sunucuda boş yer kalmadı; dosya yüklenemiyor.' });

	let govde;
	try {
		govde = await govdeOku(req, DOSYA_SINIRI);
	} catch (e) {
		return jsonYanit(res, e.kod === 413 ? 413 : 400, { hata: e.kod === 413 ? `Dosya çok büyük (en fazla ${DOSYA_MB} MB).` : 'Dosya okunamadı.' });
	}
	if (!govde.length) return jsonYanit(res, 400, { hata: 'Boş dosya.' });

	let hamAd = 'dosya';
	try {
		hamAd = decodeURIComponent(String(req.headers['x-dosya-adi'] || 'dosya'));
	} catch {}
	const dosyaAd = guvenliAd(hamAd);
	const tur = SATIR_ICI[uzanti(dosyaAd)] || String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].slice(0, 100);
	const id = crypto.randomBytes(9).toString('hex');

	try {
		await fs.promises.writeFile(path.join(YUKLEME_KLASORU, id), govde, { mode: 0o600 });
		const kayit = { id, kanal, dosyaAd, boyut: govde.length, tur };
		await db.dosyaEkle(kayit);
		dosyaOnbellek.set(id, kayit);
		const mesaj = await db.mesajEkle({ kanal, ad: sahibi.ad, metin: '', dosya: kayit });
		herkes({ type: 'yazi', kanal, mesaj });
		console.log(`[dosya] ${sahibi.ad} → ${kanal}: ${dosyaAd} (${govde.length} bayt)`);
		jsonYanit(res, 200, { id, ad: dosyaAd, boyut: govde.length, mesaj });
	} catch (e) {
		console.error('[dosya] yüklenemedi:', e.message);
		// Yarım kalan dosya diskte kalmasın (kayıt veritabanına giremedi).
		fs.promises.unlink(path.join(YUKLEME_KLASORU, id)).catch(() => {});
		dosyaOnbellek.delete(id);
		jsonYanit(res, 500, { hata: 'Dosya kaydedilemedi.' });
	}
}

async function dosyaGonder(req, res, id) {
	let kayit = dosyaOnbellek.get(id);
	if (!kayit) {
		try {
			kayit = await db.dosyaGetir(id);
		} catch {}
		if (kayit) dosyaOnbellek.set(id, kayit);
	}
	if (!kayit) return yanit(res, 404, 'Dosya bulunamadı\n', { 'Content-Type': 'text/plain; charset=utf-8' });
	const tam = path.join(YUKLEME_KLASORU, kayit.id);
	let boyut;
	try {
		boyut = (await fs.promises.stat(tam)).size;
	} catch {
		return yanit(res, 404, 'Dosya bulunamadı\n', { 'Content-Type': 'text/plain; charset=utf-8' });
	}
	const satirIci = SATIR_ICI[uzanti(kayit.dosyaAd)];
	const basliklar = {
		'Content-Type': satirIci || 'application/octet-stream',
		'Content-Length': boyut,
		// İçerik değişmez (id başına tek dosya): uzun süre önbellekte kalabilir.
		'Cache-Control': 'private, max-age=31536000, immutable',
		'X-Content-Type-Options': 'nosniff',
		'Content-Security-Policy': "default-src 'none'; sandbox",
		'Content-Disposition': `${satirIci ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(kayit.dosyaAd)}`,
	};
	res.writeHead(200, { ...GUVENLIK_BASLIKLARI, ...basliklar });
	if (req.method === 'HEAD') return res.end();
	const akis = fs.createReadStream(tam);
	akis.on('error', () => res.destroy());
	akis.pipe(res);
}

// ---------------------------------------------------------------- HTTP

const sunucu = http.createServer((req, res) => {
	let url;
	let yol;
	try {
		url = new URL(req.url, 'http://x');
		yol = decodeURIComponent(url.pathname);
	} catch {
		return yanit(res, 400, 'Hatalı istek\n', { 'Content-Type': 'text/plain; charset=utf-8' });
	}

	if (req.method === 'POST' && yol === '/api/yukle') return yukle(req, res, url.searchParams).catch(() => jsonYanit(res, 500, { hata: 'Beklenmeyen hata.' }));
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		return yanit(res, 405, 'İzin yok\n', { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
	}
	if (yol === '/saglik') {
		const kisi = [...sesliKanallar.values()].reduce((t, u) => t + u.size, 0);
		const iyi = turnDurumu === 'çalışıyor' || turn === null;
		const govde = {
			durum: iyi ? 'tamam' : 'sorunlu',
			surum: SURUM,
			turn: turnDurumu,
			oda: sesliKanallar.size, // dolu sesli kanal sayısı
			kisi,
			cevrimici: kimler().length,
			kanal: kanallar.length,
			maxKullanici: maxKullanici,
			girisAralikMs: GIRIS_ARALIK_MS,
			veritabani: db ? 'açık' : 'kapalı',
		};
		const sayilar = db ? Promise.all([db.sayilar(), db.kisiSayisi()]) : Promise.resolve([{ mesaj: 0, dosya: 0 }, 0]);
		return sayilar.then(
			([s, kisiSayisi]) =>
				yanit(res, iyi ? 200 : 503, JSON.stringify({ ...govde, mesaj: s.mesaj, dosya: s.dosya, beyazListe: kisiSayisi }) + '\n', {
					'Content-Type': 'application/json; charset=utf-8',
					'Cache-Control': 'no-store',
				}),
			() =>
				yanit(res, iyi ? 200 : 503, JSON.stringify(govde) + '\n', {
					'Content-Type': 'application/json; charset=utf-8',
					'Cache-Control': 'no-store',
				}),
		);
	}
	if (yol === '/api/ice') {
		return yanit(res, 200, JSON.stringify(iceSunuculari(req)), {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
		});
	}
	if (yol.startsWith('/dosya/')) {
		const id = yol.slice('/dosya/'.length).replace(/\/$/, '');
		if (!/^[a-f0-9]{18}$/.test(id)) return yanit(res, 404, 'Bulunamadı\n', { 'Content-Type': 'text/plain; charset=utf-8' });
		return dosyaGonder(req, res, id).catch(() => yanit(res, 500, 'Dosya okunamadı\n', { 'Content-Type': 'text/plain; charset=utf-8' }));
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

async function kapat(sinyal) {
	if (kapaniyor) return;
	kapaniyor = true;
	console.log(`Kapanıyor (${sinyal}).`);
	clearInterval(nabiz);
	clearInterval(kapiZamanlayici);
	for (const ws of wss.clients) ws.close(1001, 'sunucu kapanıyor');
	sunucu.close();
	const bitir = async () => {
		try {
			await db?.kapat();
		} catch {}
		process.exit(0);
	};
	if (turn) {
		turn.once('exit', bitir);
		turn.kill('SIGTERM');
		setTimeout(bitir, 3000).unref();
	} else await bitir();
}
process.on('SIGTERM', () => kapat('SIGTERM'));
process.on('SIGINT', () => kapat('SIGINT'));

sunucu.on('error', (e) => {
	console.error(`HTTP ${HOST}:${PORT} açılamadı: ${e.message}`);
	process.exit(1);
});

async function main() {
	try {
		db = veritabani.ac(VERI_KLASORU);
		await db.hazir;
	} catch (e) {
		console.error('Veritabanı açılamadı: ' + e.message);
		process.exit(1);
	}
	try {
		kanallar = await db.kanallarGetir();
		if (!kanallar.length) {
			for (const k of VARSAYILAN_KANALLAR) await db.kanalEkle(k);
			kanallar = await db.kanallarGetir();
			console.log('[kanal] varsayılan kanallar oluşturuldu');
		}
		console.log(`[kanal] ${kanallar.length} kanal: ${kanallar.map((k) => k.id).join(', ')}`);
	} catch (e) {
		console.error('Kanallar yüklenemedi: ' + e.message);
		process.exit(1);
	}
	// Kişi limiti: DB'de kayıtlı değer varsa .env varsayılanını geçersiz kılar.
	try {
		const kayitli = await db.ayarOku('kisi_limiti');
		const n = Number(kayitli);
		if (Number.isInteger(n) && n >= MIN_KISI_LIMITI && n <= MAKS_KISI_LIMITI) maxKullanici = n;
	} catch (e) {
		console.error('[ayar] kişi limiti okunamadı: ' + e.message);
	}
	// Beyaz liste boşsa ilk (yönetici) anahtarı üret; kullanıcı dosyadan okuyup bağlantıyla girer.
	try {
		beyazListeSayisi = await db.kisiSayisi();
		if (!beyazListeSayisi) {
			const anahtar = ILK_ANAHTAR || crypto.randomBytes(ANAHTAR_BAYT).toString('hex');
			await db.kisiKaydet({ ad: YONETICI_ADI, anahtar, yonetici: 1 });
			beyazListeSayisi = 1;
			const dosya = path.join(VERI_KLASORU, 'ilk-anahtar.txt');
			const adres = SITE_ADRESI.replace(/\/$/, '');
			const metin =
				'Beyaz liste boştu; ilk anahtar oluşturuldu.\n\n' +
				`Kişi: ${YONETICI_ADI}\n` +
				`Anahtar: ${anahtar}\n` +
				`Giriş bağlantısı: ${adres}/#anahtar=${anahtar}\n\n` +
				'Bağlantıyı bir kez aç: anahtar tarayıcına yazılır ve bir daha sormaz.\n' +
				'Bu dosyayı kaydettikten sonra silebilirsin.\n';
			await fs.promises.writeFile(dosya, metin, { mode: 0o600 });
			console.log(`[beyaz liste] ilk anahtar oluşturuldu (${YONETICI_ADI}) → ${dosya}`);
		}
	} catch (e) {
		console.error('Beyaz liste hazırlanamadı: ' + e.message);
		process.exit(1);
	}
	try {
		await fs.promises.mkdir(YUKLEME_KLASORU, { recursive: true });
	} catch (e) {
		console.error('Yükleme klasörü açılamadı: ' + e.message);
		process.exit(1);
	}

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
		console.log(
			`Ses Kanalı çalışıyor: http://${HOST}:${PORT}  sürüm ${SURUM}, sesli kanal başına en fazla ${MAX_KISI} kişi, ` +
				`dosya sınırı ${DOSYA_MB} MB, veri ${VERI_KLASORU}, ${turnBilgi}`,
		);
	});
}

main();
