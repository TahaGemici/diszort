// Çizici: sayfanın DOM'unu terminal satırlarına çevirir.
//
// Ayrı bir "terminal arayüzü" yazmak yerine web arayüzünün kendisi çizilir: hangi öğe görünüyor,
// hangi düğme var, ne yazıyor, hep sayfanın DOM'undan okunur. Web'e eklenen bir düğme ya da ayar
// burada kendiliğinden görünür ve çalışır (tıklamak sayfadaki öğeye tıklamaktır). Buradaki tablo
// yalnızca görünüşü belirler (stil.css'in terminaldeki karşılığı): sınıfa göre renk, satır mı blok
// mu, simgelerin karakteri. Tabloda olmayan öğe varsayılan biçimde (etiketine göre) çizilir.
//
// Çıktı: satırlar; her satır parçalardan oluşur: { m: metin, s: stil no, w: genişlik, el: öğe,
// h: odaklanabilir öğe (düğme, bağlantı, girdi) ya da null, imlec: (yazı alanında) imlecin yeri }.
'use strict';

const { metinGenislik, kirp, hucreler } = require('./genislik');
const { stilNo } = require('./terminal');

// ---------------------------------------------------------------- renkler (stil.css'tekiler)

const R = {
	zemin: [30, 31, 34],
	yan: [43, 45, 49],
	orta: [49, 51, 56],
	kart: [35, 36, 40],
	ust: [56, 58, 64],
	secili: [64, 66, 73],
	uzerinde: [53, 55, 60],
	dugme: [78, 80, 88],
	yazi: [219, 222, 225],
	parlak: [242, 243, 245],
	soluk: [148, 155, 164],
	sonuk: [109, 111, 120],
	cizgi: [63, 65, 71],
	vurgu: [88, 101, 242],
	yesil: [35, 165, 90],
	yesilAcik: [59, 165, 93],
	sari: [240, 178, 50],
	turuncu: [245, 151, 59],
	tehlike: [242, 63, 67],
	baglanti: [0, 168, 252],
	beyaz: [255, 255, 255],
};

function hsl(h, s, l) {
	s /= 100;
	l /= 100;
	const k = (n) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
const renkTonu = (el) => {
	const m = /--renk:\s*(-?\d+(?:\.\d+)?)/.exec(el.getAttribute('style') || '');
	return m ? Number(m[1]) : 235;
};

// Simgeler (web/ana.js'teki SIMGELER adlarıyla): terminalde tek karakter ya da kısa bir yazı.
const SIMGE = {
	diszort: '◆',
	mik: 'mik',
	'mik-kapali': 'mik✕',
	kulaklik: 'ses',
	'kulaklik-kapali': 'ses✕',
	ayar: '⚙',
	ayril: 'ayrıl',
	kare: '#',
	hoparlor: '♪',
	'hoparlor-kapali': '♪✕',
	arti: '+',
	x: '✕',
	ekle: '+',
	gonder: '➤',
	kisiler: 'üyeler',
	menu: '≡',
	sinyal: '▂▄▆',
	asagi: '▾',
	uyari: '⚠',
	dosya: '▤',
	indir: '⇩',
	buyut: '⊕',
	kucult: '⊖',
	disari: '↗',
	ekran: '▭',
	'ekran-kapali': '▭✕',
	yayin: 'paylaş',
	dur: '■',
	'tam-ekran': '⤢',
	veritabani: 'sunucu',
	yukari: '⇧',
};

// Çocukları arasında boşluk olan kapsayıcılar (CSS'te flex + gap): satırlar ve iç içe gruplar.
const ARALIKLI = new Set(['ses-kisi-bilgi', 'uye-bilgi', 'dosya-bilgi', 'aktarim-bilgi', 'ses-baglanti-bilgi', 'ben-bilgi', 'yayin-menu-yazi', 'dosya-dugmeler', 'ses-kart-denetim', 'yayin-menu-kap', 'durum-ikon', 'kanal', 'yayin-menu-oge', 'giris-logo', 'yazma-kutu', 'yayin-aciklama']);

const BLOK = new Set(['div', 'section', 'header', 'footer', 'main', 'aside', 'form', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'nav', 'fieldset', 'dl', 'dt', 'dd', 'table', 'tr', 'pre', 'figure', 'blockquote', 'article', 'hr']);
const GIZLI_ETIKET = new Set(['script', 'style', 'link', 'meta', 'noscript', 'template', 'head', 'title', 'datalist']);
const METIN_GIRDISI = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);

// Satır düzenindeki (yan yana) öğeler: CSS'te flex olan satırlar.
const SATIRLAR = new Set([
	'kanal-satir', 'kanal', 'ses-uyesi', 'uye', 'ses-kisi', 'ben-kart', 'ses-baglanti', 'sunucu-baslik', 'bolum-baslik', 'ses-kart-ust', 'yayin-ust', 'istek-ust',
	'istek-dugmeler', 'pencere-dugmeler', 'kalite-satir', 'olcer-satir', 'yazma-kutu', 'dosya-kart', 'aktarim', 'aktarim-ust', 'yayin-ses', 'limit-satir', 'buyutec-dugmeler', 'ayar-ust',
	'uye-ust', 'yayin-menu-oge', 'yaziyor', 'mesaj-ust', 'ad-satir', 'istek-uyari', 'anahtar', 'ses-uyari', 'onizleme-bekle',
]);

// ---------------------------------------------------------------- satır oluşturma

