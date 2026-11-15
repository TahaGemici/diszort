// Terminal arayüzü: sayfanın görünen hâlini terminale çizer, tuşları ve fareyi sayfaya iletir.
//
// Ekran web'deki gibi bölünür: solda kanallar (#kanal-panosu), ortada sohbet ve sesli kanal kartı
// (#ana), sağda üyeler (#uye-panosu); açık pencereler (ayarlar, kanal ekle, sunucu…) ortada kutu
// olarak, bildirimler (giriş istekleri, dosya aktarımları) sağ üstte, kısa iletiler altta. Dar
// terminalde paneller web'in telefon görünümündeki gibi çekmece olur. Bölgelerin içi çizici.js'le
// sayfanın DOM'undan çizilir; buradaki tek bilgi bölgelerin yeri ve hangisinin kaydığıdır.
//
// Tuşlar: Tab/Shift+Tab (ya da ↑/↓) öğeler arasında gezer, Enter/boşluk düğmeye basar, ←/→
// kaydırıcıyı ve seçimi değiştirir, Esc pencereyi kapatır; yazmaya başlamak mesaj kutusuna yazar.
// Alt+M mikrofon, Alt+D sağırlaştırma (web'deki Ctrl+Shift+M/D: terminal Ctrl+Shift'i ayırt
// edemez), PgUp/PgDn sohbeti kaydırır, Ctrl+C çıkar. Fare: tıklama, tekerlek, kaydırıcıyı sürükleme.
// Terminale sürüklenen (ya da yapıştırılan) dosya yolları açık kanalda paylaşılır.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Terminal, Ekran, stilNo, stilDegistir } = require('./terminal');
const { Cizici, R, bos, ekle, doldur, satirKirp } = require('./cizici');
const { metinGenislik, kirp } = require('./genislik');
const dosya = require('../kabuk/dosya');

const SOL_PANEL = 28;
const SAG_PANEL = 26;
const DOLDURANLAR = new Set(['kanal-kaydir', 'uye-kaydir']);

class Arayuz {
	constructor({ kabuk, terminal = new Terminal(), surum = '', cikis = () => {}, guncelleme = null }) {
		this.kabuk = kabuk;
		this.terminal = terminal;
		this.surum = surum;
		this.cikis = cikis;
		this.guncelleme = guncelleme; // { metin, yap() } — güncelleme varsa durum satırında
		this.cizici = null;
		this.gozcu = null;
		this.kaydirma = new WeakMap(); // kaydırılan öğe → { ust } ya da (mesajlar) { dipten }
		this.istem = null; // arayüzün kendi sorusu (dosya yolu, onay)
		this.secim = null; // açık seçim listesi (select)
		this.zamanlayici = null;
		this.sonCizim = 0;
		this.odakGoster = true;
		this.hedefler = [];
		this.kaydirmalar = [];
		this.kip = 'genis';
		this.tamEkran = null; // tam ekran gösterilen görüntü öğesi
		this.goruntu = null; // görüntü çizici (goruntu.js) — varsa
		this.durumMetni = '';
		this.kapanis = false;
	}

	// ------------------------------------------------------------ başlatma

	baslat() {
		const t = this.terminal;
		t.on('tus', (k) => this.guvenli(() => this.tus(k)));
		t.on('fare', (f) => this.guvenli(() => this.fare(f)));
		t.on('yapistir', (m) => this.guvenli(() => this.yapistir(m)));
		t.on('boyut', () => this.planla(0));
		t.baslat();
		this.kabuk.on('pencere', () => this.sayfaKur());
		this.kabuk.on('bildirim', (b) => this.bildir(b.metin, b.hata));
		this.kabuk.dosyaSec = (s) => this.dosyaSor(s);
		this.kabuk.kayitYeriSor = (ad) => this.kayitYeriSor(ad);
		if (this.kabuk.window) this.sayfaKur();
		this.planla(0);
	}

	bitir() {
		clearTimeout(this.zamanlayici);
		this.zamanlayici = null;
		if (this.gozcu) this.gozcu.disconnect();
		this.terminal.bitir();
	}

	guvenli(fn) {
		try {
			fn();
		} catch (h) {
			this.kabuk.gunluk('arayüz', h);
			this.bildir('Arayüz hatası: ' + ((h && h.message) || h), true);
		}
	}

	// Sayfa (yeniden) kuruldu: çiziciyi ve değişiklik gözcüsünü kur.
	sayfaKur() {
		const w = this.kabuk.window;
		if (!w) return;
		if (this.gozcu) this.gozcu.disconnect();
		this.cizici = new Cizici(w);
		if (this.goruntu) this.cizici.video = (el, gen) => this.goruntu.satirlar(el, gen, this.cizici);
		this.gozcu = new w.MutationObserver((kayitlar) => {
			for (const k of kayitlar) this.cizici.kirlet(k.target);
			this.planla();
		});
		this.gozcu.observe(w.document, { subtree: true, childList: true, attributes: true, characterData: true });
		this.planla(0);
	}

	// Yeniden çizimi planla: sayfa değişince en çok saniyede ~16 kez (seviye ölçerleri saniyede 10 kez
	// değişir); tuş ve fare olaylarında hemen.
	planla(ms = null) {
		if (this.kapanis) return;
		if (this.zamanlayici) {
			if (ms !== 0) return;
			clearTimeout(this.zamanlayici);
		}
		const bekle = ms ?? Math.max(0, 60 - (Date.now() - this.sonCizim));
		this.zamanlayici = setTimeout(() => {
			this.zamanlayici = null;
			this.guvenli(() => this.ciz());
		}, bekle);
	}

	bildir(metin, hata = false) {
		this.durumMetni = metin;
		this.durumHata = hata;
		clearTimeout(this.durumZamani);
		this.durumZamani = setTimeout(() => {
			this.durumMetni = '';
			this.planla();
		}, hata ? 7000 : 4000);
		this.planla();
	}

	// ------------------------------------------------------------ yardımcılar

