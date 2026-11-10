'use strict';
// Paylaşılan sesten kanaldakilerin sesini çıkarma.
//
// Ekran paylaşımı ses vermeyen tarayıcıda (Firefox, Safari) paylaşılan ses bir ses aygıtından
// alınır. Bilgisayarın sesini veren aygıt (Linux'ta "Monitor of …", Windows'ta Stereo Karışımı, Mac'te
// BlackHole) bu sayfanın çaldığını da, yani kanaldakilerin konuşmasını da duyar; çıkarılmazsa herkes
// kendi sesini paylaşımdan geri duyar. Sayfa ne çaldığını bilir: o ses (referans) yakalanan sesten
// çıkarılır. Hoparlör-mikrofon yankısının tersine bu yol dijitaldir: yakalanan kopya, referansın
// gecikmiş ve ölçeklenmiş hâlidir. Tarayıcının yankı engelleyicisi bu yüzden kullanılmaz: o,
// hoparlörden gelen yankının çıkarılamayan kalıntısını da bastırır ve müziği bir eşik varmış gibi
// kesik kesik gönderir. Burada yalnızca çıkarma yapılır (doğrusal): ses hiçbir eşikle kesilmez,
// referans sessizken (kimse konuşmuyorken) çıkış yakalanan sesin ta kendisidir.
//
// Çalınan her akış (bir kişinin mikrofonu ya da paylaşımı) ayrı bir yuvadır: tarayıcı her akışı kendi
// tamponundan çalar, yakalanana gecikmeleri farklı olabilir (Chromium + PulseAudio'da iki kişinin sesi
// 128 örnek farkla geliyordu; tek bir toplam referansla çıkarma orada 1 dB'yi geçmedi).
//
//   1. Tahmin (Web Worker'da, YankiTahminleri; her yuva için yarım saniyede bir, son ~1,4 saniyeden):
//      yuvanın referansıyla yakalanan ses dörtte bire seyreltilip FFT ile karşılaştırılır (GCC-PHAT):
//      yakalanan kopyanın kaç örnek sonra geldiği. Sonra o gecikmenin çevresinde kısa bir süzgeç (48
//      dokunuş: kazanç, kesirli gecikme, yeniden örneklemenin izi) en küçük kareler yöntemiyle bulunur.
//      Müzik referansla ilintisiz olduğu için uzun pencerede ortalaması sıfıra gider: müzik çalarken de
//      doğru çıkar. Öteki yuvaların bilinen kopyaları önce yakalanandan çıkarılır (iki kişi aynı anda
//      konuşurken biri ötekinin tahmininde gürültü olmasın). (Örnek örnek uyarlanan bir süzgeç, NLMS,
//      burada işe yaramadı: hep çalan müzik onu sürekli sarsıyor, müziğin bir kısmını da "yankı" sanıp
//      çıkarıyordu.)
//   2. Çıkarma (AudioWorklet'te, YankiCikarici): her yuvanın süzgeci kendi referansına uygulanır, çıkan
//      kopyalar yakalanan sesten çıkarılır. Yeni süzgeç gelince eskisinden yumuşakça geçilir. Ayrıca her
//      kopyanın yakalananla ilintisi ~0,2 sn'de bir ölçülür: gecikme sıçrar da süzgeç tutmaz olursa o
//      kopyanın ölçeği sıfıra iner, yankıyı ikiye katlamak yerine olduğu gibi bırakır (yeni gecikme
//      birkaç yüz ms içinde bulunur).
//
// Bu dosya hem AudioWorklet'e (registerProcessor) hem Web Worker'a yüklenir (sayfa ikisi arasında
// iletir); Node denemeleri module.exports'tan alır.

const YANKI_PAKET = 4096; // worklet bu kadar örnekte bir (48 kHz'de ~85 ms) referans + yakalanan gönderir (tahmine)
const YANKI_DOKUNUS = 48; // süzgeç uzunluğu (örnek)
const YANKI_YUVA = 20; // en çok bu kadar çalınan akış (kanalda en çok 10 kişi: 9 mikrofon + 9 paylaşım)

// ---------------------------------------------------------------- AudioWorklet tarafı: çıkarma