// Satırın sağına yaslanan öğeler (CSS'te margin-left: auto ya da satırın sonundaki düğmeler).
const SAGA_SINIF = ['kanal-sil', 'uye-at', 'aktarim-iptal', 'rozet', 'rozet-yazi', 'ses-kart-denetim', 'sunucu-dugme', 'bolum-ekle', 'dosya-dugmeler', 'limit-dugme', 'sus'];
const SAGA_ID = new Set(['uye-ac', 'ayarlar-kapat', 'sunucu-kapat', 'ses-kaynagi-kapat', 'ben-mikrofon', 'ben-kapat']);
function sagaMi(el) {
	if (el.id && SAGA_ID.has(el.id)) return true;
	const c = el.classList;
	if (!c.length) return false;
	for (const s of SAGA_SINIF) if (c.contains(s)) return s !== 'sus' || !!el.closest('.ses-kisi');
	return false;
}

const bos = () => ({ parcalar: [], w: 0 });
function ekle(satir, m, s, el = null, h = null, ek = null) {
	if (!m) return;
	const w = metinGenislik(m);
	const p = { m, s, w, el, h };
	if (ek) Object.assign(p, ek);
	satir.parcalar.push(p);
	satir.w += w;
}
// Satırı genişliğe kırp (sığmayan parçalar kesilir).
function satirKirp(satir, w) {
	if (satir.w <= w) return satir;
	const y = bos();
	for (const p of satir.parcalar) {
		if (y.w + p.w <= w) {
			y.parcalar.push(p);
			y.w += p.w;
			continue;
		}
		const kalan = w - y.w;
		if (kalan > 0) {
			const m = kirp(p.m, kalan);
			y.parcalar.push({ ...p, m, w: metinGenislik(m) });
			y.w += metinGenislik(m);
		}
		break;
	}
	return y;
}
// Satırın sonunu boşlukla w'ye tamamla (zemin rengi sürsün).
function doldur(satir, w, s) {
	if (satir.w < w) ekle(satir, ' '.repeat(w - satir.w), s);
	return satir;
}

// ---------------------------------------------------------------- çizici

class Cizici {
	constructor(window) {
		this.window = window;
		this.document = window.document;
		this.kip = 'genis'; // 'genis' | 'orta' | 'dar' (stil.css'teki ekran genişliği eşikleri)
		this.odak = null; // odaktaki öğe
		this.imlecler = new WeakMap(); // yazı alanı → imleç (karakter)
		this.video = null; // (el, w) → satırlar: görüntü çizici (goruntu.js) verirse
		this.simgeAdlari = new Map();
		// Simgelerin adı: web'in kendi tablosundan, DOM'un yazdığı biçimiyle (karşılaştırmak için).
		try {
			const tablo = window.eval('typeof SIMGELER === "object" ? SIMGELER : null') || {};
			const svg = this.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			for (const [ad, ic] of Object.entries(tablo)) {
				svg.innerHTML = ic;
				this.simgeAdlari.set(svg.innerHTML, ad);
			}
		} catch {}
	}

	// ------------------------------------------------------------ görünüm kuralları (stil.css'in karşılığı)

	gizliMi(el) {
		if (el.hidden || GIZLI_ETIKET.has(el.localName)) return true;
		const st = el.getAttribute('style');
		if (st && /display:\s*none/.test(st)) return true;
		const c = el.classList;
		if (c.length) {
			if (c.contains('mobil')) {
				const uyeUst = !!el.closest('.uye-ust');
				if (this.kip === 'genis' || (this.kip === 'orta' && !uyeUst)) return true;
			}
			if (c.contains('uye-ust') && this.kip === 'genis') return true;
			if (c.contains('ses-akislari') || c.contains('istek-sure') || c.contains('ortu') || c.contains('tost') || c.contains('bildirim-sutunu') || c.contains('yayin-menu') || c.contains('pencere') || c.contains('buyutec')) return true;
			if (c.contains('istekler') && !el.children.length) return true;
			if (c.contains('ses-kart-ozet') && this.kip === 'dar') return true;
		}
		const id = el.id;
		if (id) {
			if (id === 'ayar-gurultu-sonuc' && !el.textContent) return true;
			if ((id === 'ses-kisiler' || id === 'yayinlar') && el.parentElement && el.parentElement.classList.contains('kucuk')) return true;
		}
		const e = el.localName;
		if (e === 'input' && (el.type === 'file' || el.type === 'hidden')) return true;
		if (e === 'audio' && !(el.controls && el.getAttribute('src'))) return true;
		if (e === 'video') return !el.getAttribute('src') && !(el.srcObject && this.video);
		// Fareyle üzerine gelince görünen düğmeler (kanalı sil, kişiyi at): satır odaktayken görünür.
		if (c.length && (c.contains('kanal-sil') || c.contains('uye-at'))) {
			const satir = el.closest('.kanal-satir, .uye');
			if (this.kip !== 'dar' && !(this.odak && satir && satir.contains(this.odak))) return true;
		}
		return false;
	}

