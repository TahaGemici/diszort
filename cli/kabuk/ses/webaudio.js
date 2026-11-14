// Web Audio API'nin karşılığı: AudioContext ve sayfanın kullandığı düğümler.
//
// Tarayıcıdaki gibi çalışır: grafik 128 örneklik kuantumlarla işlenir, düğümler bağlandıkları
// düğümlerden sesi çeker; AudioWorklet işlemcileri (web/gurultu.js: RNNoise ve konuşma eşiği,
// web/yanki.js: paylaşılan sesten kanaldakilerin sesini çıkarma) sayfanın gönderdiği dosyanın
// kendisidir, kendi kapsamlarında çalışır. Zamanı ses motoru verir (motor.js).
//
// Kapsam, sayfanın kullandıklarıdır: GainNode, AnalyserNode, OscillatorNode,
// MediaStreamAudioSourceNode, MediaStreamAudioDestinationNode, AudioWorkletNode, AudioDestinationNode
// ve AudioParam zamanlaması (setValueAtTime, doğrusal/üstel rampa). Kullanılmayan düğümler
// (süzgeçler, sıkıştırıcı…) bilerek yok: sayfa bir gün kullanırsa "desteklenmiyor" hatasıyla ve
// denemelerle hemen görünür.
'use strict';

const vm = require('node:vm');
const { HIZ, KUANTUM } = require('./motor');

const BOS = Object.freeze([]);
const DT = 1 / HIZ;

// on<olay> özelliği olan EventTarget.
function olayOzellikleri(sinif, ...olaylar) {
	for (const ad of olaylar) {
		const gizli = Symbol(ad);
		Object.defineProperty(sinif.prototype, 'on' + ad, {
			configurable: true,
			get() {
				return this[gizli] ? this[gizli].fn : null;
			},
			set(fn) {
				if (this[gizli]) this.removeEventListener(ad, this[gizli].sarmal);
				this[gizli] = null;
				if (typeof fn !== 'function') return;
				const kayit = { fn, sarmal: (e) => kayit.fn.call(this, e) };
				this[gizli] = kayit;
				this.addEventListener(ad, kayit.sarmal);
			},
		});
	}
}
const desteklenmiyor = (ad) => {
	throw Object.assign(new Error(`${ad}: bu ortamda desteklenmiyor`), { name: 'NotSupportedError' });
};
const durumHatasi = (metin) => Object.assign(new Error(metin), { name: 'InvalidStateError' });

// ---------------------------------------------------------------- AudioParam

