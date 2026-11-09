// Diszort — sohbet veritabanı (SQLite).
//
// Yalnızca YAZILI kanalların mesajları ve paylaşılan dosyaların KAYITLARI (ad, boyut, tür) diske
// yazılır. Dosyaların kendisi sunucuya gelmez: paylaşanın tarayıcısından doğrudan (P2P) alınır.
// Ses/görüntü hiçbir zaman kaydedilmez. Dosya: <veri>/sohbet.db
// Debian'ın node-sqlite3 paketi kullanılır (npm derlemesi gerekmez).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=4000;

CREATE TABLE IF NOT EXISTS mesaj (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	kanal TEXT NOT NULL,
	ad TEXT NOT NULL,
	metin TEXT NOT NULL DEFAULT '',
	dosya_id TEXT,
	zaman INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mesaj_kanal ON mesaj (kanal, id);

-- Beyaz liste: ad = kişi kimliği, anahtar = cihaz anahtarı (onayda üretilir, yeniden onayda döner).
CREATE TABLE IF NOT EXISTS kisi (
	ad TEXT PRIMARY KEY,
	anahtar TEXT NOT NULL UNIQUE,
	olusturma INTEGER NOT NULL,
	son_giris INTEGER,
	yonetici INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kanal (
	id TEXT PRIMARY KEY,
	ad TEXT NOT NULL,
	tur TEXT NOT NULL,
	sira INTEGER NOT NULL DEFAULT 0,
	olusturma INTEGER NOT NULL
);

-- Paylaşılan dosyanın kaydı: dosyanın kendisi sunucuda değil, paylaşanın tarayıcısında (P2P).
CREATE TABLE IF NOT EXISTS dosya (
	id TEXT PRIMARY KEY,
	kanal TEXT NOT NULL,
	ad TEXT NOT NULL,
	boyut INTEGER NOT NULL,
	tur TEXT NOT NULL,
	zaman INTEGER NOT NULL
);

-- Basit anahtar/değer ayarları (ör. kisi_limiti). .env yalnızca varsayılanı verir; buradaki değer onu geçersiz kılar.
CREATE TABLE IF NOT EXISTS ayar (
	ad TEXT PRIMARY KEY,
	deger TEXT NOT NULL
);
`;

function sayi(deger) {
	const n = Number(deger);
	return Number.isFinite(n) ? n : 0;
}

// Satır → istemciye giden mesaj biçimi.
function mesajCevir(satir) {
	const m = { id: satir.id, ad: satir.ad, metin: satir.metin || '', zaman: satir.zaman };
	if (satir.dosya_id) {
		m.dosya = {
			id: satir.dosya_id,
			ad: satir.dosya_ad || 'dosya',
			boyut: sayi(satir.dosya_boyut),
			tur: satir.dosya_tur || 'application/octet-stream',
		};
	}
	return m;
}

const MESAJ_SORGUSU =
	'SELECT m.*, d.ad AS dosya_ad, d.boyut AS dosya_boyut, d.tur AS dosya_tur FROM mesaj m ' +
	'LEFT JOIN dosya d ON d.id = m.dosya_id ';

// Silinecek mesajların koşulları: kanal ('' = hepsi) ve zaman (0 = hepsi; yoksa bundan eskiler).
// onek: sütun adlarının önüne (ör. 'm.').
function temizlikKosulu({ kanal = '', once = 0 }, onek = '') {
	const parcalar = [];
	const params = [];
	if (kanal) {
		parcalar.push(onek + 'kanal = ?');
		params.push(kanal);
	}
	if (once > 0) {
		parcalar.push(onek + 'zaman < ?');
		params.push(once);
	}
	return { parcalar, params };
}
const nerede = (parcalar) => (parcalar.length ? ' WHERE ' + parcalar.join(' AND ') : '');

function ac(klasor) {
	fs.mkdirSync(klasor, { recursive: true });
	let sqlite3;
	try {
		sqlite3 = require('sqlite3');
	} catch (e) {
		throw new Error('SQLite kütüphanesi yok (kur: sudo apt install node-sqlite3): ' + e.message);
	}
	const yol = path.join(klasor, 'sohbet.db');
	const db = new sqlite3.Database(yol);
	console.log(`[veritabanı] ${yol}`);

	const calistir = (sql, params = []) =>
		new Promise((coz, red) => {
			db.run(sql, params, function (hata) {
				if (hata) red(hata);
				else coz({ id: this.lastID, degisen: this.changes });
			});
		});
	const tek = (sql, params = []) =>
		new Promise((coz, red) => {
			db.get(sql, params, (hata, satir) => (hata ? red(hata) : coz(satir || null)));
		});
	const hepsi = (sql, params = []) =>
		new Promise((coz, red) => {
			db.all(sql, params, (hata, satirlar) => (hata ? red(hata) : coz(satirlar || [])));
		});

	// Şema hazır olana kadar beklenir (sunucu dinlemeye bundan sonra başlar).
	const hazir = new Promise((coz, red) => {
		db.exec(SEMA, (hata) => (hata ? red(hata) : coz(true)));
	});

	// Veritabanı dosyalarının diskteki boyutu (WAL günlüğü dahil).
	async function diskBoyutu() {
		let toplam = 0;
		for (const ek of ['', '-wal', '-shm']) {
			try {
				toplam += (await fs.promises.stat(yol + ek)).size;
			} catch {}
		}
		return toplam;
	}

	const api = {
		hazir,
		yol,

		// Yeni mesaj yaz; yazılan satırı istemci biçiminde döndürür.
		async mesajEkle({ kanal, ad, metin = '', dosya = null }) {
			const zaman = Date.now();
			const sonuc = await calistir('INSERT INTO mesaj (kanal, ad, metin, dosya_id, zaman) VALUES (?, ?, ?, ?, ?)', [
				kanal,
				ad,
				metin,
				dosya ? dosya.id : null,
				zaman,
			]);
			const mesaj = { id: sonuc.id, ad, metin, zaman };
			if (dosya) mesaj.dosya = { id: dosya.id, ad: dosya.dosyaAd, boyut: dosya.boyut, tur: dosya.tur };
			return mesaj;
		},

		// Bir kanalın son mesajları (eskiden yeniye). once: bu id'den daha eski olanlar.
		async mesajlar(kanal, once = 0, adet = 50) {
			const satirlar = once
				? await hepsi(MESAJ_SORGUSU + 'WHERE m.kanal = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?', [kanal, once, adet])
				: await hepsi(MESAJ_SORGUSU + 'WHERE m.kanal = ? ORDER BY m.id DESC LIMIT ?', [kanal, adet]);
			return satirlar.reverse().map(mesajCevir);
		},

		// --- beyaz liste (kişiler + anahtarları)
		async kisiSayisi() {
			const s = await tek('SELECT COUNT(*) AS n FROM kisi');
			return s ? s.n : 0;
		},

		async kisiler() {
			return hepsi('SELECT ad, olusturma, son_giris, yonetici FROM kisi ORDER BY olusturma, ad');
		},

		async kisiAnahtarla(anahtar) {
			return tek('SELECT ad, anahtar, yonetici FROM kisi WHERE anahtar = ?', [anahtar]);
		},

		async kisiAd(ad) {
			return tek('SELECT ad, anahtar, yonetici FROM kisi WHERE ad = ?', [ad]);
		},

		// Kişiyi beyaz listeye ekler; ad zaten varsa anahtarı yenilenir (cihaz değişti / yeniden onay).
		async kisiKaydet({ ad, anahtar, yonetici = 0 }) {
			await calistir(
				'INSERT INTO kisi (ad, anahtar, olusturma, son_giris, yonetici) VALUES (?, ?, ?, ?, ?) ' +
					'ON CONFLICT(ad) DO UPDATE SET anahtar = excluded.anahtar, son_giris = excluded.son_giris',
				[ad, anahtar, Date.now(), Date.now(), yonetici ? 1 : 0],
			);
		},

		async kisiSonGiris(ad) {
			await calistir('UPDATE kisi SET son_giris = ? WHERE ad = ?', [Date.now(), ad]);
		},

		async kisiSil(ad) {
			await calistir('DELETE FROM kisi WHERE ad = ?', [ad]);
		},

		// --- basit ayarlar (anahtar/değer). Örn. kişi limiti beyaz listedekiler tarafından değiştirilir.
		async ayarOku(ad) {
			const satir = await tek('SELECT deger FROM ayar WHERE ad = ?', [ad]);
			return satir ? satir.deger : null;
		},

		async ayarYaz(ad, deger) {
			await calistir('INSERT INTO ayar (ad, deger) VALUES (?, ?) ON CONFLICT(ad) DO UPDATE SET deger = excluded.deger', [
				ad,
				String(deger),
			]);
		},

		// --- kanallar (yazılı/sesli). Kanal listesi veritabanında tutulur; mesajlar 'kanal' id'siyle bağlanır.
		async kanallarGetir() {
			const satirlar = await hepsi('SELECT id, ad, tur FROM kanal ORDER BY sira, olusturma, id');
			return satirlar.map((s) => ({ id: s.id, ad: s.ad, tur: s.tur }));
		},

		async kanalEkle({ id, ad, tur }) {
			const son = await tek('SELECT COALESCE(MAX(sira), 0) + 1 AS sira FROM kanal');
			await calistir('INSERT INTO kanal (id, ad, tur, sira, olusturma) VALUES (?, ?, ?, ?, ?)', [
				id,
				ad,
				tur,
				son.sira,
				Date.now(),
			]);
		},

		// Kanalı ve içindeki mesajları siler; silinen dosyaların id'lerini döndürür (artık sunulmasınlar).
		async kanalSil(id) {
			const dosyalar = await hepsi('SELECT DISTINCT dosya_id FROM mesaj WHERE kanal = ? AND dosya_id IS NOT NULL', [id]);
			await calistir('DELETE FROM mesaj WHERE kanal = ?', [id]);
			await calistir('DELETE FROM dosya WHERE kanal = ?', [id]);
			await calistir('DELETE FROM kanal WHERE id = ?', [id]);
			return dosyalar.map((d) => d.dosya_id);
		},

		async dosyaEkle({ id, kanal, dosyaAd, boyut, tur }) {
			await calistir('INSERT INTO dosya (id, kanal, ad, boyut, tur, zaman) VALUES (?, ?, ?, ?, ?, ?)', [id, kanal, dosyaAd, boyut, tur, Date.now()]);
		},

		// idler içinden, sohbette `ad` kişisinin paylaştığı dosyalar (kişi yalnızca kendi paylaştığı
		// dosyayı sunabilir; mesajı silinen dosya da artık sunulamaz).
		async sahipDosyalari(ad, idler) {
			if (!idler.length) return [];
			const satirlar = await hepsi(
				`SELECT DISTINCT d.id FROM dosya d JOIN mesaj m ON m.dosya_id = d.id WHERE m.ad = ? AND d.id IN (${idler.map(() => '?').join(',')})`,
				[ad, ...idler],
			);
			return satirlar.map((s) => s.id);
		},

		async sayilar() {
			const m = await tek('SELECT COUNT(*) AS n FROM mesaj');
			const d = await tek('SELECT COUNT(*) AS n FROM dosya');
			return { mesaj: m ? m.n : 0, dosya: d ? d.n : 0 };
		},

		// Diskteki boyut (bayt): sohbet.db + WAL günlüğü.
		boyut: diskBoyutu,

		// Sohbeti temizle: yalnızca mesajlar ve onların dosya kayıtları silinir. Beyaz liste (kisi),
		// kanallar ve ayarlar DOKUNULMAZ. kanal: '' = tüm kanallar; once: 0 = hepsi, yoksa bu
		// zamandan (ms) eski mesajlar. Sonra VACUUM ile dosya küçültülür (silinen yer diske döner).
		// Dönüş: silinen mesaj sayısı, artık sunulamayacak dosyalar ve önceki/sonraki boyut.
		async sohbetiTemizle({ kanal = '', once = 0 } = {}) {
			const onceki = await diskBoyutu();
			const kosul = temizlikKosulu({ kanal, once });
			const mKosul = temizlikKosulu({ kanal, once }, 'm.');
			const dosyalar = await hepsi(
				'SELECT DISTINCT m.dosya_id AS id FROM mesaj m' + nerede([...mKosul.parcalar, 'm.dosya_id IS NOT NULL']),
				mKosul.params,
			);
			const sonuc = await calistir('DELETE FROM mesaj' + nerede(kosul.parcalar), kosul.params);
			// Dosya kayıtları yüzerlik parçalarla silinir (SQLite'ın değişken sınırı).
			const idler = dosyalar.map((d) => d.id);
			for (let i = 0; i < idler.length; i += 400) {
				const parca = idler.slice(i, i + 400);
				await calistir(`DELETE FROM dosya WHERE id IN (${parca.map(() => '?').join(',')})`, parca);
			}
			// Her şey silindiyse sahipsiz kalmış dosya kayıtları da gider.
			if (!kanal && !once) await calistir('DELETE FROM dosya');
			await calistir('VACUUM');
			await calistir('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {});
			return {
				mesaj: sonuc.degisen,
				dosyalar: idler,
				onceki,
				sonraki: await diskBoyutu(),
			};
		},

		kapat() {
			return new Promise((coz) => db.close(() => coz(true)));
		},
	};
	return api;
}

module.exports = { ac };
