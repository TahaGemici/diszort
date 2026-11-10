// Paylaşılan sesten kanaldakilerin sesini çıkarma (web/yanki.js) benzetimle denenir: tarayıcısız,
// birkaç saniyede. Yakalanan ses = müzik + referansın (sayfanın çaldığı konuşma) gecikmiş, ölçeklenmiş,
// kesirli gecikmeyle süzülmüş kopyası; gecikme yavaşça kayar, bir senaryoda sıçrar. Worklet'in
// (YankiCikarici) 128 örneklik blokları ve Worker'ın (YankiTahmini) tahminleri tarayıcıdaki sırayla
// çalıştırılır. Gerçek tarayıcıda, gerçek WebRTC sesiyle: test/tarayici.js.
//
//   node test/yanki.js
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { YankiCikarici, YankiTahminleri } = require(path.join(__dirname, '../web/yanki.js'));

let gecen = 0;
function dene(ad, fn) {
	const t0 = Date.now();
	try {
		const ek = fn();
		gecen++;
		console.log(`ok   ${ad} (${((Date.now() - t0) / 1000).toFixed(1)} sn)${ek ? '\n     ' + ek : ''}`);
	} catch (e) {
		process.exitCode = 1;
		console.error('HATA ' + ad + '\n     ' + (e && e.stack ? e.stack : e));
	}
}

// Tohumlu rastgele (mulberry32).
function rastgeleYap(tohum) {
	let a = tohum >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
	};
}

// Konuşmaya benzeyen ses: değişen perdede harmonikler, hece ritmi, cümle araları.
function konusma(hiz, N, perdeTaban, kaydir, tohum) {
	const s = new Float32Array(N);
	const r = rastgeleYap(tohum);
	let faz = 0;
	for (let i = 0; i < N; i++) {
		const t = i / hiz + kaydir;
		const perde = perdeTaban + 45 * Math.sin(2 * Math.PI * 0.37 * t) + 20 * Math.sin(2 * Math.PI * 2.3 * t);
		faz += (2 * Math.PI * perde) / hiz;
		let v = 0;
		for (let h = 1; h <= 20; h++) {
			const f = h * perde;
			if (f > hiz / 2.2) break;
			const formant = Math.exp(-(((f - 500) / 300) ** 2)) + 0.6 * Math.exp(-(((f - 1500) / 400) ** 2)) + 0.35 * Math.exp(-(((f - 2600) / 500) ** 2));
			v += (Math.sin(h * faz) / h) * (0.25 + formant);
		}
		const hece = Math.max(0, Math.sin(2 * Math.PI * 3.7 * t)) ** 0.6;
		const cumle = t % 4 < 3.4 ? 1 : 0.02;
		s[i] = (v * 0.3 + r() * 0.02) * hece * cumle;
	}
	return s;
}

// Stereo müzik: akorlar (sol/sağ farklı), bas, davul, hışırtı. dinamik(t): genlik çarpanı.
function muzik(hiz, N, dinamik = () => 1) {
	const L = new Float32Array(N);
	const R = new Float32Array(N);
	const r = rastgeleYap(99);
	const notalar = [220, 261.63, 329.63, 392, 196, 246.94, 293.66, 349.23];
	const faz = new Float64Array(64);
	let davul = 0;
	let hisirti = 0;
	let lp = 0;
	for (let i = 0; i < N; i++) {
		const t = i / hiz;
		const akor = Math.floor(t / 2) % 4;
		let l = 0;
		let rr = 0;
		for (let n = 0; n < 3; n++) {
			const f0 = notalar[(akor * 2 + n * 2) % notalar.length] * (n === 2 ? 2 : 1);
			for (let h = 1; h <= 8; h++) {
				const f = f0 * h;
				if (f > 9000) break;
				faz[n * 16 + h] += (2 * Math.PI * f) / hiz;
				const v = Math.sin(faz[n * 16 + h]) / h;
				l += v * (n === 0 ? 0.8 : n === 1 ? 0.5 : 0.3);
				rr += v * (n === 0 ? 0.3 : n === 1 ? 0.5 : 0.8);
			}
		}
		const zarf = 0.6 + 0.4 * Math.exp(-((t * 2) % 1) * 3);
		faz[60] += (2 * Math.PI * notalar[(akor * 2) % notalar.length]) / 2 / hiz;
		if ((t * 2) % 1 < 2 / hiz) davul = 1;
		davul *= 0.9993;
		faz[61] += (2 * Math.PI * (50 + 100 * davul)) / hiz;
		if ((t * 4) % 1 < 2 / hiz) hisirti = 1;
		hisirti *= 0.9985;
		const g = r();
		lp = 0.3 * lp + 0.7 * g;
		const ortak = Math.sin(faz[60]) * 0.15 + Math.sin(faz[61]) * davul * 0.3;
		const d = dinamik(t);
		L[i] = (l * 0.08 * zarf + ortak + (g - lp) * hisirti * 0.08) * d;
		R[i] = (rr * 0.08 * zarf + ortak + (g - lp) * hisirti * 0.056) * d;
	}
	return { L, R };
}

