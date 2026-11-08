// Diszort sunucusu — Discord'umsu tek sunucu: yazılı kanallar + sesli kanallar.
//   - web sayfasını sunar (web/),
//   - /rtc WebSocket'inde yazılı sohbeti iletir ve kaydeder (SQLite), sesli kanallar için
//     WebRTC signaling yapar (mesh: ses, ekran ve müzik paylaşımı tarayıcılar arasında P2P akar),
//   - dosya paylaşımında yalnızca aracıdır: dosya paylaşanın tarayıcısında kalır, isteyen onu
//     doğrudan (WebRTC veri kanalıyla) alır; sunucu yalnızca sohbetteki kaydı (ad, boyut) tutar ve
//     iki tarayıcıyı tanıştırır. Eski sürümün yüklediği dosyalar /dosya/<id> ile sunulmaya devam eder,
//   - coturn'ü (STUN/TURN) başlatıp izler ve tarayıcılara geçici TURN şifresi verir (/api/ice).
//
// Yalnızca yazılı kanallar diske yazılır; ses/görüntü ve dosyaların içeriği sunucuya hiç gelmez.
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
// Bulut meta veri sunucusundan dış IP (GCP: metadata.google.internal). Yoksa boş döner.
function disIpBul() {
	return new Promise((coz) => {
		let bitti = false;
		const bitir = (deger) => {
			if (bitti) return;
			bitti = true;
			coz(deger || '');
		};
		try {
			const istek = http.get(
				{
					host: 'metadata.google.internal',
					path: '/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip',
					headers: { 'Metadata-Flavor': 'Google' },
					timeout: 1500,
				},
				(yanit) => {
					let veri = '';
					yanit.on('data', (d) => (veri += d));
					yanit.on('end', () => bitir(ipv4mu(veri.trim()) ? veri.trim() : ''));
				},
			);
			istek.on('timeout', () => {
				istek.destroy();
				bitir('');
			});
			istek.on('error', () => bitir(''));
		} catch {
			bitir('');
		}
	});
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
// Giriş freni: TÜM giriş denemeleri sunucu genelinde (tüm bağlantılar, tüm kişiler) tek bir
// jeton kovasından düşer: kova her GIRIS_ARALIK_MS'de 1 dolar, en fazla GIRIS_KOVA jeton birikir.
// Varsayılan GIRIS_KOVA=1: art arda iki deneme arasında en az GIRIS_ARALIK_MS (10 saniyede 1).
// İlk deneme, yeni bağlantı, geçerli anahtar ayrımı YOKTUR. Yalnızca sunucu tarafında uygulanır;
// istemci kodu değiştirilerek aşılamaz. Reddedilen istemci söylenen süre kadar bekleyip kendiliğinden
// yeniden dener (sunucu yeniden başlayınca içeridekiler 10'ar saniye arayla döner; P2P ses bu arada
// sürer). Testler için (ya da yeniden başlatmada herkes beklemeden dönsün istenirse) arttırılabilir:
// GIRIS_KOVA=N ise N deneme birikebilir.
const GIRIS_ARALIK_MS = sayiAyar('GIRIS_ARALIK_MS', 10000, 0, 600000);
const GIRIS_KOVA = sayiAyar('GIRIS_KOVA', 1, 1, 100);
let girisJetonu = GIRIS_KOVA; // açılışta kova dolu
let girisDolumZamani = Date.now();
// Sesli kanaldayken bağlantısı beklenmedik şekilde kopan kişinin yeri bu süre kadar "askıda" tutulur.
// Aynı kişi bu sürede geri bağlanıp kanala devam ederse diğerlerine çıktı/girdi denmez: P2P ses
// sunucudan geçmediği için konuşma hiç kesilmeden sürer (ağ değişimi, sunucu güncellemesi, telefonun
// siteyi arka planda bir süre uyutması).
const SES_ASKI_MS = sayiAyar('SES_ASKI_MS', 60000, 0, 300000);
const ILK_ANAHTAR = ayar('ILK_ANAHTAR'); // test/kurulum için sabit ilk anahtar (üretimde boş bırak)
const SITE_ADRESI = ayar('SITE_ADRESI', 'https://chat.tahagemici.com'); // ilk anahtar bağlantısında kullanılır
// Ses teşhisi: istemciler 10 saniyede bir kendi ses durumlarını gönderir, sunucu YALNIZCA günlüğe
// yazar (kimseye dağıtılmaz, veritabanına yazılmaz). Sorun bildirildiğinde cihazın ne gördüğünü
// okumak için. Kapatmak: .env'de TANI=0
const TANI = ayar('TANI', '1') !== '0';
const TURN_PORT = sayiAyar('TURN_PORT', 3478, 1, 65535);
const RELAY_MIN_PORT = sayiAyar('RELAY_MIN_PORT', 49152, 1024, 65535);
const RELAY_MAX_PORT = sayiAyar('RELAY_MAX_PORT', 61000, RELAY_MIN_PORT, 65535);
// Dış IP: .env'deki DIS_IP varsa o kullanılır; yoksa GCP meta veri sunucusundan okunur.
// (Bulut sunucusunun geçici IP'si değişebilir; sabit yazılırsa STUN/TURN sessizce ölür →
// tarayıcı STUN'a ulaşamaz, relay adayı hiç oluşmaz, ses bağlantısı kurulmaz.)
const DIS_IP_ELLE = !!ayar('DIS_IP'); // .env'de sabitlenmişse meta veriye dokunulmaz
let disIp = ayar('DIS_IP') || '';
const IC_IP = ayar('IC_IP') || icIpBul();
let turnAdresi = ayar('TURN_ADRESI') || ''; // tarayıcıya verilen STUN/TURN adresi (boşsa sayfanın adresi)
// Yasaklı iç ağ aralıklarından yine de aktarım yapılabilecek adresler (virgülle; "a.b.c.d" ya da
// "a.b.c.d-e.f.g.h"). Yalnızca özel kurulumlar ve otomatik denemeler için (ör. CI makinesinin 10.x IP'si).
const TURN_IZINLI_IP = ayar('TURN_IZINLI_IP')
	.split(',')
	.map((x) => x.trim())
	.filter(Boolean);
const SURUM = surumBul();
const VERI_KLASORU = ayar('VERI_KLASORU') || (fs.existsSync('/veri') ? '/veri' : path.join(KOK, 'veri'));
// Eski sürümün sunucuya yüklediği dosyalar (yeni dosyalar P2P paylaşılır, buraya yazılmaz).
const YUKLEME_KLASORU = path.join(VERI_KLASORU, 'yuklemeler');

if (ILK_ANAHTAR && !ANAHTAR_KALIBI.test(ILK_ANAHTAR)) {
	console.error(`Ayar hatası: ILK_ANAHTAR ${ANAHTAR_UZUNLUK} karakterlik hex olmalı (512 bit) ya da boş bırakılmalı.`);
	process.exit(1);
}

for (const [ad, deger] of [['DIS_IP', disIp], ['IC_IP', IC_IP]]) {
	if (deger && !ipv4mu(deger)) {
		console.error(`Ayar hatası: ${ad}=${deger} bir IPv4 adresi değil (${AYAR_DOSYASI})`);
		process.exit(1);
	}
}
for (const aralik of TURN_IZINLI_IP) {
	if (!aralik.split('-').every(ipv4mu) || aralik.split('-').length > 2) {
		console.error(`Ayar hatası: TURN_IZINLI_IP içinde "${aralik}" bir IPv4 adresi ya da "a-b" aralığı değil (${AYAR_DOSYASI})`);
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
// Bu açılışın TURN "nesli" (sırrın kendisi değil, rastgele bir etiket). İstemci yeniden bağlanınca
// değiştiğini görürse coturn yeniden başlamıştır: TURN üzerinden akan bağlantıları ölmelerini
// beklemeden taze şifreyle hemen yeniler.
const TURN_NESLI = crypto.randomBytes(6).toString('hex');

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
	// camera=() bilerek yazılmadı: Chrome ekran paylaşımında (getDisplayMedia) kamera kuralına da
	// bakıyor ve her paylaşımda "Permissions policy violation: camera" hatası basıyor. Kamera hiç istenmez.
	'Permissions-Policy': 'microphone=(self), display-capture=(self), geolocation=()',
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
		disIp && IC_IP && disIp !== IC_IP ? `external-ip=${disIp}/${IC_IP}` : null,
		`min-port=${RELAY_MIN_PORT}`,
		`max-port=${RELAY_MAX_PORT}`,
		'fingerprint',
		'use-auth-secret',
		`static-auth-secret=${TURN_SIRRI}`,
		'realm=diszort',
		// Kötüye kullanıma karşı: kullanıcı başına ve toplam aktarım sayısı, aktarım başına bant genişliği.
		// Bir kişinin sesli kanaldaki her eşi ve her dosya aktarımı (UDP + TCP yedeği) birer aktarım
		// açabildiği için kullanıcı başına 64.
		'user-quota=64',
		'total-quota=640',
		// Aktarım (relay) başına bant genişliği sınırı. Birimi BAYT/saniye (coturn: "bytes per second",
		// gelen ve giden ayrı sayılır): 512000 B/s ≈ 4 Mbit/s. Ses (~100 kbit/s) ve ekran paylaşımı
		// (≤ 2,5 Mbit/s) için yeterli; doğrudan bağlanamayan iki kişi arasındaki dosya aktarımı bu
		// yüzden ~0,5 MB/sn ile sınırlı kalır (sunucunun bant genişliği korunur).
		'max-bps=512000',
		'stale-nonce=600',
		'no-cli',
		'no-tls',
		'no-dtls',
		'no-tcp-relay',
		'no-multicast-peers',
		'no-software-attribute',
		// Sunucunun iç ağına ve kendisine aktarım yapılmasın. ANCAK 192.168/16 (ev ağı) ve
		// 100.64/10 (CGNAT) BİLEREK AÇIK: aynı ev ağındaki iki kişi ya da operatörü CGNAT kullanan
		// telefon, aksi halde TURN üzerinden ses alamıyor ("peer IP denied" → tek yönlü ses ya da
		// bağlantı hiç kurulmuyor). GCP'nin iç ağı 10.x olduğu için 10/8 kapalı kalıyor.
		'denied-peer-ip=0.0.0.0-0.255.255.255',
		'denied-peer-ip=10.0.0.0-10.255.255.255',
		'denied-peer-ip=127.0.0.0-127.255.255.255',
		'denied-peer-ip=169.254.0.0-169.254.255.255',
		'denied-peer-ip=172.16.0.0-172.31.255.255',
		'denied-peer-ip=192.0.0.0-192.0.0.255',
		'denied-peer-ip=198.18.0.0-198.19.255.255',
		'denied-peer-ip=::1',
		'denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
		'denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
		...TURN_IZINLI_IP.map((ip) => `allowed-peer-ip=${ip}`),
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

// STUN/TURN adresleri + bir günlük geçici TURN şifresi. YALNIZCA içeridekilere (beyaz listedekilere)
// verilir: 'hazir' ve 'ses-girdi' mesajlarında, ya da jetonla /api/ice'tan. Şifre dışarıya açık olsaydı
// herkes sunucuyu ücretsiz aktarıcı (relay) olarak kullanabilirdi.
// Not: TURN sırrı her açılışta yeniden üretilir; istemci her bağlanışta taze şifre alır (eskiden
// sayfanın ilk açılışında aldığı şifreyi saklıyordu → her güncellemeden sonra TURN'e ihtiyaç duyan
// kişiler sayfayı yenileyene kadar bağlanamıyordu).
function iceSunuculari(host) {
	if (turnDurumu !== 'çalışıyor') return { iceServers: [] };
	let adres = turnAdresi;
	if (!adres) {
		// Dış IP ayarlanmadıysa tarayıcı sayfayı hangi adresten açtıysa onu kullanır.
		host = String(host || '');
		adres = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
	}
	if (adres.includes(':') && !adres.startsWith('[')) adres = `[${adres}]`;
	const kullanici = `${Math.floor(Date.now() / 1000) + TURN_SURESI}:${crypto.randomBytes(6).toString('hex')}`;
	const sifre = crypto.createHmac('sha1', TURN_SIRRI).update(kullanici).digest('base64');
	return {
		iceServers: [
			{ urls: [`stun:${adres}:${TURN_PORT}`] },
			// UDP önce; UDP'nin kapalı olduğu ağlar (bazı okul/iş/otel ağları) için aynı portta TCP yedeği.
			{ urls: [`turn:${adres}:${TURN_PORT}?transport=udp`, `turn:${adres}:${TURN_PORT}?transport=tcp`], username: kullanici, credential: sifre },
		],
		gecerlilik: TURN_SURESI,
	};
}

// ---------------------------------------------------------------- signaling + sohbet (/rtc)
//
// WebSocket protokolü (JSON). İstemci -> sunucu:
//   {type:'giris', ad, id, anahtar, ses}       anahtar geçerliyse doğrudan girer, yoksa kapıyı çalar
//                                              (bekleniyor). Sunucu geneli giriş freni: giris-red
//                                              {kod:'fren', bekle}. ses: yeniden bağlanırken sürdürülecek
//                                              sesli kanal (askıdaki yer korunur)
//   {type:'giris-karari', id, kabul}           içerideki biri isteği kabul/red eder (kabulde anahtar üretilir)
//   {type:'giris-iptal'}                       kapıyı çalan isteğini geri çeker
//   {type:'at', ad}                            kişiyi beyaz listeden atar (anahtarı iptal, bağlantısı düşer)
//   {type:'beyaz-liste'}                       beyaz listeyi ister
//   {type:'kisi-limiti', deger}                beyaz liste sınırı (2–50; veritabanına yazılır)
//   {type:'yazi', kanal, metin}                yazılı kanala mesaj (kişi başı 10 sn'de 12)
//   {type:'gecmis', kanal, once}               son 50 mesaj; once verilirse ondan eskiler
//   {type:'yaziyor', kanal}                    "yazıyor" göstergesi
//   {type:'ses-gir', kanal, devam, sessiz, sagir, ekran, yayinSes, yayinBaslik} / {type:'ses-cik'}
//                                              sesli kanala gir/çık (devam: eş bağlantıları ayakta;
//                                              ekran/yayinSes: süren yayın, yeniden bağlanınca)
//   {type:'kanal-ekle', tur, ad} / {type:'kanal-sil', kanal}   tur: 'yazi' | 'ses'
//   {type:'sdp', to, sdp, oturum} / {type:'ice', to, ice, oturum}
//                                              WebRTC (aynı sesli kanaldaki kişiye). oturum: eş
//                                              bağlantısının kimliği (eskisine ait yanıt/aday ayıklanır)
//   {type:'yenile', to, oturum}                yanıtlayan: "bağlantımız bozuk" → teklif eden ICE'yi
//                                              yeniler ya da baştan kurar
//   {type:'sessiz', sessiz, sagir}             mikrofon kapalı / sağırlaştırılmış mı
//   {type:'yayin', ekran, ses, baslik}         ekranını / sesini (bilgisayar sesi, müzik) paylaşıyor mu;
//                                              baslik: çalan parçanın adı. Akışlar P2P gider.
//   {type:'izle', to, izle}                    yayını izle / kapat (aynı sesli kanaldaki yayıncıya;
//                                              kapatana görüntü ve yayın sesi gönderilmez)
//   {type:'dosya-paylas', kanal, id, ad, boyut, tur}
//                                              P2P dosya: sohbete kaydı yazılır, dosya gönderende kalır.
//                                              id: istemcinin ürettiği 24 hex
//   {type:'dosya-sun', idler}                  bu bağlantının şu an sunduğu dosyalar (yeniden bağlanınca);
//                                              yalnızca kendi paylaştıkları geçerli sayılır
//   {type:'dosya-sinyal', to, veri}            P2P dosya aktarımı için WebRTC tanışması (herhangi bir
//                                              çevrimiçi kişiye; veri sunucuda yorumlanmaz)
//   {type:'sunucu-bilgi'}                      veritabanı boyutu, mesaj/dosya sayısı
//   {type:'sohbet-temizle', kanal, gun}        mesajları sil ('' = tüm kanallar; gun: 0 = hepsi, yoksa
//                                              o kadar günden eskiler). Beyaz liste, kanallar, ayarlar kalır
//   {type:'ice-iste'}                          taze STUN/TURN şifresi (ice-sunuculari döner)
//   {type:'tani', veri}                        ses teşhisi (yalnızca günlüğe yazılır; TANI=0 kapatır)
//   {type:'ping'}                              canlılık yoklaması (pong döner)
// Sunucu -> istemci:
//   {type:'hazir', ad, kanallar, kimler, beyazListeAdlari, max, jeton, ice, surum, turnNesli,
//    girisAralikMs, girisKova, sunulanDosyalar, anahtar?}
//                                              giriş kabul edildi (anahtar yalnızca yeni verilince). surum
//                                              değişirse sekme kendini yeniler; turnNesli değişirse
//                                              coturn yeniden başlamıştır (TURN bağlantıları yenilenir)
//   {type:'bekleniyor', ad, anahtarGecersiz}   kapıyı çaldın, karar bekleniyor
//   {type:'giris-red', message, kod, bekle?}   kod: fren, anahtar, ad, ad-kullaniliyor, dolu, kimse-yok,
//                                              reddedildi, cok-istek, zaman-asimi
//   {type:'giris-istegi', id, ad, kayitli} / {type:'istek-kapandi', id, kabul}
//                                              içeridekilere onay isteği ve sonucu (kayitli: ad zaten
//                                              beyaz listede)
//   {type:'atildi', message}                   beyaz listeden atıldın
//   {type:'oturum-devralindi', message}        aynı anahtar başka sekmede açıldı (bu sekme durur)
//   {type:'beyaz-liste', kisiler, maxKullanici}
//   {type:'kanallar', kanallar} / {type:'kimler', kimler, beyazListe, beyazListeAdlari, maxKullanici}
//                                              (kanallar'da bağlantısı kopan kişi askida:true, yayın
//                                              yapan ekran/yayinSes/yayinBaslik ile görünür)
//   {type:'yazi', kanal, mesaj} / {type:'gecmis', kanal, mesajlar, bitti}
//                                              mesaj.dosya.p2p: dosya paylaşanın tarayıcısında
//   {type:'yaziyor', kanal, ad} / {type:'sessiz', ad, sessiz, sagir}
//   {type:'ses-girdi', kanal, kisiler, ice, devam} / {type:'ses-kisi-girdi', kanal, ad, devam} /
//   {type:'ses-kisi-cikti', kanal, ad} / {type:'ses-kapatildi', kanal}
//   {type:'sdp', from, sdp, oturum} / {type:'ice', from, ice, oturum} / {type:'yenile', from, oturum}
//   {type:'izle', from, izle}
//   {type:'dosya-durum', sunulan}              şu an çevrimiçi biri tarafından sunulan dosya id'leri
//   {type:'dosya-sun', idler}                  dosya-sun yanıtı: geçerli sayılanlar (gerisi bırakılır)
//   {type:'dosya-sinyal', from, veri}          (hedef çevrimiçi değilse from: hedef, veri.tur:'ulasilamadi')
//   {type:'sunucu-bilgi', veritabani, mesaj, dosya, yuklemeler, yuklemeAdet, bosAlan, surum}
//                                              boyutlar bayt; yuklemeler: eski sürümün sunucudaki dosyaları
//   {type:'sohbet-temizlendi', kanal, gun, ad, silinen}
//   {type:'ice-sunuculari', ice}
//   {type:'hata', message, kod?}               kod: ses-dolu, ses-kanal-yok, ...
//   {type:'pong'}
// Her çiftte teklifi adı alfabetik olarak büyük olan yapar (çakışma olmaz). Adlar sunucu genelinde benzersiz.

const sesliKanallar = new Map(); // kanal id -> Map<ad, ws>  (bağlantısı kopan kişi kısa süre askıda kalır)
const jetonlar = new Map(); // yükleme jetonu -> ws
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
let db = null;

function gonder(ws, nesne) {
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(nesne));
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
		if (k.tur === 'ses') {
			o.kisiler = [...(sesliKanallar.get(k.id) || new Map()).entries()].map(([ad, ws]) => {
				const kisi = { ad, sessiz: !!ws.sessiz, sagir: !!ws.sagir };
				if (ws.askida) kisi.askida = true; // bağlantısı koptu, geri dönmesi bekleniyor
				if (ws.ekran) kisi.ekran = true; // ekranını paylaşıyor
				if (ws.yayinSes) kisi.yayinSes = true; // bilgisayar sesini / müzik paylaşıyor
				if (ws.yayinBaslik) kisi.yayinBaslik = ws.yayinBaslik;
				return kisi;
			});
		}
		return o;
	});
}
let beyazListeSayisi = 0; // son bilinen beyaz liste boyutu (yanıtlarda gösterilir)
let beyazListeAdlari = []; // beyaz listedeki adlar (çevrimdışı olanlar da arayüzde görünsün)

