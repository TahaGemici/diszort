// Ses motoru: tarayıcının ses düzeninin karşılığı.
//
// Tarayıcıda sayfanın sesi üç yoldan geçer: mikrofon → (Web Audio) → WebRTC göndericisi; WebRTC
// alıcısı → <audio> öğesi → hoparlör; ve Web Audio grafiği (seviye ölçerler, bildirim sesleri,
// AudioWorklet'ler). Burada hepsini tek bir motor yürütür: bilgisayarın saatiyle, 128 örneklik
// kuantumlarla (Web Audio'nun işleme birimi), 48 kHz'de.
//
//   yakalama (PulseAudio kaydı) ─┐                         ┌→ WebRTC (RTCAudioSource, 10 ms'lik çerçeveler)
//   uzak izler (RTCAudioSink) ───┼→ izlerin blokları → grafik ─┤
//                                └→ <audio> öğeleri ───────────┴→ çıkış aygıtları (PulseAudio çalma)
//
// Her iz (MediaStreamTrack) için bir kayıt tutulur; her kuantumda izin o kuantuma ait bloğu
// hazırlanır, onu kim kullanıyorsa (öğe, MediaStreamSource düğümü, WebRTC) aynı bloğu okur. Aygıtlarla
// motor arasındaki saat farkı yeniden örneklemeyle giderilir (ornekleyici.js).
'use strict';

const { Ornekleyici, OranDenetimi } = require('./ornekleyici');

const HIZ = 48000;
const KUANTUM = 128;
const ON_MS = 480; // 10 ms (WebRTC'nin çerçeve boyu)
const MS = HIZ / 1000;
const YAKALAMA_TAMPON_MS = 25;

// ---------------------------------------------------------------- izler

// Bir izin o kuantumdaki sesi: blok[k] (k < kanal). bos: blok tam sessizlik (kullanan atlayabilir).
class IzKaydi {
	constructor(motor, tur, kanal) {
		this.motor = motor;
		this.tur = tur; // 'yakalama' | 'hedef' | 'uzak'
		this.kanal = kanal;
		this.blok = [new Float32Array(KUANTUM), new Float32Array(KUANTUM)];
		this.bos = true;
		this.iz = null; // yerel (wrtc) MediaStreamTrack
		this.sonKullanim = -1e9; // en son hangi kuantumda okundu
	}
	sustur() {
		if (this.bos) return;
		this.blok[0].fill(0);
		this.blok[1].fill(0);
		this.bos = true;
	}
	// Kullanan (öğe, kaynak düğümü) her kuantumda çağırır: iz etkin kalır.
	kullan() {
		this.sonKullanim = this.motor.kuantumNo;
	}
}

// Gönderilebilen iz (mikrofon, MediaStreamDestination çıkışı): bloklar 10 ms'lik 16 bit çerçevelere
// toplanıp WebRTC'ye verilir. Göndericiye bağlı değilken de verilir (kimse dinlemiyorsa atılır).
class GidenIz extends IzKaydi {
	constructor(motor, tur, kanal) {
		super(motor, tur, kanal);
		this.kaynak = new motor.wrtc.nonstandard.RTCAudioSource();
		this.iz = this.kaynak.createTrack();
		this.cerceve = new Int16Array(ON_MS * kanal);
		this.dolu = 0;
		this.bitti = false;
		motor.izler.set(this.iz, this);
	}
	// Bu kuantumun bloğunu WebRTC çerçevesine ekle.
	gonder() {
		if (this.bitti) return;
		const k = this.kanal;
		const c = this.cerceve;
		const l = this.blok[0];
		const r = this.blok[1];
		for (let i = 0; i < KUANTUM; i++) {
			if (k === 1) c[this.dolu] = ornek16(l[i]);
			else {
				c[2 * this.dolu] = ornek16(l[i]);
				c[2 * this.dolu + 1] = ornek16(r[i]);
			}
			if (++this.dolu === ON_MS) {
				this.dolu = 0;
				try {
					// Kaynak çerçeveyi hemen kopyalar; aynı dizi yeniden kullanılır.
					this.kaynak.onData({ samples: c, sampleRate: HIZ, bitsPerSample: 16, channelCount: k, numberOfFrames: ON_MS });
				} catch (h) {
					this.motor.gunluk('ses çerçevesi verilemedi', h);
				}
			}
		}
	}
}
const ornek16 = (x) => (x >= 1 ? 32767 : x <= -1 ? -32768 : Math.round(x * 32767));

