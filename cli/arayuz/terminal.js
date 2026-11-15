// Terminal: ham kip, ayrı ekran (çıkınca terminal eski hâline döner), fare ve yapıştırma olayları,
// tuşların çözülmesi ve ekranın yalnızca değişen satırlarının yazılması.
'use strict';

const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const { hucreler } = require('./genislik');

// ---------------------------------------------------------------- renk ve stil

const gercekRenk = /truecolor|24bit/i.test(process.env.COLORTERM || '') || /kitty|wezterm|alacritty|ghostty|foot/i.test(process.env.TERM_PROGRAM || process.env.TERM || '');

// RGB → 256 renk paletinin en yakını (gerçek renk yoksa).
function renk256(r, g, b) {
	const kup = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
	const kr = kup(r);
	const kg = kup(g);
	const kb = kup(b);
	const deger = [0, 95, 135, 175, 215, 255];
	const kupFark = (deger[kr] - r) ** 2 + (deger[kg] - g) ** 2 + (deger[kb] - b) ** 2;
	const gri = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
	const gv = 8 + gri * 10;
	const griFark = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
	return griFark < kupFark ? 232 + gri : 16 + 36 * kr + 6 * kg + kb;
}
const renkKodu = (r, arka) => (gercekRenk ? `${arka ? 48 : 38};2;${r[0]};${r[1]};${r[2]}` : `${arka ? 48 : 38};5;${renk256(r[0], r[1], r[2])}`);

// Stiller kimlikle tutulur (hücre başına küçük bir sayı): { fg, bg, kalin, soluk, italik, alti, ters, ustu }.
const stilKimlik = new Map();
const stilSgr = [''];
function stilNo(s) {
	if (!s) return 0;
	const anahtar = `${s.fg ? s.fg.join(',') : ''}|${s.bg ? s.bg.join(',') : ''}|${s.kalin ? 1 : 0}${s.soluk ? 1 : 0}${s.italik ? 1 : 0}${s.alti ? 1 : 0}${s.ters ? 1 : 0}${s.ustu ? 1 : 0}`;
	let no = stilKimlik.get(anahtar);
	if (no === undefined) {
		const p = [];
		if (s.kalin) p.push('1');
		if (s.soluk) p.push('2');
		if (s.italik) p.push('3');
		if (s.alti) p.push('4');
		if (s.ters) p.push('7');
		if (s.ustu) p.push('9');
		if (s.fg) p.push(renkKodu(s.fg, false));
		if (s.bg) p.push(renkKodu(s.bg, true));
		no = stilSgr.length;
		stilSgr.push(p.length ? '\x1b[0;' + p.join(';') + 'm' : '\x1b[0m');
		stilKimlik.set(anahtar, no);
	}
	return no;
}

// ---------------------------------------------------------------- ekran tamponu

