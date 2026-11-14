// Saat farkını gideren yeniden örnekleyici.
//
// Ses motoru bilgisayarın saatine göre işler; ses kartlarının (mikrofon, hoparlör) kendi saatleri
// vardır ve hiçbiri tam aynı hızda akmaz (tipik fark milyonda 10-100: dakikada birkaç ms). Fark
// giderilmezse aradaki tampon ya taşar ya boşalır: birkaç dakikada bir duyulan bir kesinti. Tarayıcılar
// bunu sesi çok az hızlandırıp yavaşlatarak giderir; burada da öyle: aygıtla motor arasındaki her
// akış, oranı 1'e çok yakın (en çok ±%0,5) ve sürekli ayarlanan bir yeniden örnekleyiciden geçer.
//
// Yeniden örnekleme pencereli sinc ile (32 dokunuş, 64 evre + evreler arası doğrusal geçiş): doğrusal
// ya da kübik ara değerleme oran 1'e yakınken tizleri evreye göre değişen oranda zayıflatır (yarım
// örnekte 15 kHz −2,5 dB), fark yavaş kaydıkça tizlerde dalgalanma duyulur. Burada 18 kHz'e kadar düz.
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

class Ornekleyici {
	constructor(kanal) {
		this.kanal = kanal;
		this.giris = new Float32Array(kanal * 8192);
		this.dolu = 0; // giris'teki çerçeve sayısı
		this.konum = YARI - 1; // bir sonraki çıkış örneğinin giris'teki (kesirli) yeri
		this.sifirla();
	}

	// Geçmişi unut: süzgecin baktığı ilk örnekler sessizlik sayılır.
	sifirla() {
		this.giris.fill(0);
		this.dolu = YARI - 1;
		this.konum = YARI - 1;
	}

	// Henüz çıkışa dönüşmemiş giriş (çerçeve, kesirli).
	get bekleyen() {
		return Math.max(0, this.dolu - YARI - this.konum);
	}

	// Giriş ekle (kanalları iç içe: L R L R …).
	besle(veri, cerceve = veri.length / this.kanal) {
		const k = this.kanal;
		const gerek = (this.dolu + cerceve) * k;
		if (gerek > this.giris.length) {
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
		const at = Math.floor(this.konum) - (YARI - 1);
		if (at <= 0) return;
		const k = this.kanal;
		this.giris.copyWithin(0, at * k, this.dolu * k);
		this.dolu -= at;
		this.konum -= at;
	}

	// En eski bekleyen girişten `cerceve` kadarını at (tampon fazla büyüdü: gecikme birikmesin).
	at(cerceve) {
		this.konum += Math.min(cerceve, this.bekleyen);
	}

	// `hedef`e (kanalları iç içe) en çok `enCok` çerçeve üret; oran: çıkış örneği başına tüketilen
	// giriş (1'den büyük: giriş daha hızlı tüketilir). Dönüş: üretilen çerçeve sayısı.
	uret(hedef, enCok, oran = 1) {
		const k = this.kanal;
		const g = this.giris;
		let konum = this.konum;
		const son = this.dolu - YARI; // floor(konum) en çok bu olabilir (ilerideki dokunuşlar da dolu olsun)
		let n = 0;
		while (n < enCok) {
			const i = Math.floor(konum);
			if (i > son) break;
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
			konum += oran;
			n++;
		}
		this.konum = konum;
		if (konum > 4096) this.sikistir();
		return n;
	}
}

// Tampon doluluğundan yeniden örnekleme oranı: doluluk hedefin üstündeyse giriş biraz daha hızlı
// tüketilir (oran > 1), altındaysa daha yavaş. Doluluk parça parça gelen veriyle oynar: önce
// yumuşatılır (~1 sn). 10 ms'lik sapma %0,1 hız farkıyla (~10 sn'de) giderilir; en çok ±%0,5.
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
		this.oran = 1 + Math.max(-0.005, Math.min(0.005, this.sapma * 1e-4));
		return this.oran;
	}
}

module.exports = { Ornekleyici, OranDenetimi, DOKUNUS };