class YankiCikarici {
	constructor(hiz, secenek = {}) {
		this.hiz = hiz;
		this.enUzun = Math.round((secenek.enUzunGecikme || 0.8) * hiz); // tahminin aradığından uzun
		this.monEnUzun = Math.round(0.12 * hiz); // yakalanan ses en çok bu kadar geciktirilir
		// Her yuvanın referans geçmişi (stereo halka): süzgeç D0..D0+L-1 gecikmeli örnekleri buradan okur.
		this.halkaBoy = 2 ** Math.ceil(Math.log2(this.enUzun + this.monEnUzun + 1024));
		this.maske = this.halkaBoy - 1;
		this.yaz = 0; // bütün halkaların ortak yazma yeri (hepsi aynı anda ilerler)
		// Yakalanan sesin gecikme halkası: yankı referanstan önce gelirse (olağan değil) yakalanan
		// ses geciktirilir (bütün yuvalar için aynı; en çok gerekeni).
		this.monBoy = 2 ** Math.ceil(Math.log2(this.monEnUzun + 256));
		this.monMaske = this.monBoy - 1;
		this.monL = new Float32Array(this.monBoy);
		this.monR = new Float32Array(this.monBoy);
		this.monYaz = 0;
		this.Dm = 0;
		this.yuvalar = []; // k -> yuva (ilk kez ses gelince kurulur)
		// Tahmine giden tam hızda tek kanal örnekler (L+R): yakalanan + ses gelen yuvalar.
		this.pm = new Float32Array(YANKI_PAKET);
		this.pn = 0;
		// Teşhis: kopya etkinken yakalanan/çıkan güç, yakalanan seste kopukluk (kısa tam sıfır dizileri).
		this.olcYakalanan = 0;
		this.olcCikan = 0;
		this.sifirDizi = 0;
		this.kopukluk = 0;
		this.kopuklukOrnek = 0;
		this.uzunSessizlik = []; // son uzun (>200 ms) tam sıfır dizilerinin süreleri (ms)
		this.sesVardi = false;
	}

	yuva(k) {
		let y = this.yuvalar[k];
		if (!y) {
			y = this.yuvalar[k] = {
				refL: new Float32Array(this.halkaBoy),
				refR: new Float32Array(this.halkaBoy),
				// Uygulanan süzgeç { D0, w } (null: yok); yenisi gelince bir blok boyunca eskisinden geçilir.
				suzgec: null,
				eski: null,
				// Kopyanın ölçeği: Σ yakalanan·kopya / Σ kopya² (≈0,2 sn) belirgin biçimde düşükse [0, 1).
				olcek: 1,
				Sdy: 0,
				Syy: 0,
				pr: new Float32Array(YANKI_PAKET),
				sesVar: false, // bu pakette ses geldi mi
			};
		}
		return y;
	}

	// Yuva boşaldı (akış gitti): geçmişi ve süzgeci unutulur.
	yuvaBosalt(k) {
		this.yuvalar[k] = undefined;
		this.dmAyarla();
	}

	// Tahminden yeni süzgeç: kopya = Σ w[j] · referans[n - D0 - j]. D0 < 0 ise (yankı referanstan önce)
	// yakalanan ses geciktirilir. w = null: süzgeci kaldır.
	suzgecAyarla(k, D0, w) {
		const y = this.yuva(k);
		if (!w) {
			y.eski = y.suzgec;
			y.suzgec = null;
			this.dmAyarla();
			return;
		}
		D0 = Math.round(D0);
		if (D0 < -this.monEnUzun || D0 + w.length >= this.halkaBoy - this.monEnUzun - 512) return;
		y.eski = y.suzgec;
		y.suzgec = { D0, w: Float32Array.from(w) };
		y.olcek = 1;
		y.Sdy = y.Syy = 0;
		this.dmAyarla();
	}

	// Yakalananın gecikmesi: en çok gereken (yankısı referanstan önce gelen yuva). Değişirse çıkış bir
	// kez sıçrar (olağan değil); süzgeçler kendi D0'larıyla kalır, okurken Dm eklenir.
	dmAyarla() {
		let Dm = 0;
		for (const y of this.yuvalar) if (y && y.suzgec) Dm = Math.max(Dm, -y.suzgec.D0);
		this.Dm = Math.min(this.monEnUzun, Dm);
	}