// Ses aygıtından (mikrofon ya da bir çıkışın monitörü) yakalanan iz.
class YakalamaIzi extends GidenIz {
	constructor(motor, { kanal, aygit, etiket }) {
		super(motor, 'yakalama', kanal);
		this.aygit = aygit; // PulseAudio giriş adı ('' = varsayılan)
		this.etiket = etiket;
		this.akis = null;
		this.ornekleyici = new Ornekleyici(kanal);
		// Tamponda ortalama 25 ms: aygıtın verisi 10-21 ms'lik parçalarla ve düzensiz gelir; tampon
		// boşalırsa mikrofonun sesinde boşluk olur.
		this.denetim = new OranDenetimi(YAKALAMA_TAMPON_MS);
		this.ara = new Float32Array(KUANTUM * kanal);
		this.artik = Buffer.alloc(0); // çerçeveye tamamlanmamış baytlar
		this.basladi = false;
		this.bosalma = 0;
	}
	// Aygıttan gelen ham veri (float32le, kanalları iç içe).
	veriGeldi(yuk) {
		if (this.bitti) return;
		if (this.artik.length) yuk = Buffer.concat([this.artik, yuk]);
		const bayt = this.kanal * 4;
		const cerceve = Math.floor(yuk.length / bayt);
		this.artik = yuk.length % bayt ? Buffer.from(yuk.subarray(cerceve * bayt)) : Buffer.alloc(0);
		if (!cerceve) return;
		const f = new Float32Array(cerceve * this.kanal);
		new Uint8Array(f.buffer).set(yuk.subarray(0, cerceve * bayt));
		this.ornekleyici.besle(f, cerceve);
		// Motor uzun durduysa gecikme birikmesin: çeyrek saniyeyi aşan tamponun fazlası atılır.
		if (this.ornekleyici.bekleyen > 250 * MS) this.tazele();
	}
	hazirla(simdi) {
		const o = this.ornekleyici;
		// İlk veri gelene ve tampon hedefe yaklaşana kadar sessizlik (başta boşalmasın).
		if (!this.basladi) {
			if (o.bekleyen < YAKALAMA_TAMPON_MS * MS) return this.sustur();
			this.basladi = true;
		}
		if (!this.iz.enabled) {
			// Kapalı iz sessizlik verir (Web Audio kuralı); tampon yine tüketilir.
			o.at(Math.min(KUANTUM, o.bekleyen));
			return this.sustur();
		}
		const oran = this.denetim.guncelle(o.bekleyen / MS, simdi);
		const n = o.uret(this.ara, KUANTUM, oran);
		if (n < KUANTUM) {
			// Aygıt veri yetiştiremedi: kalanı sessizlik; tampon yeniden dolana kadar bekle.
			this.ara.fill(0, n * this.kanal);
			this.basladi = false;
			this.bosalma++;
		}
		const l = this.blok[0];
		if (this.kanal === 1) l.set(this.ara);
		else {
			const r = this.blok[1];
			for (let i = 0; i < KUANTUM; i++) {
				l[i] = this.ara[2 * i];
				r[i] = this.ara[2 * i + 1];
			}
		}
		this.bos = false;
	}
	// Biriken sesi at, tampon hedefinde kalsın (motor zaman atladı).
	tazele() {
		const fazla = this.ornekleyici.bekleyen - YAKALAMA_TAMPON_MS * MS;
		if (fazla > 0) this.ornekleyici.at(fazla);
		this.denetim.sifirla();
	}
	// Aygıtı bırak (iz durduruldu).
	kapat() {
		if (this.bitti) return;
		this.bitti = true;
		this.motor.yakalamalar.delete(this);
		if (this.akis) this.akis.kapat();
		this.akis = null;
		this.motor.etkinlikDegisti();
	}
}