	// Öğenin çizim düzeni: 'blok' | 'satir' | 'satiri' (satır içi) | 'mesaj' | 'cubuk' | 'dl' | 'gun' | 'pre'
	duzen(el) {
		const c = el.classList;
		if (c.contains('mesaj')) return 'mesaj';
		if (c.contains('gun')) return 'gun';
		if (c.contains('metin') && el.closest('.mesaj')) return 'pre';
		if (c.contains('seviye-cubuk') || c.contains('ilerleme') || c.contains('olcer')) return 'cubuk';
		for (const s of c) if (SATIRLAR.has(s)) return el.localName === 'button' || el.localName === 'label' ? 'satiri' : 'satir';
		if (el.localName === 'dl') return 'dl';
		if (el.localName === 'label' && c.contains('alan-adi')) return 'blok';
		if (c.contains('ses-kisi-bilgi') || c.contains('uye-bilgi') || c.contains('dosya-bilgi') || c.contains('aktarim-bilgi') || c.contains('ses-baglanti-bilgi') || c.contains('ben-bilgi') || c.contains('yayin-menu-yazi') || c.contains('dosya-dugmeler') || c.contains('ses-kart-denetim') || c.contains('yayin-menu-kap') || c.contains('durum-ikon')) return 'satiri';
		return BLOK.has(el.localName) ? 'blok' : 'satiri';
	}

	// Öğenin kendi stili (üstten gelene eklenir).
	stil(el, ust) {
		const c = el.classList;
		const s = { ...ust };
		const e = el.localName;
		if (e === 'b' || e === 'strong' || /^h[1-6]$/.test(e)) s.kalin = true;
		if (e === 'small') s.fg = R.soluk;
		if (e === 'i' || e === 'em') s.italik = true;
		if (e === 'h1' || e === 'h2') s.fg = R.parlak;
		if (e === 'h3') s.fg = R.soluk;
		if (e === 'a' && el.hasAttribute('href')) {
			s.fg = R.baglanti;
			s.alti = true;
		}
		if (!c.length) return s;
		for (const k of c) {
			switch (k) {
				case 'soluk':
				case 'saat':
				case 'yan-saat':
				case 'ayar-not':
				case 'ayar-not-ic':
				case 'pencere-metin':
				case 'yayin-menu-not':
				case 'aktarim-metin':
				case 'aktarim-kisi':
				case 'dosya-durum':
				case 'ses-istatistik':
				case 'kanal-hos':
				case 'bos-kanal':
				case 'rozet-yazi':
				case 'bolum-baslik':
				case 'alan-adi':
				case 'durum':
				case 'yaziyor':
				case 'yayin-aciklama':
					s.fg = R.soluk;
					break;
				case 'kanal':
				case 'uye':
				case 'ses-uyesi':
					s.fg = R.soluk;
					break;
				case 'aktif':
					s.fg = R.parlak;
					s.bg = R.secili;
					s.kalin = true;
					break;
				case 'okunmamis':
					s.fg = R.parlak;
					s.kalin = true;
					break;
				case 'ben':
					if (el.closest('#uye-listesi') || el.classList.contains('ses-uyesi')) s.fg = R.parlak;
					break;
				case 'ad':
					if (el.closest('.mesaj-ust')) s.fg = hsl(renkTonu(el), 70, 74);
					else if (el.closest('.ses-kisi')) s.fg = R.parlak;
					s.kalin = !!el.closest('.mesaj-ust, .ses-kisi, .uye.ben') || s.kalin;
					break;
				case 'bahsetme':
					s.fg = [201, 205, 251];
					s.bg = [60, 66, 112];
					break;
				case 'bahsediliyor':
					s.bg = [73, 68, 60];
					break;
				case 'rozet':
					s.fg = R.beyaz;
					s.bg = R.tehlike;
					s.kalin = true;
					break;
				case 'canli':
					s.fg = R.beyaz;
					s.bg = R.tehlike;
					s.kalin = true;
					break;
				case 'konusuyor':
					s.fg = R.yesilAcik;
					s.kalin = true;
					break;
				case 'kapali':
				case 'tehlike':
				case 'hata':
				case 'kotu':
				case 'red':
					s.fg = R.tehlike;
					break;
				case 'orta':
				case 'bekliyor':
				case 'uyari':
				case 'istek-uyari':
					s.fg = R.sari;
					break;
				case 'turn':
					s.fg = R.turuncu;
					break;
				case 'askida':
				case 'cevrimdisi':
				case 'susturuldu':
					s.soluk = true;
					break;
				case 'etiket':
				case 'bag':
					s.fg = R.sari;
					break;
				case 'sinyal':
					s.fg = c.contains('kotu') ? R.tehlike : c.contains('orta') || c.contains('bekliyor') ? R.sari : R.yesilAcik;
					break;
				case 'ses-baglanti':
					s.fg = c.contains('kotu') ? R.tehlike : c.contains('orta') ? R.sari : R.yesilAcik;
					break;
				case 'sayac':
					s.fg = R.soluk;
					break;
				case 'ses-uyari':
					s.fg = R.sari;
					break;
				case 'kanal-isaret':
				case 'dosya-ikon':
				case 'aktarim-isaret':
					s.fg = R.sonuk;
					break;
			}
		}
		return s;
	}

	// ------------------------------------------------------------ parçalar (satır içi içerik)

	simgeAdi(svg) {
		const ust = svg.parentElement;
		if (ust && ust.dataset && ust.dataset.ikonAdi && ust.children.length === 1) return ust.dataset.ikonAdi;
		return this.simgeAdlari.get(svg.innerHTML) || '';
	}

	odaklanabilir(el) {
		const e = el.localName;
		if (e === 'button' || e === 'select' || e === 'textarea') return !el.disabled;
		if (e === 'input') return !el.disabled && el.type !== 'hidden' && el.type !== 'file';
		if (e === 'a') return el.hasAttribute('href');
		if (e === 'audio' || e === 'video') return !!el.getAttribute('src');
		return el.hasAttribute('tabindex') && el.tabIndex >= 0;
	}