	// Bir blok işle. mon*: yakalanan ses; refler[k] = [L, R] (o yuvaya ses gelmiyorsa yok);
	// cik*: gönderilecek. Dönüş: tahmine gidecek örnek paketi ({ m, r: { k: dizi } }) ya da null.
	isle(monL, monR, refler, cikL, cikR) {
		const n = monL.length;
		const maske = this.maske;
		const monMaske = this.monMaske;
		const a0 = this.yaz;
		const pn0 = this.pn;
		// Referansları halkalara yaz (gelmeyen yuvaya sıfır).
		for (let k = 0; k < Math.max(refler.length, this.yuvalar.length); k++) {
			const giris = refler[k];
			const varMi = !!(giris && giris[0]);
			let y = this.yuvalar[k];
			if (!y && !varMi) continue;
			if (!y) y = this.yuva(k);
			const L = varMi ? giris[0] : null;
			const R = varMi ? giris[1] || giris[0] : null;
			for (let i = 0; i < n; i++) {
				const a = (a0 + i) & maske;
				const l = L ? L[i] : 0;
				const r = R ? R[i] : 0;
				y.refL[a] = l;
				y.refR[a] = r;
				y.pr[pn0 + i] = l + r;
				if (l !== 0 || r !== 0) y.sesVar = true;
			}
		}
		let sd = 0;
		let sc = 0;
		let etkin = false;
		for (let i = 0; i < n; i++) {
			const ml = monL[i];
			const mr = monR[i];
			const ma = this.monYaz;
			this.monL[ma] = ml;
			this.monR[ma] = mr;
			this.monYaz = (ma + 1) & monMaske;
			// Kopukluk teşhisi: sesin ortasında 2-200 ms tam sıfır (yakalamada düşen örnekler). Daha uzun
			// tam sessizlikler ayrıca (son beşinin süresi) tutulur: şarkı arası da olabilir.
			if (ml === 0 && mr === 0) this.sifirDizi++;
			else {
				if (this.sesVardi && this.sifirDizi >= this.hiz / 500 && this.sifirDizi <= this.hiz / 5) {
					this.kopukluk++;
					this.kopuklukOrnek += this.sifirDizi;
				} else if (this.sesVardi && this.sifirDizi > this.hiz / 5) {
					// Uzun tam sessizlik: şarkı arası olabilir; müzik sürerken olduysa yakalama durmuştur.
					this.uzunSessizlik.push(Math.round((this.sifirDizi / this.hiz) * 1000));
					if (this.uzunSessizlik.length > 5) this.uzunSessizlik.shift();
				}
				this.sifirDizi = 0;
				this.sesVardi = true;
			}
			this.pm[pn0 + i] = ml + mr;
			let dl = ml;
			let dr = mr;
			if (this.Dm > 0) {
				const mb = (ma - this.Dm + this.monBoy) & monMaske;
				dl = this.monL[mb];
				dr = this.monR[mb];
			}
			cikL[i] = dl;
			cikR[i] = dr;
		}
		// Her yuvanın kopyasını çıkar.
		for (const y of this.yuvalar) {
			if (!y || (!y.suzgec && !y.eski)) continue;
			let sdy = 0;
			let syy = 0;
			const olcek = y.olcek;
			const s = y.suzgec;
			const e = y.eski;
			for (let i = 0; i < n; i++) {
				const a = (a0 + i) & maske;
				let yl = 0;
				let yr = 0;
				if (s) {
					const w = s.w;
					let b = a - (s.D0 + this.Dm) + 4 * this.halkaBoy;
					for (let j = 0; j < w.length; j++, b--) {
						const c = b & maske;
						yl += w[j] * y.refL[c];
						yr += w[j] * y.refR[c];
					}
				}
				if (e) {
					// Eski süzgeçten yeniye doğrusal geçiş (tık olmasın).
					let el = 0;
					let er = 0;
					const w = e.w;
					let b = a - (e.D0 + this.Dm) + 4 * this.halkaBoy;
					for (let j = 0; j < w.length; j++, b--) {
						const c = b & maske;
						el += w[j] * y.refL[c];
						er += w[j] * y.refR[c];
					}
					const g = (i + 1) / n;
					yl = g * yl + (1 - g) * el;
					yr = g * yr + (1 - g) * er;
				}
				// Ölçek, kopyanın bu yuvanın yakaladığına ne kadar uyduğu (diğer yuvaların kopyası ilintisiz).
				const ml = this.monL[(this.monYaz - n + i - this.Dm + 2 * this.monBoy) & monMaske];
				const mr = this.monR[(this.monYaz - n + i - this.Dm + 2 * this.monBoy) & monMaske];
				sdy += ml * yl + mr * yr;
				syy += yl * yl + yr * yr;
				cikL[i] -= olcek * yl;
				cikR[i] -= olcek * yr;
			}
			y.eski = null;
			if (s) {
				// Ölçek yalnızca süzgeç belirgin biçimde tutmuyorsa düşer: olağan oynamada (müzik oranı
				// gürültülü yapar) 1 kalır, yoksa her blokta kopyanın seviyesini oynatıp kalıntı bırakırdı.
				const ag = Math.min(1, n / (0.2 * this.hiz));
				y.Sdy += ag * (sdy - y.Sdy);
				y.Syy += ag * (syy - y.Syy);
				if (y.Syy > n * 1e-8) {
					const oran = y.Sdy / y.Syy;
					y.olcek = oran >= 0.6 ? 1 : Math.max(0, oran / 0.6);
				}
				if (syy > n * 1e-7) etkin = true;
			}
		}
		if (etkin) {
			for (let i = 0; i < n; i++) {
				const mb = (this.monYaz - n + i - this.Dm + 2 * this.monBoy) & monMaske;
				sd += this.monL[mb] * this.monL[mb] + this.monR[mb] * this.monR[mb];
				sc += cikL[i] * cikL[i] + cikR[i] * cikR[i];
			}
			this.olcYakalanan += sd;
			this.olcCikan += sc;
		}
		this.yaz = (a0 + n) & maske;
		this.pn = pn0 + n;
		if (this.pn < YANKI_PAKET) return null;
		// Paket doldu: yakalanan + bu pakette sesi olan yuvalar.
		const paket = { m: this.pm, r: {} };
		this.pm = new Float32Array(YANKI_PAKET);
		this.pn = 0;
		this.yuvalar.forEach((y, k) => {
			if (!y) return;
			if (y.sesVar) {
				paket.r[k] = y.pr;
				y.pr = new Float32Array(YANKI_PAKET);
			}
			y.sesVar = false;
		});
		return paket;
	}