	get document() {
		return this.kabuk.document;
	}
	$(id) {
		return this.document ? this.document.getElementById(id) : null;
	}
	gorunur(el) {
		if (!el || !el.isConnected) return false;
		for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
			// Ayrı katmanda çizilenler (pencere, bildirimler, menü) akışta gizli sayılır ama görünür.
			if (this.ozelKatman(e)) {
				if (e.hidden) return false;
				continue;
			}
			if (this.cizici.gizliMi(e)) return false;
		}
		return true;
	}
	// Ayrı katman olarak çizilen öğeler (normal akışta gizli sayılırlar).
	ozelKatman(el) {
		const c = el.classList;
		return c.contains('pencere') || c.contains('buyutec') || c.contains('bildirim-sutunu') || c.contains('yayin-menu') || c.contains('tost');
	}
	acikPencereler() {
		if (!this.document) return [];
		return [...this.document.querySelectorAll('.pencere, .buyutec')].filter((p) => !p.hidden && this.atalarGorunur(p));
	}
	atalarGorunur(el) {
		for (let e = el.parentElement; e && e.nodeType === 1; e = e.parentElement) if (e.hidden) return false;
		return true;
	}
	odak() {
		const a = this.document && this.document.activeElement;
		return a && a !== this.document.body ? a : null;
	}
	yaziAlaniMi(el) {
		if (!el) return false;
		if (el.localName === 'textarea') return true;
		return el.localName === 'input' && ['text', 'search', 'email', 'url', 'tel', 'password', 'number', ''].includes(el.type);
	}

	// ------------------------------------------------------------ çizim

	ciz() {
		this.sonCizim = Date.now();
		if (!this.cizici || !this.document) return;
		const { genislik: W, yukseklik: H } = this.terminal.boyut();
		const kip = W >= 111 ? 'genis' : W >= 77 ? 'orta' : 'dar';
		if (kip !== this.kip || this.kabuk.genislik !== W * 10) {
			this.kip = kip;
			this.kabuk.genislikAyarla(W * 10);
		}
		this.cizici.kip = kip;
		const odak = this.odak();
		this.cizici.odak = odak;
		const ekran = new Ekran(W, H);
		this.ekran = ekran;
		this.hedefler = [];
		this.kaydirmalar = [];
		this.imlec = null;
		this.katman = 0;
		this.karartildi = false;
		const ana = H - 1; // son satır: durum satırı
		if (this.tamEkran && this.goruntu && this.tamEkran.isConnected) {
			this.goruntu.tamEkranCiz(ekran, this.tamEkran, 0, 0, W, ana);
		} else if (this.gorunurKok('giris-ekrani')) this.girisCiz(W, ana);
		else if (this.gorunurKok('uygulama')) this.uygulamaCiz(W, ana);
		else ekran.doldur(0, 0, W, ana, { bg: R.zemin });
		this.bildirimlerCiz(W, ana);
		for (const p of this.acikPencereler()) this.pencereCiz(p, W, ana);
		this.yayinMenusuCiz(W, ana);
		this.tostCiz(W, ana);
		if (this.secim) this.secimCiz(W, ana);
		if (this.istem) this.istemCiz(W, ana);
		this.durumSatiri(W, H - 1);
		this.odakBoya();
		ekran.imlec = this.imlec;
		this.terminal.ciz(ekran);
		this.odakGoster = false;
		const baslik = this.document.title || 'Diszort';
		if (baslik !== this.sonBaslik) {
			this.sonBaslik = baslik;
			this.terminal.baslik(baslik);
		}
	}

	gorunurKok(id) {
		const el = this.$(id);
		return !!el && !el.hidden;
	}

	// Satırları (x, y)'den başlayarak w×h alana boya; ust: ilk görünen satır.
	boya(satirlar, x, y, w, h, ust, zemin) {
		const ekran = this.ekran;
		const odak = this.cizici.odak;
		for (let i = 0; i < h; i++) {
			ekran.doldur(x, y + i, w, 1, zemin);
			const satir = satirlar[ust + i];
			if (!satir) continue;
			let cx = x;
			for (const p of satir.parcalar) {
				if (cx >= x + w) break;
				if (p.video) {
					if (this.goruntu) this.goruntu.boya(ekran, p.video, p.satir, cx, y + i, Math.min(p.w, x + w - cx), p.satirSayisi);
				} else ekran.yaz(cx, y + i, p.m, p.s, x, x + w);
				if (p.el || p.h) this.hedefler.push({ x: cx, y: y + i, g: Math.min(p.w, x + w - cx), y2: 1, el: p.el, h: p.h, p, katman: this.katman });
				if (p.imlec != null && p.h && p.h === odak) this.imlec = { x: Math.min(x + w - 1, cx + p.imlec), y: y + i };
				cx += p.w;
			}
		}
	}

	// Kaydırılabilir bölge: satırların bir kısmı görünür; odaktaki öğe görünür tutulur.
	kaydirmali(el, satirlar, x, y, w, h, zemin, { dip = false } = {}) {
		let d = this.kaydirma.get(el);
		if (!d) this.kaydirma.set(el, (d = dip ? { dipten: 0 } : { ust: 0 }));
		const enCok = Math.max(0, satirlar.length - h);
		let ust = dip ? enCok - Math.min(enCok, d.dipten) : Math.min(d.ust, enCok);
		if (this.odakGoster && this.cizici.odak) {
			const i = satirlar.findIndex((s) => s.parcalar.some((p) => p.h === this.cizici.odak));
			if (i >= 0) {
				if (i < ust) ust = i;
				else if (i >= ust + h) ust = i - h + 1;
			}
		}
		ust = Math.max(0, Math.min(ust, enCok));
		if (dip) d.dipten = enCok - ust;
		else d.ust = ust;
		this.boya(satirlar, x, y, w, h, ust, zemin);
		this.kaydirmalar.push({ x, y, g: w, y2: h, el, toplam: satirlar.length, ust, dip, katman: this.katman });
		// Kaydırma çubuğu (içerik taşıyorsa).
		if (enCok > 0 && w > 4) {
			const boy = Math.max(1, Math.round((h * h) / satirlar.length));
			const yer = Math.round((ust / enCok) * (h - boy));
			for (let i = 0; i < h; i++) this.ekran.yaz(x + w - 1, y + i, i >= yer && i < yer + boy ? '┃' : ' ', stilNo({ fg: R.sonuk, bg: zemin.bg }));
		}
		return ust;
	}

	// Sütun düzeni (panel): sabit öğeler doğal yükseklikte, dolduranlar kalan yeri alır ve kayar.
	sutunCiz(kok, x, y, w, h, zemin) {
		const z = stilNo(zemin);
		const parcalar = [];
		for (const c of kok.children) {
			if (this.cizici.gizliMi(c)) continue;
			const doldurur = [...c.classList].some((s) => DOLDURANLAR.has(s)) || c.id === 'mesaj-alani';
			if (doldurur) parcalar.push({ el: c, doldurur: true });
			else {
				const ic = c.id === 'ses-karti' ? Math.max(1, w - 2) : w;
				let satirlar = this.cizici.blok(c, ic, zemin);
				if (c.id === 'ses-karti') satirlar = this.kartCercevesi(satirlar, w, zemin);
				parcalar.push({ el: c, satirlar });
			}
		}
		const doldurucu = parcalar.filter((p) => p.doldurur).length;
		let sabit = parcalar.reduce((t, p) => t + (p.satirlar ? p.satirlar.length : 0), 0);
		// Sığmıyorsa: sesli kanal kartı en çok yüksekliğin %45'i (kendi içinde kayar).
		for (const p of parcalar) {
			if (p.satirlar && p.el.id === 'ses-karti') {
				const enCok = Math.max(4, Math.floor(h * 0.45));
				if (p.satirlar.length > enCok) {
					sabit -= p.satirlar.length - enCok;
					p.kayar = enCok;
				}
			}
		}
		let kalan = Math.max(0, h - sabit);
		let cy = y;
		for (const p of parcalar) {
			if (cy >= y + h) break;
			if (p.doldurur) {
				const ph = Math.max(0, Math.floor(kalan / doldurucu));
				const satirlar = this.cizici.blok(p.el, w - 1, zemin);
				this.kaydirmali(p.el, satirlar, x, cy, w, ph, zemin, { dip: p.el.id === 'mesaj-alani' });
				cy += ph;
			} else {
				const ph = Math.min(p.kayar || p.satirlar.length, y + h - cy);
				if (p.kayar) this.kaydirmali(p.el, p.satirlar, x, cy, w, ph, zemin);
				else this.boya(p.satirlar, x, cy, w, ph, 0, z);
				cy += ph;
			}
		}
		if (cy < y + h) this.ekran.doldur(x, cy, w, y + h - cy, z);
		void kalan;
	}

	// Sesli kanal kartı: çerçeveli kutu.
	kartCercevesi(satirlar, w, zemin) {
		const cizgi = stilNo({ fg: R.cizgi, bg: zemin.bg });
		const z = stilNo(zemin);
		const out = [];
		const ust = bos();
		ekle(ust, '╭' + '─'.repeat(Math.max(0, w - 2)) + '╮', cizgi);
		out.push(ust);
		for (const s of satirlar) {
			const satir = bos();
			ekle(satir, '│', cizgi);
			const ic = satirKirp(s, w - 2);
			satir.parcalar.push(...ic.parcalar);
			satir.w += ic.w;
			ekle(satir, ' '.repeat(Math.max(0, w - 1 - satir.w)), z);
			ekle(satir, '│', cizgi);
			out.push(satir);
		}
		const alt = bos();
		ekle(alt, '╰' + '─'.repeat(Math.max(0, w - 2)) + '╯', cizgi);
		out.push(alt);
		return out;
	}

	girisCiz(W, H) {
		this.ekran.doldur(0, 0, W, H, { bg: R.zemin });
		const form = this.$('giris');
		if (!form) return;
		const w = Math.min(46, W - 2);
		const zemin = { fg: R.yazi, bg: R.yan };
		const satirlar = this.cizici.blok(form, w - 4, zemin);
		const h = Math.min(H - 2, satirlar.length + 2);
		const x = Math.floor((W - w) / 2);
		const y = Math.max(0, Math.floor((H - h) / 2));
		this.ekran.doldur(x, y, w, h, zemin);
		this.boya(satirlar, x + 2, y + 1, w - 4, h - 2, 0, stilNo(zemin));
		this.ilkOdak(['ad', 'gir', 'burada-devam']);
	}

	uygulamaCiz(W, H) {
		const uyg = this.$('uygulama');
		const sol = this.$('kanal-panosu');
		const orta = this.$('ana');
		const sag = this.$('uye-panosu');
		const zYan = { fg: R.yazi, bg: R.yan };
		const zOrta = { fg: R.yazi, bg: R.orta };
		let x = 0;
		let w = W;
		// Paneller: zemin, içi bir sütun boşluklu.
		const panel = (el, px, pw, z) => {
			this.ekran.doldur(px, 0, pw, H, z);
			this.sutunCiz(el, px + 1, 0, pw - 2, H, z);
		};
		if (this.kip !== 'dar' && sol) {
			panel(sol, 0, SOL_PANEL, zYan);
			x = SOL_PANEL;
			w -= SOL_PANEL;
		}
		const sagGorunur = this.kip === 'genis' && sag && !uyg.classList.contains('uyeler-gizli');
		if (sagGorunur) w -= SAG_PANEL;
		if (orta) panel(orta, x, w, zOrta);
		if (sagGorunur) panel(sag, W - SAG_PANEL, SAG_PANEL, zYan);
		// Çekmeceler (dar/orta terminal): web'in telefon görünümündeki gibi panel üstte açılır.
		const cekmece = (panel, solda) => {
			if (!panel || !panel.classList.contains('acik')) return;
			this.katman++;
			const pw = Math.min(solda ? 32 : 30, W - 6);
			const px = solda ? 0 : W - pw;
			const ortu = this.$('ortu');
			if (ortu) this.hedefler.push({ x: 0, y: 0, g: W, y2: H, el: ortu, h: null, katman: this.katman });
			this.karart(W, H);
			this.karartildi = false;
			this.ekran.doldur(px, 0, pw, H, zYan);
			this.sutunCiz(panel, px + 1, 0, pw - 2, H, zYan);
			const kenar = solda ? px + pw : px - 1;
			for (let i = 0; i < H; i++) this.ekran.yaz(kenar, i, '│', { fg: R.cizgi, bg: R.zemin });
		};
		if (this.kip === 'dar') cekmece(sol, true);
		if (this.kip !== 'genis') cekmece(sag, false);
		this.ilkOdak(['metin']);
	}

	// Odak yoksa (ya da görünmüyorsa) uygun bir öğeye ver.
	ilkOdak(adaylar) {
		const odak = this.odak();
		if (odak && this.gorunur(odak) && !odak.disabled) return;
		if (this.acikPencereler().length || this.istem) return;
		for (const id of adaylar) {
			const el = this.$(id);
			if (el && this.gorunur(el) && !el.disabled) {
				el.focus();
				this.cizici.odak = this.odak();
				return;
			}
		}
	}

	// Ortada kutu (pencere): içerik sığmazsa kayar; dışına tıklamak pencerenin kendisine tıklamaktır.
	kutu(el, icerik, W, H, { genislik = 64, zemin = { fg: R.yazi, bg: R.orta }, arka = null } = {}) {
		this.karart(W, H);
		this.katman++;
		if (arka) this.hedefler.push({ x: 0, y: 0, g: W, y2: H, el: arka, h: null, katman: this.katman });
		const w = Math.min(genislik, W - 2);
		const satirlar = this.cizici.blok(icerik, w - 5, zemin);
		const h = Math.min(H - 2, satirlar.length + 2);
		const x = Math.floor((W - w) / 2);
		const y = Math.max(0, Math.floor((H - h) / 2));
		this.cerceve(x, y, w, h, zemin);
		this.hedefler.push({ x, y, g: w, y2: h, el: icerik, h: null, katman: this.katman });
		this.kaydirmali(el, satirlar, x + 2, y + 1, w - 4, h - 2, zemin);
		return { x, y, w, h };
	}

	// Kutu: zemin ve çerçeve.
	cerceve(x, y, w, h, zemin) {
		this.ekran.doldur(x, y, w, h, zemin);
		const c = { fg: R.cizgi, bg: zemin.bg };
		this.ekran.yaz(x, y, '╭' + '─'.repeat(Math.max(0, w - 2)) + '╮', c);
		this.ekran.yaz(x, y + h - 1, '╰' + '─'.repeat(Math.max(0, w - 2)) + '╯', c);
		for (let i = 1; i < h - 1; i++) {
			this.ekran.yaz(x, y + i, '│', c);
			this.ekran.yaz(x + w - 1, y + i, '│', c);
		}
	}

	// Pencere açılınca arkadaki her şey sönükleşir (web'deki karartma).
	karart(W, H) {
		if (this.karartildi) return;
		this.karartildi = true;
		const onbellek = new Map();
		for (let y = 0; y < H; y++) {
			this.ekran.boya(0, y, W, (no) => {
				let k = onbellek.get(no);
				if (k === undefined) onbellek.set(no, (k = stilDegistir(no, { soluk: true })));
				return k;
			});
		}
	}

	pencereCiz(p, W, H) {
		const kart = p.querySelector('.pencere-kart') || p;
		const genis = kart.classList.contains('ayar-kart') ? 72 : 60;
		if (p.classList.contains('buyutec')) {
			// Resim büyüteci: resim terminalde gösterilemez; adı ve düğmeleri (orijinalini aç) görünür.
			this.kutu(p, p, W, H, { genislik: 60, arka: p.querySelector('.buyutec-kaydir') || p });
			return;
		}
		this.kutu(p, kart, W, H, { genislik: genis, arka: p });
	}

	bildirimlerCiz(W, H) {
		const kap = this.document.querySelector('.bildirim-sutunu');
		if (!kap || kap.hidden) return;
		const parcalar = [...kap.children].filter((c) => !this.cizici.gizliMi(c) && c.children.length);
		if (!parcalar.length) return;
		this.katman++;
		const w = Math.min(48, W - 4);
		const zemin = { fg: R.yazi, bg: R.kart };
		const satirlar = [];
		for (const c of parcalar) {
			for (const parca of c.children) {
				if (this.cizici.gizliMi(parca)) continue;
				if (satirlar.length) satirlar.push(doldur(bos(), 0, stilNo(zemin)));
				satirlar.push(...this.cizici.blok(parca, w - 4, zemin));
			}
		}
		const h = Math.min(Math.floor(H / 2), satirlar.length + 2);
		const x = W - w - 1;
		const y = 1;
		this.cerceve(x, y, w, h, zemin);
		this.hedefler.push({ x, y, g: w, y2: h, el: kap, h: null, katman: this.katman });
		this.kaydirmali(kap, satirlar, x + 2, y + 1, w - 3, h - 2, zemin);
	}

	yayinMenusuCiz(W, H) {
		const m = this.$('yayin-menu');
		if (!m || m.hidden || !this.atalarGorunur(m)) return;
		this.katman++;
		const w = Math.min(46, W - 4);
		const zemin = { fg: R.yazi, bg: R.kart };
		const satirlar = this.cizici.blok(m, w - 4, zemin);
		const h = Math.min(H - 2, satirlar.length + 2);
		// Paylaş düğmesinin yanında (görünüyorsa).
		const d = this.hedefler.find((t) => t.h && t.h.id === 'yayin-ac');
		let x = d ? Math.min(W - w - 1, Math.max(0, d.x + d.g - w)) : Math.floor((W - w) / 2);
		let y = d ? (d.y + 1 + h <= H ? d.y + 1 : Math.max(0, d.y - h)) : Math.floor((H - h) / 2);
		this.hedefler.push({ x: 0, y: 0, g: W, y2: H, el: this.document.body, h: null, katman: this.katman });
		this.cerceve(x, y, w, h, zemin);
		this.hedefler.push({ x, y, g: w, y2: h, el: m, h: null, katman: this.katman });
		this.kaydirmali(m, satirlar, x + 2, y + 1, w - 3, h - 2, zemin);
	}

	tostCiz(W, H) {
		const t = this.$('durum');
		let metin = t && t.classList.contains('gorunur') ? t.textContent : '';
		let hata = !!(t && t.classList.contains('hata'));
		if (!metin && this.durumMetni) {
			metin = this.durumMetni;
			hata = this.durumHata;
		}
		if (!metin) return;
		const w = Math.min(W - 4, metinGenislik(metin) + 4);
		const satirlar = [];
		const ic = Math.max(4, w - 4);
		// Uzun ileti birkaç satıra bölünür (en çok 4).
		let kalan = metin;
		while (kalan && satirlar.length < 4) {
			let parca = '';
			for (const kelime of kalan.split(/(\s+)/)) {
				if (metinGenislik(parca + kelime) > ic) break;
				parca += kelime;
			}
			if (!parca) parca = kirp(kalan, ic, '');
			satirlar.push(parca.trim());
			kalan = kalan.slice(parca.length).trimStart();
		}
		const h = satirlar.length + 2;
		const x = Math.floor((W - w) / 2);
		const y = H - h - 1;
		const zemin = { fg: R.parlak, bg: hata ? [130, 34, 37] : R.kart };
		this.ekran.doldur(x, y, w, h, zemin);
		satirlar.forEach((s, i) => this.ekran.yaz(x + 2, y + 1 + i, s, zemin));
	}

	durumSatiri(W, y) {
		const zemin = { fg: R.soluk, bg: R.kart };
		this.ekran.doldur(0, y, W, 1, zemin);
		const odak = this.cizici.odak;
		let sol = '';
		if (this.istem) sol = 'Enter tamam · Esc vazgeç' + (this.istem.tamamla ? ' · Tab tamamla' : '');
		else if (this.secim) sol = '↑/↓ seç · Enter tamam · Esc vazgeç';
		else {
			const ipucu = odak && !this.yaziAlaniMi(odak) && (odak.getAttribute('title') || odak.getAttribute('aria-label'));
			sol = ipucu ? ipucu : 'Tab/↑↓ gez · Enter seç · Esc kapat · Alt+M mik · Alt+D sağır · PgUp/PgDn kaydır · Ctrl+C çık';
		}
		let sag = this.guncelleme ? this.guncelleme.metin : this.surum ? 'Diszort ' + this.surum : '';
		const sagW = metinGenislik(sag);
		this.ekran.yaz(1, y, kirp(sol, Math.max(0, W - sagW - 4)), zemin);
		if (sag) this.ekran.yaz(W - sagW - 1, y, sag, this.guncelleme ? { fg: R.sari, bg: R.kart, kalin: true } : zemin);
	}

	// Odaktaki öğeyi vurgula (en üst katmanda).
	odakBoya() {
		const odak = this.cizici.odak;
		if (!odak || this.yaziAlaniMi(odak)) return;
		const ust = this.ustKatman();
		for (const t of this.hedefler) {
			if (t.h !== odak || t.katman !== ust) continue;
			this.ekran.boya(t.x, t.y, t.g, (no) => stilDegistir(no, { bg: R.vurgu, fg: R.beyaz, soluk: false }));
		}
	}

	ustKatman() {
		let k = 0;
		for (const t of this.hedefler) if (t.katman > k && t.h) k = t.katman;
		// Pencere açıkken (odaklanabilir öğesi olmasa da) alttakiler seçilmez.
		for (const t of this.hedefler) if (t.katman > k && !t.h && (t.el.classList && (t.el.classList.contains('pencere') || t.el.classList.contains('buyutec')))) k = t.katman;
		return k;
	}

	// Odaklanabilir öğeler (en üst katmanda, ekrandaki sırayla, her öğe bir kez).
	odaklanabilirler() {
		const ust = this.ustKatman();
		const liste = [];
		const gorulen = new Set();
		for (const t of this.hedefler) {
			if (!t.h || t.katman !== ust || gorulen.has(t.h)) continue;
			gorulen.add(t.h);
			liste.push(t.h);
		}
		return liste;
	}

	// ------------------------------------------------------------ olaylar (sayfaya)

	olay(el, tur, ek = {}) {
		const w = this.kabuk.window;
		const Yapici = tur.startsWith('key') ? w.KeyboardEvent : w.Event;
		const e = new Yapici(tur, { bubbles: true, cancelable: true, ...ek });
		el.dispatchEvent(e);
		return e;
	}
	tikla(el) {
		if (!el) return;
		el.click();
		this.planla(0);
	}
	odakla(el) {
		if (!el) return;
		el.focus();
		if (this.yaziAlaniMi(el) && !this.cizici.imlecler.has(el)) this.cizici.imlecler.set(el, String(el.value || '').length);
		this.odakGoster = true;
		this.planla(0);
	}
	odakKaydir(yon) {
		const liste = this.odaklanabilirler();
		if (!liste.length) return;
		const i = liste.indexOf(this.odak());
		const yeni = i < 0 ? (yon > 0 ? 0 : liste.length - 1) : (i + yon + liste.length) % liste.length;
		this.odakla(liste[yeni]);
	}

	// ------------------------------------------------------------ klavye

	tus(k) {
		if (this.istem) return this.istemTus(k);
		if (this.secim) return this.secimTus(k);
		if (k.ctrl && (k.ad === 'c' || k.ad === 'q')) return this.cikmayiDene();
		if (this.tamEkran) {
			if (k.ad === 'escape' || k.ad === 'enter' || k.metin === 'q') this.tamEkrandanCik();
			return;
		}
		if (this.guncelleme && k.ctrl && k.ad === 'u') return this.guncelleme.yap();
		const odak = this.odak();
		// Web'in kısayolları (Ctrl+Shift+M / D): terminalde Alt+M / Alt+D.
		if (k.alt && k.metin && /^[mdMD]$/.test(k.metin)) {
			this.olay(this.document, 'keydown', { key: k.metin.toLowerCase(), ctrlKey: true, shiftKey: true });
			return this.planla(0);
		}
		if (k.ad === 'escape') {
			this.olay(odak || this.document.body, 'keydown', { key: 'Escape', code: 'Escape' });
			return this.planla(0);
		}
		if (k.ad === 'tab') return this.odakKaydir(k.shift ? -1 : 1);
		if (k.ad === 'pageup' || k.ad === 'pagedown') return this.sayfaKaydir(k.ad === 'pageup' ? -1 : 1);
		if (this.yaziAlaniMi(odak) && !odak.disabled) {
			if (this.yaziTus(odak, k)) return this.planla(0);
		}
		if (odak && odak.localName === 'input' && odak.type === 'range' && (k.ad === 'left' || k.ad === 'right' || k.ad === 'home' || k.ad === 'end')) return this.kaydiriciTus(odak, k);
		if (odak && odak.localName === 'select' && (k.ad === 'left' || k.ad === 'right')) return this.secimDegistir(odak, k.ad === 'left' ? -1 : 1);
		if (k.ad === 'up' || k.ad === 'down') return this.odakKaydir(k.ad === 'up' ? -1 : 1);
		if (k.ad === 'enter' || k.ad === 'space') {
			if (!odak) return;
			if (odak.localName === 'select') return this.secimAc(odak);
			if (odak.localName === 'input' && odak.type === 'range') return;
			if (odak.localName === 'audio' || odak.localName === 'video') return this.kabuk.baglantiAc(odak.getAttribute('src'));
			this.olay(odak, 'keydown', { key: k.ad === 'enter' ? 'Enter' : ' ' });
			return this.tikla(odak);
		}
		// Yazı: mesaj kutusuna (ya da açık penceredeki ilk yazı alanına).
		if (k.metin && !k.ctrl && !k.alt) {
			const hedef = this.varsayilanYaziAlani();
			if (hedef) {
				this.odakla(hedef);
				this.yaz(hedef, k.metin);
				return this.planla(0);
			}
		}
	}

	varsayilanYaziAlani() {
		const liste = this.odaklanabilirler();
		return liste.find((el) => this.yaziAlaniMi(el) && el.id === 'metin') || liste.find((el) => this.yaziAlaniMi(el)) || null;
	}

	imlecAl(el) {
		let i = this.cizici.imlecler.get(el);
		const n = String(el.value || '').length;
		if (i == null || i > n) i = n;
		return i;
	}
	imlecKoy(el, i) {
		this.cizici.imlecler.set(el, Math.max(0, Math.min(String(el.value || '').length, i)));
	}
	degerKoy(el, deger, imlec) {
		const n = el.maxLength > 0 ? el.maxLength : Infinity;
		if (deger.length > n) deger = deger.slice(0, n);
		el.value = deger;
		this.imlecKoy(el, imlec);
		this.olay(el, 'input', { inputType: 'insertText' });
	}
	yaz(el, metin) {
		if (el.localName !== 'textarea') metin = metin.replace(/[\r\n]+/g, ' ');
		const v = String(el.value || '');
		const i = this.imlecAl(el);
		this.degerKoy(el, v.slice(0, i) + metin + v.slice(i), i + metin.length);
	}

	// Yazı alanında tuş: işlendiyse true.
	yaziTus(el, k) {
		const v = String(el.value || '');
		const i = this.imlecAl(el);
		const kelimeSol = () => {
			let j = i;
			while (j > 0 && /\s/.test(v[j - 1])) j--;
			while (j > 0 && !/\s/.test(v[j - 1])) j--;
			return j;
		};
		const kelimeSag = () => {
			let j = i;
			while (j < v.length && /\s/.test(v[j])) j++;
			while (j < v.length && !/\s/.test(v[j])) j++;
			return j;
		};
		if (k.metin && !k.ctrl && !k.alt) {
			this.yaz(el, k.metin);
			return true;
		}
		if (k.ad === 'space' && !k.ctrl) {
			this.yaz(el, ' ');
			return true;
		}
		switch (k.ad) {
			case 'enter': {
				if (k.alt || k.shift) {
					if (el.localName === 'textarea') {
						this.yaz(el, '\n');
						return true;
					}
				}
				const e = this.olay(el, 'keydown', { key: 'Enter', code: 'Enter', shiftKey: !!k.shift });
				if (e.defaultPrevented) {
					this.imlecKoy(el, String(el.value || '').length);
					return true;
				}
				if (el.localName === 'textarea') {
					this.yaz(el, '\n');
					return true;
				}
				if (el.form) {
					if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
					else this.olay(el.form, 'submit');
				}
				return true;
			}
			case 'backspace':
				if (k.ctrl || k.alt) {
					const j = kelimeSol();
					this.degerKoy(el, v.slice(0, j) + v.slice(i), j);
				} else if (i > 0) {
					const once = Array.from(v.slice(0, i));
					once.pop();
					const j = once.join('').length;
					this.degerKoy(el, v.slice(0, j) + v.slice(i), j);
				}
				return true;
			case 'delete':
				if (i < v.length) {
					const sonra = Array.from(v.slice(i));
					sonra.shift();
					this.degerKoy(el, v.slice(0, i) + sonra.join(''), i);
				}
				return true;
			case 'left':
				this.imlecKoy(el, k.ctrl || k.alt ? kelimeSol() : i - (i > 1 && /[\udc00-\udfff]/.test(v[i - 1]) ? 2 : 1));
				return true;
			case 'right':
				this.imlecKoy(el, k.ctrl || k.alt ? kelimeSag() : i + (/[\ud800-\udbff]/.test(v[i]) ? 2 : 1));
				return true;
			case 'home':
				this.imlecKoy(el, el.localName === 'textarea' ? v.lastIndexOf('\n', i - 1) + 1 : 0);
				return true;
			case 'end': {
				const son = el.localName === 'textarea' ? v.indexOf('\n', i) : -1;
				this.imlecKoy(el, son < 0 ? v.length : son);
				return true;
			}
			case 'a':
				if (k.ctrl) {
					this.imlecKoy(el, 0);
					return true;
				}
				return false;
			case 'e':
				if (k.ctrl) {
					this.imlecKoy(el, v.length);
					return true;
				}
				return false;
			case 'u':
				if (k.ctrl) {
					this.degerKoy(el, v.slice(i), 0);
					return true;
				}
				return false;
			case 'k':
				if (k.ctrl) {
					this.degerKoy(el, v.slice(0, i), i);
					return true;
				}
				return false;
			case 'w':
				if (k.ctrl) {
					const j = kelimeSol();
					this.degerKoy(el, v.slice(0, j) + v.slice(i), j);
					return true;
				}
				return false;
			case 'up':
			case 'down': {
				// Çok satırlı alanda satırlar arasında; değilse odak kayar.
				if (el.localName !== 'textarea' || !v.includes('\n')) return false;
				const bas = v.lastIndexOf('\n', i - 1) + 1;
				const sutun = i - bas;
				if (k.ad === 'up') {
					if (bas === 0) return false;
					const oncekiBas = v.lastIndexOf('\n', bas - 2) + 1;
					this.imlecKoy(el, Math.min(oncekiBas + sutun, bas - 1));
				} else {
					const son = v.indexOf('\n', i);
					if (son < 0) return false;
					const sonrakiSon = v.indexOf('\n', son + 1);
					this.imlecKoy(el, Math.min(son + 1 + sutun, sonrakiSon < 0 ? v.length : sonrakiSon));
				}
				return true;
			}
		}
		return false;
	}

	kaydiriciTus(el, k) {
		const enAz = Number(el.min || 0);
		const enCok = Number(el.max || 100);
		const adim = Number(el.step) > 0 ? Number(el.step) : 1;
		const kat = k.shift || k.ctrl ? 10 : (enCok - enAz) / adim > 40 ? 5 : 1;
		let v = Number(el.value);
		if (k.ad === 'left') v -= adim * kat;
		else if (k.ad === 'right') v += adim * kat;
		else if (k.ad === 'home') v = enAz;
		else v = enCok;
		this.kaydiriciKoy(el, v);
	}
	kaydiriciKoy(el, v) {
		const enAz = Number(el.min || 0);
		const enCok = Number(el.max || 100);
		const adim = Number(el.step) > 0 ? Number(el.step) : 1;
		v = Math.max(enAz, Math.min(enCok, Math.round((v - enAz) / adim) * adim + enAz));
		if (String(v) === el.value) return;
		el.value = String(v);
		this.olay(el, 'input');
		this.olay(el, 'change');
		this.planla(0);
	}

	secimDegistir(el, yon) {
		const n = el.options.length;
		if (!n) return;
		let i = el.selectedIndex;
		for (let k = 0; k < n; k++) {
			i = (i + yon + n) % n;
			if (!el.options[i].disabled) break;
		}
		this.secimKoy(el, i);
	}
	secimKoy(el, i) {
		if (i === el.selectedIndex) return;
		el.selectedIndex = i;
		this.olay(el, 'input');
		this.olay(el, 'change');
		this.planla(0);
	}
	secimAc(el) {
		if (!el.options.length) return;
		this.secim = { el, i: Math.max(0, el.selectedIndex) };
		this.planla(0);
	}
	secimTus(k) {
		const s = this.secim;
		const n = s.el.options.length;
		if (k.ad === 'escape') this.secim = null;
		else if (k.ad === 'up') s.i = (s.i - 1 + n) % n;
		else if (k.ad === 'down' || k.ad === 'tab') s.i = (s.i + 1) % n;
		else if (k.ad === 'home') s.i = 0;
		else if (k.ad === 'end') s.i = n - 1;
		else if (k.ad === 'enter' || k.ad === 'space') {
			this.secim = null;
			this.secimKoy(s.el, s.i);
		} else if (k.ctrl && k.ad === 'c') {
			this.secim = null;
		}
		this.planla(0);
	}
	secimCiz(W, H) {
		const s = this.secim;
		if (!s.el.isConnected) {
			this.secim = null;
			return;
		}
		this.katman += 10;
		const secenekler = [...s.el.options].map((o) => o.textContent.trim());
		const w = Math.min(W - 4, Math.max(20, ...secenekler.map((m) => metinGenislik(m) + 4)));
		const h = Math.min(H - 2, secenekler.length + 2);
		const d = this.hedefler.find((t) => t.h === s.el);
		const x = d ? Math.max(0, Math.min(W - w, d.x)) : Math.floor((W - w) / 2);
		const y = d ? (d.y + 1 + h <= H ? d.y + 1 : Math.max(0, d.y - h)) : Math.floor((H - h) / 2);
		const zemin = { fg: R.yazi, bg: R.kart };
		this.cerceve(x, y, w, h, zemin);
		this.hedefler.push({ x: 0, y: 0, g: W, y2: H, el: null, h: null, katman: this.katman, secimDisi: true });
		const gorunen = h - 2;
		const ust = Math.max(0, Math.min(secenekler.length - gorunen, s.i - Math.floor(gorunen / 2)));
		for (let k = 0; k < gorunen && ust + k < secenekler.length; k++) {
			const i = ust + k;
			const st = i === s.i ? { fg: R.beyaz, bg: R.vurgu } : i === s.el.selectedIndex ? { fg: R.parlak, bg: R.kart, kalin: true } : zemin;
			this.ekran.doldur(x + 1, y + 1 + k, w - 2, 1, st);
			this.ekran.yaz(x + 2, y + 1 + k, kirp(secenekler[i], w - 4), st);
			this.hedefler.push({ x: x + 1, y: y + 1 + k, g: w - 2, y2: 1, el: null, h: null, katman: this.katman, secenek: i });
		}
	}

	sayfaKaydir(yon) {
		// Açık pencere varsa onu, yoksa sohbeti.
		const ust = this.ustKatman();
		const bolge = [...this.kaydirmalar].reverse().find((b) => b.katman === ust && b.toplam > b.y2) || this.kaydirmalar.find((b) => b.el.id === 'mesaj-alani');
		if (bolge) this.bolgeKaydir(bolge, yon * Math.max(1, bolge.y2 - 2));
	}
	bolgeKaydir(b, satir) {
		const d = this.kaydirma.get(b.el);
		if (!d) return;
		if (b.dip) {
			d.dipten = Math.max(0, Math.min(b.toplam - b.y2, d.dipten - satir));
			// En üste gelindi: daha eski mesajlar (web'de de kaydırınca yüklenir).
			if (d.dipten >= b.toplam - b.y2 && satir < 0) {
				const daha = this.$('daha-eski');
				if (daha && !daha.hidden && Date.now() - (this.sonEskiIstek || 0) > 1500) {
					this.sonEskiIstek = Date.now();
					daha.click();
				}
			}
		} else d.ust = Math.max(0, Math.min(b.toplam - b.y2, d.ust + satir));
		this.planla(0);
	}

	// ------------------------------------------------------------ fare

	fare(f) {
		if (f.tekerlek) {
			if (this.secim) {
				const s = this.secim;
				const n = s.el.options.length;
				s.i = (s.i + (f.dugme === 'yukari' ? -1 : 1) + n) % n;
				return this.planla(0);
			}
			const b = [...this.kaydirmalar].reverse().find((k) => f.x >= k.x && f.x < k.x + k.g && f.y >= k.y && f.y < k.y + k.y2);
			if (b) this.bolgeKaydir(b, f.dugme === 'yukari' ? -3 : 3);
			return;
		}
		if (f.dugme !== 'sol') return;
		const t = [...this.hedefler].reverse().find((h) => f.x >= h.x && f.x < h.x + h.g && f.y >= h.y && f.y < h.y + h.y2);
		// Kaydırıcıyı sürükleme.
		if (f.hareket) {
			if (this.surukle && f.basildi) this.kaydiriciFare(this.surukle, f.x);
			return;
		}
		if (!f.basildi) {
			this.surukle = null;
			return;
		}
		if (this.tamEkran) return this.tamEkrandanCik();
		if (this.secim) {
			if (t && t.secenek != null) {
				const s = this.secim;
				this.secim = null;
				this.secimKoy(s.el, t.secenek);
			} else this.secim = null;
			return this.planla(0);
		}
		if (this.istem) {
			if (t && t.istemDugme) t.istemDugme();
			return this.planla(0);
		}
		if (!t) return;
		const h = t.h;
		if (h) {
			if (this.yaziAlaniMi(h)) {
				this.odakla(h);
				if (t.p && t.p.imlec != null) {
					// Tıklanan yere imleç (tek satırlı alan: yaklaşık).
					const v = String(h.value || '');
					this.imlecKoy(h, Math.max(0, Math.min(v.length, this.imlecAl(h) + (f.x - (t.x + t.p.imlec)))));
				}
				return;
			}
			if (h.localName === 'input' && h.type === 'range') {
				this.odakla(h);
				this.surukle = { el: h, t };
				return this.kaydiriciFare(this.surukle, f.x);
			}
			if (h.localName === 'select') {
				this.odakla(h);
				return this.secimAc(h);
			}
			if (h.localName === 'audio' || h.localName === 'video') return this.kabuk.baglantiAc(h.getAttribute('src'));
			if (h.focus) h.focus();
			return this.tikla(h);
		}
		// Odaklanamayan öğe: tıklama ona gider (ör. pencerenin dışı: pencereyi kapatır; etiket: kutucuğu).
		if (t.el && t.el.click) {
			const etiket = t.el.closest && t.el.closest('label');
			this.tikla(etiket || t.el);
		}
	}
	kaydiriciFare(s, x) {
		const el = s.el;
		const t = s.t;
		const enAz = Number(el.min || 0);
		const enCok = Number(el.max || 100);
		const oran = Math.max(0, Math.min(1, (x - t.x) / Math.max(1, t.g - 1)));
		this.kaydiriciKoy(el, enAz + oran * (enCok - enAz));
	}

	// ------------------------------------------------------------ yapıştırma

	yapistir(metin) {
		if (this.istem) {
			const i = this.istem;
			const v = i.deger.slice(0, i.imlec) + metin.replace(/[\r\n]+/g, ' ') + i.deger.slice(i.imlec);
			i.deger = v;
			i.imlec += metin.length;
			return this.planla(0);
		}
		// Dosya yolları (terminale sürüklenen dosyalar böyle gelir): açık kanalda paylaşılır.
		const yollar = yolListesi(metin);
		if (yollar.length && yollar.every((y) => dosyaVar(y))) {
			if (this.kabuk.dosyalariBirak(yollar)) return this.planla(0);
		}
		const odak = this.odak();
		const hedef = this.yaziAlaniMi(odak) ? odak : this.varsayilanYaziAlani();
		if (!hedef) return;
		this.odakla(hedef);
		this.yaz(hedef, metin);
		this.planla(0);
	}

	// ------------------------------------------------------------ arayüzün kendi soruları

	// Soru: { baslik, aciklama, deger, tamamla (Tab), dugmeler: [{ ad, deger }] } → Promise (iptalde null).
	sor(soru) {
		return new Promise((coz) => {
			const onceki = this.istem;
			this.istem = { ...soru, deger: soru.deger || '', imlec: (soru.deger || '').length, oneriler: [], coz: (v) => {
				this.istem = onceki;
				this.planla(0);
				coz(v);
			} };
			this.planla(0);
		});
	}
	istemTus(k) {
		const i = this.istem;
		if (k.ad === 'escape' || (k.ctrl && k.ad === 'c')) return i.coz(null);
		if (k.ad === 'enter') return i.coz(i.dugmeler && !i.girdi ? (i.dugmeler[i.secili || 0] || {}).deger : i.deger);
		if (i.dugmeler && !i.girdi) {
			if (k.ad === 'left' || k.ad === 'right' || k.ad === 'tab') i.secili = ((i.secili || 0) + (k.ad === 'left' ? -1 : 1) + i.dugmeler.length) % i.dugmeler.length;
			else if (k.metin) {
				const d = i.dugmeler.find((x) => x.tus && x.tus === k.metin.toLowerCase());
				if (d) return i.coz(d.deger);
			}
			return this.planla(0);
		}
		if (k.ad === 'tab' && i.tamamla) {
			const sonuc = i.tamamla(i.deger);
			if (sonuc) {
				i.deger = sonuc.deger;
				i.imlec = i.deger.length;
				i.oneriler = sonuc.oneriler || [];
			}
			return this.planla(0);
		}
		const v = i.deger;
		const j = i.imlec;
		if (k.metin && !k.ctrl && !k.alt) {
			i.deger = v.slice(0, j) + k.metin + v.slice(j);
			i.imlec = j + k.metin.length;
		} else if (k.ad === 'space') {
			i.deger = v.slice(0, j) + ' ' + v.slice(j);
			i.imlec = j + 1;
		} else if (k.ad === 'backspace' && j > 0) {
			i.deger = v.slice(0, j - 1) + v.slice(j);
			i.imlec = j - 1;
		} else if (k.ad === 'delete') i.deger = v.slice(0, j) + v.slice(j + 1);
		else if (k.ad === 'left') i.imlec = Math.max(0, j - 1);
		else if (k.ad === 'right') i.imlec = Math.min(v.length, j + 1);
		else if (k.ad === 'home' || (k.ctrl && k.ad === 'a')) i.imlec = 0;
		else if (k.ad === 'end' || (k.ctrl && k.ad === 'e')) i.imlec = v.length;
		else if (k.ctrl && k.ad === 'u') {
			i.deger = v.slice(j);
			i.imlec = 0;
		}
		i.oneriler = [];
		this.planla(0);
	}
	istemCiz(W, H) {
		const i = this.istem;
		this.katman += 20;
		const w = Math.min(W - 2, 76);
		const ic = w - 4;
		const zemin = { fg: R.yazi, bg: R.kart };
		const satirlar = [];
		const metinSatirlari = (m, st) => {
			for (const parca of String(m).split('\n')) {
				let kalan = parca;
				do {
					const s = kirp(kalan, ic, '');
					satirlar.push({ m: s, st });
					kalan = kalan.slice(s.length);
				} while (kalan);
			}
		};
		metinSatirlari(i.baslik, { ...zemin, fg: R.parlak, kalin: true });
		if (i.aciklama) metinSatirlari(i.aciklama, { ...zemin, fg: R.soluk });
		const girdiYeri = i.dugmeler && !i.girdi ? -1 : satirlar.length + 1;
		const oneriYeri = satirlar.length + 3;
		const h = Math.min(H - 2, satirlar.length + 2 + (girdiYeri >= 0 ? 2 : 0) + (i.oneriler.length ? Math.min(8, i.oneriler.length) + 1 : 0) + (i.dugmeler ? 2 : 0));
		const x = Math.floor((W - w) / 2);
		const y = Math.max(0, Math.floor((H - h) / 2));
		this.karart(W, H);
		this.cerceve(x, y, w, h, zemin);
		satirlar.forEach((s, k) => this.ekran.yaz(x + 2, y + 1 + k, s.m, s.st));
		if (girdiYeri >= 0) {
			const gy = y + girdiYeri + 1;
			const st = { fg: R.yazi, bg: R.ust };
			this.ekran.doldur(x + 2, gy, ic, 1, st);
			// İmleç görünsün diye kaydır.
			const once = i.deger.slice(0, i.imlec);
			let bas = 0;
			while (metinGenislik(once.slice(bas)) > ic - 2) bas++;
			this.ekran.yaz(x + 3, gy, i.deger.slice(bas), st, x + 2, x + 2 + ic);
			this.imlec = { x: Math.min(x + 2 + ic - 1, x + 3 + metinGenislik(once.slice(bas))), y: gy };
		}
		if (i.oneriler.length) {
			const n = Math.min(8, i.oneriler.length);
			const metin = i.oneriler.slice(0, n).map((o) => kirp(o, ic));
			metin.forEach((m, k) => this.ekran.yaz(x + 2, y + oneriYeri + k, m, { ...zemin, fg: R.soluk }));
			if (i.oneriler.length > n) this.ekran.yaz(x + 2, y + oneriYeri + n, `… ${i.oneriler.length - n} tane daha`, { ...zemin, fg: R.sonuk });
		}
		if (i.dugmeler) {
			let dx = x + 2;
			const dy = y + h - 2;
			i.dugmeler.forEach((d, k) => {
				const secili = !i.girdi && (i.secili || 0) === k;
				const m = ` ${d.ad} `;
				this.ekran.yaz(dx, dy, m, { fg: R.beyaz, bg: secili ? R.vurgu : R.dugme, kalin: secili });
				this.hedefler.push({ x: dx, y: dy, g: metinGenislik(m), y2: 1, el: null, h: null, katman: this.katman, istemDugme: () => i.coz(d.deger) });
				dx += metinGenislik(m) + 2;
			});
		}
	}

	// Paylaşılacak dosyalar (web'deki dosya seçme penceresi).
	async dosyaSor({ coklu }) {
		const yanit = await this.sor({
			baslik: 'Paylaşılacak dosya',
			aciklama: 'Dosyanın yolunu yaz (Tab tamamlar).' + (coklu ? ' Birden çok dosya: yolları tırnak içinde, boşlukla ayır. Dosyayı terminale sürükleyip bırakmak da paylaşır.' : ''),
			deger: this.sonKlasor || os.homedir() + '/',
			tamamla: yolTamamla,
		});
		if (!yanit) return [];
		const yollar = yolListesi(yanit);
		if (yollar.length) this.sonKlasor = path.dirname(dosya.yolAc(yollar[0])) + '/';
		return yollar;
	}

	// İndirilen büyük dosyanın kaydedileceği yer ("Farklı kaydet").
	async kayitYeriSor(ad) {
		const oneri = dosya.bosYol(dosya.indirmeKlasoru(), ad);
		const yanit = await this.sor({ baslik: 'Farklı kaydet', aciklama: `"${ad}" nereye kaydedilsin?`, deger: oneri, tamamla: yolTamamla });
		if (!yanit) return null;
		let yol = dosya.yolAc(yanit);
		try {
			if (fs.statSync(yol).isDirectory()) yol = dosya.bosYol(yol, ad);
		} catch {}
		if (fs.existsSync(yol)) {
			const ustune = await this.sor({ baslik: 'Dosya zaten var', aciklama: yol + '\nÜzerine yazılsın mı?', dugmeler: [{ ad: 'Üzerine yaz', deger: 'evet', tus: 'e' }, { ad: 'Vazgeç', deger: null, tus: 'v' }] });
			if (ustune !== 'evet') return null;
		}
		return yol;
	}

	async cikmayiDene() {
		if (this.cikiliyor) return;
		if (!this.kabuk.kapatilabilir()) {
			const ok = await this.sor({ baslik: 'Dosya aktarımı sürüyor', aciklama: 'Çıkarsan aktarım yarıda kalır. Yine de çıkılsın mı?', dugmeler: [{ ad: 'Çık', deger: 'evet', tus: 'ç' }, { ad: 'Kal', deger: null, tus: 'k' }] });
			if (ok !== 'evet') return;
		}
		this.cikiliyor = true;
		this.cikis();
	}

	tamEkrandanCik() {
		const el = this.tamEkran;
		this.tamEkran = null;
		if (el && this.kabuk.window) {
			this.olay(this.document, 'fullscreenchange');
		}
		this.terminal.yenidenCiz();
		this.planla(0);
	}
}

