// Mikrofonun yolu (AudioWorklet, ana.js'ten yüklenir): RNNoise gürültü bastırma (hep açık) →
// mikrofon seviyesi (kazanç) → konuşma eşiği (kapı). Bilgisayar sesi (paylaşım) bu yoldan geçmez.
//
// RNNoise: Xiph/Mozilla'nın yapay sinir ağıyla gürültü bastırıcısı (BSD-3-Clause); WebAssembly derlemesi
// Jitsi'nin rnnoise-wasm 0.2.1 paketinden (Apache-2.0): rnnoise.wasm. Lisanslar: rnnoise.LICENSE.txt.
// Emscripten yapıştırıcısı yerine iki içe aktarma yeter (belleği büyüt, bellek içinde kopyala);
// dışa aktarımların küçültülmüş adları: c bellek, d __wasm_call_ctors, f rnnoise_create, g malloc,
// h rnnoise_destroy, i free, j rnnoise_process_frame(durum, çıkış, giriş) → konuşma olasılığı.
// RNNoise 48 kHz'de 480 örneklik (10 ms) çerçevelerle çalışır, örnekler ±32768 ölçeğinde: yol 10 ms
// gecikme ekler (çerçeve dolana kadar).
//
// Kapı (konuşma eşiği): çerçevenin seviyesi (gürültü bastırıldıktan ve kazançtan sonra) eşiği geçince
// hemen açılır, eşiğin altında 300 ms kalınca kapanır (kelime sonları kesilmesin); açılış 2 ms,
// kapanış 20 ms'lik rampayla (tık sesi olmasın). Kapalıyken sessizlik gider.
//
// İletiler: içeri {tur:'ayar', kazanc, esik (dBFS ya da null: kapı yok)}, {tur:'kapat'}; dışarı
// {tur:'hazir'}, {tur:'hata', metin}, ~100 ms'de bir {tur:'olcum', konusma (0-1), girisDb (bastırmadan
// önce), rnnDb (bastırmadan sonra, kazançsız), cikisDb (kazançtan sonra, kapıdan önce), acik}.
const CERCEVE = 480;

class Gurultu extends AudioWorkletProcessor {
	constructor(secenek) {
		super();
		const o = (secenek && secenek.processorOptions) || {};
		this.kazanc = typeof o.kazanc === 'number' ? o.kazanc : 1;
		this.esik = typeof o.esik === 'number' ? o.esik : null;
		this.tutma = Math.round(0.3 * sampleRate);
		this.acilisAdim = 1 / Math.max(1, Math.round(0.002 * sampleRate));
		this.kapanisAdim = 1 / Math.max(1, Math.round(0.02 * sampleRate));
		this.kapi = this.esik === null ? 1 : 0;
		this.sonSes = -Infinity;
		this.sayac = 0;
		this.bekleyen = new Float32Array(CERCEVE);
		this.bDolu = 0;
		// Çıkış kuyruğu: başta bir çerçeve sessizlik (gecikme 10 ms); çerçeveler 128'lik parçalardan önce
		// dolduğu için kuyruk hiç boşalmaz.
		this.kuyruk = new Float32Array(CERCEVE * 4);
		this.yaz = CERCEVE;
		this.oku = 0;
		this.ara = new Float32Array(CERCEVE);
		this.top = { n: 0, konusma: 0, giris: 0, rnn: 0, cikis: 0 };
		this.bitti = false;
		this.rnn = null;
		try {
			this.rnnKur(o.wasm);
			this.port.postMessage({ tur: 'hazir' });
		} catch (h) {
			this.rnn = null;
			this.port.postMessage({ tur: 'hata', metin: String((h && h.message) || h).slice(0, 160) });
		}
		this.port.onmessage = (e) => {
			const v = e.data || {};
			if (v.tur === 'ayar') {
				if (typeof v.kazanc === 'number') this.kazanc = v.kazanc;
				if ('esik' in v) this.esik = typeof v.esik === 'number' ? v.esik : null;
			} else if (v.tur === 'kapat') this.kapat();
		};
	}