class SesParametresi {
	constructor(baglam, varsayilan, enAz = -3.4028234663852886e38, enCok = 3.4028234663852886e38) {
		this.baglam = baglam;
		this.defaultValue = varsayilan;
		this.minValue = enAz;
		this.maxValue = enCok;
		this.deger = varsayilan;
		this.olaylar = []; // zamana göre sıralı: { tur: 'ayar' | 'dogrusal' | 'ustel', zaman, deger }
		this.capaZaman = null; // rampaların başladığı yer: geçilen son olayın zamanı ve değeri
		this.capaDeger = 0;
		this.dizi = new Float32Array(KUANTUM);
	}
	get value() {
		return this.deger;
	}
	set value(v) {
		v = Number(v);
		if (Number.isFinite(v)) this.deger = Math.min(this.maxValue, Math.max(this.minValue, v));
	}
	ekle(tur, deger, zaman) {
		deger = Number(deger);
		zaman = Number(zaman);
		if (!Number.isFinite(deger) || !Number.isFinite(zaman) || zaman < 0) throw new TypeError('AudioParam: değer ve zaman sayı olmalı');
		if (tur === 'ustel' && deger === 0) throw new RangeError('AudioParam: üstel rampa sıfıra inemez');
		// Öncesinde olay olmayan rampa, şu anki değerden şu andan başlar.
		if (tur !== 'ayar' && !this.olaylar.length && this.capaZaman === null) {
			this.capaZaman = this.baglam.currentTime;
			this.capaDeger = this.deger;
		}
		let i = this.olaylar.length;
		while (i > 0 && this.olaylar[i - 1].zaman > zaman) i--;
		this.olaylar.splice(i, 0, { tur, zaman, deger });
		return this;
	}
	setValueAtTime(v, t) {
		return this.ekle('ayar', v, t);
	}
	linearRampToValueAtTime(v, t) {
		return this.ekle('dogrusal', v, t);
	}
	exponentialRampToValueAtTime(v, t) {
		return this.ekle('ustel', v, t);
	}
	setTargetAtTime() {
		desteklenmiyor('AudioParam.setTargetAtTime');
	}
	setValueCurveAtTime() {
		desteklenmiyor('AudioParam.setValueCurveAtTime');
	}
	cancelScheduledValues(t) {
		t = Number(t) || 0;
		this.olaylar = this.olaylar.filter((o) => o.zaman < t);
		return this;
	}
	cancelAndHoldAtTime(t) {
		return this.cancelScheduledValues(t);
	}
	// t anındaki değer; geçilen olaylar listeden düşer.
	an(t) {
		const o = this.olaylar;
		while (o.length && o[0].zaman <= t) {
			const gecen = o.shift();
			this.deger = this.capaDeger = gecen.deger;
			this.capaZaman = gecen.zaman;
		}
		const s = o[0];
		if (!s) {
			this.capaZaman = null;
			return this.deger;
		}
		if (s.tur === 'ayar') return this.deger;
		if (this.capaZaman === null) {
			this.capaZaman = t;
			this.capaDeger = this.deger;
		}
		const sure = s.zaman - this.capaZaman;
		const oran = sure > 0 ? Math.min(1, Math.max(0, (t - this.capaZaman) / sure)) : 1;
		const a = this.capaDeger;
		if (s.tur === 'dogrusal') this.deger = a + (s.deger - a) * oran;
		else this.deger = a !== 0 && a > 0 === s.deger > 0 ? a * (s.deger / a) ** oran : s.deger;
		return this.deger;
	}
	// Bu kuantumun değerleri: zamanlama yoksa null (sabit: .deger), varsa 128 değerlik dizi.
	kuantum(t0) {
		if (!this.olaylar.length) return null;
		const d = this.dizi;
		for (let i = 0; i < KUANTUM; i++) d[i] = this.an(t0 + i * DT);
		return d;
	}
}

// ---------------------------------------------------------------- düğümler

class SesDugumu extends EventTarget {
	constructor(baglam, { giris = 1, cikis = 1, kanal = 2, kip = 'max', yorum = 'speakers' } = {}) {
		super();
		if (!(baglam instanceof SesBaglami)) throw new TypeError('AudioNode: geçersiz AudioContext');
		this.context = baglam;
		this.numberOfInputs = giris;
		this.numberOfOutputs = cikis;
		this.channelCount = kanal;
		this.channelCountMode = kip;
		this.channelInterpretation = yorum || 'speakers';
		this.girisler = Array.from({ length: giris }, () => new Set()); // { dugum, cikis }
		this.hedefler = new Set(); // { dugum, cikis, giris }
		// Giriş ve çıkış tamponları: çift kanallı hâli [sol, sağ], tek kanallı hâli [sol].
		const tampon = () => {
			const cift = [new Float32Array(KUANTUM), new Float32Array(KUANTUM)];
			return { cift, tek: [cift[0]] };
		};
		this.girisTamponu = Array.from({ length: giris }, tampon);
		this.cikisTamponu = Array.from({ length: cikis }, tampon);
		this.cikti = Array.from({ length: cikis }, () => BOS); // son kuantumun çıktısı (çıkış başına kanal dizileri)
		this.islenen = -1;
		this.isleniyor = false;
	}