	// Teşhis özeti: yuvaların gecikmeleri, kopya etkinken yakalanan/çıkan güç oranı (müzik de içinde:
	// alt sınır), yakalamadaki kopukluklar.
	ozet() {
		const azalma = this.olcYakalanan > 0 && this.olcCikan > 0 ? 10 * Math.log10(this.olcYakalanan / this.olcCikan) : null;
		const gecikmeler = {};
		this.yuvalar.forEach((y, k) => {
			if (y && y.suzgec) gecikmeler[k] = Math.round(((y.suzgec.D0 + y.suzgec.w.length / 2) / this.hiz) * 10000) / 10;
		});
		const o = {
			gecikmeMs: gecikmeler,
			olcek: this.yuvalar.reduce((en, y) => (y && y.suzgec ? Math.min(en, Math.round(y.olcek * 100) / 100) : en), 1),
			azalmaDb: azalma === null ? null : Math.round(azalma * 10) / 10,
			kopukluk: this.kopukluk,
			kopuklukMs: Math.round((this.kopuklukOrnek / this.hiz) * 1000),
			uzunSessizlikMs: this.uzunSessizlik.slice(),
		};
		this.olcYakalanan = this.olcCikan = 0;
		return o;
	}
}

// ---------------------------------------------------------------- Worker tarafı: tahmin

// Yerinde karmaşık FFT (radix-2). ters=true: ters dönüşüm (1/N ölçeğiyle). Tablolar boya göre bir kez
// kurulur (her yuvanın tahmini aynısını kullanır).
const FFT_TABLOLARI = new Map();
function fftKur(N) {
	if (FFT_TABLOLARI.has(N)) return FFT_TABLOLARI.get(N);
	const t = fftTablosu(N);
	FFT_TABLOLARI.set(N, t);
	return t;
}
function fftTablosu(N) {
	const cos = new Float64Array(N / 2);
	const sin = new Float64Array(N / 2);
	for (let i = 0; i < N / 2; i++) {
		cos[i] = Math.cos((2 * Math.PI * i) / N);
		sin[i] = -Math.sin((2 * Math.PI * i) / N);
	}
	const bit = Math.log2(N);
	const sira = new Uint32Array(N);
	for (let i = 0; i < N; i++) {
		let r = 0;
		for (let b = 0, x = i; b < bit; b++, x >>= 1) r = (r << 1) | (x & 1);
		sira[i] = r;
	}
	return { N, cos, sin, sira };
}
function fft(t, re, im, ters = false) {
	const { N, cos, sin, sira } = t;
	for (let i = 0; i < N; i++) {
		const j = sira[i];
		if (j > i) {
			let x = re[i];
			re[i] = re[j];
			re[j] = x;
			x = im[i];
			im[i] = im[j];
			im[j] = x;
		}
	}
	const isaret = ters ? -1 : 1;
	for (let boy = 2; boy <= N; boy <<= 1) {
		const yarim = boy >> 1;
		const adim = N / boy;
		for (let i = 0; i < N; i += boy) {
			for (let j = 0, k = 0; j < yarim; j++, k += adim) {
				const c = cos[k];
				const s = isaret * sin[k];
				const a = i + j;
				const b = a + yarim;
				const xr = re[b] * c - im[b] * s;
				const xi = re[b] * s + im[b] * c;
				re[b] = re[a] - xr;
				im[b] = im[a] - xi;
				re[a] += xr;
				im[a] += xi;
			}
		}
	}
	if (ters) {
		for (let i = 0; i < N; i++) {
			re[i] /= N;
			im[i] /= N;
		}
	}
}