// Beyaz listeyi diskten tazele: adlar + boyut, sonra herkese duyur.
// Dönüşü beklemeden çağrılabilir; hata sunucuyu düşürmesin.
function beyazListeTazele(yayinla = true) {
	return db
		.kisiler()
		.then((satirlar) => {
			beyazListeAdlari = satirlar.map((s) => s.ad);
			beyazListeSayisi = beyazListeAdlari.length;
			if (yayinla) durumYayinla();
		})
		.catch((e) => console.error('[beyaz liste] adlar okunamadı:', e.message));
}

function kimler() {
	const liste = [];
	for (const ws of wss.clients) {
		if (ws.ad) liste.push({ ad: ws.ad, sessiz: !!ws.sessiz, sagir: !!ws.sagir, ses: ws.sesKanal || null });
	}
	return liste.sort((a, b) => a.ad.localeCompare(b.ad, 'tr'));
}
// Kim girdi/çıktı, hangi sesli kanalda kim var: herkese tek seferde.
function durumYayinla() {
	const kanallar = kanalDurumu();
	const kim = kimler();
	for (const ws of wss.clients) {
		if (!ws.ad) continue;
		gonder(ws, { type: 'kanallar', kanallar });
		gonder(ws, { type: 'kimler', kimler: kim, beyazListe: beyazListeSayisi, beyazListeAdlari, maxKullanici: maxKullanici });
	}
}