	connect(hedef, cikis = 0, giris = 0) {
		if (hedef instanceof SesParametresi) desteklenmiyor('AudioNode.connect(AudioParam)');
		if (!(hedef instanceof SesDugumu)) throw new TypeError('AudioNode.connect: hedef bir AudioNode olmalı');
		if (hedef.context !== this.context) throw Object.assign(new Error("düğümler aynı AudioContext'te olmalı"), { name: 'InvalidAccessError' });
		if (cikis >= this.numberOfOutputs || giris >= hedef.numberOfInputs) throw Object.assign(new Error('AudioNode.connect: giriş/çıkış numarası aralık dışında'), { name: 'IndexSizeError' });
		for (const h of this.hedefler) if (h.dugum === hedef && h.cikis === cikis && h.giris === giris) return hedef;
		this.hedefler.add({ dugum: hedef, cikis, giris });
		hedef.girisler[giris].add({ dugum: this, cikis });
		hedef.baglantiDegisti();
		return hedef;
	}
	// disconnect(), disconnect(çıkışNo), disconnect(hedef), disconnect(hedef, çıkışNo[, girişNo]).
	disconnect(hedef, cikis, giris) {
		for (const h of [...this.hedefler]) {
			if (typeof hedef === 'number') {
				if (h.cikis !== hedef) continue;
			} else if (hedef !== undefined) {
				if (h.dugum !== hedef) continue;
				if (cikis !== undefined && h.cikis !== cikis) continue;
				if (giris !== undefined && h.giris !== giris) continue;
			}
			this.hedefler.delete(h);
			const kume = h.dugum.girisler[h.giris];
			for (const b of kume) if (b.dugum === this && b.cikis === h.cikis) kume.delete(b);
			h.dugum.baglantiDegisti();
		}
	}
	// Girişlerine bağlı düğüm var mı (kök düğümler buna göre işlenir).
	get bagli() {
		for (const g of this.girisler) if (g.size) return true;
		return false;
	}
	baglantiDegisti() {}

	// q kuantumunun çıktısı (kuantum başına bir kez işlenir; döngüde bir önceki çıktı).
	cek(q) {
		if (this.islenen === q || this.isleniyor) return this.cikti;
		this.isleniyor = true;
		try {
			this.isle(q);
		} finally {
			this.isleniyor = false;
			this.islenen = q;
		}
		return this.cikti;
	}

	// Bir girişe bağlı çıkışların toplamı; kanal sayısı düğümün kurallarına göre (yalnızca tek ve çift
	// kanal: tekten çifte iki yana aynı, çiftten teke ortalama). Bağlantı yoksa ya da hepsi sessizse BOS.
	girisTopla(no, q) {
		const baglantilar = this.girisler[no];
		if (!baglantilar.size) return BOS;
		let parcalar = null;
		let enCok = 0;
		for (const b of baglantilar) {
			const c = b.dugum.cek(q)[b.cikis];
			if (!c || !c.length) continue;
			(parcalar = parcalar || []).push(c);
			if (c.length > enCok) enCok = c.length;
		}
		if (!parcalar) return BOS;
		const kip = this.channelCountMode;
		const kanal = (kip === 'explicit' ? this.channelCount : kip === 'clamped-max' ? Math.min(enCok, this.channelCount) : enCok) >= 2 ? 2 : 1;
		// Tek kaynak ve kanal sayısı uyuyorsa kopyalamadan geçir.
		if (parcalar.length === 1 && parcalar[0].length === kanal) return parcalar[0];
		const t = this.girisTamponu[no];
		const l = t.cift[0];
		const r = t.cift[1];
		l.fill(0);
		if (kanal === 2) r.fill(0);
		for (const p of parcalar) {
			const a = p[0];
			if (kanal === 1) {
				if (p.length === 1) for (let i = 0; i < KUANTUM; i++) l[i] += a[i];
				else {
					const b = p[1];
					for (let i = 0; i < KUANTUM; i++) l[i] += 0.5 * (a[i] + b[i]);
				}
			} else {
				const b = p.length === 2 ? p[1] : a;
				for (let i = 0; i < KUANTUM; i++) {
					l[i] += a[i];
					r[i] += b[i];
				}
			}
		}
		return kanal === 2 ? t.cift : t.tek;
	}

	// Çıkış tamponu (kanal sayısı kadar; içini çağıran doldurur).
	cikisAl(no, kanal) {
		const t = this.cikisTamponu[no];
		return kanal >= 2 ? t.cift : t.tek;
	}
	isle() {}
}

class KazancDugumu extends SesDugumu {
	constructor(baglam, secenek = {}) {
		super(baglam);
		this.gain = new SesParametresi(baglam, 1);
		if (secenek && secenek.gain != null) this.gain.value = secenek.gain;
	}
	isle(q) {
		const giris = this.girisTopla(0, q);
		const degerler = this.gain.kuantum(this.context.zaman(q));
		if (!giris.length || (!degerler && this.gain.deger === 0)) {
			this.cikti[0] = BOS;
			return;
		}
		const cikis = this.cikisAl(0, giris.length);
		const g = this.gain.deger;
		for (let k = 0; k < giris.length; k++) {
			const s = giris[k];
			const h = cikis[k];
			if (degerler) for (let i = 0; i < KUANTUM; i++) h[i] = s[i] * degerler[i];
			else for (let i = 0; i < KUANTUM; i++) h[i] = s[i] * g;
		}
		this.cikti[0] = cikis;
	}
}