	// Öğenin kısa yazısı (düğmeler: içerik; boşsa aria-label/title).
	duzYazi(el) {
		let s = '';
		const gez = (n) => {
			for (const c of n.childNodes) {
				if (c.nodeType === 3) s += c.data;
				else if (c.nodeType === 1) {
					if (this.gizliMi(c)) continue;
					if (c.localName === 'svg') {
						const g = SIMGE[this.simgeAdi(c)];
						if (g) s += (s && !/\s$/.test(s) ? ' ' : '') + g + ' ';
					} else if (c.localName === 'br') s += ' ';
					else gez(c);
				}
			}
		};
		gez(el);
		s = s.replace(/\s+/g, ' ').trim();
		if (!s) s = el.getAttribute('aria-label') || el.getAttribute('title') || '';
		return s;
	}

	aralikli(el) {
		if (this.duzen(el) === 'satir') return true;
		for (const k of el.classList) if (ARALIKLI.has(k) || SATIRLAR.has(k)) return true;
		return false;
	}

	// Öğenin satır içi parçalarını topla. p: parça listesi; s: stil (nesne); h: odaklanabilir üst öğe.
	// Flex satırlarda (aralikli) çocukların arasına boşluk girer (CSS'teki gap).
	parcala(el, p, s, h, w) {
		const aralik = this.aralikli(el);
		for (const c of el.childNodes) {
			if (c.nodeType === 3) {
				const m = c.data.replace(/[ \t\n\r\f]+/g, ' ');
				if (m && !(aralik && !m.trim())) p.push({ t: 'm', m, s: stilNo(s), el, h });
				continue;
			}
			if (c.nodeType !== 1 || this.gizliMi(c)) continue;
			if (aralik) p.push({ t: 'ara', h, el });
			this.ogeParcala(c, p, s, h, w);
		}
	}

	ogeParcala(c, p, s, h, w) {
		const e = c.localName;
		const cs = this.stil(c, s);
		if (e === 'br') return p.push({ t: 'br' });
		if (sagaMi(c)) p.push({ t: 'sag' });
		if (e === 'svg') {
			const g = SIMGE[this.simgeAdi(c)];
			if (g) p.push({ t: 'a', m: g, s: stilNo(cs), el: c, h });
			return;
		}
		if (c.classList.contains('bosluk')) return p.push({ t: 'sag' });
		if (c.classList.contains('avatar')) {
			const harf = (c.firstChild && c.firstChild.nodeType === 3 ? c.firstChild.data : c.textContent).trim().slice(0, 2) || '?';
			const konusuyor = c.classList.contains('konusuyor');
			const st = stilNo({ ...cs, fg: R.beyaz, bg: hsl(renkTonu(c), 52, 46), kalin: true, alti: konusuyor });
			const buyuk = c.classList.contains('orta-avatar') || (!c.classList.contains('mini-avatar') && !c.classList.contains('kucuk-avatar'));
			p.push({ t: 'a', m: buyuk ? ` ${harf} ` : harf, s: st, el: c, h });
			if (c.querySelector('.durum-nokta')) {
				const n = c.querySelector('.durum-nokta');
				p.push({ t: 'a', m: '●', s: stilNo({ ...s, fg: n.classList.contains('kapali') ? R.sonuk : R.yesil }), el: n, h });
			}
			return;
		}
		if (c.classList.contains('durum-nokta') || c.classList.contains('dosya-nokta')) {
			const acik = c.classList.contains('dosya-nokta') ? c.classList.contains('acik') : !c.classList.contains('kapali');
			return p.push({ t: 'a', m: '●', s: stilNo({ ...s, fg: acik ? R.yesil : R.sonuk }), el: c, h });
		}
		if (c.classList.contains('sayac')) {
			p.push({ t: 'a', m: '●', s: stilNo({ ...s, fg: R.yesil }), el: c, h });
			return this.parcala(c, p, cs, h, w);
		}
		if (c.classList.contains('yazma-noktalar')) return p.push({ t: 'a', m: '•••', s: stilNo(cs), el: c, h });
		if (c.classList.contains('canli')) return p.push({ t: 'a', m: ` ${c.textContent.trim()} `, s: stilNo(cs), el: c, h });
		if (c.classList.contains('rozet')) return p.push({ t: 'a', m: ` ${c.textContent.trim()} `, s: stilNo(cs), el: c, h });
		if (this.duzen(c) === 'cubuk') return p.push(this.cubuk(c, cs, h));
		if (e === 'button' && (c.classList.contains('kanal') || c.classList.contains('yayin-menu-oge'))) {
			// Zengin içerikli düğme (kanal: işaret, ad, rozet): parçaları korunur, hepsi düğmeye tıklar.
			const once = p.length;
			this.parcala(c, p, cs, c.disabled ? null : c, w);
			if (p.length === once) p.push({ t: 'a', m: this.duzYazi(c) || '…', s: stilNo(cs), el: c, h: c });
			return;
		}
		if (e === 'button' || (e === 'a' && c.hasAttribute('href'))) return p.push(this.dugme(c, cs));
		if (e === 'input' || e === 'select' || e === 'textarea') return p.push(this.girdi(c, cs, w));
		if (e === 'img') {
			const ad = c.getAttribute('alt') || 'resim';
			return p.push({ t: 'a', m: `[resim: ${ad}]`, s: stilNo({ ...cs, fg: R.baglanti }), el: c, h });
		}
		if (e === 'audio' || e === 'video') {
			if (c.getAttribute('src')) return p.push({ t: 'a', m: `[▶ ${e === 'audio' ? 'ses' : 'video'}: aç]`, s: stilNo({ ...cs, fg: R.baglanti, alti: true }), el: c, h: this.odaklanabilir(c) ? c : h });
			return;
		}
		if (e === 'output') return this.parcala(c, p, cs, h, w);
		const d = this.duzen(c);
		if (d === 'satiri' || d === 'satir') {
			// Satır içi öğe (ya da yan yana dizilen bir grup): içeriği araya boşluk koyarak.
			const once = p.length;
			this.parcala(c, p, cs, h, w);
			if (d === 'satir' && p.length > once) {
				p.splice(once, 0, { t: 'ara' });
				p.push({ t: 'ara' });
			}
			return;
		}
		// Satır içinde blok öğe: içeriği satır içi, öncesinde ve sonrasında ayraç.
		p.push({ t: 'ara' });
		this.parcala(c, p, cs, h, w);
		p.push({ t: 'ara' });
	}

