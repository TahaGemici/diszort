// Saat farkını gideren yeniden örnekleyici.
//
// Ses motoru bilgisayarın saatine göre işler; ses kartlarının (mikrofon, hoparlör) kendi saatleri
// vardır ve hiçbiri tam aynı hızda akmaz (tipik fark milyonda 10-100: dakikada birkaç ms). Fark
// giderilmezse aradaki tampon ya taşar ya boşalır: birkaç dakikada bir duyulan bir kesinti. Tarayıcılar
// bunu sesi çok az hızlandırıp yavaşlatarak giderir; burada da öyle: aygıtla motor arasındaki her
// akış, oranı 1'e çok yakın (en çok ±%0,5) ve sürekli ayarlanan bir yeniden örnekleyiciden geçer.
//
// Yeniden örnekleme pencereli sinc ile (32 dokunuş, 64 evre + evreler arası doğrusal geçiş): doğrusal
// ya da kübik ara değerleme tizleri evreye göre değişen oranda zayıflatır (yarım örnekte 15 kHz
// −2,5 dB), fark yavaş kaydıkça tizlerde dalgalanma duyulur. Burada 18 kHz'e kadar düz.
'use strict';

const DOKUNUS = 32;
const EVRE = 64;
const YARI = DOKUNUS / 2;

// Kaiser penceresi için değiştirilmiş Bessel işlevi (I0).
function bessel(x) {
	let toplam = 1;
	let terim = 1;
	for (let k = 1; k < 30; k++) {
		terim *= (x / (2 * k)) ** 2;
		toplam += terim;
		if (terim < 1e-12 * toplam) break;
	}
	return toplam;
}

// tablo[e * DOKUNUS + j]: e/EVRE kesirli konum için j. dokunuşun katsayısı (EVRE + 1 satır).
const TABLO = (() => {
	const t = new Float32Array((EVRE + 1) * DOKUNUS);
	const kesim = 0.94; // Nyquist'e göre (oran ~1: örtüşme yok, yalnızca geçiş bandı)
	const beta = 9;
	const i0 = bessel(beta);
	for (let e = 0; e <= EVRE; e++) {
		const kesir = e / EVRE;
		let toplam = 0;
		for (let j = 0; j < DOKUNUS; j++) {
			const x = j - (YARI - 1) - kesir; // dokunuşun, istenen noktaya uzaklığı (örnek)
			const s = x === 0 ? kesim : Math.sin(Math.PI * kesim * x) / (Math.PI * x);
			const u = x / YARI;
			const p = Math.abs(u) >= 1 ? 0 : bessel(beta * Math.sqrt(1 - u * u)) / i0;
			t[e * DOKUNUS + j] = s * p;
			toplam += s * p;
		}
		for (let j = 0; j < DOKUNUS; j++) t[e * DOKUNUS + j] /= toplam; // DC kazancı 1
	}
	return t;
})();

// Fark çok küçüktür (saniyede birkaç örnek): ses çoğu zaman olduğu gibi kopyalanır; istenen oranın
// biriktirdiği fark bir örneği bulunca kısa bir "kayma" yapılır: ~43 ms boyunca (2048 örnek; fark
// büyükse daha kısa) pencereli sinc ile yeniden örneklenerek bir örnek kazanılır ya da bırakılır.
// Böylece işlemci yalnızca kayma sırasında harcanır (fark milyonda 50 ise zamanın onda biri), fark
// yokken ses bit bit aynı geçer.
const KAYMA = 2048;
const KAYMA_ENAZ = 200; // en hızlı kayma: %0,5

class Ornekleyici {
	constructor(kanal) {
		this.kanal = kanal;
		this.giris = new Float32Array(kanal * 8192);
		this.sifirla();
	}