// Ölçer: giren sesin son örneklerini tutar (zaman alanı). Ses buradan geçer ama sayfa çıkışını
// kullanmaz; bir yere bağlı olmasa da işlenir (kök düğüm).
class OlcerDugumu extends SesDugumu {
	constructor(baglam, secenek = {}) {
		super(baglam);
		this.boy = 2048;
		this.halka = new Float32Array(32768);
		this.yaz = 0;
		this.minDecibels = -100;
		this.maxDecibels = -30;
		this.smoothingTimeConstant = 0.8;
		if (secenek && secenek.fftSize) this.fftSize = secenek.fftSize;
	}
	get fftSize() {
		return this.boy;
	}
	set fftSize(n) {
		n = Number(n);
		if (!Number.isInteger(n) || n < 32 || n > 32768 || n & (n - 1)) throw Object.assign(new Error('fftSize 32 ile 32768 arasında ikinin kuvveti olmalı'), { name: 'IndexSizeError' });
		this.boy = n;
	}
	get frequencyBinCount() {
		return this.boy / 2;
	}
	baglantiDegisti() {
		this.context.kokAyarla(this, this.bagli);
	}
	isle(q) {
		const giris = this.girisTopla(0, q);
		const h = this.halka;
		let y = this.yaz;
		if (!giris.length) {
			for (let i = 0; i < KUANTUM; i++) {
				h[y] = 0;
				y = (y + 1) & 32767;
			}
		} else if (giris.length === 1) {
			const s = giris[0];
			for (let i = 0; i < KUANTUM; i++) {
				h[y] = s[i];
				y = (y + 1) & 32767;
			}
		} else {
			const l = giris[0];
			const r = giris[1];
			for (let i = 0; i < KUANTUM; i++) {
				h[y] = 0.5 * (l[i] + r[i]);
				y = (y + 1) & 32767;
			}
		}
		this.yaz = y;
		this.cikti[0] = giris;
	}
	getFloatTimeDomainData(dizi) {
		const n = Math.min(dizi.length, this.boy);
		const bas = this.yaz - this.boy;
		for (let i = 0; i < n; i++) dizi[i] = this.halka[(bas + i) & 32767];
	}
	getByteTimeDomainData(dizi) {
		const n = Math.min(dizi.length, this.boy);
		const bas = this.yaz - this.boy;
		for (let i = 0; i < n; i++) dizi[i] = Math.max(0, Math.min(255, Math.round(128 * (1 + this.halka[(bas + i) & 32767]))));
	}
	getFloatFrequencyData() {
		desteklenmiyor('AnalyserNode.getFloatFrequencyData');
	}
	getByteFrequencyData() {
		desteklenmiyor('AnalyserNode.getByteFrequencyData');
	}
}