class Ekran {
	constructor(genislik, yukseklik) {
		this.genislik = genislik;
		this.yukseklik = yukseklik;
		const n = genislik * yukseklik;
		this.kar = new Array(n).fill(' ');
		this.stil = new Uint32Array(n);
		this.imlec = null; // { x, y }: görünen imleç (yazı alanında)
	}
	// Hücreyi üzerine yazmaya hazırla: geniş bir karakterin yarısı kalmasın (öteki yarısı boşalır).
	ac(i) {
		const W = this.genislik;
		if (this.ham) this.ham.delete(i);
		if (this.kar[i] === '' && i % W > 0) this.kar[i - 1] = ' ';
		if (i % W < W - 1 && this.kar[i + 1] === '') this.kar[i + 1] = ' ';
	}
	// Metni (x, y)'ye yaz; [sol, sag) dışı kırpılır. Dönüş: yazmanın bittiği x.
	yaz(x, y, metin, stil = 0, sol = 0, sag = this.genislik) {
		if (y < 0 || y >= this.yukseklik) return x;
		const no = typeof stil === 'number' ? stil : stilNo(stil);
		sag = Math.min(sag, this.genislik);
		sol = Math.max(0, sol);
		const satirBasi = y * this.genislik;
		for (const [ch, w] of hucreler(metin)) {
			if (x + w > sag) break;
			if (x >= sol) {
				const i = satirBasi + x;
				this.ac(i);
				this.kar[i] = ch;
				this.stil[i] = no;
				if (w === 2) {
					this.ac(i + 1);
					this.kar[i + 1] = '';
					this.stil[i + 1] = no;
				}
			} else if (x + w > sol) {
				// Geniş karakter sol sınırı aşıyor: sınırdaki hücre boş görünür.
				const i = satirBasi + sol;
				this.ac(i);
				this.kar[i] = ' ';
				this.stil[i] = no;
			}
			x += w;
		}
		return x;
	}
	doldur(x, y, w, h, stil = 0, ch = ' ') {
		const no = typeof stil === 'number' ? stil : stilNo(stil);
		const x0 = Math.max(0, x);
		const x1 = Math.min(this.genislik, x + w);
		if (x1 <= x0) return;
		for (let yy = Math.max(0, y); yy < Math.min(this.yukseklik, y + h); yy++) {
			const bas = yy * this.genislik;
			this.ac(bas + x0);
			this.ac(bas + x1 - 1);
			for (let xx = x0; xx < x1; xx++) {
				this.kar[bas + xx] = ch;
				this.stil[bas + xx] = no;
				if (this.ham) this.ham.delete(bas + xx);
			}
		}
	}
	// Hücreye kendi renk koduyla yaz (görüntü: her hücrenin rengi ayrı; stil tablosuna girmez).
	yazHam(x, y, ch, sgr) {
		if (x < 0 || y < 0 || x >= this.genislik || y >= this.yukseklik) return;
		const i = y * this.genislik + x;
		this.ac(i);
		this.kar[i] = ch;
		this.stil[i] = 0;
		(this.ham || (this.ham = new Map())).set(i, sgr);
	}
	// Bir bölgenin stilini değiştir (odak vurgusu): stil işlevi eski stili alır, yenisini verir.
	boya(x, y, w, fn) {
		if (y < 0 || y >= this.yukseklik) return;
		for (let xx = Math.max(0, x); xx < Math.min(this.genislik, x + w); xx++) {
			const i = y * this.genislik + xx;
			this.stil[i] = fn(this.stil[i]);
		}
	}
	satir(y) {
		let s = '';
		let son = -1;
		const bas = y * this.genislik;
		for (let x = 0; x < this.genislik; x++) {
			const i = bas + x;
			const ch = this.kar[i];
			if (ch === '') continue;
			const ham = this.ham && this.ham.get(i);
			if (ham) {
				s += ham + ch;
				son = -1;
				continue;
			}
			const st = this.stil[i];
			if (st !== son) {
				s += stilSgr[st] || '\x1b[0m';
				son = st;
			}
			s += ch;
		}
		return s + '\x1b[0m';
	}
}

// Stilin bir kopyasını değiştirerek yeni kimlik al (odak için ters çevirme vb.).
const stilTablosu = new Map(); // no → nesne (ters arama için)
function stilNesnesi(no) {
	if (stilTablosu.has(no)) return stilTablosu.get(no);
	for (const [anahtar, n] of stilKimlik) {
		if (n !== no) continue;
		const [fg, bg, b] = anahtar.split('|');
		const s = {
			fg: fg ? fg.split(',').map(Number) : null,
			bg: bg ? bg.split(',').map(Number) : null,
			kalin: b[0] === '1',
			soluk: b[1] === '1',
			italik: b[2] === '1',
			alti: b[3] === '1',
			ters: b[4] === '1',
			ustu: b[5] === '1',
		};
		stilTablosu.set(no, s);
		return s;
	}
	return {};
}
function stilDegistir(no, degisim) {
	return stilNo({ ...stilNesnesi(no), ...degisim });
}