	// Geçmişi unut: süzgecin baktığı ilk örnekler sessizlik sayılır.
	sifirla() {
		this.giris.fill(0);
		this.dolu = YARI - 1; // giris'teki çerçeve sayısı
		this.konum = YARI - 1; // bir sonraki çıkış örneğinin giris'teki yeri (kayma dışında tam sayı)
		this.borc = 0; // istenen oranın biriktirdiği fark (örnek): ±1'i bulunca kayma başlar
		this.kayma = 0; // süren kaymanın yönü (+1: bir giriş örneği fazladan tüketilir, −1: bir eksik)
		this.kaymaBoyu = 0;
		this.kaymaAdim = 0;
		this.kaymaBasi = 0;
		this.kaymaSayisi = 0; // teşhis
	}

	// Henüz çıkışa dönüşmemiş giriş (çerçeve, kesirli).
	get bekleyen() {
		return Math.max(0, this.dolu - YARI - 1 - this.konum);
	}

	// Giriş ekle (kanalları iç içe: L R L R …).
	besle(veri, cerceve = veri.length / this.kanal) {
		const k = this.kanal;
		if ((this.dolu + cerceve) * k > this.giris.length) {
			// Önce tüketilen baştaki örnekleri at; yetmezse büyüt.
			this.sikistir();
			if ((this.dolu + cerceve) * k > this.giris.length) {
				const yeni = new Float32Array(Math.max(this.giris.length * 2, (this.dolu + cerceve) * k * 2));
				yeni.set(this.giris.subarray(0, this.dolu * k));
				this.giris = yeni;
			}
		}
		this.giris.set(cerceve * k === veri.length ? veri : veri.subarray(0, cerceve * k), this.dolu * k);
		this.dolu += cerceve;
	}

	sikistir() {
		const at = Math.floor(this.kayma ? this.kaymaBasi : this.konum) - (YARI - 1);
		if (at <= 0) return;
		const k = this.kanal;
		this.giris.copyWithin(0, at * k, this.dolu * k);
		this.dolu -= at;
		this.konum -= at;
		this.kaymaBasi -= at;
	}

	// En eski bekleyen girişten `cerceve` kadarını at (tampon fazla büyüdü: gecikme birikmesin).
	at(cerceve) {
		cerceve = Math.floor(Math.min(cerceve, this.bekleyen));
		if (cerceve <= 0) return;
		this.konum += cerceve;
		this.kaymaBasi += cerceve;
	}