class OsilatorDugumu extends SesDugumu {
	constructor(baglam, secenek = {}) {
		super(baglam, { giris: 0 });
		this.type = (secenek && secenek.type) || 'sine';
		this.frequency = new SesParametresi(baglam, (secenek && secenek.frequency) ?? 440);
		this.detune = new SesParametresi(baglam, (secenek && secenek.detune) ?? 0);
		this.faz = 0;
		this.baslangic = null;
		this.bitis = Infinity;
		this.bitti = false;
	}
	start(zaman = 0) {
		if (this.baslangic !== null) throw durumHatasi('OscillatorNode zaten başlatıldı');
		this.baslangic = Math.max(Number(zaman) || 0, this.context.currentTime);
		this.context.kokAyarla(this, true);
	}
	stop(zaman = 0) {
		if (this.baslangic === null) throw durumHatasi('OscillatorNode başlatılmadı');
		this.bitis = Math.max(Number(zaman) || 0, this.context.currentTime);
	}
	isle(q) {
		const t0 = this.context.zaman(q);
		const frekanslar = this.frequency.kuantum(t0);
		if (this.baslangic === null || this.bitti || t0 + KUANTUM * DT <= this.baslangic) {
			this.cikti[0] = BOS;
			return;
		}
		const cikis = this.cikisAl(0, 1);
		const h = cikis[0];
		const kat = 2 ** (this.detune.deger / 1200);
		const tur = this.type;
		let faz = this.faz;
		for (let i = 0; i < KUANTUM; i++) {
			const t = t0 + i * DT;
			if (t < this.baslangic || t >= this.bitis) {
				h[i] = 0;
				continue;
			}
			if (tur === 'square') h[i] = faz < 0.5 ? 1 : -1;
			else if (tur === 'sawtooth') h[i] = 2 * faz - 1;
			else if (tur === 'triangle') h[i] = faz < 0.5 ? 4 * faz - 1 : 3 - 4 * faz;
			else h[i] = Math.sin(2 * Math.PI * faz);
			faz += (frekanslar ? frekanslar[i] : this.frequency.deger) * kat * DT;
			faz -= Math.floor(faz);
		}
		this.faz = faz;
		this.cikti[0] = cikis;
		if (t0 + KUANTUM * DT >= this.bitis) {
			this.bitti = true;
			this.context.kokAyarla(this, false);
			setImmediate(() => this.dispatchEvent(new Event('ended')));
		}
	}
}
olayOzellikleri(OsilatorDugumu, 'ended');

// Bir akışın (mikrofon, uzak ses, başka bir düğümün çıkış akışı) sesini grafiğe sokar.
class AkisKaynagiDugumu extends SesDugumu {
	constructor(baglam, secenek) {
		super(baglam, { giris: 0 });
		const akis = secenek && secenek.mediaStream;
		const izler = akis && typeof akis.getAudioTracks === 'function' ? akis.getAudioTracks() : [];
		if (!izler.length) throw durumHatasi('MediaStreamAudioSourceNode: akışta ses izi yok');
		this.mediaStream = akis;
		this.kayit = baglam.motor.izKaydi(izler[0]);
	}
	isle(q) {
		const k = this.kayit;
		if (!k) {
			this.cikti[0] = BOS;
			return;
		}
		k.kullan();
		if (k.tur === 'uzak' && !k.havuz) k.dinle();
		// Başka bir düğümün çıkış akışıysa önce o düğüm işlenir (aynı kuantumun sesi okunsun).
		if (k.dugum && k.dugum.context === this.context) k.dugum.cek(q);
		this.cikti[0] = k.bos ? BOS : k.kanal === 2 ? k.blok : k.tekBlok || (k.tekBlok = [k.blok[0]]);
	}
}

// Grafiğin sesini bir akışa (gönderilebilir ize) verir. Girişi bağlıyken işlenir ve WebRTC'ye ses
// verir; bağlantısı kalmayınca durur (sayfa bıraktığı düğümleri yalnızca koparır: boşta kalan
// düğüm sessizlik göndermeyi sürdürmesin), yeniden bağlanınca sürer.
class AkisHedefiDugumu extends SesDugumu {
	constructor(baglam, secenek = {}) {
		super(baglam, { cikis: 0, kanal: (secenek && secenek.channelCount) || 2, kip: 'explicit' });
		this.kayit = baglam.motor.gidenIzAc(2);
		this.kayit.dugum = this;
		this.stream = new baglam.motor.wrtc.MediaStream([this.kayit.iz]);
		this.durdu = false;
		// İz durdurulunca düğüm de bırakılır.
		const iz = this.kayit.iz;
		const dur = iz.stop.bind(iz);
		// (Kitaplığın iz yöntemleri salt okunur tanımlı: atama yerine örnekte yeniden tanımlanır.)
		Object.defineProperty(iz, 'stop', {
			configurable: true,
			writable: true,
			value: () => {
				this.durdu = true;
				this.baglantiDegisti();
				dur();
			},
		});
	}
	baglantiDegisti() {
		const etkin = !this.durdu && this.bagli && this.context.durum !== 'closed';
		this.context.kokAyarla(this, etkin);
		if (etkin) this.context.hedefler.add(this);
		else {
			this.context.hedefler.delete(this);
			this.kayit.sustur();
		}
		this.context.motor.gidenIzEtkin(this.kayit, etkin);
	}
	isle(q) {
		const giris = this.girisTopla(0, q);
		const k = this.kayit;
		if (!giris.length) return k.sustur();
		k.blok[0].set(giris[0]);
		k.blok[1].set(giris[1] || giris[0]);
		k.bos = false;
	}
}