// Referansı gecikme(t) kadar (kesirli; pencereli sinc, hafif alçak geçiren) geciktir, kazançla ölçekle.
// Süzgeç çekirdeği 32 örnekte bir yeniden hesaplanır (gecikme yavaş değişir ya da bir kez sıçrar).
function yankiYap(hiz, ref, gecikme, kazanc) {
	const N = ref.length;
	const y = new Float32Array(N);
	const S = 16;
	const cekirdek = new Float64Array(2 * S);
	let tam = 0;
	for (let i = 0; i < N; i++) {
		if (i % 32 === 0) {
			const D = gecikme(i / hiz);
			tam = Math.floor(D);
			const kes = D - tam;
			for (let k = -S + 1; k <= S; k++) {
				const x = k - kes;
				const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
				cekirdek[k + S - 1] = sinc * (0.5 + 0.5 * Math.cos((Math.PI * x) / (S + 1))) * 0.97 * kazanc;
			}
		}
		let v = 0;
		for (let k = -S + 1; k <= S; k++) {
			const j = i - tam - k;
			if (j >= 0 && j < N) v += ref[j] * cekirdek[k + S - 1];
		}
		y[i] = v;
	}
	return y;
}

// Worklet + Worker'ı tarayıcıdaki gibi çalıştır: her referans (çalınan akış) ayrı yuvada. Dönüş:
// çıkış, süzgeç olayları, ilk kilit zamanı.
function calistir(hiz, monL, monR, refler) {
	const N = monL.length;
	const c = new YankiCikarici(hiz);
	const tahmin = new YankiTahminleri(hiz);
	const cikL = new Float32Array(N);
	const cikR = new Float32Array(N);
	const olaylar = [];
	let isleme = 0n;
	let bekleyen = [];
	for (let i = 0; i + 128 <= N; i += 128) {
		// Worker'dan dönen süzgeçler bir sonraki blokta uygulanır.
		for (const [k, s] of bekleyen) {
			if (s.kaldir) c.suzgecAyarla(k, 0, null);
			else c.suzgecAyarla(k, s.D0, s.w);
		}
		bekleyen = [];
		const s0 = process.hrtime.bigint();
		const p = c.isle(monL.subarray(i, i + 128), monR.subarray(i, i + 128), refler.map((r) => (r ? [r.subarray(i, i + 128), r.subarray(i, i + 128)] : null)), cikL.subarray(i, i + 128), cikR.subarray(i, i + 128));
		isleme += process.hrtime.bigint() - s0;
		if (!p) continue;
		for (const ileti of tahmin.paket(p.m, p.r)) {
			if (ileti.tur !== 'suzgec') continue;
			const k = ileti.yuva;
			olaylar.push({ sn: i / hiz, yuva: k, kaldir: !ileti.w, D: ileti.w ? ileti.D0 + ileti.w.length / 2 : null });
			bekleyen.push([k, ileti.w ? ileti : { kaldir: true }]);
		}
	}
	return { cikL, cikR, olaylar, kilit: olaylar.find((o) => !o.kaldir), islemeMs: Number(isleme) / 1e6, c };
}

