// Görüntü: kanaldakilerin ekran paylaşımını terminalde göstermek.
//
// Sayfa paylaşılan ekranı bir <video> öğesine bağlar (srcObject); burada o izin kareleri libwebrtc'den
// (RTCVideoSink) alınır ve terminale yarım blok karakterleriyle (▀: üst yarısı yazı rengi, alt yarısı
// zemin rengi) çizilir: her hücre iki piksel. Çözünürlük terminalin boyutu kadardır (ör. 120×70
// piksel); yazıyı okumaya yetmez ama ne paylaşıldığı görülür. Web'deki "tam ekran" düğmesi terminalin
// tamamını kullanır (Esc ile çıkılır). Görünmeyen görüntünün kareleri alınmaz.
'use strict';

const { stilNo } = require('./terminal');
const { gercekRenk } = require('./terminal');
const { R } = require('./cizici');

const SAG_KARE_MS = 120; // en çok ~8 kare/sn çizilir

class Goruntu {
	constructor({ kabuk, arayuz }) {
		this.kabuk = kabuk;
		this.arayuz = arayuz;
		this.kaynaklar = new Map(); // iz → { havuz, kare, son }
		this.sonCizim = 0;
		this.temizlik = setInterval(() => this.temizle(), 2000);
		this.temizlik.unref();
		kabuk.on('pencere', (w) => this.kur(w));
		if (kabuk.window) this.kur(kabuk.window);
	}

	// Sayfaya tam ekran desteği: requestFullscreen → terminalin tamamında görüntü.
	kur(window) {
		const g = this;
		window.Element.prototype.requestFullscreen = function () {
			const video = this.localName === 'video' ? this : this.querySelector('video');
			if (!video || !video.srcObject) return Promise.reject(Object.assign(new Error('Tam ekran: görüntü yok'), { name: 'TypeError' }));
			g.arayuz.tamEkran = video;
			g.arayuz.tamEkranKok = this;
			g.arayuz.terminal.yenidenCiz();
			g.arayuz.planla(0);
			queueMicrotask(() => window.document.dispatchEvent(new window.Event('fullscreenchange')));
			return Promise.resolve();
		};
		Object.defineProperty(window.document, 'fullscreenElement', { configurable: true, get: () => (g.arayuz.tamEkran ? g.arayuz.tamEkranKok || g.arayuz.tamEkran : null) });
		window.document.exitFullscreen = () => {
			g.arayuz.tamEkrandanCik();
			return Promise.resolve();
		};
	}

	kaynak(iz) {
		let k = this.kaynaklar.get(iz);
		if (!k) {
			k = { havuz: null, kare: null, son: Date.now() };
			try {
				k.havuz = new this.kabuk.motor.wrtc.nonstandard.RTCVideoSink(iz);
				k.havuz.onframe = (o) => {
					k.kare = o.frame;
					const simdi = Date.now();
					if (simdi - this.sonCizim > SAG_KARE_MS) {
						this.sonCizim = simdi;
						this.arayuz.planla();
					}
				};
			} catch (h) {
				this.kabuk.gunluk('görüntü alınamadı', h);
			}
			this.kaynaklar.set(iz, k);
		}
		k.son = Date.now();
		return k;
	}

	// Bir süredir çizilmeyen görüntülerin karelerini almayı bırak.
	temizle() {
		const simdi = Date.now();
		for (const [iz, k] of this.kaynaklar) {
			if (simdi - k.son < 3000 && iz.readyState !== 'ended') continue;
			try {
				k.havuz.onframe = null;
				k.havuz.stop();
			} catch {}
			this.kaynaklar.delete(iz);
		}
	}

	iz(el) {
		const akis = el && el.srcObject;
		const iz = akis && typeof akis.getVideoTracks === 'function' ? akis.getVideoTracks()[0] : null;
		return iz && iz.readyState !== 'ended' ? iz : null;
	}

	// Çizici için: görüntünün satırları (her satırda tek parça; boyanırken kare çizilir).
	satirlar(el, w) {
		const iz = this.iz(el);
		if (!iz) return [];
		const k = this.kaynak(iz);
		if (!k.kare) return [];
		const gw = Math.max(8, Math.min(w, 100));
		const gh = Math.max(3, Math.min(20, Math.round((gw * k.kare.height) / k.kare.width / 2)));
		const satirlar = [];
		for (let i = 0; i < gh; i++) satirlar.push({ parcalar: [{ video: el, satir: i, satirSayisi: gh, m: '', s: 0, w: gw, el, h: null }], w: gw });
		return satirlar;
	}