// Hoparlör.
class CikisDugumu extends SesDugumu {
	constructor(baglam) {
		super(baglam, { cikis: 0, kanal: 2, kip: 'explicit' });
		this.maxChannelCount = 2;
	}
	baglantiDegisti() {
		this.context.kokAyarla(this, this.bagli);
	}
	isle(q) {
		const giris = this.girisTopla(0, q);
		if (!giris.length) return;
		this.context.motor.cikis(this.context.cikisAdi).ekle(giris[0], giris[1] || null, 1);
	}
}

// ---------------------------------------------------------------- AudioWorklet

// İleti kapısı çifti (MessagePort gibi): gönderilen veri kopyalanır (aktarılanlar taşınır) ve karşı
// tarafa bir sonraki turda ulaşır.
class Kapi extends EventTarget {
	constructor() {
		super();
		this.es = null;
		this.acik = true;
	}
	postMessage(veri, aktar) {
		const es = this.es;
		if (!es || !this.acik) return;
		const liste = Array.isArray(aktar) ? aktar : aktar && Array.isArray(aktar.transfer) ? aktar.transfer : [];
		const kopya = structuredClone(veri, liste.length ? { transfer: liste } : undefined);
		setImmediate(() => {
			if (es.acik) es.dispatchEvent(Object.assign(new Event('message'), { data: kopya }));
		});
	}
	start() {}
	close() {
		this.acik = false;
	}
}
olayOzellikleri(Kapi, 'message', 'messageerror');
function kapiCifti() {
	const a = new Kapi();
	const b = new Kapi();
	a.es = b;
	b.es = a;
	return [a, b];
}

// Worklet kapsamı (AudioWorkletGlobalScope): modüller burada çalışır, işlemciler buraya kaydolur.
class WorkletKapsami {
	constructor(baglam) {
		this.islemciler = new Map(); // ad → sınıf
		this.bekleyenKapi = null;
		const kapsam = this;
		class AudioWorkletProcessor {
			constructor() {
				// İşlemcinin kapısı düğüm kurulurken hazırlanır (tarayıcıdaki gibi yapıcıda hazırdır).
				this.port = kapsam.bekleyenKapi;
				kapsam.bekleyenKapi = null;
			}
		}
		const kure = {
			AudioWorkletProcessor,
			registerProcessor: (ad, sinif) => {
				if (typeof ad !== 'string' || !ad) throw new TypeError('registerProcessor: ad boş olamaz');
				if (this.islemciler.has(ad)) throw Object.assign(new Error(`registerProcessor: "${ad}" zaten kayıtlı`), { name: 'NotSupportedError' });
				if (typeof sinif !== 'function') throw new TypeError('registerProcessor: sınıf gerekli');
				this.islemciler.set(ad, sinif);
			},
			sampleRate: HIZ,
			console,
		};
		Object.defineProperty(kure, 'currentTime', { get: () => baglam.currentTime, enumerable: true });
		Object.defineProperty(kure, 'currentFrame', { get: () => (baglam.motor.kuantumNo - baglam.ilkKuantum) * KUANTUM, enumerable: true });
		this.kure = vm.createContext(kure, { name: 'AudioWorklet' });
	}
	// Her dosya kendi kapsamında (tarayıcıda modüldür: adları başka dosyalarınkiyle çakışmaz).
	calistir(kaynak, ad) {
		new vm.Script(`(function () {\n${kaynak}\n})();`, { filename: ad, lineOffset: -1 }).runInContext(this.kure);
	}
}

class Worklet {
	constructor(baglam) {
		this.baglam = baglam;
		this.kapsam = null;
		this.yuklenen = new Map(); // adres → söz
	}
	addModule(adres) {
		adres = String(adres);
		let soz = this.yuklenen.get(adres);
		if (!soz) {
			soz = Promise.resolve()
				.then(() => this.baglam.ortam.kaynakOku(adres))
				.then((kaynak) => {
					if (!this.kapsam) this.kapsam = new WorkletKapsami(this.baglam);
					this.kapsam.calistir(String(kaynak), adres);
				});
			this.yuklenen.set(adres, soz);
			soz.catch(() => this.yuklenen.delete(adres));
		}
		return soz;
	}
}