const gucDb = (x) => (x > 0 ? 10 * Math.log10(x) : -Infinity);
// [bas, son) saniye aralığında: yankının ne kadar azaldığı (kalan = çıkış - müzik).
function azalma(hiz, sonuc, muzikL, muzikR, yanki, bas, son) {
	if (son - bas < 0.1) return null;
	let ey = 0;
	let er = 0;
	for (let i = Math.round(bas * hiz); i < Math.round(son * hiz); i++) {
		const kl = sonuc.cikL[i] - muzikL[i];
		const kr = sonuc.cikR[i] - muzikR[i];
		ey += 2 * yanki[i] * yanki[i];
		er += kl * kl + kr * kr;
	}
	return gucDb(ey) - gucDb(er);
}

// Konuşma (iki kişi sırayla) 2. saniyeden sonra; [sessizBas, sessizSon) arası kimse konuşmuyor.
function referans(hiz, N, sessizBas = Infinity, sessizSon = Infinity) {
	const k1 = konusma(hiz, N, 130, 0, 7);
	const k2 = konusma(hiz, N, 210, 3.3, 11);
	const r = new Float32Array(N);
	for (let i = 0; i < N; i++) {
		const t = i / hiz;
		if (t < 2 || (t >= sessizBas && t < sessizSon)) continue;
		const d = (t - 2) % 8;
		r[i] = d < 4 ? k1[i] : d >= 4.5 && d < 7.5 ? k2[i] : 0;
	}
	return r;
}

function senaryo(hiz, saniye, { gecikme, kazanc = 0.85, muzikKatsayi = 1, sessizBas, sessizSon, dinamik }) {
	const N = Math.round(hiz * saniye);
	const ref = referans(hiz, N, sessizBas, sessizSon);
	const m = muzik(hiz, N, dinamik);
	for (let i = 0; i < N; i++) {
		m.L[i] *= muzikKatsayi;
		m.R[i] *= muzikKatsayi;
	}
	const yanki = kazanc ? yankiYap(hiz, ref, gecikme, kazanc) : new Float32Array(N);
	const monL = new Float32Array(N);
	const monR = new Float32Array(N);
	for (let i = 0; i < N; i++) {
		monL[i] = m.L[i] + yanki[i];
		monR[i] = m.R[i] + yanki[i];
	}
	return { N, ref, m, yanki, monL, monR, sonuc: calistir(hiz, monL, monR, [ref]) };
}

// ---------------------------------------------------------------- denemeler

dene('müzik çalarken: gecikme bulunur, konuşma çıkarılır, müzik bozulmaz; kimse konuşmuyorken ses olduğu gibi gider', () => {
	const hiz = 48000;
	// Gecikme 73,3 ms dolayında, 13 sn'lik dönemle ±0,6 örnek kayıyor (tarayıcının saat uydurması gibi).
	const s = senaryo(hiz, 22, { gecikme: (t) => 3517.37 + 0.6 * Math.sin((2 * Math.PI * t) / 13), sessizBas: 15, sessizSon: 19 });
	const { sonuc } = s;
	assert.ok(sonuc.kilit, 'süzgeç kurulmalı');
	assert.ok(sonuc.kilit.sn < 4, 'konuşma başladıktan ~1,5 sn sonra kilitlenmeli: ' + sonuc.kilit.sn.toFixed(2));
	assert.ok(Math.abs(sonuc.kilit.D - 3517.4) <= 4, 'gecikme 3517 örnek dolayında: ' + sonuc.kilit.D);
	// Kilitten önce (ilk 2 sn kimse konuşmuyor) ve kimse konuşmuyorken çıkış yakalananın ta kendisi.
	for (let i = 0; i < 2 * hiz; i++) assert.equal(sonuc.cikL[i], s.monL[i], 'süzgeç yokken çıkış = yakalanan');
	let fark = 0;
	let guc = 0;
	for (let i = 16 * hiz; i < 18.5 * hiz; i++) {
		fark += (sonuc.cikL[i] - s.monL[i]) ** 2 + (sonuc.cikR[i] - s.monR[i]) ** 2;
		guc += s.monL[i] ** 2 + s.monR[i] ** 2;
	}
	const sessizFark = gucDb(fark) - gucDb(guc);
	assert.ok(sessizFark < -60, 'kimse konuşmuyorken çıkış yakalananla aynı olmalı (eşik yok): ' + sessizFark.toFixed(1) + ' dB');
	const a1 = azalma(hiz, sonuc, s.m.L, s.m.R, s.yanki, 4, 15);
	const a2 = azalma(hiz, sonuc, s.m.L, s.m.R, s.yanki, 19.5, 22);
	assert.ok(a1 > 15, 'müzik çalarken konuşma en az 15 dB azalmalı: ' + a1.toFixed(1));
	assert.ok(a2 > 15, 'sessizlikten sonra da: ' + a2.toFixed(1));
	return `kilit ${sonuc.kilit.sn.toFixed(2)} sn, gecikme ${sonuc.kilit.D}; azalma ${a1.toFixed(1)} / ${a2.toFixed(1)} dB; kimse konuşmuyorken fark ${sessizFark === -Infinity ? '-∞' : sessizFark.toFixed(0)} dB; worklet ${(sonuc.islemeMs / 22).toFixed(1)} ms/sn`;
});

