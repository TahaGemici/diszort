// PulseAudio yerel protokolü — saf JavaScript istemcisi.
//
// Linux masaüstlerinde ses sunucusu ya PulseAudio'dur ya da PipeWire'ın PulseAudio uyumluluk
// katmanı (pipewire-pulse); ikisi de aynı protokolü aynı Unix soketinde ($XDG_RUNTIME_DIR/pulse/native)
// konuşur. Tarayıcılar da (Firefox: cubeb, Chrome) sese bu yoldan ulaşır. Burada libpulse yerine
// protokolün kendisi konuşulur: yerel (native) kitaplık, derleme ya da kurulum gerekmez.
//
// Kapsam: kimlik doğrulama, aygıt listeleri (çıkışlar, girişler, "Monitor of …"), varsayılanlar,
// değişiklik olayları (aygıt takıldı/çıkarıldı, varsayılan değişti), çalma ve kayıt akışları
// (ses verisi soketten akar; paylaşılan bellek kullanılmaz), gecikme ölçümü, modül yükleme.
//
// Protokol: her paket 20 baytlık bir başlıkla başlar (uzunluk, kanal, konum ×2, bayraklar; büyük
// uçlu). Kanal 0xFFFFFFFF ise yük bir komuttur ("tagstruct": her değerin önünde bir tür baytı),
// değilse o akışın ham ses verisidir. Sürüm 32 konuşulur (PulseAudio 6+ ve pipewire-pulse; alan
// sıraları PulseAudio kaynağındaki PROTOCOL dosyasına ve protocol-native.c'ye göre).
'use strict';

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const SURUM = 32;
const GECERSIZ = 0xffffffff;
const SES_NORMAL = 0x10000; // PA_VOLUME_NORM

const KOMUT = {
	HATA: 0,
	ZAMAN_ASIMI: 1,
	YANIT: 2,
	CALMA_AC: 3,
	CALMA_SIL: 4,
	KAYIT_AC: 5,
	KAYIT_SIL: 6,
	KIMLIK: 8,
	ISTEMCI_ADI: 9,
	CALMA_GECIKMESI: 14,
	SUNUCU_BILGISI: 20,
	CIKIS_LISTESI: 22,
	GIRIS_LISTESI: 24,
	ABONE: 35,
	CALMA_DURAKLAT: 41,
	CALMA_BOSALT: 42,
	MODUL_YUKLE: 51,
	MODUL_KALDIR: 52,
	KAYIT_GECIKMESI: 57,
	KAYIT_DURAKLAT: 58,
	ISTEK: 61,
	TASMA: 62,
	BOSALMA: 63,
	CALMA_OLDURULDU: 64,
	KAYIT_OLDURULDU: 65,
	ABONE_OLAYI: 66,
	CALMA_ASKIDA: 76,
	KAYIT_ASKIDA: 77,
	CALMA_TASINDI: 78,
	KAYIT_TASINDI: 79,
	BASLADI: 86,
};

// Örnek biçimleri (PA_SAMPLE_*).
const BICIM = { s16le: 3, float32le: 5 };
const ORNEK_BAYTI = { s16le: 2, float32le: 4 };

// Olay tesisleri (PA_SUBSCRIPTION_EVENT_*) ve abonelik maskesi.
const TESIS = ['cikis', 'giris', 'cikis-akisi', 'giris-akisi', 'modul', 'istemci', 'ornek', 'sunucu', '', 'kart'];
const ABONE_MASKESI = 0x01 | 0x02 | 0x80 | 0x200; // çıkışlar, girişler, sunucu (varsayılanlar), kartlar

const HATA_ADLARI = ['tamam', 'erişim reddedildi', 'bilinmeyen komut', 'geçersiz değer', 'zaten var', 'böyle bir şey yok', 'bağlantı reddedildi', 'protokol hatası', 'zaman aşımı', 'kimlik anahtarı yok', 'iç hata', 'bağlantı kesildi', 'öldürüldü', 'geçersiz sunucu', 'modül başlatılamadı', 'kötü durum', 'veri yok', 'sürüm uyuşmuyor', 'çok büyük', 'desteklenmiyor', 'bilinmiyor', 'uzantı yok', 'eskimiş', 'gerçeklenmemiş', 'istemci çatallandı', 'giriş/çıkış hatası', 'meşgul'];

// ---------------------------------------------------------------- tagstruct yazma / okuma