	// Satırın görüntüsü: (x, y)'den w hücre; satir: kaçıncı satır (her satır iki piksel).
	boya(ekran, el, satir, x, y, w, satirSayisi = null) {
		const iz = this.iz(el);
		const k = iz && this.kaynak(iz);
		const kare = k && k.kare;
		if (!kare) return;
		const n = satirSayisi || Math.max(1, Math.round((w * kare.height) / kare.width / 2));
		this.satirBoya(ekran, kare, x, y, w, satir, n);
	}

	tamEkranCiz(ekran, el, x0, y0, W, H) {
		ekran.doldur(x0, y0, W, H, { bg: [0, 0, 0] });
		const iz = this.iz(el);
		const k = iz && this.kaynak(iz);
		const kare = k && k.kare;
		if (!kare) {
			ekran.yaz(x0 + 2, y0 + 1, 'Görüntü bekleniyor… (Esc: çık)', { fg: R.soluk, bg: [0, 0, 0] });
			return;
		}
		// En-boy oranı korunarak sığdır (hücre ≈ 1×2 piksel).
		let w = W;
		let h = Math.round((w * kare.height) / kare.width / 2);
		if (h > H) {
			h = H;
			w = Math.round((h * 2 * kare.width) / kare.height);
		}
		const x = x0 + Math.floor((W - w) / 2);
		const y = y0 + Math.floor((H - h) / 2);
		for (let i = 0; i < h; i++) this.satirBoya(ekran, kare, x, y + i, w, i, h);
	}

	// I420 kareden bir terminal satırı (iki piksel satırı): her hücre için küçük bir alanın ortalaması.
	satirBoya(ekran, kare, x, y, w, satir, satirSayisi) {
		const KW = kare.width;
		const KH = kare.height;
		const d = kare.data;
		const uBas = KW * KH;
		const vBas = uBas + (KW >> 1) * (KH >> 1);
		const yarimW = KW >> 1;
		const piksel = (px0, px1, py0, py1) => {
			// Alanın 3×3 noktasının ortalaması (BT.601).
			let r = 0;
			let g = 0;
			let b = 0;
			let n = 0;
			for (let sy = 0; sy < 3; sy++) {
				const py = Math.min(KH - 1, Math.floor(py0 + ((py1 - py0) * (sy + 0.5)) / 3));
				for (let sx = 0; sx < 3; sx++) {
					const px = Math.min(KW - 1, Math.floor(px0 + ((px1 - px0) * (sx + 0.5)) / 3));
					const Y = d[py * KW + px] - 16;
					const ci = (py >> 1) * yarimW + (px >> 1);
					const U = d[uBas + ci] - 128;
					const V = d[vBas + ci] - 128;
					r += 1.164 * Y + 1.596 * V;
					g += 1.164 * Y - 0.813 * V - 0.391 * U;
					b += 1.164 * Y + 2.018 * U;
					n++;
				}
			}
			const k = (v) => Math.max(0, Math.min(255, Math.round(v / n)));
			return [k(r), k(g), k(b)];
		};
		const toplamPiksel = satirSayisi * 2;
		const ust0 = ((satir * 2) / toplamPiksel) * KH;
		const ust1 = ((satir * 2 + 1) / toplamPiksel) * KH;
		const alt1 = ((satir * 2 + 2) / toplamPiksel) * KH;
		for (let i = 0; i < w; i++) {
			const px0 = (i / w) * KW;
			const px1 = ((i + 1) / w) * KW;
			const ust = piksel(px0, px1, ust0, ust1);
			const alt = piksel(px0, px1, ust1, alt1);
			ekran.yazHam(x + i, y, '▀', renkSgr(ust, alt));
		}
	}
}

function renkSgr(ust, alt) {
	if (gercekRenk) return `\x1b[0;38;2;${ust[0]};${ust[1]};${ust[2]};48;2;${alt[0]};${alt[1]};${alt[2]}m`;
	const k = (c) => {
		const q = (v) => Math.round((v / 255) * 5);
		return 16 + 36 * q(c[0]) + 6 * q(c[1]) + q(c[2]);
	};
	return `\x1b[0;38;5;${k(ust)};48;5;${k(alt)}m`;
}

void stilNo;
module.exports = { Goruntu };
