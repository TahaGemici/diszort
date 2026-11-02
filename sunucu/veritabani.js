// Ses Kanalı — sohbet veritabanı (SQLite).
//
// Yalnızca YAZILI kanalların mesajları ve yüklenen dosyaların kayıtları diske yazılır;
// ses/görüntü hiçbir zaman kaydedilmez (P2P akar). Dosya: <veri>/sohbet.db
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

CREATE TABLE IF NOT EXISTS kanal (
	id TEXT PRIMARY KEY,
	ad TEXT NOT NULL,
	tur TEXT NOT NULL,
	sira INTEGER NOT NULL DEFAULT 0,
	olusturma INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dosya (
	id TEXT PRIMARY KEY,
	kanal TEXT NOT NULL,
	ad TEXT NOT NULL,
	boyut INTEGER NOT NULL,
	tur TEXT NOT NULL,
	zaman INTEGER NOT NULL
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
				? await hepsi(
						'SELECT m.*, d.ad AS dosya_ad, d.boyut AS dosya_boyut, d.tur AS dosya_tur FROM mesaj m ' +
							'LEFT JOIN dosya d ON d.id = m.dosya_id WHERE m.kanal = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?',
						[kanal, once, adet],
					)
				: await hepsi(
						'SELECT m.*, d.ad AS dosya_ad, d.boyut AS dosya_boyut, d.tur AS dosya_tur FROM mesaj m ' +
							'LEFT JOIN dosya d ON d.id = m.dosya_id WHERE m.kanal = ? ORDER BY m.id DESC LIMIT ?',
						[kanal, adet],
					);
			return satirlar.reverse().map(mesajCevir);
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

		// Kanalı ve içindeki mesajları siler; silinen dosyaların id'lerini döndürür (diskten temizlemek için).
		async kanalSil(id) {
			const dosyalar = await hepsi('SELECT DISTINCT dosya_id FROM mesaj WHERE kanal = ? AND dosya_id IS NOT NULL', [id]);
			await calistir('DELETE FROM mesaj WHERE kanal = ?', [id]);
			await calistir('DELETE FROM dosya WHERE kanal = ?', [id]);
			await calistir('DELETE FROM kanal WHERE id = ?', [id]);
			return dosyalar.map((d) => d.dosya_id);
		},

		async dosyaEkle({ id, kanal, dosyaAd, boyut, tur }) {
			await calistir('INSERT INTO dosya (id, kanal, ad, boyut, tur, zaman) VALUES (?, ?, ?, ?, ?, ?)', [
				id,
				kanal,
				dosyaAd,
				boyut,
				tur,
				Date.now(),
			]);
		},

		async dosyaGetir(id) {
			const satir = await tek('SELECT * FROM dosya WHERE id = ?', [id]);
			if (!satir) return null;
			return { id: satir.id, kanal: satir.kanal, dosyaAd: satir.ad, boyut: satir.boyut, tur: satir.tur, zaman: satir.zaman };
		},

		async sayilar() {
			const m = await tek('SELECT COUNT(*) AS n FROM mesaj');
			const d = await tek('SELECT COUNT(*) AS n FROM dosya');
			return { mesaj: m ? m.n : 0, dosya: d ? d.n : 0 };
		},

		kapat() {
			return new Promise((coz) => db.close(() => coz(true)));
		},
	};
	return api;
}

module.exports = { ac };