dene('müzik yokken (yalnızca konuşmanın kopyası) çok derin çıkarılır', () => {
	const hiz = 48000;
	const s = senaryo(hiz, 10, { gecikme: () => 2411.6, muzikKatsayi: 0 });
	const a = azalma(hiz, s.sonuc, s.m.L, s.m.R, s.yanki, 4, 10);
	assert.ok(a > 30, 'en az 30 dB: ' + a.toFixed(1));
	return `azalma ${a.toFixed(1)} dB`;
});

dene('yakalanan seste yankı yoksa (ör. sayfa başka bir çıkışa çalıyor) süzgeç kurulmaz, ses dokunulmadan gider', () => {
	const hiz = 48000;
	const s = senaryo(hiz, 10, { kazanc: 0 });
	assert.equal(s.sonuc.olaylar.filter((o) => !o.kaldir).length, 0, 'süzgeç kurulmamalı: ' + JSON.stringify(s.sonuc.olaylar));
	for (let i = 0; i < s.N - 128; i++) assert.equal(s.sonuc.cikL[i], s.monL[i]);
});

dene('gecikme sıçrayınca (tampon büyüdü) süzgeç yeni yere geçer, arada yankıyı ikiye katlamaz', () => {
	const hiz = 48000;
	const s = senaryo(hiz, 16, { gecikme: (t) => (t < 9 ? 3517.4 : 3517.4 + 586) });
	const yeni = s.sonuc.olaylar.find((o) => o.sn > 9 && !o.kaldir && Math.abs(o.D - 4103.4) <= 4);
	assert.ok(yeni, 'yeni gecikme bulunmalı: ' + JSON.stringify(s.sonuc.olaylar.filter((o) => o.sn > 8.5)));
	assert.ok(yeni.sn - 9 < 2.5, 'sıçramadan sonra 2,5 sn içinde: ' + (yeni.sn - 9).toFixed(2));
	// Sıçrama ile yeni süzgeç arası: eski süzgeç tutmaz; ölçek sıfıra iner, yankı en çok biraz artar.
	const ara = azalma(hiz, s.sonuc, s.m.L, s.m.R, s.yanki, 9.25, yeni.sn);
	const sonra = azalma(hiz, s.sonuc, s.m.L, s.m.R, s.yanki, yeni.sn + 0.5, 16);
	assert.ok(ara === null || ara > -3, 'arada yankı ikiye katlanmamalı: ' + ara + ' dB');
	assert.ok(sonra > 15, 'sonra yine en az 15 dB: ' + sonra.toFixed(1));
	return `${(yeni.sn - 9).toFixed(2)} sn'de yeni gecikme; arada ${ara === null ? '-' : ara.toFixed(1)} dB, sonra ${sonra.toFixed(1)} dB`;
});