// Simetrik Toeplitz sistemi (Levinson): R x = p, R[i][j] = r[|i-j|]. Çözülemezse null.
function toeplitzCoz(r, p) {
	const L = p.length;
	if (!(r[0] > 0)) return null;
	const x = new Float64Array(L);
	let f = new Float64Array(L); // ileri vektör (simetrikte geri vektör bunun tersidir)
	f[0] = 1 / r[0];
	x[0] = p[0] / r[0];
	for (let n = 1; n < L; n++) {
		let ef = 0;
		for (let i = 0; i < n; i++) ef += r[n - i] * f[i];
		const d = 1 - ef * ef;
		if (!(d > 1e-12)) return null;
		const yeni = new Float64Array(L);
		// f_yeni = (f, 0)/d - ef·(0, b)/d, b[i] = f[n-1-i]
		for (let i = 0; i <= n; i++) {
			const fi = i < n ? f[i] : 0;
			const bi = i > 0 ? f[n - i] : 0;
			yeni[i] = (fi - ef * bi) / d;
		}
		f = yeni;
		let ex = 0;
		for (let i = 0; i < n; i++) ex += r[n - i] * x[i];
		const k = p[n] - ex;
		// x_yeni = (x, 0) + k·b_yeni, b_yeni[i] = f_yeni[n-i]
		for (let i = 0; i <= n; i++) x[i] += k * f[n - i];
	}
	return x;
}

// Referans (r) ile yakalanan (m) tam hızda tek kanal örneklerden yankı süzgecini bulur. Yarım
// saniyede bir, son pencerede yeterince konuşma varsa dener. Dönüş: { D0, w, ... } (yeni süzgeç),
// { kaldir: true } (yankı artık yok) ya da null (değişiklik yok).
class YankiTahmini {
	constructor(hiz, secenek = {}) {
		this.hiz = hiz;
		this.seyrek = 4;
		this.L = secenek.dokunus || YANKI_DOKUNUS;
		// Aranan gecikme: -0,1 .. +0,7 sn (ses çıkışı + yakalama tamponları; olağanı 20-150 ms).
		this.enUzun = Math.round((secenek.enUzunGecikme || 0.7) * hiz);
		this.enKisa = Math.round((secenek.enKisaGecikme || 0.1) * hiz); // yankı referanstan önce: en çok
		this.pencere = 2 ** Math.ceil(Math.log2(1.3 * hiz)); // bakılan son kısım (48 kHz'de 65536 ≈ 1,37 sn)
		this.boy = this.pencere + this.enUzun + this.L + 1024; // süzgeç için referans daha geriden gerekir
		this.r = new Float32Array(this.boy);
		this.m = new Float32Array(this.boy);
		this.dolu = 0;
		this.yeni = 0;
		this.aralik = Math.round((secenek.aralik || 0.5) * hiz);
		// GCC: seyreltilmiş pencerenin iki katı uzunlukta FFT (doğrusal ilinti, ±pencere gecikme).
		this.Ns = (this.pencere / this.seyrek) * 2;
		this.t = fftKur(this.Ns);
		this.esik = secenek.esik || 9;
		this.merkez = null; // süzgecin ortadaki gecikmesi (tam hız); null: yankı bulunmadı
		this.aday = null; // son kaba gecikme (art arda iki deneme aynı yeri göstersin)
		this.sonSuzgec = null; // { D0, w }: son kabul edilen süzgeç (öteki yuvalar için kopya)
	}

	ekle(r, m) {
		const n = r.length;
		const B = this.boy;
		if (n >= B) {
			this.r.set(r.subarray(n - B));
			this.m.set(m.subarray(n - B));
		} else {
			this.r.copyWithin(0, n);
			this.m.copyWithin(0, n);
			this.r.set(r, B - n);
			this.m.set(m, B - n);
		}
		this.dolu = Math.min(B, this.dolu + n);
		this.yeni += n;
	}

