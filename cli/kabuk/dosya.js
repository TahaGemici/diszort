// Dosyalar: tarayıcının File / Blob / blob adresi / "Farklı kaydet" düzeninin diskteki karşılığı.
//
// Paylaşılan dosya belleğe alınmaz: DiskDosyasi, File gibi davranır (name, size, type, slice,
// arrayBuffer) ama parçaları istendikçe diskten okur (sayfa dosyayı 1 MB'lık dilimlerle gönderir).
// İndirilen dosya da belleğe değil doğrudan seçilen yere yazılır (showSaveFilePicker'ın karşılığı).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const TURLER = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	bmp: 'image/bmp',
	mp3: 'audio/mpeg',
	ogg: 'audio/ogg',
	oga: 'audio/ogg',
	opus: 'audio/ogg',
	m4a: 'audio/mp4',
	wav: 'audio/wav',
	flac: 'audio/flac',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mkv: 'video/x-matroska',
	mov: 'video/quicktime',
	pdf: 'application/pdf',
	zip: 'application/zip',
	gz: 'application/gzip',
	'7z': 'application/x-7z-compressed',
	json: 'application/json',
	txt: 'text/plain',
	md: 'text/markdown',
	csv: 'text/csv',
	html: 'text/html',
};
const turBul = (ad) => TURLER[(String(ad).split('.').pop() || '').toLowerCase()] || '';

// Diskteki bir dosyanın [bas, son) dilimi; File/Blob gibi kullanılır.
class DiskDosyasi {
	constructor(yol, { bas = 0, son = null, tur = null, ad = null, boyut = null, degisim = null } = {}) {
		this.yol = yol;
		if (boyut === null) {
			const d = fs.statSync(yol);
			if (!d.isFile()) throw Object.assign(new Error('Dosya değil: ' + yol), { name: 'NotFoundError' });
			boyut = d.size;
			degisim = d.mtimeMs;
		}
		this.tamBoyut = boyut;
		this.bas = Math.min(bas, boyut);
		this.son = son === null ? boyut : Math.min(Math.max(son, this.bas), boyut);
		this.name = ad ?? path.basename(yol);
		this.type = tur ?? turBul(this.name);
		this.lastModified = Math.round(degisim || Date.now());
	}
	get size() {
		return this.son - this.bas;
	}
	slice(bas = 0, son = this.size, tur = '') {
		const n = this.size;
		const duzelt = (x) => (x < 0 ? Math.max(n + x, 0) : Math.min(x, n));
		const b = duzelt(Math.trunc(Number(bas) || 0));
		const s = Math.max(b, duzelt(Math.trunc(son == null ? n : Number(son) || 0)));
		return new DiskDosyasi(this.yol, { bas: this.bas + b, son: this.bas + s, tur: String(tur || ''), ad: this.name, boyut: this.tamBoyut, degisim: this.lastModified });
	}
	async arrayBuffer() {
		const n = this.size;
		const tampon = Buffer.allocUnsafeSlow(n);
		const tutamac = await fs.promises.open(this.yol, 'r');
		try {
			let okunan = 0;
			while (okunan < n) {
				const { bytesRead } = await tutamac.read(tampon, okunan, n - okunan, this.bas + okunan);
				if (!bytesRead) throw Object.assign(new Error('Dosya kısaldı: ' + this.name), { name: 'NotReadableError' });
				okunan += bytesRead;
			}
		} finally {
			await tutamac.close();
		}
		return tampon.buffer;
	}
	async text() {
		return Buffer.from(await this.arrayBuffer()).toString('utf8');
	}
	stream() {
		return fs.createReadStream(this.yol, { start: this.bas, end: Math.max(this.bas, this.son - 1) });
	}
}

// ~ ile başlayan ve göreli yolları aç.
function yolAc(yol) {
	yol = String(yol || '').trim();
	// Terminale sürüklenen dosya tırnak içinde ya da boşlukları kaçırılmış gelebilir.
	if (/^'.*'$/.test(yol) || /^".*"$/.test(yol)) yol = yol.slice(1, -1);
	else yol = yol.replace(/\\(.)/g, '$1');
	if (yol.startsWith('file://')) {
		try {
			yol = decodeURIComponent(new URL(yol).pathname);
		} catch {}
	}
	if (yol === '~' || yol.startsWith('~/')) yol = path.join(os.homedir(), yol.slice(1));
	return path.resolve(yol);
}