class Yazar {
	constructor() {
		this.parcalar = [];
	}
	ham(...baytlar) {
		this.parcalar.push(Buffer.from(baytlar));
		return this;
	}
	u32(v) {
		const b = Buffer.alloc(5);
		b[0] = 0x4c; // 'L'
		b.writeUInt32BE(v >>> 0, 1);
		this.parcalar.push(b);
		return this;
	}
	u8(v) {
		return this.ham(0x42, v & 0xff); // 'B'
	}
	metin(s) {
		if (s == null) return this.ham(0x4e); // 'N'
		this.parcalar.push(Buffer.from([0x74]), Buffer.from(String(s), 'utf8'), Buffer.from([0])); // 't'
		return this;
	}
	mantik(v) {
		return this.ham(v ? 0x31 : 0x30);
	}
	zaman(ms) {
		const b = Buffer.alloc(9);
		b[0] = 0x54; // 'T'
		b.writeUInt32BE(Math.floor(ms / 1000) >>> 0, 1);
		b.writeUInt32BE(Math.floor((ms % 1000) * 1000) >>> 0, 5);
		this.parcalar.push(b);
		return this;
	}
	bayt(veri) {
		const b = Buffer.alloc(5);
		b[0] = 0x78; // 'x'
		b.writeUInt32BE(veri.length, 1);
		this.parcalar.push(b, veri);
		return this;
	}
	ornekBicimi(bicim, kanal, hiz) {
		const b = Buffer.alloc(7);
		b[0] = 0x61; // 'a'
		b[1] = BICIM[bicim];
		b[2] = kanal;
		b.writeUInt32BE(hiz, 3);
		this.parcalar.push(b);
		return this;
	}
	// Kanal haritası: tek kanal = mono (0), iki kanal = sol, sağ (1, 2).
	kanalHaritasi(kanal) {
		return this.ham(0x6d, kanal, ...(kanal === 1 ? [0] : [1, 2])); // 'm'
	}
	sesDuzeyleri(kanal, v = SES_NORMAL) {
		const b = Buffer.alloc(2 + 4 * kanal);
		b[0] = 0x76; // 'v'
		b[1] = kanal;
		for (let i = 0; i < kanal; i++) b.writeUInt32BE(v, 2 + 4 * i);
		this.parcalar.push(b);
		return this;
	}
	ozellikler(nesne) {
		this.ham(0x50); // 'P'
		for (const [k, v] of Object.entries(nesne || {})) {
			if (v == null) continue;
			const deger = Buffer.concat([Buffer.from(String(v), 'utf8'), Buffer.from([0])]);
			this.metin(k).u32(deger.length).bayt(deger);
		}
		return this.ham(0x4e);
	}
	bitir() {
		return Buffer.concat(this.parcalar);
	}
}