// Uzaktan gelen iz (WebRTC alıcısı): çözülen ses RTCAudioSink'ten 10 ms'lik çerçevelerle gelir.
// Yalnızca kullanılırken dinlenir (öğe çalıyor ya da bir düğüm okuyor).
class UzakIz extends IzKaydi {
	constructor(motor, iz) {
		super(motor, 'uzak', 1);
		this.iz = iz;
		this.havuz = null;
		this.halka = new Float32Array(HIZ * 2 * 0.25); // 250 ms, kanalları iç içe (stereo yer)
		this.oku = 0;
		this.dolu = 0; // çerçeve
		this.bekleme = 0; // ilk çerçeveden sonra okumaya başlamadan beklenen kuantum
		this.basladi = false;
		motor.izler.set(iz, this);
	}
	dinle() {
		if (this.havuz || this.iz.readyState === 'ended') return;
		try {
			this.havuz = new this.motor.wrtc.nonstandard.RTCAudioSink(this.iz);
		} catch (h) {
			this.motor.gunluk('uzak ses dinlenemedi', h);
			return;
		}
		this.havuz.ondata = (v) => this.veriGeldi(v);
		this.motor.uzaklar.add(this);
		this.motor.etkinlikDegisti();
	}
	birak() {
		if (!this.havuz) return;
		try {
			this.havuz.ondata = null;
			this.havuz.stop();
		} catch {}
		this.havuz = null;
		this.dolu = 0;
		this.basladi = false;
		this.motor.uzaklar.delete(this);
		this.sustur();
		this.motor.etkinlikDegisti();
	}
	veriGeldi(v) {
		// Bağlantının ilk çerçeveleri 16 kHz gelir (çözücü henüz başlamadı): atılır.
		if (v.sampleRate !== HIZ) return;
		const k = v.channelCount === 2 ? 2 : 1;
		if (k !== this.kanal) {
			this.kanal = k;
			this.dolu = 0;
			this.basladi = false;
		}
		const n = v.numberOfFrames || v.samples.length / k;
		const boy = this.halka.length / k; // çerçeve
		if (this.dolu + n > boy) {
			// Motor yetişemedi: en eskileri at.
			const at = this.dolu + n - boy;
			this.oku = (this.oku + at) % boy;
			this.dolu -= at;
		}
		const s = v.samples;
		let yaz = ((this.oku + this.dolu) % boy) * k;
		const son = this.halka.length;
		for (let i = 0; i < n * k; i++) {
			this.halka[yaz++] = s[i] / 32768;
			if (yaz === son) yaz = 0;
		}
		this.dolu += n;
	}
	// Biriken sesi at (motor zaman atladı): bir çerçevelik ses kalır.
	tazele() {
		if (this.dolu <= ON_MS * 2) return;
		const at = this.dolu - ON_MS;
		this.oku = (this.oku + at) % (this.halka.length / this.kanal);
		this.dolu -= at;
	}
	hazirla() {
		if (!this.basladi) {
			// İlk çerçeve geldikten sonra 3 kuantum (8 ms) beklenir: çerçeveler 10 ms arayla geldiği için
			// okuma hep birkaç ms geriden gelir, zamanlayıcı oynasa da tampon boşalmaz.
			if (this.dolu < ON_MS) return this.sustur();
			if (this.bekleme++ < 3) return this.sustur();
			this.basladi = true;
			this.bekleme = 0;
		}
		const k = this.kanal;
		const boy = this.halka.length / k;
		if (this.dolu < KUANTUM) {
			this.basladi = false;
			return this.sustur();
		}
		const l = this.blok[0];
		const r = this.blok[1];
		let p = this.oku * k;
		const son = this.halka.length;
		let enerji = 0;
		for (let i = 0; i < KUANTUM; i++) {
			const a = this.halka[p++];
			l[i] = a;
			enerji += a * a;
			if (k === 2) {
				const b = this.halka[p++];
				r[i] = b;
				enerji += b * b;
			}
			if (p === son) p = 0;
		}
		this.oku = (this.oku + KUANTUM) % boy;
		this.dolu -= KUANTUM;
		this.bos = enerji === 0;
	}
}

// ---------------------------------------------------------------- çıkış aygıtı