	// hedefFn: yakalananın yerine kullanılacak dizi (öteki yuvaların kopyaları çıkarılmış); yalnızca
	// gerçekten denenecekse çağrılır.
	dene(hedefFn) {
		// Tampon dolmadan da denenir: dolmayan baş sıfırdır (yuva o zaman yoktu, ses de yoktu).
		if (this.yeni < this.aralik || this.dolu < this.hiz / 2) return null;
		this.yeni = 0;
		this.son = null; // bu denemenin özeti (teşhis): { D, guven, anlamli }
		const B = this.boy;
		const P = this.pencere;
		const r = this.r;
		// Referansta yeterince ses var mı (son pencerede en az yarım saniye)? Yoksa denemeye değmez.
		let etkin = 0;
		const parca = 512;
		for (let i = B - P; i + parca <= B; i += parca) {
			let e = 0;
			for (let j = i; j < i + parca; j++) e += r[j] * r[j];
			if (e / parca > 4e-6) etkin += parca;
		}
		if (etkin < this.hiz / 2) return null;
		const m = hedefFn ? hedefFn() : this.m;
		// 1. Kaba gecikme (GCC-PHAT, seyreltilmiş). Yeni bir yer ancak art arda iki deneme aynı yeri
		// gösterirse (ya da çok belirginse) ve süzgecin kapsadığından uzaksa (sıçrama) alınır.
		const kaba = this.kabaGecikme(m);
		this.son = { D: kaba.D, guven: Math.round(kaba.guven) };
		let D = this.merkez;
		if (kaba.guven >= this.esik) {
			const once = this.aday;
			this.aday = kaba.D;
			const tutarli = (once !== null && Math.abs(once - kaba.D) <= 2 * this.seyrek) || kaba.guven >= this.esik * 2;
			if (tutarli && (D === null || Math.abs(kaba.D - D) > this.L / 4)) D = kaba.D;
		}
		if (D === null) return null;
		this.merkez = D;
		// 2. İnce süzgeç (en küçük kareler), gecikmenin çevresinde.
		const s = this.suzgecBul(D, m);
		if (!s) return null;
		this.son.anlamli = Math.round(s.anlamli);
		if (s.anlamli < 10) {
			// Bu gecikmede açıklanan enerji tesadüften ayırt edilemiyor: yankı yok (ya da kayboldu).
			if (kaba.guven < this.esik) {
				this.merkez = null;
				this.sonSuzgec = null;
				return { kaldir: true };
			}
			return null;
		}
		// Tepe kenara kaydıysa (yavaş kayma) bir dahaki süzgeç yeni yere ortalanır.
		if (Math.abs(s.tepe - this.L / 2) > this.L / 4) this.merkez = D + s.tepe - this.L / 2;
		this.sonSuzgec = { D0: D - this.L / 2, w: Float32Array.from(s.w) };
		return { D0: D - this.L / 2, w: s.w, azalmaDb: s.azalmaDb, guven: kaba.guven, kazanc: s.kazanc };
	}

	// Bu yuvanın şu anki süzgeciyle yankının kopyasını hedef'ten çıkar (tamponun tamamı boyunca):
	// öteki yuvaların tahmininde bu yuvanın yankısı gürültü olmasın.
	kopyaCikar(hedef) {
		const f = this.sonSuzgec;
		if (!f) return;
		const r = this.r;
		const w = f.w;
		const L = w.length;
		const bas = Math.max(0, f.D0 + L - 1);
		const son = Math.min(this.boy, this.boy + f.D0);
		for (let n = bas; n < son; n++) {
			let y = 0;
			const o = n - f.D0;
			for (let j = 0; j < L; j++) y += w[j] * r[o - j];
			hedef[n] -= y;
		}
	}