function yayinBitir(ws) {
	ws.ekran = false;
	ws.yayinSes = false;
	ws.yayinBaslik = '';
}

// Sesli kanaldan kalıcı olarak çıkar (kendi isteğiyle, kanal değiştirince ya da askı süresi dolunca).
function koltukBirak(kanal, ad, ws) {
	const uyeler = sesliKanallar.get(kanal);
	if (!uyeler || uyeler.get(ad) !== ws) return false;
	clearTimeout(ws.askiZamani);
	ws.askida = false;
	yayinBitir(ws);
	uyeler.delete(ad);
	if (!uyeler.size) sesliKanallar.delete(kanal);
	else kanalHerkes(kanal, { type: 'ses-kisi-cikti', kanal, ad });
	return true;
}

function sesCikar(ws) {
	const kanal = ws.sesKanal;
	if (!kanal) return;
	ws.sesKanal = null;
	yayinBitir(ws);
	if (ws.ad && koltukBirak(kanal, ws.ad, ws)) console.log(`[ses] ${kanal}: ${ws.ad} çıktı`);
}

// Bağlantısı kopan kişinin sesli kanal yeri hemen boşaltılmaz: SES_ASKI_MS boyunca askıda kalır.
// Kişi bu sürede geri bağlanıp {type:'ses-gir', devam:true} derse yerine oturur (bkz. sesGir).
function sesAskiyaAl(ws) {
	const kanal = ws.sesKanal;
	const ad = ws.ad;
	const uyeler = kanal && sesliKanallar.get(kanal);
	if (!uyeler || uyeler.get(ad) !== ws) return;
	if (!SES_ASKI_MS) {
		sesCikar(ws);
		return;
	}
	ws.askida = true;
	clearTimeout(ws.askiZamani);
	ws.askiZamani = setTimeout(() => {
		if (koltukBirak(kanal, ad, ws)) {
			console.log(`[ses] ${kanal}: ${ad} geri dönmedi, çıkarıldı`);
			durumYayinla();
		}
	}, SES_ASKI_MS);
	ws.askiZamani.unref?.();
	console.log(`[ses] ${kanal}: ${ad} bağlantısı koptu, ${Math.round(SES_ASKI_MS / 1000)} sn askıda`);
}

// Bu adın askıdaki sesli kanal yeri (varsa): { kanal, ws }.
function askidakiKoltuk(ad) {
	for (const [kanal, uyeler] of sesliKanallar) {
		const ws = uyeler.get(ad);
		if (ws && ws.askida) return { kanal, ws };
	}
	return null;
}