// Bir hoparlör (PulseAudio çıkışı): ona çalan her şey (öğeler, bildirim sesleri) kuantum kuantum
// toplanır, yeniden örneklenip sunucunun istediği kadar yazılır.
//
// Sunucuda hedef kadar (60 ms) ses tutulur: motor bu sürecin ana iş parçacığında çalışır (WebRTC
// kitaplığı çözdüğü sesi oraya verir), çöp toplama ya da yoğun bir an yüzünden onlarca ms gecikebilir;
// bu sırada sunucu tamponundan çalar, kesinti duyulmaz. Sunucunun almadığı ses burada kısa bir kuyrukta
// bekler; kuyruğun boyu aygıtla aradaki hız farkını ölçmeye yarar.
const CIKIS_HEDEF_MS = 60;
const CIKIS_YEREL_MS = 6; // kuyrukta tutulmak istenen
const CIKIS_YEREL_ENCOK_MS = 30; // kuyruk bunu aşıp öyle kalırsa (sunucu almıyor) eskisi atılır
class CikisAygiti {
	constructor(motor, ad) {
		this.motor = motor;
		this.ad = ad; // PulseAudio çıkış adı ('' = varsayılan)
		this.karisim = new Float32Array(KUANTUM * 2);
		this.katki = false; // bu kuantumda ses eklendi mi
		this.sessizKuantum = 0; // art arda sessiz kuantum
		this.ornekleyici = new Ornekleyici(2);
		this.denetim = new OranDenetimi(CIKIS_YEREL_MS);
		// Yazılmayı bekleyen ses: halka (kanalları iç içe), yarım saniyelik yer.
		this.kuyruk = new Float32Array(HIZ);
		this.oku = 0; // çerçeve
		this.dolu = 0; // çerçeve
		this.akis = null;
		this.aciliyor = false;
		this.hata = 0; // son açma hatasının zamanı
		this.ara = new Float32Array(2048);
		this.atilan = 0; // sunucu almadığı için atılan (çerçeve; teşhis)
		this.bosalma = 0; // sunucunun tamponu kaç kez boşaldı (teşhis)
		this.fazlaBasi = 0;
	}
	ekle(l, r, kazanc) {
		const k = this.karisim;
		if (!r) r = l;
		for (let i = 0; i < KUANTUM; i++) {
			k[2 * i] += l[i] * kazanc;
			k[2 * i + 1] += r[i] * kazanc;
		}
		this.katki = true;
	}
	kuantumBitti() {
		if (this.katki) {
			this.sessizKuantum = 0;
			const k = this.karisim;
			for (let i = 0; i < k.length; i++) {
				if (k[i] > 1) k[i] = 1;
				else if (k[i] < -1) k[i] = -1;
			}
		} else this.sessizKuantum++;
		// Akış açıkken sessizlik de yazılır (zaman aksın); kapalıyken ses gelince açılır.
		if (this.akis) this.ornekleyici.besle(this.karisim, KUANTUM);
		if (this.katki) {
			this.karisim.fill(0);
			this.katki = false;
		}
	}
	kuyrugaEkle(veri, cerceve) {
		const boy = this.kuyruk.length / 2;
		if (this.dolu + cerceve > boy) {
			const at = this.dolu + cerceve - boy;
			this.oku = (this.oku + at) % boy;
			this.dolu -= at;
		}
		let yaz = ((this.oku + this.dolu) % boy) * 2;
		const ilk = Math.min(cerceve * 2, this.kuyruk.length - yaz);
		this.kuyruk.set(veri.subarray(0, ilk), yaz);
		if (ilk < cerceve * 2) this.kuyruk.set(veri.subarray(ilk, cerceve * 2), 0);
		this.dolu += cerceve;
	}
	async ac() {
		if (this.akis || this.aciliyor || Date.now() - this.hata < 3000) return;
		this.aciliyor = true;
		try {
			const pulse = await this.motor.pulse();
			const akis = await pulse.calmaAc({ aygit: this.ad || '', kanal: 2, hiz: HIZ, bicim: 'float32le', hedefMs: CIKIS_HEDEF_MS, ad: 'Diszort' });
			akis.on('olduruldu', () => {
				if (this.akis === akis) this.akis = null;
			});
			this.akis = akis;
			// Sunucunun tamponu hedefe kadar sessizlikle doldurulur (ilk sesler boşalmaya denk gelmesin);
			// kuyruk da hedefinde başlar (hız denetimi dengede başlasın).
			if (akis.kredi > 0) akis.yaz(Buffer.alloc(akis.kredi - (akis.kredi % akis.cerceve)));
			this.ornekleyici.sifirla();
			this.denetim.sifirla();
			this.oku = 0;
			this.dolu = CIKIS_YEREL_MS * MS;
			this.kuyruk.fill(0, 0, this.dolu * 2);
		} catch (h) {
			this.hata = Date.now();
			this.motor.gunluk('ses çıkışı açılamadı', h);
			// Seçili aygıt yoksa (çıkarıldı) varsayılana düş.
			if (this.ad && h && h.kod === 5) this.motor.cikisYok(this.ad);
		} finally {
			this.aciliyor = false;
		}
	}
	// Motor turunun sonunda: toplananı yeniden örnekle, sunucunun istediği kadarını yaz.
	gonder(simdi) {
		const akis = this.akis;
		if (!akis) {
			if (this.sessizKuantum === 0) this.ac();
			return;
		}
		if (this.sessizKuantum > (5 * HIZ) / KUANTUM) {
			// Uzun süredir ses yok: akışı kapat (ses sunucusu aygıtı uyutabilsin).
			this.kapat();
			return;
		}
		const hedef = akis.hedef / akis.cerceve;
		let kredi = Math.floor(akis.kredi / akis.cerceve);
		// Sunucu hedeften fazlasını istiyorsa tamponu boşalmıştır (duraklama): çalma, yazılanın önüne
		// geçti; aradaki boşluğa yazılan ses atılır.
		const bosaldi = kredi > hedef;
		// Sunucudaki + buradaki ses, hedefe göre: oran buna göre ayarlanır.
		const oran = bosaldi ? 1 : this.denetim.guncelle((hedef - Math.max(0, kredi) + this.dolu + this.ornekleyici.bekleyen - hedef) / MS, simdi);
		for (;;) {
			const n = this.ornekleyici.uret(this.ara, this.ara.length / 2, oran);
			if (!n) break;
			this.kuyrugaEkle(this.ara, n);
		}
		if (bosaldi) {
			// İstenenin tamamı yazılır: eldeki ses yetmiyorsa önüne sessizlik eklenir. Böylece en eski ses
			// boşluğa (atılacak yere), en yenisi tamponun sonuna düşer ve tampon yeniden hedefe dolar.
			const eksik = kredi - this.dolu;
			if (eksik > 0) {
				akis.yaz(Buffer.alloc(eksik * akis.cerceve));
				kredi -= eksik;
			}
			this.denetim.sifirla();
			this.bosalma++;
		}
		const boy = this.kuyruk.length / 2;
		let n = Math.min(Math.max(0, kredi), this.dolu);
		while (n > 0) {
			const parca = Math.min(n, boy - this.oku);
			const d = this.kuyruk.subarray(this.oku * 2, (this.oku + parca) * 2);
			akis.yaz(Buffer.from(d.buffer, d.byteOffset, d.byteLength));
			this.oku = (this.oku + parca) % boy;
			this.dolu -= parca;
			n -= parca;
		}
		// Sunucu sesi almıyorsa (aygıt askıda) kuyruk büyür: 0,3 sn boyunca fazla kalırsa eskisi atılır.
		if (this.dolu > CIKIS_YEREL_ENCOK_MS * MS) {
			if (!this.fazlaBasi) this.fazlaBasi = simdi;
			else if (simdi - this.fazlaBasi > 300) {
				const at = this.dolu - CIKIS_YEREL_MS * MS;
				this.oku = (this.oku + at) % boy;
				this.dolu -= at;
				this.atilan += at;
				this.fazlaBasi = 0;
				this.denetim.sifirla();
			}
		} else this.fazlaBasi = 0;
	}
	kapat() {
		if (this.akis) this.akis.kapat();
		this.akis = null;
		this.dolu = 0;
		this.ornekleyici.sifirla();
	}
}