// İndirilenler klasörü: XDG ayarı, yoksa ~/Downloads ya da ~/İndirilenler, o da yoksa ev dizini.
function indirmeKlasoru() {
	const ev = os.homedir();
	try {
		const ayar = fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME || path.join(ev, '.config'), 'user-dirs.dirs'), 'utf8');
		const m = ayar.match(/^XDG_DOWNLOAD_DIR="?([^"\n]+)"?/m);
		if (m) {
			const yol = m[1].replace(/^\$HOME/, ev);
			if (fs.statSync(yol).isDirectory()) return yol;
		}
	} catch {}
	for (const ad of ['Downloads', 'İndirilenler']) {
		try {
			if (fs.statSync(path.join(ev, ad)).isDirectory()) return path.join(ev, ad);
		} catch {}
	}
	return ev;
}

// Var olan dosyanın üstüne yazmamak için "ad (2).uzantı" gibi boş bir yol bul.
function bosYol(klasor, ad) {
	ad = path.basename(String(ad || 'dosya')).replace(/[\0/]/g, '_') || 'dosya';
	const uz = path.extname(ad);
	const govde = ad.slice(0, ad.length - uz.length);
	let yol = path.join(klasor, ad);
	for (let i = 2; fs.existsSync(yol); i++) yol = path.join(klasor, `${govde} (${i})${uz}`);
	return yol;
}

// Blob / File / DiskDosyasi içeriğini diske yaz.
async function diskeYaz(nesne, yol) {
	if (nesne instanceof DiskDosyasi) {
		await fs.promises.copyFile(nesne.yol, yol);
		return;
	}
	const tutamac = await fs.promises.open(yol, 'w', 0o644);
	try {
		// Büyük Blob'lar parça parça yazılır.
		const PARCA = 8 * 1024 * 1024;
		for (let i = 0; i < nesne.size; i += PARCA) await tutamac.write(Buffer.from(await nesne.slice(i, Math.min(nesne.size, i + PARCA)).arrayBuffer()));
	} finally {
		await tutamac.close();
	}
}

// Blob adresleri (URL.createObjectURL): adres → nesne.
class BlobAdresleri {
	constructor(koken) {
		this.koken = koken;
		this.kayit = new Map();
	}
	olustur(nesne) {
		const adres = `blob:${this.koken}/${crypto.randomUUID()}`;
		this.kayit.set(adres, nesne);
		return adres;
	}
	sil(adres) {
		this.kayit.delete(String(adres));
	}
	bul(adres) {
		return this.kayit.get(String(adres)) || null;
	}
}

// showSaveFilePicker'ın döndürdüğü tutamaç: doğrudan diske yazar.
function kayitTutamaci(yol) {
	return {
		kind: 'file',
		name: path.basename(yol),
		yol,
		async createWritable() {
			const tutamac = await fs.promises.open(yol, 'w', 0o644);
			let kapali = false;
			const yaz = async (veri) => {
				if (veri && typeof veri === 'object' && 'type' in veri && veri.type === 'write') veri = veri.data;
				if (veri && typeof veri.arrayBuffer === 'function') veri = await veri.arrayBuffer();
				if (typeof veri === 'string') veri = Buffer.from(veri, 'utf8');
				const b = Buffer.isBuffer(veri) ? veri : ArrayBuffer.isView(veri) ? Buffer.from(veri.buffer, veri.byteOffset, veri.byteLength) : Buffer.from(veri);
				await tutamac.write(b);
			};
			return {
				write: yaz,
				async close() {
					if (kapali) return;
					kapali = true;
					await tutamac.close();
				},
				async abort() {
					if (kapali) return;
					kapali = true;
					await tutamac.close();
					await fs.promises.unlink(yol).catch(() => {});
				},
			};
		},
		async getFile() {
			return new DiskDosyasi(yol);
		},
	};
}

module.exports = { DiskDosyasi, BlobAdresleri, yolAc, indirmeKlasoru, bosYol, diskeYaz, kayitTutamaci, turBul };