	dugme(el, s) {
		const yazi = this.duzYazi(el) || '…';
		const ikonlu = el.classList.contains('ikon-dugme') || el.classList.contains('kanal-sil') || el.classList.contains('uye-at') || el.classList.contains('aktarim-iptal') || el.classList.contains('bolum-ekle') || el.classList.contains('buyutec-dugme');
		const satirIci = el.localName === 'a' || el.classList.contains('kanal') || el.classList.contains('yayin-menu-oge') || el.classList.contains('daha-eski') || el.classList.contains('yeni-mesaj');
		let st = { ...s };
		let m = yazi;
		if (el.localName === 'a') m = yazi;
		else if (ikonlu) {
			m = yazi;
			if (el.getAttribute('aria-pressed') === 'true' && !el.classList.contains('kapali') && el.id === 'uye-ac') st.fg = R.parlak;
		} else if (!satirIci) {
			// Yazılı düğme: zeminli.
			m = ` ${yazi} `;
			st.bg = el.classList.contains('tehlike') || el.classList.contains('tehlike-dugme') || el.classList.contains('red') ? [161, 40, 40] : el.classList.contains('birincil') || el.id === 'pencere-tamam' || el.id === 'ses-kaynagi-paylas' ? R.vurgu : R.dugme;
			st.fg = R.parlak;
			if (el.classList.contains('secili')) st.bg = R.yesil;
		}
		if (el.classList.contains('secili') && ikonlu) st.fg = R.yesilAcik;
		if (el.disabled) {
			st.soluk = true;
			st.bg = st.bg === R.dugme || st.bg === R.vurgu ? R.ust : st.bg;
		}
		return { t: 'a', m, s: stilNo(st), el, h: this.odaklanabilir(el) ? el : null };
	}

	cubuk(el, s, h) {
		const dolgu = el.querySelector(':scope > div') || el.firstElementChild;
		const oran = (n) => {
			const m = /(-?\d+(?:\.\d+)?)%/.exec((n && n.getAttribute('style')) || '');
			return m ? Math.max(0, Math.min(100, Number(m[1]))) / 100 : 0;
		};
		const w = el.classList.contains('olcer') ? 24 : el.classList.contains('ilerleme') ? 16 : 10;
		const dolu = Math.round(oran(dolgu) * w);
		const kapali = !!(dolgu && dolgu.classList.contains('kapali'));
		let m = '█'.repeat(dolu) + '░'.repeat(w - dolu);
		// Ölçerdeki eşik çizgisi.
		const esik = el.querySelector('.olcer-esik');
		if (esik && !esik.hidden) {
			const m2 = /left:\s*(-?\d+(?:\.\d+)?)%/.exec(esik.getAttribute('style') || '');
			if (m2) {
				const x = Math.max(0, Math.min(w - 1, Math.round((Number(m2[1]) / 100) * w)));
				m = m.slice(0, x) + '│' + m.slice(x + 1);
			}
		}
		return { t: 'a', m, s: stilNo({ ...s, fg: kapali ? R.sonuk : el.classList.contains('ilerleme') ? R.vurgu : R.yesilAcik, soluk: false }), el, h };
	}

	// Girdiler: yazı alanı, onay kutusu, kaydırıcı, seçim.
	girdi(el, s, w) {
		const e = el.localName;
		const tur = e === 'input' ? (el.type || 'text') : e;
		const h = this.odaklanabilir(el) ? el : null;
		const odakta = this.odak === el;
		if (tur === 'checkbox' || tur === 'radio') {
			const m = tur === 'radio' ? (el.checked ? '(●)' : '( )') : el.checked ? '[✓]' : '[ ]';
			return { t: 'a', m, s: stilNo({ ...s, fg: el.disabled ? R.sonuk : el.checked ? R.yesilAcik : R.yazi }), el, h };
		}
		if (tur === 'range') {
			const enAz = Number(el.min || 0);
			const enCok = Number(el.max || 100);
			const v = Number(el.value);
			const n = 14;
			const x = Math.round(((v - enAz) / Math.max(1e-9, enCok - enAz)) * (n - 1));
			const m = '━'.repeat(x) + '●' + '─'.repeat(n - 1 - x);
			return { t: 'a', m, s: stilNo({ ...s, fg: el.disabled ? R.sonuk : R.vurgu }), el, h, kaydirici: { enAz, enCok, n } };
		}
		if (tur === 'select') {
			const o = el.options[el.selectedIndex];
			const yazi = o ? o.textContent.trim() : '—';
			return { t: 'a', m: `‹ ${kirp(yazi, Math.max(8, Math.min(48, w - 6)))} ›`, s: stilNo({ ...s, fg: el.disabled ? R.sonuk : R.parlak, bg: R.zemin }), el, h };
		}
		// Yazı alanı (satır içinde: esnek genişlik; blokta: kendi satırı).
		return { t: 'esnek', el, s, h, odakta };
	}