class Okur {
	constructor(b) {
		this.b = b;
		this.i = 0;
	}
	get bitti() {
		return this.i >= this.b.length;
	}
	bekle(tur) {
		if (this.b[this.i] !== tur) throw new Error(`ses sunucusu yanıtı beklenmedik (0x${(this.b[this.i] ?? 0).toString(16)}, beklenen 0x${tur.toString(16)}, konum ${this.i})`);
		this.i++;
	}
	u32() {
		this.bekle(0x4c);
		const v = this.b.readUInt32BE(this.i);
		this.i += 4;
		return v;
	}
	metin() {
		if (this.b[this.i] === 0x4e) {
			this.i++;
			return null;
		}
		this.bekle(0x74);
		const son = this.b.indexOf(0, this.i);
		if (son < 0) throw new Error('ses sunucusu yanıtı yarım (metin)');
		const s = this.b.toString('utf8', this.i, son);
		this.i = son + 1;
		return s;
	}
	mantik() {
		const t = this.b[this.i++];
		if (t !== 0x31 && t !== 0x30) throw new Error('ses sunucusu yanıtı beklenmedik (mantık)');
		return t === 0x31;
	}
	// Mikrosaniye (64 bit) → milisaniye.
	usec() {
		this.bekle(0x55);
		const v = Number(this.b.readBigUInt64BE(this.i)) / 1000;
		this.i += 8;
		return v;
	}
	ornekBicimi() {
		this.bekle(0x61);
		const v = { bicim: this.b[this.i], kanal: this.b[this.i + 1], hiz: this.b.readUInt32BE(this.i + 2) };
		this.i += 6;
		return v;
	}
	ozellikler() {
		this.bekle(0x50);
		const o = {};
		for (;;) {
			const k = this.metin();
			if (k === null) return o;
			this.u32();
			this.bekle(0x78);
			const n = this.b.readUInt32BE(this.i);
			this.i += 4;
			o[k] = this.b.toString('utf8', this.i, this.i + n).replace(/\0+$/, '');
			this.i += n;
		}
	}
	// Türü ne olursa olsun bir değeri atla (şemanın kullanılmayan alanları).
	atla(adet = 1) {
		for (let k = 0; k < adet; k++) {
			const t = this.b[this.i];
			switch (t) {
				case 0x4c: // u32
				case 0x56: // ses düzeyi
					this.i += 5;
					break;
				case 0x42: // u8
					this.i += 2;
					break;
				case 0x74:
				case 0x4e:
					this.metin();
					break;
				case 0x31:
				case 0x30:
					this.i++;
					break;
				case 0x54: // zaman
				case 0x55: // usec
				case 0x52: // u64
				case 0x72: // s64
					this.i += 9;
					break;
				case 0x61:
					this.i += 7;
					break;
				case 0x6d: // kanal haritası
					this.i += 2 + this.b[this.i + 1];
					break;
				case 0x76: // kanal ses düzeyleri
					this.i += 2 + 4 * this.b[this.i + 1];
					break;
				case 0x78:
					this.i += 5 + this.b.readUInt32BE(this.i + 1);
					break;
				case 0x50:
					this.ozellikler();
					break;
				case 0x66: // biçim bilgisi: u8 kodlama + özellikler
					this.i++;
					this.atla(2);
					break;
				default:
					throw new Error(`ses sunucusu yanıtında bilinmeyen tür 0x${(t ?? 0).toString(16)} (konum ${this.i})`);
			}
		}
	}
}

// ---------------------------------------------------------------- bağlantı

// Sunucunun soketi: PULSE_SERVER (unix:/yol ya da /yol), yoksa çalışma dizinlerindeki pulse/native.
function soketYollari() {
	const yollar = [];
	const sunucu = process.env.PULSE_SERVER;
	if (sunucu) {
		for (const parca of sunucu.split(/\s+/)) {
			const p = parca.replace(/^\{[^}]*\}/, '');
			if (p.startsWith('unix:')) yollar.push(p.slice(5));
			else if (p.startsWith('/')) yollar.push(p);
		}
	}
	if (process.env.PULSE_RUNTIME_PATH) yollar.push(path.join(process.env.PULSE_RUNTIME_PATH, 'native'));
	if (process.env.XDG_RUNTIME_DIR) yollar.push(path.join(process.env.XDG_RUNTIME_DIR, 'pulse', 'native'));
	const uid = typeof process.getuid === 'function' ? process.getuid() : null;
	if (uid != null) yollar.push(`/run/user/${uid}/pulse/native`);
	yollar.push('/var/run/pulse/native');
	return [...new Set(yollar)];
}