	// Seyreltilmiş (4'te 1) son pencerede referansla yakalananın (m) ilintisi: tepe = gecikme (tam hız).
	kabaGecikme(m = this.m) {
		const S = this.seyrek;
		const B = this.boy;
		const P = this.pencere;
		const Ns = this.Ns;
		const Ps = P / S;
		const re = new Float64Array(Ns);
		const im = new Float64Array(Ns);
		// İki gerçek sinyal tek karmaşık FFT'de: z = referans + i·yakalanan (sıfır dolgulu).
		for (let i = 0; i < Ps; i++) {
			let x = 0;
			let y = 0;
			const o = B - P + i * S;
			for (let j = 0; j < S; j++) {
				x += this.r[o + j];
				y += m[o + j];
			}
			re[i] = x;
			im[i] = y;
		}
		fft(this.t, re, im);
		// R[k] = (Z[k] + Z*[N-k]) / 2, M[k] = (Z[k] - Z*[N-k]) / 2i; C = M · R* (PHAT ağırlıklı).
		let toplam = 0;
		const cre = new Float64Array(Ns);
		const cim = new Float64Array(Ns);
		for (let k = 0; k < Ns; k++) {
			const j = (Ns - k) & (Ns - 1);
			const ar = (re[k] + re[j]) / 2;
			const ai = (im[k] - im[j]) / 2;
			const br = (im[k] + im[j]) / 2;
			const bi = -(re[k] - re[j]) / 2;
			const xr = br * ar + bi * ai;
			const xi = bi * ar - br * ai;
			cre[k] = xr;
			cim[k] = xi;
			toplam += Math.hypot(xr, xi);
		}
		const eps = (toplam / Ns) * 1e-3 + 1e-30;
		for (let k = 0; k < Ns; k++) {
			const o = 1 / Math.pow(Math.hypot(cre[k], cim[k]) + eps, 0.85);
			cre[k] *= o;
			cim[k] *= o;
		}
		fft(this.t, cre, cim, true);
		const deger = (tau) => cre[(tau + Ns) & (Ns - 1)];
		const bas = -Math.round(this.enKisa / S);
		const son = Math.round(this.enUzun / S);
		let enb = -Infinity;
		let yer = 0;
		for (let tau = bas; tau <= son; tau++) {
			const v = deger(tau);
			if (v > enb) {
				enb = v;
				yer = tau;
			}
		}
		let s = 0;
		let s2 = 0;
		let say = 0;
		for (let tau = bas; tau <= son; tau++) {
			if (Math.abs(tau - yer) < 6) continue;
			const v = deger(tau);
			s += v;
			s2 += v * v;
			say++;
		}
		const ort = s / say;
		const sapma = Math.sqrt(Math.max(1e-30, s2 / say - ort * ort));
		return { D: yer * S, guven: (enb - ort) / sapma };
	}

	// Gecikme D'nin çevresinde L dokunuşlu süzgeç: yakalanan (m) ≈ Σ w[k] · referans[n - (D - L/2) - k].
	suzgecBul(D, m = this.m) {
		const L = this.L;
		const B = this.boy;
		const P = this.pencere;
		const r = this.r;
		const D0 = D - L / 2;
		// Yakalananın bakılan kısmı: son pencere (yankı referanstan önce geliyorsa o kadar daha eskisi).
		const son = Math.min(B, B + D0);
		const bas = son - P;
		if (bas - D0 - (L - 1) < 0) return null;
		// Referansın öz ilintisi (Toeplitz yaklaşımı) ve yakalananla çapraz ilintisi.
		const rr = new Float64Array(L);
		const p = new Float64Array(L);
		for (let k = 0; k < L; k++) {
			let a = 0;
			let c = 0;
			const o = -D0 - k;
			for (let n = bas; n < son; n++) {
				const x = r[n + o];
				c += m[n] * x;
				a += r[n - D0] * x;
			}
			rr[k] = a;
			p[k] = c;
		}
		let em = 0;
		for (let n = bas; n < son; n++) em += m[n] * m[n];
		if (!(rr[0] > 0) || !(em > 0)) return null;
		rr[0] *= 1 + 1e-3; // düzenleme: referansta enerjisi olmayan bantlarda katsayılar şişmesin
		const w = toeplitzCoz(rr, p);
		if (!w) return null;
		let aciklanan = 0;
		let tepe = 0;
		let enb = 0;
		let kazanc = 0;
		for (let k = 0; k < L; k++) {
			aciklanan += w[k] * p[k];
			kazanc += w[k];
			if (Math.abs(w[k]) > enb) {
				enb = Math.abs(w[k]);
				tepe = k;
			}
		}
		const kalan = Math.max(em - aciklanan, em * 1e-9);
		// Tesadüfen açıklanabilecek enerji ≈ L · (kalan / P): ondan kaç kat fazla?
		const anlamli = aciklanan / ((L * kalan) / P);
		return { w: Float32Array.from(w), tepe, anlamli, azalmaDb: 10 * Math.log10(em / kalan), kazanc };
	}
}