	// Yazı alanının satırları (genişlik w). Tek satırlı alanda imleç görünecek biçimde kaydırılır.
	yaziAlani(el, s, w, enCokSatir = 6) {
		const cok = el.localName === 'textarea';
		const deger = String(el.value || '');
		const odakta = this.odak === el;
		const zemin = { ...s, bg: R.ust, fg: R.yazi, alti: false };
		const zeminNo = stilNo(zemin);
		const soluk = stilNo({ ...zemin, fg: R.sonuk });
		let imlec = this.imlecler.get(el);
		if (imlec == null || imlec > deger.length) imlec = deger.length;
		const satirlar = [];
		if (!deger) {
			const satir = bos();
			ekle(satir, ' ' + kirp(el.getAttribute('placeholder') || '', Math.max(1, w - 2)), soluk, el, el, odakta ? { imlec: 1 } : null);
			satirlar.push(doldur(satir, w, zeminNo));
			return satirlar;
		}
		if (!cok) {
			// Tek satır: imleç görünsün diye yatay kaydır.
			const ic = w - 2;
			const hucre = hucreler(el.type === 'password' ? '•'.repeat(deger.length) : deger);
			let imlecHucre = 0;
			for (let i = 0, k = 0; i < hucre.length && k < imlec; i++) {
				imlecHucre += hucre[i][1];
				k += hucre[i][0].length;
			}
			let bas = 0;
			if (imlecHucre > ic - 1) bas = imlecHucre - (ic - 1);
			let gorunen = '';
			let g = 0;
			let x = 0;
			for (const [ch, cw] of hucre) {
				if (x >= bas && g + cw <= ic) {
					gorunen += ch;
					g += cw;
				}
				x += cw;
			}
			const satir = bos();
			ekle(satir, ' ' + gorunen, zeminNo, el, el, odakta ? { imlec: 1 + imlecHucre - bas } : null);
			satirlar.push(doldur(satir, w, zeminNo));
			return satirlar;
		}
		// Çok satırlı: kelime kaydırmasız, w-2 hücrede bölünür; imleç satırı görünür kalır.
		const ic = Math.max(4, w - 2);
		const parcalar = []; // { m, bas (karakter) }
		let bas = 0;
		for (const satirMetni of deger.split('\n')) {
			let m = '';
			let g = 0;
			let parcaBas = bas;
			for (const [ch, cw] of hucreler(satirMetni)) {
				if (g + cw > ic) {
					parcalar.push({ m, bas: parcaBas });
					parcaBas += m.length;
					m = '';
					g = 0;
				}
				m += ch;
				g += cw;
			}
			parcalar.push({ m, bas: parcaBas });
			bas += satirMetni.length + 1;
		}
		let imlecSatir = parcalar.length - 1;
		for (let i = 0; i < parcalar.length; i++) {
			const son = i + 1 < parcalar.length ? parcalar[i + 1].bas : Infinity;
			if (imlec >= parcalar[i].bas && imlec < son) {
				imlecSatir = i;
				break;
			}
		}
		const n = Math.min(enCokSatir, parcalar.length);
		const ilk = Math.max(0, Math.min(parcalar.length - n, imlecSatir - n + 1));
		for (let i = ilk; i < ilk + n; i++) {
			const satir = bos();
			const p = parcalar[i];
			let ek = null;
			if (odakta && i === imlecSatir) ek = { imlec: 1 + metinGenislik(deger.slice(p.bas, imlec)) };
			ekle(satir, ' ' + p.m, zeminNo, el, el, ek);
			satirlar.push(doldur(satir, w, zeminNo));
		}
		return satirlar;
	}

	// ------------------------------------------------------------ satır kaydırma