	// `hedef`e (kanalları iç içe) en çok `enCok` çerçeve üret; oran: çıkış örneği başına tüketilmek
	// istenen giriş (1'den büyük: giriş daha hızlı tüketilir). Dönüş: üretilen çerçeve sayısı.
	uret(hedef, enCok, oran = 1) {
		const k = this.kanal;
		// floor(konum) en çok bu olabilir: süzgeç, konumun YARI örnek ilerisine kadar okur.
		const son = this.dolu - YARI - 1;
		const fark = oran - 1;
		let n = 0;
		while (n < enCok) {
			if (!this.kayma && (this.borc >= 1 || this.borc <= -1)) {
				// Bir örneklik fark birikti: kayma başlat (fark büyükse daha kısa, yani daha hızlı).
				this.kayma = this.borc > 0 ? 1 : -1;
				this.borc -= this.kayma;
				this.kaymaBoyu = Math.max(KAYMA_ENAZ, Math.min(KAYMA, Math.floor(KAYMA / Math.max(1, Math.abs(this.borc)))));
				this.kaymaAdim = 0;
				this.kaymaBasi = this.konum;
				this.kaymaSayisi++;
			}
			if (!this.kayma) {
				// Kopyala: en çok 128 çerçeve (fark hesabı arada güncellensin).
				const i = this.konum;
				const adet = Math.min(enCok - n, son - i + 1, 128);
				if (adet <= 0) break;
				const g = this.giris;
				if (adet * k < 48) for (let j = 0; j < adet * k; j++) hedef[n * k + j] = g[i * k + j];
				else hedef.set(g.subarray(i * k, (i + adet) * k), n * k);
				this.konum = i + adet;
				this.borc += fark * adet;
				n += adet;
				continue;
			}
			// Kayma: konum, kaymaBoyu örnekte bir tam örnek fazla (ya da eksik) ilerler.
			const g = this.giris;
			const adim = 1 + this.kayma / this.kaymaBoyu;
			while (n < enCok && this.kaymaAdim < this.kaymaBoyu) {
				const konum = this.kaymaBasi + this.kaymaAdim * adim;
				const i = Math.floor(konum);
				if (i > son) {
					this.konum = konum;
					return n;
				}
				const evre = (konum - i) * EVRE;
				const e0 = Math.floor(evre);
				const a = evre - e0;
				const t0 = e0 * DOKUNUS;
				const t1 = t0 + DOKUNUS;
				const bas = (i - (YARI - 1)) * k;
				if (k === 1) {
					let s = 0;
					for (let j = 0; j < DOKUNUS; j++) s += g[bas + j] * (TABLO[t0 + j] + a * (TABLO[t1 + j] - TABLO[t0 + j]));
					hedef[n] = s;
				} else {
					let sl = 0;
					let sr = 0;
					for (let j = 0; j < DOKUNUS; j++) {
						const c = TABLO[t0 + j] + a * (TABLO[t1 + j] - TABLO[t0 + j]);
						sl += g[bas + 2 * j] * c;
						sr += g[bas + 2 * j + 1] * c;
					}
					hedef[2 * n] = sl;
					hedef[2 * n + 1] = sr;
				}
				this.kaymaAdim++;
				this.borc += fark;
				n++;
			}
			if (this.kaymaAdim >= this.kaymaBoyu) {
				// Kayma bitti: konum yine tam sayı.
				this.konum = this.kaymaBasi + this.kaymaBoyu + this.kayma;
				this.kayma = 0;
			} else this.konum = this.kaymaBasi + this.kaymaAdim * adim;
		}
		if (this.konum > 4096) this.sikistir();
		return n;
	}
}

// Tampon doluluğundan yeniden örnekleme oranı: doluluk hedefin üstündeyse giriş biraz daha hızlı
// tüketilir (oran > 1), altındaysa daha yavaş. Doluluk parça parça gelen veriyle oynar: önce
// yumuşatılır (~1 sn). Ölü bölgenin ötesindeki 10 ms'lik sapma %0,1 hız farkıyla (~10 sn'de)
// giderilir; en çok ±%0,5.
const OLU_BOLGE_MS = 3;
class OranDenetimi {
	constructor(hedefMs) {
		this.hedefMs = hedefMs;
		this.sapma = 0; // yumuşatılmış sapma (ms)
		this.oran = 1;
		this.son = 0;
	}
	sifirla() {
		this.sapma = 0;
		this.oran = 1;
		this.son = 0;
	}
	// doluMs: şu anki doluluk; simdi: ms (zaman adımından bağımsız yumuşatma için).
	guncelle(doluMs, simdi) {
		const dt = this.son ? Math.min(100, Math.max(0, simdi - this.son)) : 0;
		this.son = simdi;
		const alfa = 1 - Math.exp(-dt / 1000);
		this.sapma += (doluMs - this.hedefMs - this.sapma) * alfa;
		// ±3 ms'lik sapmaya dokunulmaz (veri parça parça geldiği için doluluk hep biraz oynar; her
		// oynamada düzeltme yapmak boşuna işlemci harcar); ötesi orantılı düzeltilir.
		const s = this.sapma;
		const fazla = s > OLU_BOLGE_MS ? s - OLU_BOLGE_MS : s < -OLU_BOLGE_MS ? s + OLU_BOLGE_MS : 0;
		this.oran = 1 + Math.max(-0.005, Math.min(0.005, fazla * 1e-4));
		return this.oran;
	}
}

module.exports = { Ornekleyici, OranDenetimi, DOKUNUS };