// Bütün yuvaların tahmini (Worker'ın işi; Node denemesi de bunu kullanır). Her paket önce bütün
// yuvalara eklenir (zaman hizası: sessiz yuvaya sıfır), sonra her yuva denenir: yakalanandan öteki
// yuvaların bilinen kopyaları çıkarılmış olarak (iki kişi aynı anda konuşurken biri ötekinin
// tahmininde gürültü olmasın). Dönüş: worklet'e/sayfaya gidecek iletiler.
class YankiTahminleri {
	constructor(hiz) {
		this.hiz = hiz;
		this.tahminler = new Map(); // yuva -> YankiTahmini
		this.sifirlar = new Float32Array(YANKI_PAKET);
	}
	yuvaBosalt(k) {
		this.tahminler.delete(k);
	}
	paket(m, r = {}) {
		if (this.sifirlar.length !== m.length) this.sifirlar = new Float32Array(m.length);
		for (const k of Object.keys(r)) if (!this.tahminler.has(Number(k))) this.tahminler.set(Number(k), new YankiTahmini(this.hiz));
		for (const [k, t] of this.tahminler) t.ekle(r[k] || this.sifirlar, m);
		const iletiler = [];
		for (const [k, t] of this.tahminler) {
			t.son = undefined;
			const s = t.dene(() => {
				let hedef = null;
				for (const [k2, t2] of this.tahminler) {
					if (k2 === k || !t2.sonSuzgec) continue;
					if (!hedef) hedef = Float32Array.from(t.m);
					t2.kopyaCikar(hedef);
				}
				return hedef || t.m;
			});
			if (t.son !== undefined) iletiler.push({ tur: 'deneme', yuva: k, ...(t.son || { etkin: false }), kabul: !!(s && !s.kaldir) });
			if (!s) continue;
			if (s.kaldir) iletiler.push({ tur: 'suzgec', yuva: k, w: null });
			else iletiler.push({ tur: 'suzgec', yuva: k, D0: s.D0, w: s.w, azalmaDb: s.azalmaDb, guven: s.guven, kazanc: s.kazanc });
		}
		return iletiler;
	}
}

// ---------------------------------------------------------------- AudioWorklet işlemcisi

if (typeof registerProcessor === 'function' && typeof AudioWorkletProcessor === 'function') {
	// Girişler: 0 yakalanan ses, 1..YANKI_YUVA çalınan akışlar (her biri bir yuva).
	registerProcessor(
		'yanki-cikarici',
		class extends AudioWorkletProcessor {
			constructor() {
				super();
				/* global sampleRate */
				this.c = new YankiCikarici(sampleRate);
				this.bitti = false;
				this.port.onmessage = (e) => {
					const v = e.data || {};
					if (v.tur === 'suzgec') this.c.suzgecAyarla(v.yuva, v.D0, v.w || null);
					else if (v.tur === 'yuva-bos') this.c.yuvaBosalt(v.yuva);
					else if (v.tur === 'ozet') this.port.postMessage({ tur: 'ozet', ozet: this.c.ozet() });
					else if (v.tur === 'bitir') this.bitti = true;
				};
				this.sessiz = new Float32Array(128);
				this.refler = [];
			}
			process(girisler, cikislar) {
				if (this.bitti) return false;
				const mon = girisler[0] || [];
				const cik = cikislar[0];
				const n = cik[0].length;
				if (this.sessiz.length !== n) this.sessiz = new Float32Array(n);
				const ml = mon[0] || this.sessiz;
				const mr = mon[1] || ml;
				const refler = this.refler;
				refler.length = 0;
				for (let k = 1; k < girisler.length; k++) refler.push(girisler[k] && girisler[k].length ? girisler[k] : null);
				const cl = cik[0];
				const cr = cik[1] || new Float32Array(n);
				const paket = this.c.isle(ml, mr, refler, cl, cr);
				if (paket) {
					const aktar = [paket.m.buffer, ...Object.values(paket.r).map((d) => d.buffer)];
					this.port.postMessage({ tur: 'ornek', m: paket.m, r: paket.r }, aktar);
				}
				return true;
			}
		},
	);
}

// ---------------------------------------------------------------- Web Worker: tahmin
//
// Tahmin (FFT ve en küçük kareler, yuva başına yarım saniyede bir ~20 ms) sayfayı yormasın diye ayrı
// bir iş parçacığında. Sayfa, worklet'in gönderdiği örnekleri buraya, buradan çıkan süzgeçleri
// worklet'e iletir. Her yuvanın kendi tahmini var (sessiz yuva için sıfır eklenir: zaman hizası).

if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
	let tahmin = new YankiTahminleri(48000);
	self.onmessage = (e) => {
		const v = e.data || {};
		if (v.tur === 'kur') tahmin = new YankiTahminleri(v.hiz);
		else if (v.tur === 'yuva-bos') tahmin.yuvaBosalt(v.yuva);
		else if (v.tur === 'ornek' && v.m) {
			for (const ileti of tahmin.paket(v.m, v.r || {})) self.postMessage(ileti, ileti.w ? [ileti.w.buffer] : []);
		}
	};
}

if (typeof module !== 'undefined' && module.exports) module.exports = { YankiCikarici, YankiTahmini, YankiTahminleri, YANKI_PAKET, YANKI_DOKUNUS, YANKI_YUVA, fftKur, fft, toeplitzCoz };