	// Parçaları w genişliğinde satırlara diz. ilkSatir: ilk satırın başındaki boşluklar silinsin mi.
	diz(parcalar, w, s) {
		const satirlar = [];
		let satir = bos();
		let sag = null; // sağa yaslanacak parçalar (bosluk'tan sonra)
		const bitir = () => {
			if (sag) {
				while (satir.parcalar.length && satir.parcalar[satir.parcalar.length - 1].m === ' ') {
					satir.w -= 1;
					satir.parcalar.pop();
				}
				while (sag.length && sag[0].m === ' ') sag.shift();
				const solW = satir.w;
				const sagSatir = bos();
				for (const p of sag) {
					sagSatir.parcalar.push(p);
					sagSatir.w += p.w;
				}
				if (solW + sagSatir.w + 1 <= w) {
					ekle(satir, ' '.repeat(w - solW - sagSatir.w), s);
					satir.parcalar.push(...sagSatir.parcalar);
					satir.w += sagSatir.w;
				} else if (sagSatir.w) {
					satirlar.push(satirKirp(satir, w));
					satir = bos();
					ekle(satir, ' '.repeat(Math.max(0, w - sagSatir.w)), s);
					satir.parcalar.push(...sagSatir.parcalar);
					satir.w += sagSatir.w;
				}
				sag = null;
			}
			// Sondaki boşlukları at.
			while (satir.parcalar.length && satir.parcalar[satir.parcalar.length - 1].m === ' ') {
				satir.w -= 1;
				satir.parcalar.pop();
			}
			satirlar.push(satirKirp(satir, w));
			satir = bos();
		};
		const hedef = () => (sag ? { parcalar: sag, get w() { return sag.reduce((t, p) => t + p.w, 0); } } : satir);
		const koy = (p) => {
			if (sag) sag.push(p);
			else {
				satir.parcalar.push(p);
				satir.w += p.w;
			}
		};
		let bosluk = false; // son konan bir boşluk muydu (birden çok boşluk tek olur)
		const esnekler = [];
		for (const p of parcalar) {
			if (p.t === 'br') {
				bitir();
				bosluk = false;
				continue;
			}
			if (p.t === 'sag') {
				if (!sag) sag = [];
				continue;
			}
			if (p.t === 'ara') {
				if (!bosluk && hedef().w > 0) {
					koy({ m: ' ', s: p.s ?? stilNo(s), w: 1, el: p.el || null, h: p.h || null });
					bosluk = true;
				}
				continue;
			}
			if (p.t === 'a' || p.t === 'esnek') {
				if (p.t === 'esnek') {
					// Satır içi yazı alanı: kalan genişliği kaplar (sağdaki parçalar için yer bırakarak).
					const kalanParcalar = parcalar.slice(parcalar.indexOf(p) + 1).filter((x) => x.t === 'a');
					const sagW = kalanParcalar.reduce((t, x) => t + metinGenislik(x.m) + 1, 0);
					const aw = Math.max(8, w - hedef().w - sagW);
					const alan = this.yaziAlani(p.el, p.s, aw, 6);
					const bas = hedef().w;
					koy(alan[0].parcalar.length === 1 ? alan[0].parcalar[0] : { ...alan[0].parcalar[0] });
					for (const x of alan[0].parcalar.slice(1)) koy(x);
					if (alan.length > 1) p.ekSatirlar = { bas, satirlar: alan.slice(1) };
					p.yer = satirlar.length;
					bosluk = false;
					esnekler.push(p);
					continue;
				}
				const pw = metinGenislik(p.m);
				if (hedef().w + pw > w && hedef().w > 0 && !sag) bitir();
				koy({ m: p.m, s: p.s, w: pw, el: p.el, h: p.h, kaydirici: p.kaydirici });
				bosluk = /\s$/.test(p.m);
				continue;
			}
			// Metin: kelimelere böl.
			const kelimeler = p.m.split(/( )/);
			for (const k of kelimeler) {
				if (!k) continue;
				if (k === ' ') {
					if (bosluk || hedef().w === 0) continue;
					if (hedef().w + 1 > w && !sag) {
						bitir();
						bosluk = false;
						continue;
					}
					koy({ m: ' ', s: p.s, w: 1, el: p.el, h: p.h });
					bosluk = true;
					continue;
				}
				let kw = metinGenislik(k);
				if (hedef().w + kw > w && hedef().w > 0 && !sag) bitir();
				// Satırdan uzun kelime: bölünür.
				let kalan = k;
				while (!sag && kw > w) {
					let par = '';
					let g = 0;
					for (const [ch, cw] of hucreler(kalan)) {
						if (g + cw > w - hedef().w) break;
						par += ch;
						g += cw;
					}
					if (!par) {
						bitir();
						continue;
					}
					koy({ m: par, s: p.s, w: g, el: p.el, h: p.h });
					bitir();
					kalan = kalan.slice(par.length);
					kw = metinGenislik(kalan);
				}
				if (kalan) koy({ m: kalan, s: p.s, w: kw, el: p.el, h: p.h });
				bosluk = false;
			}
		}
		if (satir.w > 0 || sag) bitir();
		// Satır içi çok satırlı yazı alanlarının ek satırları.
		if (esnekler.length) {
			for (const p of esnekler) {
				if (!p.ekSatirlar) continue;
				const { bas, satirlar: ekler } = p.ekSatirlar;
				const yer = Math.min(p.yer, satirlar.length - 1);
				const yeni = ekler.map((alan) => {
					const satir = bos();
					ekle(satir, ' '.repeat(bas), s);
					for (const x of alan.parcalar) {
						satir.parcalar.push(x);
						satir.w += x.w;
					}
					return satir;
				});
				satirlar.splice(yer + 1, 0, ...yeni);
			}
		}
		return satirlar;
	}

	// ------------------------------------------------------------ blok düzeni

	// Öğeyi w genişliğinde satırlara çiz. s: üstten gelen stil (nesne).
	blok(el, w, s = {}) {
		if (w <= 0) return [];
		const d = this.duzen(el);
		const cs = this.stil(el, s);
		if (d === 'satir' || d === 'satiri') {
			const p = [];
			this.parcala(el, p, cs, this.odaklanabilir(el) ? el : null, w);
			return this.diz(p, w, cs);
		}
		if (d === 'mesaj') return this.mesaj(el, w, cs);
		if (d === 'gun') {
			const yazi = ` ${el.textContent.trim()} `;
			const yan = Math.max(0, w - metinGenislik(yazi));
			const satir = bos();
			ekle(satir, '─'.repeat(Math.floor(yan / 2)) + yazi + '─'.repeat(Math.ceil(yan / 2)), stilNo({ ...cs, fg: R.sonuk }), el);
			return [satir];
		}
		if (d === 'pre') return this.pre(el, w, cs);
		if (d === 'dl') return this.dl(el, w, cs);
		if (d === 'cubuk') {
			const satir = bos();
			const c = this.cubuk(el, cs, null);
			ekle(satir, c.m, c.s, el);
			return [satir];
		}
		const girinti = el.classList.contains('ses-uyeleri') ? 3 : 0;
		if (girinti) {
			const ic = this.blokIc(el, w - girinti, cs);
			const zemin = stilNo(cs);
			return ic.map((x) => {
				const satir = bos();
				ekle(satir, ' '.repeat(girinti), zemin, el);
				satir.parcalar.push(...x.parcalar);
				satir.w += x.w;
				return satir;
			});
		}
		return this.blokIc(el, w, cs);
	}