// ---------------------------------------------------------------- motor

class SesMotoru {
	// wrtc: @roamhq/wrtc; pulse: () => Promise<PulseBaglantisi> (ortak bağlantı, gerekince kurulur).
	constructor({ wrtc, pulse, gunluk = () => {} }) {
		this.wrtc = wrtc;
		this.pulse = pulse;
		this.gunluk = gunluk;
		this.izler = new WeakMap(); // yerel iz → IzKaydi
		this.yakalamalar = new Set();
		this.uzaklar = new Set(); // dinlenen uzak izler
		this.gidenler = new Set(); // MediaStreamDestination izleri
		this.baglamlar = new Set(); // çalışan AudioContext'ler
		this.calicilar = new Set(); // çalan <audio>/<video> öğeleri
		this.cikislar = new Map(); // çıkış adı → CikisAygiti
		this.kuantumNo = 0;
		this.t0 = 0;
		this.zamanlayici = null;
		this.varsayilanCikis = ''; // öğelerin ve bağlamların çıkışı ('' = sistemin varsayılanı)
		// Teşhis: zaman atlamaları (uzun duraklama).
		this.sayac = { atlama: 0 };
		this.tazelemeSonu = 0;
		this.devam = null;
	}

	// İzin kaydı (yoksa uzak iz sayılır ve kurulur). Ses izi değilse null.
	izKaydi(iz) {
		if (!iz || iz.kind !== 'audio') return null;
		return this.izler.get(iz) || new UzakIz(this, iz);
	}