class WorkletDugumu extends SesDugumu {
	constructor(baglam, ad, secenek = {}) {
		secenek = secenek || {};
		const giris = secenek.numberOfInputs ?? 1;
		const cikis = secenek.numberOfOutputs ?? 1;
		super(baglam, { giris, cikis, kanal: secenek.channelCount ?? 2, kip: secenek.channelCountMode || 'max', yorum: secenek.channelInterpretation });
		const kapsam = baglam.audioWorklet.kapsam;
		const sinif = kapsam && kapsam.islemciler.get(ad);
		if (!sinif) throw durumHatasi(`AudioWorkletNode: "${ad}" adında kayıtlı işlemci yok`);
		// Çıkışların kanal sayısı: verilmişse o; yoksa tek giriş-tek çıkışta girişinki, değilse tek kanal.
		this.cikisKanal = Array.from({ length: cikis }, (_, i) => (secenek.outputChannelCount && secenek.outputChannelCount[i]) || 0);
		this.parameters = new Map();
		const [dis, ic] = kapiCifti();
		this.port = dis;
		this.calisiyor = true;
		kapsam.bekleyenKapi = ic;
		try {
			// Seçenekler işlemciye kopyalanarak geçer (tarayıcıda başka iş parçacığına gider).
			this.islemci = new sinif({
				numberOfInputs: giris,
				numberOfOutputs: cikis,
				outputChannelCount: secenek.outputChannelCount ? [...secenek.outputChannelCount] : undefined,
				parameterData: secenek.parameterData,
				processorOptions: secenek.processorOptions === undefined ? undefined : structuredClone(secenek.processorOptions),
			});
		} finally {
			kapsam.bekleyenKapi = null;
		}
		this.girisDizisi = new Array(giris);
		this.cikisDizisi = new Array(cikis);
		this.parametreler = {};
		baglam.kokAyarla(this, true);
	}
	isle(q) {
		for (let i = 0; i < this.numberOfInputs; i++) this.girisDizisi[i] = this.girisTopla(i, q);
		if (!this.calisiyor) {
			for (let i = 0; i < this.numberOfOutputs; i++) this.cikti[i] = BOS;
			return;
		}
		for (let i = 0; i < this.numberOfOutputs; i++) {
			const kanal = this.cikisKanal[i] || (this.numberOfInputs === 1 && this.numberOfOutputs === 1 ? this.girisDizisi[0].length || 1 : 1);
			const c = this.cikisAl(i, kanal);
			for (const d of c) d.fill(0);
			this.cikisDizisi[i] = c;
			this.cikti[i] = c;
		}
		let surer = false;
		try {
			surer = this.islemci.process(this.girisDizisi, this.cikisDizisi, this.parametreler);
		} catch (h) {
			// İşlemci hata verdi: tarayıcıdaki gibi susar ve 'processorerror' olayı çıkar.
			this.durdur();
			this.context.motor.gunluk('AudioWorklet işlemcisi durdu', h);
			setImmediate(() => this.dispatchEvent(Object.assign(new Event('processorerror'), { error: h, message: String((h && h.message) || h) })));
			return;
		}
		if (surer === false) this.durdur(); // process() false döndü: işlemci bitti
	}
	durdur() {
		this.calisiyor = false;
		this.context.kokAyarla(this, false);
		for (let i = 0; i < this.numberOfOutputs; i++) this.cikti[i] = BOS;
	}
}
olayOzellikleri(WorkletDugumu, 'processorerror');

// ---------------------------------------------------------------- AudioContext