// Bağlantı kapanınca adı bırak. Sesli kanaldaysa yeri askıya alınır (ses P2P olduğu için konuşma
// bu sürede kesilmeyebilir); kendi isteğiyle çıkan zaten 'ses-cik' göndermiştir.
function ayril(ws) {
	if (!ws.ad) {
		ws.sesKanal = null;
		return;
	}
	if (ws.sesKanal) sesAskiyaAl(ws);
	ws.ad = null;
	if (ws.jeton) jetonlar.delete(ws.jeton);
	// Sunduğu dosyalar artık alınamaz (aynı sekme geri gelince yeniden bildirir).
	if (ws.sunulan && ws.sunulan.size) {
		ws.sunulan = new Set();
		sunulanDegisti();
	}
	durumYayinla();
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

// Aynı adın başka bir bağlantısı oturumu bırakır. Başka sekme/cihazsa ona haber verilir ve o sekme
// kendiliğinden yeniden bağlanmaz ("Bu sekmede devam et" düğmesi çıkar); aynı sekme yeniden
// bağlandıysa eski bağlantı sessizce kapatılır. Sesli kanal yeri askıya alınır: yeni bağlantı
// 'ses-gir {devam:true}' derse ses kesilmeden sürer.
function eskiOturumuKapat(eski, yeniKimlik) {
	const ayniSekme = !!yeniKimlik && eski.kimlik === yeniKimlik;
	ayril(eski);
	if (!ayniSekme) gonder(eski, { type: 'oturum-devralindi', message: 'Bu hesapla başka bir sekmede ya da cihazda girildi.' });
	setTimeout(() => eski.terminate(), ayniSekme ? 0 : 300);
}

function oturumAc(ws, ad, kimlik, anahtar, sesDevam) {
	// Aynı adla açık başka bir bağlantı varsa (sekme yenilendi / yeniden onaylandı) onu düşür.
	const eski = adSahibi(ad);
	if (eski && eski !== ws) eskiOturumuKapat(eski, kimlik);
	if (ws.jeton) jetonlar.delete(ws.jeton);
	ws.ad = ad;
	ws.kimlik = kimlik || '';
	ws.jeton = crypto.randomBytes(16).toString('hex');
	ws.yaziPencere = 0;
	ws.yaziAdet = 0;
	ws.sessiz = false;
	ws.sagir = false;
	yayinBitir(ws);
	ws.sunulan = new Set(); // istemci 'dosya-sun' ile bildirir
	ws.dosyaKuyruk = Promise.resolve(); // dosya-paylas / dosya-sun sırayla işlensin
	jetonlar.set(ws.jeton, ws);
	// Askıdaki sesli kanal yeri: istemci o kanala devam etmeyecekse hemen bırak (diğerleri boşuna beklemesin).
	const askida = askidakiKoltuk(ad);
	if (askida && askida.kanal !== sesDevam && koltukBirak(askida.kanal, ad, askida.ws)) {
		console.log(`[ses] ${askida.kanal}: ${ad} geri döndü ama kanala devam etmedi`);
	}
	gonder(ws, {
		type: 'hazir',
		ad,
		kanallar: kanalDurumu(),
		kimler: kimler(),
		max: MAX_KISI,
		maxKullanici: maxKullanici,
		beyazListe: beyazListeSayisi,
		beyazListeAdlari,
		sunulanDosyalar: sunulanListesi(),
		jeton: ws.jeton,
		anahtar: anahtar || undefined,
		ice: iceSunuculari(ws.host),
		turnNesli: TURN_NESLI,
		// İstemci, sunucu yeniden başladıktan sonra henüz dönmemiş eşleri ne kadar bekleyeceğini
		// giriş frenine göre hesaplar (fren sıkıysa son kişi dakikalar sonra dönebilir).
		girisAralikMs: GIRIS_ARALIK_MS,
		girisKova: GIRIS_KOVA,
		surum: SURUM, // istemci sürüm değişince (güncelleme) sayfayı yeniler
	});
	// Bu kişi bağlı değilken kapıyı çalanlar da ona sorulsun (yeni gelen ya da bağlantısı kopup dönen).
	for (const [id, b] of bekleyenler) {
		if (b.ws !== ws && !b.karar) gonder(ws, { type: 'giris-istegi', id, ad: b.ad, kayitli: !!b.kayitli });
	}
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

function girisRed(ws, message, kod, ek) {
	gonder(ws, { type: 'giris-red', message, kod, ...ek });
}

async function kapiCal(ws, ad, anahtarGecersiz) {
	let kisiSayisi = 0;
	let kayitli = false;
	try {
		kisiSayisi = await db.kisiSayisi();
		kayitli = !!(await db.kisiAd(ad));
	} catch {}
	if (ws.readyState !== WebSocket.OPEN) return;
	if (kisiSayisi >= maxKullanici && !kayitli) {
		return girisRed(ws, `Sunucu dolu (en fazla ${maxKullanici} kişi).`, 'dolu');
	}
	const cevrimici = [...wss.clients].filter((x) => x.ad);
	if (!cevrimici.length) {
		return girisRed(ws, 'Şu an içeride kimse yok; biraz sonra tekrar dene.', 'kimse-yok');
	}
	// Aynı IP'den istek yağmasın: aynı anda en fazla 3 bekleyen, dakikada en fazla 600 deneme.
	// (Aynı ev/NAT arkasındaki birkaç kişi birbirini engellemesin diye pencere geniş tutuldu.)
	const ip = ws.ip || '';
	if (ip) {
		const ayniIp = [...bekleyenler.values()].filter((b) => b.ip === ip);
		if (ayniIp.length >= 3) return girisRed(ws, 'Çok fazla istek; biraz bekle.', 'cok-istek');
		const simdi = Date.now();
		const kayit = kapiDenemeleri.get(ip) || { baslangic: simdi, adet: 0 };
		if (simdi - kayit.baslangic > 60000) {
			kayit.baslangic = simdi;
			kayit.adet = 0;
		}
		// Dakikada 600 deneme: insan trafiği için bol, otomatik flood için sınır.
		if (++kayit.adet > 600) {
			kapiDenemeleri.set(ip, kayit);
			return girisRed(ws, 'Çok fazla giriş denemesi; bir dakika bekle.', 'cok-istek');
		}
		kapiDenemeleri.set(ip, kayit);
	}
	// Aynı ad için eski bekleyen isteği düşür.
	for (const [id, b] of bekleyenler) if (b.ad === ad) istekKapat(id, false, ad);

	const id = crypto.randomBytes(6).toString('hex');
	// kayitli: bu ad zaten beyaz listede (yeni cihaz ya da adı taklit eden biri). Kabul edilirse
	// eski anahtar iptal olur; içeridekilere bu yüzden ayrıca gösterilir.
	bekleyenler.set(id, { ad, ip, zaman: Date.now(), ws, kimlik: ws.kimlik || '', kayitli });
	ws.knockId = id;
	gonder(ws, { type: 'bekleniyor', ad, anahtarGecersiz: !!anahtarGecersiz });
	for (const x of cevrimici) gonder(x, { type: 'giris-istegi', id, ad, kayitli });
	console.log(`[kapı] ${ad} izin istiyor (${cevrimici.length} kişiye soruldu${anahtarGecersiz ? ', anahtar geçersiz' : ''}${kayitli ? ', ad kayıtlı' : ''})`);
}

// Giriş freni (jeton kovası, sunucu geneli): her deneme bir jeton harcar; kova GIRIS_ARALIK_MS'de
// bir dolar. Bekleme sunucuda tutulmaz: jeton yoksa istek hemen reddedilir ve ne kadar beklenmesi
// gerektiği söylenir (istemci o kadar bekleyip kendiliğinden yeniden dener).
// Dönüş: 0 = geçebilir (jeton harcandı), >0 = beklenecek ms.
function girisFreni(simdi) {
	if (!GIRIS_ARALIK_MS) return 0;
	girisJetonu = Math.min(GIRIS_KOVA, girisJetonu + (simdi - girisDolumZamani) / GIRIS_ARALIK_MS);
	girisDolumZamani = simdi;
	if (girisJetonu >= 1) {
		girisJetonu -= 1;
		return 0;
	}
	return Math.max(1, Math.ceil((1 - girisJetonu) * GIRIS_ARALIK_MS));
}

async function girisYap(ws, m) {
	const ad = temizAd(m.ad);
	const kimlik = String(m.id ?? '').slice(0, 64);
	const anahtar = String(m.anahtar ?? '').trim().slice(0, ANAHTAR_UZUNLUK);
	const sesDevam = typeof m.ses === 'string' ? m.ses.slice(0, 40) : '';
	ws.kimlik = kimlik;

	// Önce fren: DB'ye bile gitmeden reddedilir.
	const kalan = girisFreni(Date.now());
	if (kalan > 0) {
		return girisRed(ws, `Çok sık deneme; ${Math.ceil(kalan / 1000)} saniye sonra tekrar dene.`, 'fren', { bekle: kalan });
	}

	// 1) Geçerli anahtar → doğrudan giriş (ad, anahtarın sahibinden gelir).
	// Yalnızca 512 bit (128 hex) anahtarlar sorgulanır; eski biçimdeki anahtarlar geçersizdir.
	if (anahtar && ANAHTAR_KALIBI.test(anahtar)) {
		let kisi = null;
		try {
			kisi = await db.kisiAnahtarla(anahtar);
		} catch (e) {
			console.error('[beyaz liste] anahtar okunamadı:', e.message);
		}
		if (ws.readyState !== WebSocket.OPEN) return;
		if (kisi) {
			// Aynı anahtar başka bir bağlantıda açıksa son giren kazanır (oturumAc eskisini kapatır).
			// Bir anahtar tek cihaza aittir (yeni cihaz onaylanınca anahtar değişir); ikinci bağlantı
			// ya aynı cihazın başka sekmesidir ya da ağ değişince kopmuş eski bağlantının yerine gelendir.
			if (ws.ad && ws.ad !== kisi.ad) ayril(ws);
			oturumAc(ws, kisi.ad, kimlik, anahtar, sesDevam);
			console.log(`[giriş] ${kisi.ad} anahtarıyla girdi`);
			db.kisiSonGiris(kisi.ad).catch(() => {});
			return;
		}
	}

	// 2) Anahtarsız / geçersiz anahtar → kapıyı çal.
	if (!ad) {
		return girisRed(ws, anahtar ? 'Anahtar geçersiz; adını yazıp izin iste.' : 'Ad gerekli.', anahtar ? 'anahtar' : 'ad');
	}
	const sahibi = adSahibi(ad);
	if (sahibi && sahibi !== ws && (!kimlik || sahibi.kimlik !== kimlik)) {
		return girisRed(ws, `"${ad}" adı şu anda kullanılıyor; başka bir ad seç.`, 'ad-kullaniliyor');
	}
	await kapiCal(ws, ad, !!anahtar);
}

// İçerideki biri kabul/red verir.
async function girisKarari(ws, m) {
	if (!ws.ad) return gonder(ws, { type: 'hata', message: 'Önce giriş yap.' });
	const id = String(m.id ?? '');
	const kayit = bekleyenler.get(id);
	// karar: aynı isteği iki kişi aynı anda kabul ederse ikinci kabul düşer (eskiden iki anahtar
	// üretilip iki 'hazir' gidiyordu).
	if (!kayit || kayit.karar) return gonder(ws, { type: 'hata', message: 'Bu giriş isteği artık geçerli değil.' });

	if (!m.kabul) {
		istekKapat(id, false, kayit.ad);
		girisRed(kayit.ws, 'Giriş isteğin reddedildi.', 'reddedildi');
		console.log(`[kapı] ${kayit.ad} reddedildi (${ws.ad})`);
		return;
	}
	kayit.karar = ws.ad;

	let sayi = 0;
	let mevcut = null;
	try {
		sayi = await db.kisiSayisi();
		mevcut = await db.kisiAd(kayit.ad);
	} catch {}
	// Kapıyı çalan bu arada vazgeçtiyse (sekmeyi kapattı) anahtar üretme: kimseye ulaşmayacak.
	if (kayit.ws.readyState !== WebSocket.OPEN) {
		istekKapat(id, false, kayit.ad);
		return;
	}
	if (sayi >= maxKullanici && !mevcut) {
		gonder(ws, { type: 'hata', message: `Beyaz liste dolu (${sayi}/${maxKullanici}); önce birini at.` });
		istekKapat(id, false, kayit.ad);
		girisRed(kayit.ws, `Sunucu dolu (en fazla ${maxKullanici} kişi).`, 'dolu');
		return;
	}

	const yeniAnahtar = crypto.randomBytes(ANAHTAR_BAYT).toString('hex');
	try {
		await db.kisiKaydet({ ad: kayit.ad, anahtar: yeniAnahtar });
	} catch (e) {
		console.error('[beyaz liste] kişi kaydedilemedi:', e.message);
		kayit.karar = null; // başka biri (ya da aynı kişi) yeniden deneyebilsin
		return gonder(ws, { type: 'hata', message: 'Kişi kaydedilemedi; tekrar dene.' });
	}
	beyazListeSayisi = mevcut ? sayi : sayi + 1;
	await beyazListeTazele(false); // adlar listesine yeni kişiyi ekle (yayın oturumAc'ta yapılır)
	istekKapat(id, true, kayit.ad);
	if (kayit.ws.readyState !== WebSocket.OPEN) return;
	oturumAc(kayit.ws, kayit.ad, kayit.kimlik, yeniAnahtar);
	console.log(`[kapı] ${kayit.ad} kabul edildi (${ws.ad}) → anahtar verildi${mevcut ? ' (eski anahtar iptal)' : ''}`);
}

// İstemcinin ses teşhisi: istemci 10 saniyede bir (ve önemli olaylarda) gönderir; bağlantı başına en
// fazla 1,5 saniyede 1 kez günlüğe yazılır. Yalnızca hata ayıklama içindir; DB'ye yazmaz, başka
// istemciye göndermez.
function taniKaydet(ws, m) {
	if (!ws.ad || !TANI) return;
	const simdi = Date.now();
	if (simdi - (ws.taniZaman || 0) < 1500) return;
	ws.taniZaman = simdi;
	let metin;
	try {
		metin = JSON.stringify(m.veri).slice(0, 1500);
	} catch {
		return;
	}
	console.log(`[tanı] ${ws.ad}: ${metin}`);
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
	await beyazListeTazele(); // atılan kişi arayüzdeki listeden de düşsün (yayın içinde)
	const hedef = adSahibi(ad);
	console.log(`[beyaz liste] ${ws.ad} → ${ad} atıldı`);
	if (hedef) {
		gonder(hedef, { type: 'atildi', message: 'Sunucudan atıldın; tekrar girmek için izin istemen gerek.' });
		sesCikar(hedef); // atılanın sesli kanal yeri askıda beklemesin
		ayril(hedef);
		setTimeout(() => hedef.terminate(), 300);
	}
	// Bağlantısı zaten kopmuşsa askıdaki sesli kanal yerini de hemen boşalt.
	const askida = askidakiKoltuk(ad);
	if (askida) koltukBirak(askida.kanal, ad, askida.ws);
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

// Sesli kanala gir. devam:true → istemcinin eşlerle WebRTC bağlantıları ayakta (sunucuya bağlantısı
// koptu ve geri geldi, ya da sunucu yeniden başladı); bu bayrak diğerlerine de iletilir ki onlar da
// bağlantıyı yeniden kurmak yerine sürdürsün. Askıda bir yeri varsa (bkz. sesAskiyaAl) ona oturur.
function sesGir(ws, m) {
	if (!ws.ad) return gonder(ws, { type: 'hata', message: 'Önce adını gir.' });
	const kanal = String(m.kanal ?? '');
	if (!sesKanali(kanal)) return gonder(ws, { type: 'hata', message: 'Bilinmeyen sesli kanal.', kod: 'ses-kanal-yok' });
	const devam = !!m.devam;
	const digerAdlar = () => [...(sesliKanallar.get(kanal) || new Map()).keys()].filter((a) => a !== ws.ad);
	if (ws.sesKanal === kanal) {
		return gonder(ws, { type: 'ses-girdi', kanal, kisiler: digerAdlar(), ice: iceSunuculari(ws.host), devam: true });
	}
	const askida = askidakiKoltuk(ws.ad);
	const geriAl = !!askida && devam && askida.kanal === kanal;
	// Doluluk, bulunduğu kanaldan çıkarılmadan ÖNCE denetlenir (eskiden önce çıkarılıyordu: kişi
	// eski kanalından düşüyor, yenisine giremiyor, arayüzü ise hâlâ eski kanalda sanıyordu).
	const dolu = [...(sesliKanallar.get(kanal) || new Map()).keys()].filter((a) => a !== ws.ad).length >= MAX_KISI;
	if (!geriAl && dolu) {
		return gonder(ws, { type: 'hata', message: `Sesli kanal dolu (en fazla ${MAX_KISI} kişi).`, kod: 'ses-dolu' });
	}
	sesCikar(ws);
	if (askida && !geriAl) koltukBirak(askida.kanal, ws.ad, askida.ws);
	const uyeler = sesliKanallar.get(kanal) || new Map();
	if (geriAl) {
		clearTimeout(askida.ws.askiZamani);
		askida.ws.askida = false;
		askida.ws.sesKanal = null;
		yayinBitir(askida.ws);
		uyeler.delete(ws.ad);
	}
	const digerleri = [...uyeler.keys()];
	uyeler.set(ws.ad, ws);
	sesliKanallar.set(kanal, uyeler);
	ws.sesKanal = kanal;
	ws.sessiz = !!m.sessiz;
	ws.sagir = !!m.sagir;
	// Yeniden bağlanan kişinin süren yayını (ekran / müzik) bilgisi de geri gelir.
	yayinAyarla(ws, m.ekran, m.yayinSes, m.yayinBaslik);
	console.log(`[ses] ${kanal}: ${ws.ad} ${geriAl ? 'geri döndü (bağlantılar sürüyor)' : devam ? 'devam ediyor' : 'girdi'} (${uyeler.size}/${MAX_KISI})`);
	gonder(ws, { type: 'ses-girdi', kanal, kisiler: digerleri, ice: iceSunuculari(ws.host), devam });
	kanalHerkes(kanal, { type: 'ses-kisi-girdi', kanal, ad: ws.ad, devam }, ws);
	durumYayinla();
}

// WebRTC mesajlarını aynı sesli kanaldaki kişiye ilet. oturum: eş bağlantısının kimliği (teklif eden
// üretir); alıcı eski bir bağlantıya ait aday/yanıtları bununla ayırır. yenile: "bağlantımız bozuk ya
// da bende yok, yeniden kur" isteği (yalnızca yanıtlayan taraf gönderir, teklif eden yeni teklif verir).
function sdpIlet(ws, m, tur) {
	if (!ws.sesKanal || !ws.ad) return;
	const hedef = String(m.to ?? '');
	const uyeler = sesliKanallar.get(ws.sesKanal);
	const karsi = uyeler && uyeler.get(hedef);
	if (!karsi || karsi === ws) return;
	const ileti = { type: tur, from: ws.ad };
	if (typeof m.oturum === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(m.oturum)) ileti.oturum = m.oturum;
	if (tur === 'sdp') ileti.sdp = m.sdp;
	else if (tur === 'ice') ileti.ice = m.ice;
	else if (tur === 'izle') ileti.izle = !!m.izle;
	gonder(karsi, ileti);
}

// --- yayın: ekran paylaşımı ve bilgisayar sesi / müzik. Akışlar eşler arasında P2P gider (sesli
// kanalın bağlantılarında önceden açılmış görüntü ve ikinci ses kanalı); sunucu yalnızca kimin neyi
// paylaştığını duyurur.

function yayinAyarla(ws, ekran, ses, baslik) {
	ws.ekran = !!ekran;
	ws.yayinSes = !!ses;
	ws.yayinBaslik = ws.yayinSes
		? String(baslik ?? '')
				.replace(/[\u0000-\u001f\u007f]/g, '')
				.trim()
				.slice(0, 120)
		: '';
}

function yayinDurumu(ws, m) {
	if (!ws.ad || !ws.sesKanal) return;
	const once = `${ws.ekran}/${ws.yayinSes}/${ws.yayinBaslik}`;
	const ekranVardi = ws.ekran;
	const sesVardi = ws.yayinSes;
	yayinAyarla(ws, m.ekran, m.ses, m.baslik);
	if (once === `${ws.ekran}/${ws.yayinSes}/${ws.yayinBaslik}`) return;
	if (ekranVardi !== ws.ekran || sesVardi !== ws.yayinSes) {
		const ne = [ws.ekran ? 'ekran' : '', ws.yayinSes ? 'ses' : ''].filter(Boolean).join(' + ') || 'yok';
		console.log(`[ses] ${ws.sesKanal}: ${ws.ad} yayın: ${ne}`);
	}
	durumYayinla();
}

// --- P2P dosya paylaşımı. Dosyanın kendisi sunucuya gelmez: sohbete yalnızca kaydı (ad, boyut, tür)
// yazılır; dosyayı isteyen, paylaşanın tarayıcısıyla doğrudan (WebRTC veri kanalı) bağlantı kurar.
// Sunucu (1) kimin hangi dosyayı şu an sunduğunu herkese duyurur, (2) iki tarayıcının tanışma
// mesajlarını (dosya-sinyal) iletir. Boyut sınırı yoktur.

const P2P_KIMLIK = /^[a-f0-9]{24}$/;
const EN_FAZLA_SUNULAN = 500; // bir bağlantının aynı anda sunabileceği dosya
const MIME_KALIBI = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;

function sunulanListesi() {
	const hepsi = new Set();
	for (const x of wss.clients) if (x.ad && x.sunulan) for (const id of x.sunulan) hepsi.add(id);
	return [...hepsi];
}

// Sunulan dosyalar değişti: herkese duyur (art arda değişiklikler tek yayında birleşir).
let sunulanZamanlayici = null;
function sunulanDegisti() {
	if (sunulanZamanlayici) return;
	sunulanZamanlayici = setTimeout(() => {
		sunulanZamanlayici = null;
		herkes({ type: 'dosya-durum', sunulan: sunulanListesi() });
	}, 30);
}

// Aynı bağlantının dosya mesajları sırayla işlenir (paylaşım ile "şunları sunuyorum" yarışmasın).
function dosyaSirasi(ws, is) {
	ws.dosyaKuyruk = (ws.dosyaKuyruk || Promise.resolve()).then(is, is).catch((e) => console.error('[dosya] beklenmeyen hata:', e && e.stack ? e.stack : e));
	return ws.dosyaKuyruk;
}

function dosyaPaylas(ws, m) {
	if (!ws.ad) return gonder(ws, { type: 'hata', message: 'Önce giriş yap.' });
	const kanal = String(m.kanal ?? '');
	if (!yaziKanali(kanal)) return gonder(ws, { type: 'hata', message: 'Bilinmeyen kanal.' });
	const id = String(m.id ?? '');
	if (!P2P_KIMLIK.test(id)) return gonder(ws, { type: 'hata', message: 'Dosya kimliği geçersiz.' });
	const boyut = Number(m.boyut);
	if (!Number.isSafeInteger(boyut) || boyut <= 0) return gonder(ws, { type: 'hata', message: 'Boş dosya paylaşılamaz.' });
	const simdi = Date.now();
	if (simdi - (ws.dosyaPencere || 0) > 10000) {
		ws.dosyaPencere = simdi;
		ws.dosyaAdet = 0;
	}
	if (++ws.dosyaAdet > 20) return gonder(ws, { type: 'hata', message: 'Çok hızlı dosya paylaşıyorsun; birkaç saniye bekle.' });
	const dosyaAd = guvenliAd(String(m.ad ?? 'dosya'));
	const hamTur = String(m.tur ?? '').trim().slice(0, 100);
	const tur = SATIR_ICI[uzanti(dosyaAd)] || (MIME_KALIBI.test(hamTur) ? hamTur.toLowerCase() : 'application/octet-stream');
	return dosyaSirasi(ws, async () => {
		if (!ws.ad) return;
		const kayit = { id, kanal, dosyaAd, boyut, tur, p2p: 1 };
		let mesaj;
		try {
			await db.dosyaEkle(kayit);
			mesaj = await db.mesajEkle({ kanal, ad: ws.ad, metin: '', dosya: kayit });
		} catch (e) {
			console.error('[dosya] kaydedilemedi:', e.message);
			return gonder(ws, { type: 'hata', message: 'Dosya paylaşılamadı; tekrar dene.' });
		}
		if (ws.sunulan && ws.sunulan.size < EN_FAZLA_SUNULAN) ws.sunulan.add(id);
		herkes({ type: 'yazi', kanal, mesaj });
		sunulanDegisti();
		console.log(`[dosya] ${ws.ad} → ${kanal}: ${dosyaAd} (${boyut} bayt, P2P)`);
	});
}

// İstemci şu an sunduğu dosyaları bildirir (yeniden bağlanınca, paylaşımı durdurunca). Yalnızca
// kendi paylaştığı ve mesajı hâlâ duran dosyalar kabul edilir; yanıtta geçerli olanlar döner.
// (Ad bilerek farklı: dosyaSun web dosyalarını sunar.)
function sunulanlariAyarla(ws, m) {
	if (!ws.ad) return;
	const istenen = [...new Set((Array.isArray(m.idler) ? m.idler : []).map(String).filter((x) => P2P_KIMLIK.test(x)))].slice(0, EN_FAZLA_SUNULAN);
	return dosyaSirasi(ws, async () => {
		if (!ws.ad) return;
		let gecerli = [];
		try {
			gecerli = await db.sahipDosyalari(ws.ad, istenen);
		} catch (e) {
			console.error('[dosya] sunulanlar okunamadı:', e.message);
			return;
		}
		if (!ws.ad) return;
		ws.sunulan = new Set(gecerli);
		gonder(ws, { type: 'dosya-sun', idler: gecerli });
		sunulanDegisti();
	});
}

// İki tarayıcının P2P dosya bağlantısı için tanışma mesajları (teklif/yanıt/aday/kapat). Sesli
// kanaldan bağımsızdır: herhangi iki çevrimiçi kişi arasında. Hedef yoksa gönderene hemen söylenir.
function dosyaSinyal(ws, m) {
	if (!ws.ad) return;
	const veri = m.veri;
	if (!veri || typeof veri !== 'object' || Array.isArray(veri)) return;
	const simdi = Date.now();
	if (simdi - (ws.sinyalPencere || 0) > 10000) {
		ws.sinyalPencere = simdi;
		ws.sinyalAdet = 0;
	}
	if (++ws.sinyalAdet > 600) return;
	const hedefAd = String(m.to ?? '').slice(0, 32);
	const hedef = adSahibi(hedefAd);
	if (!hedef || hedef === ws) {
		const bag = typeof veri.bag === 'string' ? veri.bag.slice(0, 40) : '';
		return gonder(ws, { type: 'dosya-sinyal', from: hedefAd, veri: { tur: 'ulasilamadi', bag } });
	}
	gonder(hedef, { type: 'dosya-sinyal', from: ws.ad, veri });
}

// --- veritabanı bilgisi ve sohbet temizliği

async function klasorBoyutu(klasor) {
	let toplam = 0;
	let adet = 0;
	try {
		for (const ad of await fs.promises.readdir(klasor)) {
			try {
				const s = await fs.promises.stat(path.join(klasor, ad));
				if (s.isFile()) {
					toplam += s.size;
					adet++;
				}
			} catch {}
		}
	} catch {}
	return { bayt: toplam, adet };
}

async function sunucuBilgisi() {
	const [veritabaniBayt, s, yuklemeler] = await Promise.all([db.boyut(), db.sayilar(), klasorBoyutu(YUKLEME_KLASORU)]);
	return {
		veritabani: veritabaniBayt,
		mesaj: s.mesaj,
		dosya: s.dosya,
		yuklemeler: yuklemeler.bayt, // eski sürümün sunucuya yüklediği dosyalar
		yuklemeAdet: yuklemeler.adet,
		bosAlan: bosAlan(),
		surum: SURUM,
	};
}

const TEMIZLIK_GUNLERI = [0, 1, 7, 30, 90];
let temizlikSuruyor = false;

async function sohbetTemizle(ws, m) {
	if (!ws.ad) return gonder(ws, { type: 'hata', message: 'Önce giriş yap.' });
	const kanal = String(m.kanal ?? '');
	if (kanal && !yaziKanali(kanal)) return gonder(ws, { type: 'hata', message: 'Bilinmeyen kanal.' });
	const gun = Number(m.gun ?? 0);
	if (!TEMIZLIK_GUNLERI.includes(gun)) return gonder(ws, { type: 'hata', message: 'Geçersiz süre.' });
	if (temizlikSuruyor) return gonder(ws, { type: 'hata', message: 'Temizlik zaten sürüyor; biraz bekle.' });
	temizlikSuruyor = true;
	const once = gun ? Date.now() - gun * 86400000 : 0;
	const kapsam = `${kanal ? '#' + kanal : 'tüm kanallar'}${gun ? `, ${gun} günden eski` : ''}`;
	let sonuc;
	try {
		sonuc = await db.sohbetiTemizle({ kanal, once });
	} catch (e) {
		console.error('[veritabanı] temizlenemedi:', e.message);
		return gonder(ws, { type: 'hata', message: 'Sohbet temizlenemedi; tekrar dene.' });
	} finally {
		temizlikSuruyor = false;
	}
	// Eski sürümün sunucuya yüklediği dosyalar diskten de silinir. Her şey silindiyse klasörde
	// kalan sahipsiz dosyalar da gider.
	const silinecek = new Set(sonuc.sunucuDosyalari);
	if (!kanal && !gun) {
		try {
			for (const ad of await fs.promises.readdir(YUKLEME_KLASORU)) if (/^[a-f0-9]{18}$/.test(ad)) silinecek.add(ad);
		} catch {}
	}
	for (const id of silinecek) {
		dosyaOnbellek.delete(id);
		await fs.promises.unlink(path.join(YUKLEME_KLASORU, id)).catch(() => {});
	}
	// Mesajı silinen P2P dosyalar artık sunulmaz.
	if (sonuc.p2pDosyalari.length) {
		const silinen = new Set(sonuc.p2pDosyalari);
		for (const x of wss.clients) if (x.sunulan) for (const id of silinen) x.sunulan.delete(id);
		sunulanDegisti();
	}
	const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
	console.log(`[veritabanı] ${ws.ad} sohbeti temizledi (${kapsam}): ${sonuc.mesaj} mesaj, ${silinecek.size} eski dosya; veritabanı ${mb(sonuc.onceki)} → ${mb(sonuc.sonraki)}`);
	herkes({ type: 'sohbet-temizlendi', kanal, gun, ad: ws.ad, silinen: sonuc.mesaj });
	try {
		gonder(ws, { type: 'sunucu-bilgi', ...(await sunucuBilgisi()) });
	} catch {}
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

	// Kanal bellekten hemen düşer (silinirken içine mesaj/dosya yazılamasın); veritabanı silemezse
	// eski yerine geri konur (eskiden DB hatasında kanal arayüzden kayboluyor, yeniden başlatınca
	// geri geliyordu).
	const sira = kanallar.findIndex((k) => k.id === id);
	kanallar = kanallar.filter((k) => k.id !== id);
	let silinenDosyalar;
	try {
		silinenDosyalar = await db.kanalSil(id);
	} catch (e) {
		console.error('[kanal] silinemedi:', e.message);
		if (!kanallar.some((k) => k.id === id)) kanallar.splice(Math.min(sira, kanallar.length), 0, kanal);
		return gonder(ws, { type: 'hata', message: 'Kanal silinemedi; tekrar dene.' });
	}
	let sunulanAzaldi = false;
	for (const d of silinenDosyalar) {
		dosyaOnbellek.delete(d);
		fs.promises.unlink(path.join(YUKLEME_KLASORU, d)).catch(() => {}); // P2P dosyada diskte bir şey yok
		for (const x of wss.clients) if (x.sunulan && x.sunulan.delete(d)) sunulanAzaldi = true;
	}
	if (sunulanAzaldi) sunulanDegisti();
	// Sesli kanaldaysa içindekileri çıkar (askıdakiler de).
	const uyeler = sesliKanallar.get(id);
	if (uyeler) {
		for (const uye of uyeler.values()) {
			clearTimeout(uye.askiZamani);
			uye.askida = false;
			uye.sesKanal = null;
			gonder(uye, { type: 'ses-kapatildi', kanal: id });
		}
		sesliKanallar.delete(id);
	}
	console.log(`[kanal] ${ws.ad} → -${kanal.tur} "${kanal.ad}" (${id}); toplam ${kanallar.length}`);
	durumYayinla();
}

// Async işleyicilerdeki beklenmedik bir istisna süreci düşürmesin (unhandled rejection Node'u
// kapatır → konteyner yeniden başlar → herkesin bağlantısı kopar). Günlüğe yazıp devam ederiz.
function guvenli(ad, is) {
	try {
		const sonuc = is();
		if (sonuc && typeof sonuc.catch === 'function') sonuc.catch((e) => console.error(`[${ad}] beklenmeyen hata:`, e && e.stack ? e.stack : e));
	} catch (e) {
		console.error(`[${ad}] beklenmeyen hata:`, e && e.stack ? e.stack : e);
	}
}

const ISLEYICILER = {
	giris: girisYap,
	'giris-karari': girisKarari,
	'giris-iptal': (ws) => ws.knockId && istekKapat(ws.knockId, false, null),
	at: kisiAt,
	'kisi-limiti': kisiLimitiAyarla,
	tani: taniKaydet,
	'beyaz-liste': (ws) => {
		if (!ws.ad) return;
		return db
			.kisiler()
			.then((kisiler) => gonder(ws, { type: 'beyaz-liste', kisiler, maxKullanici: maxKullanici }))
			.catch(() => gonder(ws, { type: 'hata', message: 'Beyaz liste okunamadı.' }));
	},
	yazi: yaziGonder,
	gecmis: gecmisGonder,
	yaziyor: (ws, m) => {
		if (ws.ad && yaziKanali(String(m.kanal ?? ''))) herkes({ type: 'yaziyor', kanal: String(m.kanal), ad: ws.ad }, ws);
	},
	'ses-gir': sesGir,
	'ses-cik': (ws) => {
		sesCikar(ws);
		durumYayinla();
	},
	'kanal-ekle': kanalEkleHandler,
	'kanal-sil': kanalSilHandler,
	sdp: (ws, m) => sdpIlet(ws, m, 'sdp'),
	ice: (ws, m) => sdpIlet(ws, m, 'ice'),
	yenile: (ws, m) => sdpIlet(ws, m, 'yenile'),
	izle: (ws, m) => sdpIlet(ws, m, 'izle'),
	yayin: yayinDurumu,
	'dosya-paylas': dosyaPaylas,
	'dosya-sun': sunulanlariAyarla,
	'dosya-sinyal': dosyaSinyal,
	'sunucu-bilgi': (ws) => {
		if (!ws.ad) return;
		return sunucuBilgisi()
			.then((b) => gonder(ws, { type: 'sunucu-bilgi', ...b }))
			.catch(() => gonder(ws, { type: 'hata', message: 'Sunucu bilgisi okunamadı.' }));
	},
	'sohbet-temizle': sohbetTemizle,
	sessiz: (ws, m) => {
		if (!ws.ad) return;
		ws.sessiz = !!m.sessiz;
		ws.sagir = !!m.sagir;
		herkes({ type: 'sessiz', ad: ws.ad, sessiz: ws.sessiz, sagir: ws.sagir });
		durumYayinla();
	},
	// Uzun süre açık kalan sekme (TURN şifresi 24 saatlik) ya da sunucu yeniden başladıktan sonra.
	'ice-iste': (ws) => ws.ad && gonder(ws, { type: 'ice-sunuculari', ice: iceSunuculari(ws.host) }),
	ping: (ws) => gonder(ws, { type: 'pong' }),
};

wss.on('connection', (ws, req) => {
	ws.ip = String((req && req.headers && req.headers['x-forwarded-for']) || '')
		.split(',')[0]
		.trim() || (req && req.socket ? req.socket.remoteAddress : '') || '';
	ws.host = String((req && req.headers && req.headers.host) || '');
	ws.ad = null;
	ws.sesKanal = null;
	ws.sessiz = false;
	ws.sagir = false;
	ws.canli = true;
	ws.kacirilan = 0;
	ws.on('pong', () => (ws.canli = true));
	ws.on('message', (veri, ikili) => {
		ws.canli = true; // istemciden gelen her mesaj da yaşadığını gösterir
		if (ikili) return;
		let m;
		try {
			m = JSON.parse(veri.toString());
		} catch {
			return;
		}
		if (!m || typeof m !== 'object') return;
		const isleyici = Object.prototype.hasOwnProperty.call(ISLEYICILER, m.type) ? ISLEYICILER[m.type] : null;
		if (isleyici) guvenli(m.type, () => isleyici(ws, m));
	});
	const kapandi = () => {
		ws.canli = false;
		if (ws.knockId) istekKapat(ws.knockId, false, null);
		ayril(ws);
	};
	ws.on('close', kapandi);
	ws.on('error', kapandi);
});

// Kapıda bekleyen istekler 2 dakikada bir düşsün (kimse karar vermezse).
const kapiZamanlayici = setInterval(() => {
	const simdi = Date.now();
	for (const [id, b] of bekleyenler) {
		if (simdi - b.zaman < beklemeSuresi) continue;
		istekKapat(id, false, b.ad);
		girisRed(b.ws, 'İstek zaman aşımına düştü; tekrar dene.', 'zaman-asimi');
	}
}, 15000);

// Kopan bağlantıları (telefon uykuya geçti, ağ değişti...) 15 saniyede bir yokla. Telefonlar arka
// planda ağı bir süre bekletebiliyor (pil tasarrufu): tek kaçırılan yoklamada düşürmek sesli
// kanaldakini gereksiz yere koparıyordu. Art arda NABIZ_TOLERANSI yoklamaya (~45 sn) hiç yanıt
// vermeyen düşürülür (sesli kanaldaysa yeri SES_ASKI_MS boyunca askıda kalır).
const NABIZ_MS = 15000;
const NABIZ_TOLERANSI = 3;
const nabiz = setInterval(() => {
	for (const ws of wss.clients) {
		if (ws.canli) ws.kacirilan = 0;
		else if (++ws.kacirilan >= NABIZ_TOLERANSI) {
			ws.terminate();
			continue;
		}
		ws.canli = false;
		try {
			ws.ping();
		} catch {}
	}
}, NABIZ_MS);

// Dış IP değişirse (bulutun geçici IP'si) STUN/TURN sessizce ölür: relay adayı hiç oluşmaz,
// ses bağlantısı kurulmaz. Konteyneri bilerek yeniden başlatıyoruz; açılışta yeni IP okunur.
// .env'de DIS_IP sabitlenmişse karışmayız (kullanıcı bilerek yazmıştır).
function disIpIzle() {
	const zamanlayici = setInterval(async () => {
		if (DIS_IP_ELLE) return;
		const yeni = await disIpBul();
		if (!yeni || yeni === disIp) return;
		console.error(`[turn] dış IP değişti: ${disIp || 'yok'} → ${yeni}; yeni IP ile yeniden başlatılıyor.`);
		process.exit(1);
	}, 5 * 60 * 1000);
	zamanlayici.unref?.();
}

// ---------------------------------------------------------------- eski yüklemeler (salt okunur)
//
// Eski sürümde dosyalar sunucuya yükleniyordu (/veri/yuklemeler). Yenileri P2P paylaşılır; eskiler
// sohbetteki mesajları durdukça /dosya/<id> ile sunulmaya devam eder ("sohbeti temizle" siler).

// Yalnızca bu türler tarayıcıda doğrudan gösterilir; geri kalanı indirme olarak sunulur.
// (HTML/SVG gibi betik çalıştırabilen türler asla satır içi gösterilmez.) P2P dosyaların türü de
// bu tablodan belirlenir.
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

// Diskte boş yer (bayt); okunamazsa null.
function bosAlan() {
	try {
		const s = fs.statfsSync(VERI_KLASORU);
		return s.bavail * s.bsize;
	} catch {
		return null;
	}
}

function jsonYanit(res, kod, nesne) {
	yanit(res, kod, JSON.stringify(nesne) + '\n', { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

async function dosyaGonder(req, res, id) {
	let kayit = dosyaOnbellek.get(id);
	if (!kayit) {
		try {
			kayit = await db.dosyaGetir(id);
		} catch {}
		if (kayit) dosyaOnbellek.set(id, kayit);
	}
	if (!kayit || kayit.p2p) return yanit(res, 404, 'Dosya bulunamadı\n', { 'Content-Type': 'text/plain; charset=utf-8' });
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

	// Dosyalar artık sunucuya yüklenmez (P2P); eski istemcilere anlaşılır bir yanıt.
	if (req.method === 'POST' && yol === '/api/yukle') return jsonYanit(res, 410, { hata: 'Dosyalar artık sunucuya yüklenmiyor; sayfayı yenile.' });
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
			girisKova: GIRIS_KOVA,
			sesAskiMs: SES_ASKI_MS,
			disIp: disIp || null, // STUN/TURN'ün duyurduğu dış IP (yanlışsa ses hiç kurulmaz)
			turnAdresi: turnAdresi || null,
			veritabani: db ? 'açık' : 'kapalı',
		};
		const sayilar = db ? Promise.all([db.sayilar(), db.kisiSayisi(), db.boyut()]) : Promise.resolve([{ mesaj: 0, dosya: 0 }, 0, 0]);
		return sayilar.then(
			([s, kisiSayisi, boyut]) =>
				yanit(res, iyi ? 200 : 503, JSON.stringify({ ...govde, mesaj: s.mesaj, dosya: s.dosya, beyazListe: kisiSayisi, veritabaniBayt: boyut }) + '\n', {
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
		// TURN şifresi yalnızca oturumu olan (beyaz listedeki) kişiye: Authorization: Bearer <jeton>.
		const sahibi = jetonlar.get(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
		if (!sahibi || !sahibi.ad) return jsonYanit(res, 401, { hata: 'Oturum gerekli.' });
		return jsonYanit(res, 200, iceSunuculari(req.headers.host));
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
// Son güvenlik ağı: yakalanmamış bir söz reddi sunucuyu (ve herkesin bağlantısını) düşürmesin.
process.on('unhandledRejection', (e) => console.error('[sunucu] yakalanmamış hata:', e && e.stack ? e.stack : e));

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
		const [boyut, s] = await Promise.all([db.boyut(), db.sayilar()]);
		console.log(`[veritabanı] ${(boyut / 1048576).toFixed(1)} MB, ${s.mesaj} mesaj, ${s.dosya} dosya kaydı`);
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
		await beyazListeTazele(false); // çevrimdışı beyaz liste adları arayüzde görünsün
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

	// Dış IP: .env'de sabitlenmiş değer yoksa bulut meta verisinden (GCP) okunur.
	const metaIp = await disIpBul();
	if (!disIp && metaIp) disIp = metaIp;
	else if (disIp && metaIp && disIp !== metaIp) {
		console.warn(`[turn] .env'deki DIS_IP=${disIp} güncel değil (gerçek dış IP ${metaIp}); .env'den DIS_IP satırını sil.`);
	}
	if (!turnAdresi) turnAdresi = disIp;
	console.log(`[turn] dış IP ${disIp || 'yok'}${DIS_IP_ELLE ? ' (.env)' : ' (meta veri)'}, tarayıcıya verilen adres ${turnAdresi || 'sayfa adresi'}`);
	disIpIzle();
	turnBaslat();
	// Önce coturn hazır olsun, SONRA dinlemeye başla: yoksa yeniden başlatmadan hemen sonra bağlanan
	// istemciler 'hazir' içinde boş STUN/TURN listesi alıyor, TURN'e muhtaç olanlar hiç bağlanamıyordu.
	const turnTamam = await turnHazirBekle();
	if (!turnTamam && turn) {
		console.error(`[turn] coturn UDP ${TURN_PORT}'te yanıt vermiyor.`);
		process.exit(1);
	}
	sunucu.listen(PORT, HOST, () => {
		const turnBilgi = turnTamam
			? `STUN/TURN udp/${TURN_PORT} (aktarım ${RELAY_MIN_PORT}-${RELAY_MAX_PORT}, dış IP ${disIp || 'yok'}, iç IP ${IC_IP || 'yok'})`
			: 'STUN/TURN kapalı';
		console.log(
			`Diszort çalışıyor: http://${HOST}:${PORT}  sürüm ${SURUM}, sesli kanal başına en fazla ${MAX_KISI} kişi, ` +
				`dosyalar P2P (sınırsız), veri ${VERI_KLASORU}, ${turnBilgi}`,
		);
	});
}

main();