// Yapıştırılan / yazılan metinden dosya yolları: satır satır ya da tırnaklı, boşlukla ayrılmış.
function yolListesi(metin) {
	const yollar = [];
	for (const satir of String(metin).split(/\r?\n/)) {
		const s = satir.trim();
		if (!s) continue;
		const kalip = /'([^']*)'|"([^"]*)"|((?:\\ |[^\s])+)/g;
		let m;
		const parcalar = [];
		while ((m = kalip.exec(s))) parcalar.push(m[1] ?? m[2] ?? m[3].replace(/\\(.)/g, '$1'));
		// Tırnaksız, boşluklu tek bir yol da olabilir.
		if (parcalar.length > 1 && !/['"\\]/.test(s) && dosyaVar(s)) yollar.push(s);
		else yollar.push(...parcalar);
	}
	return yollar.filter(Boolean);
}
function dosyaVar(y) {
	try {
		return fs.statSync(dosya.yolAc(y)).isFile();
	} catch {
		return false;
	}
}

// Yol tamamlama (Tab): tek aday varsa tamamlanır; çoksa ortak kısım ve adaylar.
function yolTamamla(girdi) {
	const ham = girdi.replace(/^['"]|['"]$/g, '');
	const genis = ham.startsWith('~') ? os.homedir() + ham.slice(1) : ham;
	const klasor = genis.endsWith('/') ? genis : path.dirname(genis) + '/';
	const bas = genis.endsWith('/') ? '' : path.basename(genis);
	let girdiler;
	try {
		girdiler = fs.readdirSync(klasor, { withFileTypes: true });
	} catch {
		return null;
	}
	const adaylar = girdiler
		.filter((d) => d.name.startsWith(bas) && (bas.startsWith('.') || !d.name.startsWith('.')))
		.map((d) => d.name + (d.isDirectory() || (d.isSymbolicLink() && dizinMi(path.join(klasor, d.name))) ? '/' : ''))
		.sort((a, b) => a.localeCompare(b, 'tr'));
	if (!adaylar.length) return { deger: girdi, oneriler: ['(eşleşen yok)'] };
	let ortak = adaylar[0];
	for (const a of adaylar) while (!a.startsWith(ortak)) ortak = ortak.slice(0, -1);
	const onEk = ham.slice(0, ham.length - bas.length);
	return { deger: onEk + ortak, oneriler: adaylar.length > 1 ? adaylar : [] };
}
function dizinMi(y) {
	try {
		return fs.statSync(y).isDirectory();
	} catch {
		return false;
	}
}

module.exports = { Arayuz, yolListesi, yolTamamla };