	cikis(ad) {
		ad = ad || this.varsayilanCikis || '';
		let c = this.cikislar.get(ad);
		if (!c) this.cikislar.set(ad, (c = new CikisAygiti(this, ad)));
		return c;
	}
	// Seçili çıkış artık yok: o çıkışa çalanlar varsayılana geçer.
	cikisYok(ad) {
		const c = this.cikislar.get(ad);
		if (c) c.kapat();
		this.cikislar.delete(ad);
		for (const o of this.calicilar) if (o.cikis === ad) o.cikis = '';
		if (this.varsayilanCikis === ad) this.varsayilanCikis = '';
	}

	// Mikrofon ya da ses aygıtı aç: iz hemen döner, ses aygıt açılınca akmaya başlar. Aygıt
	// açılamazsa hata (çağıran izi durdurur).
	async yakalamaAc({ aygit = '', kanal = 1, etiket = '' }) {
		const pulse = await this.pulse();
		const akis = await pulse.kayitAc({ aygit, kanal, hiz: HIZ, bicim: 'float32le', parcaMs: 10, ad: 'Diszort' });
		const y = new YakalamaIzi(this, { kanal, aygit: akis.aygit || aygit, etiket });
		y.akis = akis;
		akis.on('veri', (v) => y.veriGeldi(v));
		akis.on('olduruldu', () => {
			// Aygıt çıkarıldı ya da ses sunucusu kapandı: iz biter (sayfa yeniden almayı dener).
			if (y.bitti) return;
			y.akis = null;
			y.kapat();
			if (y.bittiGeri) y.bittiGeri();
		});
		this.yakalamalar.add(y);
		this.etkinlikDegisti();
		return y;
	}

	// MediaStreamDestination için gönderilebilir iz. Düğümü bağlıyken etkindir (WebRTC'ye ses verir).
	gidenIzAc(kanal = 2) {
		return new GidenIz(this, 'hedef', kanal);
	}
	gidenIzEtkin(g, etkin) {
		if (etkin) this.gidenler.add(g);
		else {
			this.gidenler.delete(g);
			g.dolu = 0;
		}
		this.etkinlikDegisti();
	}

	// İşlenecek bir şey varken zamanlayıcı çalışır; yokken motor tamamen durur (boşta işlemci yok).
	etkinlikDegisti() {
		const etkin = this.yakalamalar.size || this.uzaklar.size || this.gidenler.size || this.baglamlar.size || this.calicilar.size || [...this.cikislar.values()].some((c) => c.akis);
		if (etkin && !this.zamanlayici) {
			this.t0 = performance.now() - (this.kuantumNo * KUANTUM * 1000) / HIZ;
			this.zamanlayici = setInterval(() => this.tur(), 4);
			if (this.zamanlayici.unref) this.zamanlayici.unref();
		} else if (!etkin && this.zamanlayici) {
			clearInterval(this.zamanlayici);
			this.zamanlayici = null;
		}
	}