class SesBaglami extends EventTarget {
	// ortam: { motor, kaynakOku(adres) → Promise<metin> } (webAudioKur verir).
	constructor(ortam) {
		super();
		this.ortam = ortam;
		this.motor = ortam.motor;
		this.sampleRate = HIZ;
		this.durum = 'running';
		this.ilkKuantum = this.motor.kuantumNo;
		this.kokler = new Set(); // bağlı olmasa da her kuantumda işlenen düğümler
		this.hedefler = new Set(); // etkin MediaStreamDestination düğümleri
		this.cikisAdi = '';
		this.baseLatency = KUANTUM / HIZ;
		this.outputLatency = 0.045; // sunucudaki hedef tampon (40 ms) + buradaki (≈5 ms)
		this.audioWorklet = new Worklet(this);
		this.destination = new CikisDugumu(this);
		this.listener = {};
		this.motor.baglamlar.add(this);
		this.motor.etkinlikDegisti();
	}
	get state() {
		return this.durum;
	}
	get currentTime() {
		return ((this.motor.kuantumNo - this.ilkKuantum) * KUANTUM) / HIZ;
	}
	zaman(q) {
		return ((q - this.ilkKuantum) * KUANTUM) / HIZ;
	}
	durumAyarla(durum) {
		if (this.durum === durum || this.durum === 'closed') return;
		this.durum = durum;
		if (durum === 'running') this.motor.baglamlar.add(this);
		else {
			this.motor.baglamlar.delete(this);
			// Durmuş bağlamın çıkış akışları sessizlik verir.
			for (const h of this.hedefler) h.kayit.sustur();
		}
		this.motor.etkinlikDegisti();
		setImmediate(() => this.dispatchEvent(new Event('statechange')));
	}
	resume() {
		if (this.durum === 'closed') return Promise.reject(durumHatasi('AudioContext kapalı'));
		this.durumAyarla('running');
		return Promise.resolve();
	}
	suspend() {
		if (this.durum === 'closed') return Promise.reject(durumHatasi('AudioContext kapalı'));
		this.durumAyarla('suspended');
		return Promise.resolve();
	}
	close() {
		this.durumAyarla('closed');
		for (const h of [...this.hedefler]) h.baglantiDegisti();
		this.kokler.clear();
		return Promise.resolve();
	}
	// Çıkış aygıtı: '' = varsayılan.
	setSinkId(ad) {
		this.cikisAdi = typeof ad === 'string' ? ad : '';
		return Promise.resolve();
	}
	get sinkId() {
		return this.cikisAdi;
	}
	kokAyarla(dugum, etkin) {
		if (etkin && this.durum !== 'closed') this.kokler.add(dugum);
		else this.kokler.delete(dugum);
	}
	kuantumIsle(q) {
		for (const d of this.kokler) d.cek(q);
	}

	createGain() {
		return new KazancDugumu(this);
	}
	createAnalyser() {
		return new OlcerDugumu(this);
	}
	createOscillator() {
		return new OsilatorDugumu(this);
	}
	createMediaStreamSource(akis) {
		return new AkisKaynagiDugumu(this, { mediaStream: akis });
	}
	createMediaStreamDestination() {
		return new AkisHedefiDugumu(this);
	}
}
olayOzellikleri(SesBaglami, 'statechange');
for (const ad of ['createBiquadFilter', 'createBuffer', 'createBufferSource', 'createChannelMerger', 'createChannelSplitter', 'createConstantSource', 'createConvolver', 'createDelay', 'createDynamicsCompressor', 'createIIRFilter', 'createPanner', 'createPeriodicWave', 'createScriptProcessor', 'createStereoPanner', 'createWaveShaper', 'createMediaElementSource', 'decodeAudioData']) {
	SesBaglami.prototype[ad] = () => desteklenmiyor('AudioContext.' + ad);
}

// Sayfaya verilecek adlar (window.AudioContext vb.). ortam: { motor, kaynakOku(adres) → Promise<metin> }.
function webAudioKur(ortam) {
	class AudioContext extends SesBaglami {
		constructor() {
			super(ortam);
		}
	}
	return {
		AudioContext,
		AudioNode: SesDugumu,
		AudioParam: SesParametresi,
		GainNode: KazancDugumu,
		AnalyserNode: OlcerDugumu,
		OscillatorNode: OsilatorDugumu,
		MediaStreamAudioSourceNode: AkisKaynagiDugumu,
		MediaStreamAudioDestinationNode: AkisHedefiDugumu,
		AudioDestinationNode: CikisDugumu,
		AudioWorkletNode: WorkletDugumu,
		AudioWorklet: Worklet,
	};
}

module.exports = { webAudioKur, kapiCifti, olayOzellikleri };