	rnnKur(bayt) {
		if (!bayt) throw new Error('rnnoise.wasm verilmedi');
		let bellek = null;
		const ice = {
			a: {
				a: (istenen) => {
					try {
						const fark = (istenen >>> 0) - bellek.buffer.byteLength;
						if (fark > 0) bellek.grow(Math.ceil(fark / 65536));
						return 1;
					} catch {
						return 0;
					}
				},
				b: (hedef, kaynak, n) => {
					new Uint8Array(bellek.buffer).copyWithin(hedef, kaynak, kaynak + n);
				},
			},
		};
		const d = new WebAssembly.Instance(new WebAssembly.Module(bayt), ice).exports;
		bellek = d.c;
		d.d();
		const durum = d.f(0);
		const giris = d.g(CERCEVE * 4);
		const cikis = d.g(CERCEVE * 4);
		if (!durum || !giris || !cikis) throw new Error('RNNoise kurulamadı');
		this.rnn = { d, bellek, durum, giris, cikis };
	}

	kapat() {
		if (this.bitti) return;
		this.bitti = true;
		if (this.rnn) {
			try {
				this.rnn.d.h(this.rnn.durum);
				this.rnn.d.i(this.rnn.giris);
				this.rnn.d.i(this.rnn.cikis);
			} catch {}
			this.rnn = null;
		}
	}

	cerceve() {
		const x = this.bekleyen;
		const y = this.ara;
		let ge = 0;
		let konusma = 1;
		if (this.rnn) {
			const r = this.rnn;
			// Bellek büyürse eski görünümler geçersizleşir: her çerçevede yeniden alınır.
			const g = new Float32Array(r.bellek.buffer, r.giris, CERCEVE);
			for (let k = 0; k < CERCEVE; k++) {
				ge += x[k] * x[k];
				g[k] = x[k] * 32768;
			}
			konusma = r.d.j(r.durum, r.cikis, r.giris);
			const c = new Float32Array(r.bellek.buffer, r.cikis, CERCEVE);
			for (let k = 0; k < CERCEVE; k++) y[k] = c[k] / 32768;
		} else {
			for (let k = 0; k < CERCEVE; k++) {
				ge += x[k] * x[k];
				y[k] = x[k];
			}
		}
		let re = 0;
		let ce = 0;
		for (let k = 0; k < CERCEVE; k++) {
			re += y[k] * y[k];
			y[k] *= this.kazanc;
			ce += y[k] * y[k];
		}
		const cikisDb = 10 * Math.log10(ce / CERCEVE + 1e-12);
		let hedef = 1;
		if (this.esik !== null) {
			if (cikisDb >= this.esik) this.sonSes = this.sayac;
			hedef = this.sayac - this.sonSes <= this.tutma ? 1 : 0;
		}
		for (let k = 0; k < CERCEVE; k++) {
			if (this.kapi < hedef) this.kapi = Math.min(hedef, this.kapi + this.acilisAdim);
			else if (this.kapi > hedef) this.kapi = Math.max(hedef, this.kapi - this.kapanisAdim);
			this.kuyruk[this.yaz] = y[k] * this.kapi;
			this.yaz = (this.yaz + 1) % this.kuyruk.length;
		}
		this.sayac += CERCEVE;
		const t = this.top;
		t.n++;
		t.konusma += konusma;
		t.giris += ge / CERCEVE;
		t.rnn += re / CERCEVE;
		t.cikis += ce / CERCEVE;
		if (t.n >= 10) {
			const db = (v) => Math.round(10 * Math.log10(v / t.n + 1e-12) * 10) / 10;
			this.port.postMessage({ tur: 'olcum', konusma: Math.round((t.konusma / t.n) * 100) / 100, girisDb: db(t.giris), rnnDb: db(t.rnn), cikisDb: db(t.cikis), acik: hedef === 1 });
			this.top = { n: 0, konusma: 0, giris: 0, rnn: 0, cikis: 0 };
		}
	}

	process(girisler, cikislar) {
		if (this.bitti) return false;
		const giris = girisler[0];
		const cikis = cikislar[0];
		const n = (cikis && cikis[0] && cikis[0].length) || 128;
		for (let i = 0; i < n; i++) {
			let x = 0;
			if (giris && giris.length) {
				for (let k = 0; k < giris.length; k++) x += giris[k][i];
				x /= giris.length;
			}
			this.bekleyen[this.bDolu++] = x;
			if (this.bDolu === CERCEVE) {
				this.cerceve();
				this.bDolu = 0;
			}
		}
		for (let i = 0; i < n; i++) {
			const v = this.kuyruk[this.oku];
			this.oku = (this.oku + 1) % this.kuyruk.length;
			if (cikis) for (let k = 0; k < cikis.length; k++) cikis[k][i] = v;
		}
		return true;
	}
}

registerProcessor('gurultu', Gurultu);