	// Zamanlayıcı turu: vadesi gelen kuantumları işle.
	//
	// Süreç duraklarsa (çöp toplama, yoğun bir an) motor geride kalır. 80 ms'ye kadar aradaki ses
	// işlenir (mikrofonun sesi kaybolmaz, topluca gider); bir turda en çok 6 kuantum (16 ms), kalanı
	// bekleyen giriş/çıkış olaylarından (gelen ses çerçeveleri) sonra: yoksa motor henüz teslim
	// edilmemiş sesi sessizlik sanırdı. Daha uzun duraklamada (bilgisayar uyudu, süreç durduruldu)
	// aradaki zaman işlenmez; o sırada biriken ses, gelmesi 100 ms'yi bulabildiği için bir süre atılır.
	tur() {
		const simdi = performance.now();
		let n = Math.floor(((simdi - this.t0) * HIZ) / 1000 / KUANTUM) - this.kuantumNo;
		if (n <= 0) return;
		if (n > 30) {
			this.t0 = simdi - ((this.kuantumNo + 2) * KUANTUM * 1000) / HIZ;
			n = 2;
			this.sayac.atlama++;
			this.tazelemeSonu = simdi + 100;
		}
		if (simdi < this.tazelemeSonu) {
			for (const y of this.yakalamalar) y.tazele();
			for (const u of this.uzaklar) u.tazele();
		}
		const yap = Math.min(n, 6);
		for (let i = 0; i < yap; i++) {
			try {
				this.kuantum(simdi);
			} catch (h) {
				this.gunluk('ses motoru', h);
			}
		}
		for (const c of this.cikislar.values()) c.gonder(simdi);
		if (n > yap && !this.devam) {
			this.devam = setImmediate(() => {
				this.devam = null;
				this.tur();
			});
		}
		if (!(this.kuantumNo & 0x3ff)) this.etkinlikDegisti();
	}

	kuantum(simdi) {
		const q = this.kuantumNo;
		// 1. İzlerin blokları.
		for (const y of this.yakalamalar) y.hazirla(simdi);
		for (const u of this.uzaklar) {
			// Bir süredir kimse okumuyorsa dinlemeyi bırak (öğe durdu, düğüm koptu).
			if (q - u.sonKullanim > HIZ / KUANTUM) u.birak();
			else u.hazirla();
		}
		// 2. Web Audio grafikleri (MediaStreamDestination düğümleri kendi izlerinin bloğunu yazar).
		for (const b of this.baglamlar) b.kuantumIsle(q);
		// 3. Çalan öğeler → çıkışlar.
		for (const o of this.calicilar) {
			const iz = o.iz;
			if (!iz) continue;
			iz.kullan();
			if (iz.tur === 'uzak' && !iz.havuz) iz.dinle();
			if (o.sessiz || o.seviye <= 0 || iz.bos) continue;
			this.cikis(o.cikis).ekle(iz.blok[0], iz.kanal === 2 ? iz.blok[1] : null, o.seviye);
		}
		for (const c of this.cikislar.values()) c.kuantumBitti();
		// 4. Gönderilen izler → WebRTC.
		for (const y of this.yakalamalar) y.gonder();
		for (const g of this.gidenler) g.gonder();
		this.kuantumNo = q + 1;
	}

	// Her şeyi kapat (çıkış).
	kapat() {
		if (this.zamanlayici) clearInterval(this.zamanlayici);
		this.zamanlayici = null;
		for (const y of [...this.yakalamalar]) y.kapat();
		for (const u of [...this.uzaklar]) u.birak();
		for (const c of this.cikislar.values()) c.kapat();
		this.cikislar.clear();
		this.baglamlar.clear();
		this.calicilar.clear();
	}
}

module.exports = { SesMotoru, HIZ, KUANTUM };