dene('kısa ve ters gecikmeler (yankı referanstan önce geliyor) de bulunur', () => {
	const hiz = 48000;
	const sonuclar = [];
	for (const D of [180.3, -310.6]) {
		const s = senaryo(hiz, 9, { gecikme: () => D });
		assert.ok(s.sonuc.kilit && Math.abs(s.sonuc.kilit.D - D) <= 4, `gecikme ${D}: ` + JSON.stringify(s.sonuc.kilit));
		const a = azalma(hiz, s.sonuc, s.m.L, s.m.R, s.yanki, 5, 9);
		// Ters gecikmede yakalanan ses geciktirilir: müziği de o kadar kaydırıp karşılaştır.
		const Dm = s.sonuc.c.Dm;
		let ey = 0;
		let er = 0;
		for (let i = 5 * hiz; i < 9 * hiz; i++) {
			const j = i - Dm;
			const kl = s.sonuc.cikL[i] - s.m.L[j];
			const kr = s.sonuc.cikR[i] - s.m.R[j];
			ey += 2 * s.yanki[j] ** 2;
			er += kl * kl + kr * kr;
		}
		const ad = gucDb(ey) - gucDb(er);
		assert.ok(ad > 15, `gecikme ${D}: en az 15 dB (${ad.toFixed(1)})`);
		sonuclar.push(`${D}: ${ad.toFixed(1)} dB (yakalanan ${Dm} örnek geciktirildi)`);
		void a;
	}
	return sonuclar.join('; ');
});

dene('iki kişinin sesi farklı gecikmelerle geliyor (her akış kendi tamponundan): her biri kendi gecikmesiyle çıkarılır', () => {
	const hiz = 48000;
	const N = hiz * 12;
	const k1 = konusma(hiz, N, 130, 0, 7);
	const k2 = konusma(hiz, N, 210, 3.3, 11);
	// İki kişi aynı anda değil, hece hece karışık konuşuyor (gerçek konuşmada da üst üste gelir).
	const r1 = new Float32Array(N);
	const r2 = new Float32Array(N);
	for (let i = 2 * hiz; i < N; i++) {
		r1[i] = k1[i];
		r2[i] = k2[i] * 0.8;
	}
	const y1 = yankiYap(hiz, r1, () => 3361.2, 0.85);
	const y2 = yankiYap(hiz, r2, () => 3489.7, 0.85);
	const m = muzik(hiz, N);
	const monL = new Float32Array(N);
	const monR = new Float32Array(N);
	const yanki = new Float32Array(N);
	for (let i = 0; i < N; i++) {
		yanki[i] = y1[i] + y2[i];
		monL[i] = m.L[i] + yanki[i];
		monR[i] = m.R[i] + yanki[i];
	}
	const sonuc = calistir(hiz, monL, monR, [r1, r2]);
	const kilitler = [0, 1].map((k) => sonuc.olaylar.find((o) => o.yuva === k && !o.kaldir));
	assert.ok(kilitler[0] && Math.abs(kilitler[0].D - 3361.2) <= 4, 'birinci kişinin gecikmesi: ' + JSON.stringify(kilitler[0]));
	assert.ok(kilitler[1] && Math.abs(kilitler[1].D - 3489.7) <= 4, 'ikinci kişinin gecikmesi: ' + JSON.stringify(kilitler[1]));
	const a = azalma(hiz, sonuc, m.L, m.R, yanki, 5, 12);
	assert.ok(a > 15, 'iki kişinin sesi birlikte en az 15 dB azalmalı: ' + a.toFixed(1));
	return `gecikmeler ${kilitler[0].D} / ${kilitler[1].D}; azalma ${a.toFixed(1)} dB`;
});

dene('44,1 kHz ses bağlamında da çalışır', () => {
	const hiz = 44100;
	const s = senaryo(hiz, 9, { gecikme: () => 2205.5 });
	assert.ok(s.sonuc.kilit && Math.abs(s.sonuc.kilit.D - 2205.5) <= 4, JSON.stringify(s.sonuc.kilit));
	const a = azalma(hiz, s.sonuc, s.m.L, s.m.R, s.yanki, 5, 9);
	assert.ok(a > 15, 'en az 15 dB: ' + a.toFixed(1));
	return `azalma ${a.toFixed(1)} dB`;
});

console.log(process.exitCode ? 'BAŞARISIZ' : `Yankı çıkarma denemeleri geçti (${gecen}).`);