	// Blok öğenin içeriği: satır içi parçalar akıtılır, blok çocuklar alt alta.
	blokIc(el, w, cs) {
		const satirlar = [];
		let p = [];
		const akit = () => {
			if (p.length) satirlar.push(...this.diz(p, w, cs));
			p = [];
		};
		const h = this.odaklanabilir(el) ? el : null;
		for (const c of el.childNodes) {
			if (c.nodeType === 3) {
				const m = c.data.replace(/[ \t\n\r\f]+/g, ' ');
				if (m.trim() || p.length) p.push({ t: 'm', m, s: stilNo(cs), el, h });
				continue;
			}
			if (c.nodeType !== 1 || this.gizliMi(c)) continue;
			const e = c.localName;
			const cd = this.duzen(c);
			const yaziAlani = (e === 'textarea' || (e === 'input' && METIN_GIRDISI.has(c.type))) && !c.closest('.yazma-kutu');
			if (yaziAlani) {
				akit();
				satirlar.push(...this.yaziAlani(c, this.stil(c, cs), Math.min(w, 60)));
				continue;
			}
			if (e === 'video' && c.srcObject) {
				akit();
				if (this.video) satirlar.push(...this.video(c, w));
				continue;
			}
			if (cd === 'satiri' && !BLOK.has(e)) {
				this.ogeParcala(c, p, cs, h, w);
				continue;
			}
			akit();
			satirlar.push(...this.blok(c, w, cs));
		}
		akit();
		return satirlar;
	}

	// Sohbetteki mesaj: solda avatar (ya da gruplu mesajda saat), sağda gövde.
	mesaj(el, w, s) {
		const SOL = 6;
		const sol = el.querySelector(':scope > .avatar, :scope > .yan-saat');
		const govde = el.querySelector(':scope > .govde');
		const sag = govde ? this.blok(govde, w - SOL, s) : [];
		const solSatir = bos();
		const zemin = stilNo(s);
		if (sol && sol.classList.contains('avatar')) {
			const p = [];
			this.ogeParcala(sol, p, s, null, SOL);
			ekle(solSatir, p[0] ? p[0].m : '', p[0] ? p[0].s : zemin, sol);
		} else if (sol) ekle(solSatir, sol.textContent.trim(), stilNo({ ...s, fg: R.sonuk }), sol);
		const satirlar = [];
		for (let i = 0; i < Math.max(1, sag.length); i++) {
			const satir = bos();
			if (i === 0) {
				satir.parcalar.push(...solSatir.parcalar);
				satir.w = solSatir.w;
			}
			ekle(satir, ' '.repeat(SOL - satir.w), zemin, el);
			if (sag[i]) {
				satir.parcalar.push(...sag[i].parcalar);
				satir.w += sag[i].w;
			}
			satirlar.push(satir);
		}
		if (!el.classList.contains('gruplu')) satirlar.unshift(doldur(bos(), 0, zemin));
		return satirlar;
	}

	// Biçimi korunan metin (mesaj): satır sonları ve boşluklar olduğu gibi, uzun satırlar kaydırılır.
	pre(el, w, s) {
		const p = [];
		const gez = (n, st, h) => {
			for (const c of n.childNodes) {
				if (c.nodeType === 3) {
					const parcalar = c.data.split('\n');
					parcalar.forEach((m, i) => {
						if (i > 0) p.push({ t: 'br' });
						if (m) p.push({ t: 'm', m, s: stilNo(st), el: n, h });
					});
				} else if (c.nodeType === 1 && !this.gizliMi(c)) {
					if (c.localName === 'a' && c.hasAttribute('href')) {
						const cs = this.stil(c, st);
						// Bağlantı: kendi satırına sığmayan uzun adres de tıklanabilir kalır (kelime kelime).
						for (const k of c.textContent.split(/( )/)) if (k) p.push({ t: 'm', m: k, s: stilNo(cs), el: c, h: c });
					} else if (c.localName === 'br') p.push({ t: 'br' });
					else gez(c, this.stil(c, st), h);
				}
			}
		};
		gez(el, s, null);
		return this.diz(p, w, s);
	}

	// Tanım listesi: "Boyut  1,2 MB".
	dl(el, w, s) {
		const satirlar = [];
		let etiket = null;
		for (const c of el.children) {
			if (this.gizliMi(c)) continue;
			if (c.localName === 'dt') etiket = c.textContent.trim();
			else if (c.localName === 'dd') {
				const satir = bos();
				ekle(satir, (etiket || '').padEnd(14) + ' ', stilNo({ ...s, fg: R.soluk }), c);
				ekle(satir, c.textContent.trim(), stilNo({ ...s, fg: R.parlak }), c);
				satirlar.push(satirKirp(satir, w));
				etiket = null;
			}
		}
		return satirlar;
	}
}

module.exports = { Cizici, R, SIMGE, hsl, bos, ekle, doldur, satirKirp };