// ---------------------------------------------------------------- terminal

const TUSLAR = {
	A: 'up',
	B: 'down',
	C: 'right',
	D: 'left',
	H: 'home',
	F: 'end',
	P: 'f1',
	Q: 'f2',
	R: 'f3',
	S: 'f4',
	Z: 'tab',
};
const TILDA = { 1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end', 11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4', 15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12' };
// CSI parametresindeki değiştirici: 1 + (shift 1, alt 2, ctrl 4).
const degistirici = (m) => {
	const v = Math.max(0, (Number(m) || 1) - 1);
	return { shift: !!(v & 1), alt: !!(v & 2), ctrl: !!(v & 4) };
};

class Terminal extends EventEmitter {
	constructor({ girdi = process.stdin, cikti = process.stdout } = {}) {
		super();
		this.girdi = girdi;
		this.cikti = cikti;
		this.cozucu = new StringDecoder('utf8');
		this.tampon = '';
		this.yapistirma = null; // yapıştırılan metin (sürerken)
		this.kacisZamani = null;
		this.oncekiSatirlar = [];
		this.basladi = false;
		this.veriDinleyici = (d) => this.veriGeldi(d);
		this.boyutDinleyici = () => {
			this.oncekiSatirlar = [];
			this.emit('boyut', this.boyut());
		};
	}
	boyut() {
		return { genislik: Math.max(20, this.cikti.columns || 80), yukseklik: Math.max(8, this.cikti.rows || 24) };
	}
	baslat() {
		if (this.basladi) return;
		this.basladi = true;
		if (this.girdi.isTTY) this.girdi.setRawMode(true);
		this.girdi.resume();
		this.girdi.on('data', this.veriDinleyici);
		this.cikti.on('resize', this.boyutDinleyici);
		// Ayrı ekran, imleç gizli, fare (tıklama, sürükleme, SGR biçimi), yapıştırma kipi, odak olayları.
		this.cikti.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[2J');
	}
	bitir() {
		if (!this.basladi) return;
		this.basladi = false;
		this.girdi.off('data', this.veriDinleyici);
		this.cikti.off('resize', this.boyutDinleyici);
		try {
			if (this.girdi.isTTY) this.girdi.setRawMode(false);
		} catch {}
		this.girdi.pause();
		this.cikti.write('\x1b[0m\x1b[?1004l\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l');
	}
	// Ekranı yaz: yalnızca değişen satırlar.
	ciz(ekran) {
		let s = '\x1b[?25l';
		for (let y = 0; y < ekran.yukseklik; y++) {
			const satir = ekran.satir(y);
			if (this.oncekiSatirlar[y] === satir) continue;
			this.oncekiSatirlar[y] = satir;
			s += `\x1b[${y + 1};1H${satir}`;
		}
		this.oncekiSatirlar.length = ekran.yukseklik;
		if (ekran.imlec) s += `\x1b[${ekran.imlec.y + 1};${ekran.imlec.x + 1}H\x1b[?25h`;
		this.cikti.write(s);
	}
	yenidenCiz() {
		this.oncekiSatirlar = [];
	}
	// Başlığı ayarla (pencere başlığı).
	baslik(metin) {
		this.cikti.write(`\x1b]2;${String(metin).replace(/[\x00-\x1f]/g, '')}\x07`);
	}

	// ------------------------------------------------------------ girdi

	veriGeldi(d) {
		this.tampon += typeof d === 'string' ? d : this.cozucu.write(d);
		clearTimeout(this.kacisZamani);
		this.coz();
		// Yalnız kalan ESC: kaçış tuşu (ardı 30 ms'de gelmediyse).
		if (this.tampon === '\x1b') {
			this.kacisZamani = setTimeout(() => {
				if (this.tampon === '\x1b') {
					this.tampon = '';
					this.tus({ ad: 'escape' });
				}
			}, 30);
		}
	}
	tus(t) {
		this.emit('tus', { ctrl: false, alt: false, shift: false, ...t });
	}
	coz() {
		const b = this.tampon;
		let i = 0;
		while (i < b.length) {
			if (this.yapistirma !== null) {
				const son = b.indexOf('\x1b[201~', i);
				if (son < 0) {
					this.yapistirma += b.slice(i);
					i = b.length;
					break;
				}
				this.yapistirma += b.slice(i, son);
				this.emit('yapistir', this.yapistirma.replace(/\r\n?/g, '\n'));
				this.yapistirma = null;
				i = son + 6;
				continue;
			}
			const c = b[i];
			if (c === '\x1b') {
				if (i + 1 >= b.length) break; // devamı bekleniyor
				const n = b[i + 1];
				if (n === '[') {
					// CSI: ESC [ parametreler son-bayt
					let j = i + 2;
					while (j < b.length && /[0-9;<?]/.test(b[j])) j++;
					if (j >= b.length) break;
					const params = b.slice(i + 2, j);
					const son = b[j];
					i = j + 1;
					this.csi(params, son);
					continue;
				}
				if (n === 'O') {
					if (i + 2 >= b.length) break;
					const son = b[i + 2];
					i += 3;
					if (TUSLAR[son]) this.tus({ ad: TUSLAR[son] });
					continue;
				}
				if (n === '\x1b') {
					this.tus({ ad: 'escape' });
					i++;
					continue;
				}
				// Alt + tuş
				i += 2;
				this.tekKarakter(n, true);
				continue;
			}
			const k = b.codePointAt(i);
			const ch = String.fromCodePoint(k);
			i += ch.length;
			this.tekKarakter(ch, false);
		}
		this.tampon = b.slice(i);
	}
	tekKarakter(ch, alt) {
		const k = ch.codePointAt(0);
		if (ch === '\r' || ch === '\n') return this.tus({ ad: 'enter', alt });
		if (ch === '\t') return this.tus({ ad: 'tab', alt });
		if (ch === '\x7f' || ch === '\b') return this.tus({ ad: 'backspace', alt, ctrl: ch === '\b' });
		if (ch === '\x00') return this.tus({ ad: 'space', ctrl: true, alt });
		if (k < 0x20) return this.tus({ ad: String.fromCharCode(k + 96), ctrl: true, alt });
		if (ch === ' ') return this.tus({ ad: 'space', metin: ' ', alt });
		this.tus({ metin: ch, alt });
	}
	csi(params, son) {
		if (params.startsWith('<') && (son === 'M' || son === 'm')) {
			const [kod, x, y] = params.slice(1).split(';').map(Number);
			const dugme = kod & 3;
			const tekerlek = !!(kod & 64);
			const hareket = !!(kod & 32);
			this.emit('fare', {
				x: x - 1,
				y: y - 1,
				dugme: tekerlek ? (dugme === 0 ? 'yukari' : 'asagi') : ['sol', 'orta', 'sag', 'yok'][dugme],
				tekerlek,
				hareket,
				basildi: son === 'M',
				shift: !!(kod & 4),
				alt: !!(kod & 8),
				ctrl: !!(kod & 16),
			});
			return;
		}
		if (son === '~') {
			const [no, mod] = params.split(';');
			if (no === '200') {
				this.yapistirma = '';
				return;
			}
			if (TILDA[no]) this.tus({ ad: TILDA[no], ...degistirici(mod) });
			return;
		}
		if (son === 'I') return this.emit('odak', true);
		if (son === 'O') return this.emit('odak', false);
		if (TUSLAR[son]) {
			const parca = params.split(';');
			const mod = degistirici(parca[1]);
			if (son === 'Z') return this.tus({ ad: 'tab', shift: true });
			this.tus({ ad: TUSLAR[son], ...mod });
		}
	}
}

module.exports = { Terminal, Ekran, stilNo, stilDegistir, stilNesnesi, gercekRenk };