function kimlikAnahtari() {
	const adaylar = [process.env.PULSE_COOKIE, path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pulse', 'cookie'), path.join(os.homedir(), '.pulse-cookie')];
	for (const yol of adaylar) {
		if (!yol) continue;
		try {
			const b = fs.readFileSync(yol);
			if (b.length === 256) return b;
		} catch {}
	}
	// Anahtar yoksa da denenir: aynı kullanıcının soketine bağlanan istemciyi sunucu (PulseAudio
	// soket kimliğinden, pipewire-pulse soket izninden) zaten tanır.
	return Buffer.alloc(256);
}

class PulseHatasi extends Error {
	constructor(kod, komut) {
		super(`ses sunucusu: ${HATA_ADLARI[kod] || 'hata ' + kod}`);
		this.name = 'PulseHatasi';
		this.kod = kod;
		this.komut = komut;
	}
}

class PulseBaglantisi extends EventEmitter {
	constructor(soket) {
		super();
		this.soket = soket;
		this.etiket = 0;
		this.bekleyen = new Map(); // etiket -> { coz, reddet, komut }
		// Akış numaraları (protokoldeki "kanal") çalma ve kayıt için ayrı ayrı sayılır.
		this.calmalar = new Map(); // akış no -> çalma akışı
		this.kayitlar = new Map(); // akış no -> kayıt akışı
		this.esleme = 1; // her çalma akışına ayrı eşzamanlama kimliği (aynı kimlik akışları birbirine bağlar)
		this.tampon = [];
		this.tamponBoy = 0;
		this.kapali = false;
		this.surum = SURUM;
		soket.on('data', (d) => this.veriGeldi(d));
		soket.on('error', (h) => this.koptu(h));
		soket.on('close', () => this.koptu(null));
	}

	// Bağlan, kimliği doğrula, adını bildir. Sunucu yoksa (soket yok / reddedildi) hata.
	static async baglan({ ad = 'Diszort', ozellikler = {} } = {}) {
		let sonHata = null;
		for (const yol of soketYollari()) {
			let soket;
			try {
				soket = await new Promise((coz, reddet) => {
					const s = net.createConnection({ path: yol });
					s.once('connect', () => coz(s));
					s.once('error', reddet);
				});
			} catch (h) {
				sonHata = h;
				continue;
			}
			const b = new PulseBaglantisi(soket);
			try {
				const y = await b.komut(KOMUT.KIMLIK, (w) => w.u32(SURUM).bayt(kimlikAnahtari()));
				b.surum = Math.min(SURUM, y.u32() & 0xffff);
				if (b.surum < 13) throw new Error('ses sunucusu çok eski (protokol ' + b.surum + ')');
				await b.komut(KOMUT.ISTEMCI_ADI, (w) =>
					w.ozellikler({ 'application.name': ad, 'application.icon_name': 'audio-headset', 'application.process.id': process.pid, 'application.process.binary': 'diszort', ...ozellikler }),
				);
				b.yol = yol;
				return b;
			} catch (h) {
				sonHata = h;
				b.kapat();
			}
		}
		throw Object.assign(new Error('Ses sunucusuna bağlanılamadı (PulseAudio ya da PipeWire çalışıyor mu?)' + (sonHata ? ': ' + sonHata.message : '')), { name: 'NotFoundError' });
	}

	koptu(hata) {
		if (this.kapali) return;
		this.kapali = true;
		const h = hata || new Error('ses sunucusu bağlantısı kapandı');
		for (const b of this.bekleyen.values()) b.reddet(h);
		this.bekleyen.clear();
		for (const a of [...this.calmalar.values(), ...this.kayitlar.values()]) a.olduruldu();
		this.calmalar.clear();
		this.kayitlar.clear();
		try {
			this.soket.destroy();
		} catch {}
		this.emit('kapandi', hata);
	}

	kapat() {
		this.koptu(null);
	}

	paket(kanal, yuk) {
		const bas = Buffer.alloc(20);
		bas.writeUInt32BE(yuk.length, 0);
		bas.writeUInt32BE(kanal >>> 0, 4);
		return this.soket.write(Buffer.concat([bas, yuk]));
	}

	// Komut gönder; yanıtın Okur'u döner (yanıtın başındaki komut ve etiket okunmuş olarak).
	komut(kod, doldur) {
		if (this.kapali) return Promise.reject(new Error('ses sunucusu bağlantısı kapalı'));
		const etiket = this.etiket++;
		const w = new Yazar().u32(kod).u32(etiket);
		if (doldur) doldur(w);
		return new Promise((coz, reddet) => {
			this.bekleyen.set(etiket, { coz, reddet, komut: kod });
			this.paket(GECERSIZ, w.bitir());
		});
	}

	veriGeldi(d) {
		this.tampon.push(d);
		this.tamponBoy += d.length;
		for (;;) {
			if (this.tamponBoy < 20) return;
			if (this.tampon[0].length < 20) this.tampon = [Buffer.concat(this.tampon)];
			const bas = this.tampon[0];
			const boy = bas.readUInt32BE(0);
			if (this.tamponBoy < 20 + boy) return;
			const hepsi = this.tampon.length === 1 ? bas : Buffer.concat(this.tampon);
			const kanal = hepsi.readUInt32BE(4);
			const yuk = hepsi.subarray(20, 20 + boy);
			const kalan = hepsi.subarray(20 + boy);
			this.tampon = kalan.length ? [kalan] : [];
			this.tamponBoy = kalan.length;
			try {
				if (kanal === GECERSIZ) this.komutGeldi(new Okur(yuk));
				else {
					const a = this.kayitlar.get(kanal);
					if (a) a.veri(yuk);
				}
			} catch (h) {
				this.emit('hata', h);
			}
		}
	}

	komutGeldi(r) {
		const kod = r.u32();
		const etiket = r.u32();
		if (kod === KOMUT.YANIT || kod === KOMUT.HATA) {
			const b = this.bekleyen.get(etiket);
			if (!b) return;
			this.bekleyen.delete(etiket);
			if (kod === KOMUT.HATA) b.reddet(new PulseHatasi(r.u32(), b.komut));
			else b.coz(r);
			return;
		}
		if (kod === KOMUT.ABONE_OLAYI) {
			const olay = r.u32();
			const indeks = r.u32();
			this.emit('olay', { tesis: TESIS[olay & 0x0f] || '', tur: ['yeni', 'degisti', 'silindi'][(olay & 0x30) >> 4] || '', indeks });
			return;
		}
		// Kalanlar bir akışa aittir (ilk alan akışın numarası).
		const kayit = kod === KOMUT.KAYIT_OLDURULDU || kod === KOMUT.KAYIT_ASKIDA || kod === KOMUT.KAYIT_TASINDI;
		const a = (kayit ? this.kayitlar : this.calmalar).get(r.u32());
		if (!a) return;
		switch (kod) {
			case KOMUT.ISTEK:
				a.istekGeldi(r.u32());
				break;
			case KOMUT.BOSALMA:
				a.emit('bosaldi');
				break;
			case KOMUT.TASMA:
				a.emit('tasti');
				break;
			case KOMUT.BASLADI:
				a.emit('basladi');
				break;
			case KOMUT.CALMA_OLDURULDU:
			case KOMUT.KAYIT_OLDURULDU:
				(kayit ? this.kayitlar : this.calmalar).delete(a.no);
				a.olduruldu();
				break;
			case KOMUT.CALMA_ASKIDA:
			case KOMUT.KAYIT_ASKIDA:
				a.emit('askida', r.mantik());
				break;
			case KOMUT.CALMA_TASINDI:
			case KOMUT.KAYIT_TASINDI: {
				r.u32();
				const ad = r.metin();
				a.aygit = ad;
				a.emit('tasindi', ad);
				break;
			}
		}
	}

	// ------------------------------------------------------------ bilgi

	async sunucuBilgisi() {
		const r = await this.komut(KOMUT.SUNUCU_BILGISI);
		const ad = r.metin();
		const surum = r.metin();
		r.atla(2); // kullanıcı, makine
		const bicim = r.ornekBicimi();
		return { ad, surum, hiz: bicim.hiz, kanal: bicim.kanal, varsayilanCikis: r.metin(), varsayilanGiris: r.metin() };
	}

	// Aygıt kaydının ortak başı (çıkış ve giriş aynı sırada): dizin, ad, açıklama, biçim, …
	aygitOku(r) {
		const a = { indeks: r.u32(), ad: r.metin(), aciklama: r.metin() };
		const bicim = r.ornekBicimi();
		a.kanal = bicim.kanal;
		a.hiz = bicim.hiz;
		r.atla(4); // kanal haritası, sahibi modül, ses düzeyleri, sessiz
		a.esIndeks = r.u32(); // çıkışta: monitör girişi; girişte: monitörü olduğu çıkış (yoksa geçersiz)
		a.esAd = r.metin();
		r.atla(3); // gecikme, sürücü, bayraklar
		a.ozellikler = r.ozellikler();
		r.atla(1); // ayarlanan gecikme
		if (this.surum >= 15) r.atla(4); // taban ses, durum, adım sayısı, kart
		if (this.surum >= 16) {
			const kapi = r.u32();
			for (let i = 0; i < kapi; i++) {
				r.atla(3); // ad, açıklama, öncelik
				if (this.surum >= 24) r.atla(1); // kullanılabilir
				if (this.surum >= 34) r.atla(2); // grup, tür
			}
			r.atla(1); // etkin kapı
		}
		return a;
	}
	bicimleriAtla(r) {
		r.bekle(0x42);
		const n = r.b[r.i++];
		r.atla(n);
	}

	// Çıkış aygıtları (hoparlörler). monitor: o çıkışta çalanı veren girişin adı.
	async cikislar() {
		const r = await this.komut(KOMUT.CIKIS_LISTESI);
		const liste = [];
		while (!r.bitti) {
			const a = this.aygitOku(r);
			if (this.surum >= 21) this.bicimleriAtla(r);
			liste.push({ indeks: a.indeks, ad: a.ad, aciklama: a.aciklama || a.ad, kanal: a.kanal, hiz: a.hiz, monitor: a.esAd || '', ozellikler: a.ozellikler });
		}
		return liste;
	}

	// Giriş aygıtları (mikrofonlar ve çıkışların monitörleri). monitorMu: bir çıkışın sesini verir.
	async girisler() {
		const r = await this.komut(KOMUT.GIRIS_LISTESI);
		const liste = [];
		while (!r.bitti) {
			const a = this.aygitOku(r);
			if (this.surum >= 22) this.bicimleriAtla(r);
			liste.push({ indeks: a.indeks, ad: a.ad, aciklama: a.aciklama || a.ad, kanal: a.kanal, hiz: a.hiz, monitorMu: a.esIndeks !== GECERSIZ, cikis: a.esAd || '', ozellikler: a.ozellikler });
		}
		return liste;
	}

	// Aygıt/varsayılan değişikliklerini 'olay' olarak bildir.
	async aboneOl() {
		await this.komut(KOMUT.ABONE, (w) => w.u32(ABONE_MASKESI));
	}

	async modulYukle(ad, arguman = '') {
		const r = await this.komut(KOMUT.MODUL_YUKLE, (w) => w.metin(ad).metin(arguman));
		return r.u32();
	}
	async modulKaldir(indeks) {
		await this.komut(KOMUT.MODUL_KALDIR, (w) => w.u32(indeks));
	}

	// ------------------------------------------------------------ akışlar

	akisBasi(w, { bicim, kanal, hiz, aygit }) {
		w.ornekBicimi(bicim, kanal, hiz).kanalHaritasi(kanal).u32(GECERSIZ).metin(aygit || null);
	}
	akisBayraklari(w) {
		// yeniden eşleme yok, karıştırma yok, biçim/hız/kanal sabitleme, taşınmasın, değişken hız: hepsi kapalı
		for (let i = 0; i < 7; i++) w.mantik(false);
	}

	// Çalma akışı. hedefMs: sunucuda tutulacak ses (gecikme hedefi). Akış hemen çalar (ön tampon yok):
	// veri yetişmezse sessizlik çalınır, akış durmaz.
	async calmaAc({ aygit = '', hiz = 48000, kanal = 2, bicim = 'float32le', hedefMs = 40, ad = 'Diszort', rol = 'phone', ozellikler = {} } = {}) {
		const cerceve = kanal * ORNEK_BAYTI[bicim];
		const bayt = (ms) => Math.max(cerceve, Math.round((hiz * ms) / 1000) * cerceve);
		const r = await this.komut(KOMUT.CALMA_AC, (w) => {
			this.akisBasi(w, { bicim, kanal, hiz, aygit });
			w.u32(GECERSIZ) // en çok (sunucunun sınırı)
				.mantik(false) // duraklatılmış başlama
				.u32(bayt(hedefMs)) // hedef uzunluk
				.u32(0) // ön tampon yok
				.u32(bayt(Math.min(10, hedefMs / 2))) // en küçük istek
				.u32(this.esleme++) // eşzamanlama kimliği
				.sesDuzeyleri(kanal);
			this.akisBayraklari(w);
			w.mantik(false) // sessiz başlama
				.mantik(true) // gecikmeyi hedefe göre ayarla
				.ozellikler({ 'media.name': ad, 'media.role': rol, ...ozellikler })
				.mantik(false) // ses düzeyi verildi
				.mantik(false) // erken istek
				.mantik(false) // sessizlik verildi
				.mantik(false) // otomatik askıyı engelleme
				.mantik(false) // askıdaysa başarısız ol
				.mantik(false) // göreli ses
				.mantik(false) // geçiş (passthrough)
				.u8(0); // biçim listesi yok: örnek biçimi geçerli
		});
		const akis = new OynatmaAkisi(this, this.calmalar, r.u32(), { hiz, kanal, bicim, cerceve });
		akis.indeks = r.u32();
		akis.kredi = r.u32();
		r.atla(1); // en çok
		akis.hedef = r.u32();
		r.atla(4); // ön tampon, en küçük istek, örnek biçimi, kanal haritası
		r.atla(1); // aygıt dizini
		akis.aygit = r.metin();
		this.calmalar.set(akis.no, akis);
		return akis;
	}

	// Kayıt akışı. parcaMs: sunucunun veriyi göndereceği parça boyu.
	async kayitAc({ aygit = '', hiz = 48000, kanal = 1, bicim = 'float32le', parcaMs = 10, ad = 'Diszort', ozellikler = {} } = {}) {
		const cerceve = kanal * ORNEK_BAYTI[bicim];
		const r = await this.komut(KOMUT.KAYIT_AC, (w) => {
			this.akisBasi(w, { bicim, kanal, hiz, aygit });
			w.u32(GECERSIZ) // en çok
				.mantik(false) // duraklatılmış başlama
				.u32(Math.max(cerceve, Math.round((hiz * parcaMs) / 1000) * cerceve)); // parça boyu
			this.akisBayraklari(w);
			w.mantik(false) // tepe ölçümü
				.mantik(true) // gecikmeyi parçaya göre ayarla
				.ozellikler({ 'media.name': ad, ...ozellikler })
				.u32(GECERSIZ) // belirli bir çalma akışından kayıt yok
				.mantik(false) // erken istek
				.mantik(false) // otomatik askıyı engelleme
				.mantik(false); // askıdaysa başarısız ol
			if (this.surum >= 22) {
				w.u8(0).sesDuzeyleri(kanal);
				for (let i = 0; i < 5; i++) w.mantik(false); // sessiz, ses verildi, sessizlik verildi, göreli ses, geçiş
			}
		});
		const akis = new KayitAkisi(this, this.kayitlar, r.u32(), { hiz, kanal, bicim, cerceve });
		akis.indeks = r.u32();
		r.atla(2); // en çok, parça boyu
		r.atla(2); // örnek biçimi, kanal haritası
		r.atla(1); // aygıt dizini
		akis.aygit = r.metin();
		this.kayitlar.set(akis.no, akis);
		return akis;
	}
}

class Akis extends EventEmitter {
	// no: akışın protokoldeki numarası; bicim: { hiz, kanal (kanal sayısı), bicim, cerceve (bayt) }.
	constructor(baglanti, liste, no, bicim) {
		super();
		this.baglanti = baglanti;
		this.liste = liste;
		this.no = no;
		Object.assign(this, bicim);
		this.kapali = false;
		this.aygit = '';
	}
	olduruldu() {
		if (this.kapali) return;
		this.kapali = true;
		this.emit('olduruldu');
	}
	kapatKomutu(kod) {
		if (this.kapali) return;
		this.kapali = true;
		this.liste.delete(this.no);
		if (!this.baglanti.kapali) this.baglanti.komut(kod, (w) => w.u32(this.no)).catch(() => {});
	}
}

class OynatmaAkisi extends Akis {
	constructor(...a) {
		super(...a);
		this.kredi = 0; // sunucunun istediği, henüz yazılmamış bayt (eksi: fazladan yazıldı)
		this.hedef = 0; // sunucunun kabul ettiği hedef uzunluk (bayt)
	}
	istekGeldi(n) {
		this.kredi += n;
		this.emit('istek', n);
	}
	// Sunucuda bekleyen ses (bayt, yaklaşık): hedef − istenen.
	get dolu() {
		return this.hedef - this.kredi;
	}
	yaz(veri) {
		if (this.kapali || !veri.length) return;
		this.kredi -= veri.length;
		this.baglanti.paket(this.no, veri);
	}
	// Sunucunun ölçtüğü çıkış gecikmesi (ms): akış tamponu + aygıt.
	async gecikme() {
		const r = await this.baglanti.komut(KOMUT.CALMA_GECIKMESI, (w) => w.u32(this.no).zaman(Date.now()));
		const aygit = r.usec();
		r.atla(4); // kaynak gecikmesi, çalıyor, yerel zaman, uzak zaman
		const yazma = Number(r.b.readBigInt64BE(r.i + 1));
		const okuma = Number(r.b.readBigInt64BE(r.i + 10));
		return aygit + (Math.max(0, yazma - okuma) / this.cerceve / this.hiz) * 1000;
	}
	bosalt() {
		if (!this.kapali) this.baglanti.komut(KOMUT.CALMA_BOSALT, (w) => w.u32(this.no)).catch(() => {});
	}
	kapat() {
		this.kapatKomutu(KOMUT.CALMA_SIL);
	}
}

class KayitAkisi extends Akis {
	veri(yuk) {
		this.emit('veri', yuk);
	}
	kapat() {
		this.kapatKomutu(KOMUT.KAYIT_SIL);
	}
}

module.exports = { PulseBaglantisi, PulseHatasi, soketYollari };
