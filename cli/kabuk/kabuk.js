// Kabuk: web/ klasöründeki istemciyi (index.html + ana.js) değiştirmeden çalıştıran ortam.
//
// Diszort'un istemcisi bir web sayfasıdır. Burada o sayfa, pencere çizmeyen küçük bir "tarayıcı"nın
// içinde çalışır: belge jsdom'da durur, sayfanın tarayıcıdan istediği her şeyin gerçek bir karşılığı
// vardır (taklit değil):
//   WebSocket, fetch            → ağ (sayfanın kendi dosyaları programın içinden gelir)
//   RTCPeerConnection, izler    → libwebrtc (rtc.js)
//   mikrofon, hoparlör          → PulseAudio / PipeWire (ses/)
//   AudioContext, AudioWorklet  → ses motoru (ses/webaudio.js); RNNoise ve yankı çıkarma sayfanın kendi dosyaları
//   <audio> öğeleri             → ses motoru üzerinden hoparlöre
//   localStorage                → programın yanındaki ayar dosyası
//   File, Blob, "Farklı kaydet" → disk (dosya.js)
//   Worker                      → iş parçacığı (isci.js)
// Arayüzü terminale çizen ve tuşları sayfaya ileten katman ayrıdır (arayuz/): o da yalnızca belgeye
// bakar. Web tarafına eklenen bir özellik bu yüzden burada da kendiliğinden vardır; yeni bir tarayıcı
// özelliği kullanılırsa onun karşılığı buraya eklenir (test/cli.js bunu yakalar).
'use strict';

const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { JSDOM, VirtualConsole } = require('jsdom');
const jsdomIc = require('jsdom/lib/generated/idl/utils.js'); // DOM nesnesi → jsdom'un iç nesnesi
const { PulseBaglantisi } = require('./ses/pulse');
const { SesMotoru } = require('./ses/motor');
const { webAudioKur } = require('./ses/webaudio');
const { MedyaAygitlari } = require('./ses/aygitlar');
const { wrtc, pencereAdlari } = require('./rtc');
const { isciSinifi } = require('./isci');
const dosya = require('./dosya');

const hataYap = (ad, metin) => Object.assign(new Error(metin), { name: ad });

class Kabuk extends EventEmitter {
	// sunucu: "https://chat.ornek.com" (giriş bağlantısı da olur: …/#anahtar=…); depo: localStorage'ın
	// başlangıç içeriği (ayar dosyasından); varliklar: { oku(ad) } (varlik.js); surum: bu programın sürümü.
	constructor({ sunucu, depo = {}, varliklar, surum = 'yerel', gunluk = () => {}, genislik = 1280 }) {
		super();
		const adres = new URL(sunucu);
		if (adres.protocol !== 'https:' && adres.protocol !== 'http:') throw new Error('Sunucu adresi http(s) olmalı: ' + sunucu);
		this.sunucu = adres.origin;
		this.karma = adres.hash; // giriş bağlantısındaki #anahtar=… (ilk açılışta sayfaya verilir)
		this.depo = { ...depo };
		this.oturumDeposu = {}; // sessionStorage: sayfa yenilenince kalır
		this.varliklar = varliklar;
		this.surum = surum;
		this.gunluk = gunluk;
		this.genislik = genislik;
		this.pulseSozu = null;
		this.motor = new SesMotoru({ wrtc, pulse: () => this.pulse(), gunluk });
		this.window = null;
		this.dom = null;
		this.sayfa = null; // açık sayfanın kaynakları: { baglantilar, baglamlar, isciler, ogeler, izler, aygitlar }
		this.geciciKlasor = null;
		this.kapandi = false;
		// Arayüzün dolduracağı kancalar (varsayılanlar: sormadan).
		this.dosyaSec = async () => []; // ({ coklu }) → yol listesi
		this.kayitYeriSor = async (ad) => dosya.bosYol(dosya.indirmeKlasoru(), ad); // (önerilen ad) → yol ya da null (vazgeçildi)
	}

	// Ortak ses sunucusu bağlantısı (gerekince kurulur; koparsa bir sonraki istekte yeniden).
	pulse() {
		if (!this.pulseSozu) {
			const soz = PulseBaglantisi.baglan({ ad: 'Diszort' }).then(
				(p) => {
					p.on('kapandi', () => {
						if (this.pulseSozu === soz) this.pulseSozu = null;
					});
					p.on('hata', (h) => this.gunluk('ses sunucusu', h));
					return p;
				},
				(h) => {
					if (this.pulseSozu === soz) this.pulseSozu = null;
					throw h;
				},
			);
			this.pulseSozu = soz;
		}
		return this.pulseSozu;
	}

	get document() {
		return this.window ? this.window.document : null;
	}

	bildir(metin, hata = false) {
		this.emit('bildirim', { metin, hata });
	}

	// ------------------------------------------------------------ sayfa

	async baslat() {
		this.html = (await this.varliklar.oku('index.html')).toString('utf8');
		this.betik = (await this.varliklar.oku('ana.js')).toString('utf8');
		this.pencereKur();
	}

	// Sayfanın kendi dosyası (worklet modülü, işçi, wasm): adres sayfaya göre çözülür.
	async kaynakOku(adres) {
		const u = new URL(adres, this.window.location.href);
		if (u.origin !== this.sunucu) throw hataYap('SecurityError', 'Yalnızca sayfanın kendi dosyaları yüklenir: ' + adres);
		return this.varliklar.oku(u.pathname.slice(1));
	}

	pencereKur() {
		const sanal = new VirtualConsole();
		sanal.on('jsdomError', (h) => this.gunluk('sayfa', h));
		for (const tur of ['error', 'warn', 'info', 'log', 'debug']) sanal.on(tur, (...a) => this.gunluk('konsol.' + tur, ...a));
		const dom = new JSDOM(this.html, {
			url: this.sunucu + '/' + this.karma,
			pretendToBeVisual: true,
			runScripts: 'outside-only',
			userAgent: `Mozilla/5.0 (X11; Linux ${os.arch()}) Diszort-CLI/${this.surum} libwebrtc/M106 Node/${process.versions.node}`,
			virtualConsole: sanal,
		});
		const window = dom.window;
		this.dom = dom;
		this.window = window;
		const sayfa = { baglantilar: new Set(), baglamlar: new Set(), isciler: new Set(), ogeler: new Set(), izler: new Set(), aygitlar: null };
		this.sayfa = sayfa;
		window.innerWidth = this.genislik;

		this.depoKur(window);
		this.agKur(window);
		this.sesKur(window, sayfa);
		this.rtcKur(window, sayfa);
		this.dosyaKur(window);
		this.gezinmeKur(window);
		window.matchMedia = (sorgu) => ({ matches: this.medyaSorgusu(sorgu), media: String(sorgu), onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
		window.structuredClone = structuredClone;

		new vm.Script(this.betik, { filename: 'web/ana.js' }).runInContext(dom.getInternalVMContext());
		this.emit('pencere', window);
	}

	// Ekran genişliği sorguları: arayüz terminalin enine göre "geniş / dar" kipini bildirir.
	medyaSorgusu(sorgu) {
		const s = String(sorgu);
		let m = /\(\s*max-width:\s*(\d+)px\s*\)/.exec(s);
		if (m) return this.genislik <= Number(m[1]);
		m = /\(\s*min-width:\s*(\d+)px\s*\)/.exec(s);
		if (m) return this.genislik >= Number(m[1]);
		return false; // (pointer: coarse) vb.: dokunmatik değil
	}
	genislikAyarla(px) {
		if (px === this.genislik) return;
		this.genislik = px;
		if (!this.window) return;
		this.window.innerWidth = px;
		this.window.dispatchEvent(new this.window.Event('resize'));
	}

	// localStorage ↔ ayar dosyası, sessionStorage ↔ bellek (yenilemede kalır).
	depoKur(window) {
		for (const [k, v] of Object.entries(this.depo)) window.localStorage.setItem(k, String(v));
		for (const [k, v] of Object.entries(this.oturumDeposu)) window.sessionStorage.setItem(k, String(v));
		const oku = (d) => {
			const o = {};
			for (let i = 0; i < d.length; i++) o[d.key(i)] = d.getItem(d.key(i));
			return o;
		};
		const kabuk = this;
		const S = window.Storage.prototype;
		for (const ad of ['setItem', 'removeItem', 'clear']) {
			const eski = S[ad];
			S[ad] = function (...a) {
				const sonuc = eski.apply(this, a);
				if (kabuk.window !== window) return sonuc;
				if (this === window.localStorage) {
					kabuk.depo = oku(this);
					kabuk.emit('depo', kabuk.depo);
				} else kabuk.oturumDeposu = oku(this);
				return sonuc;
			};
		}
	}

	agKur(window) {
		// Sayfanın kendi dosyaları (rnnoise.wasm) programdaki kopyadan; gerisi ağdan.
		window.fetch = async (girdi, secenek) => {
			const adres = new URL(typeof girdi === 'string' ? girdi : (girdi && girdi.url) || String(girdi), window.location.href);
			const yontem = ((secenek && secenek.method) || 'GET').toUpperCase();
			if (adres.origin === this.sunucu && yontem === 'GET') {
				try {
					const govde = await this.varliklar.oku(adres.pathname.slice(1));
					return new Response(govde, { status: 200 });
				} catch (h) {
					if (!h || (h.name !== 'NotFoundError' && h.code !== 'ENOENT' && h.code !== 'ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND')) throw h;
				}
			}
			return fetch(adres, secenek);
		};
	}

	sesKur(window, sayfa) {
		const motor = this.motor;
		const ses = webAudioKur({ motor, kaynakOku: async (adres) => (await this.kaynakOku(adres)).toString('utf8') });
		class AudioContext extends ses.AudioContext {
			constructor() {
				super();
				sayfa.baglamlar.add(this);
			}
			close() {
				sayfa.baglamlar.delete(this);
				return super.close();
			}
		}
		Object.assign(window, ses, { AudioContext });

		sayfa.aygitlar = new MedyaAygitlari({ motor, pulse: () => this.pulse(), gunluk: this.gunluk });
		sayfa.aygitlar.bildir = (m) => this.bildir(m);
		const ham = sayfa.aygitlar.getUserMedia.bind(sayfa.aygitlar);
		sayfa.aygitlar.getUserMedia = async (kisit) => {
			const akis = await ham(kisit);
			for (const iz of akis.getTracks()) sayfa.izler.add(iz);
			return akis;
		};
		Object.defineProperty(window.navigator, 'mediaDevices', { value: sayfa.aygitlar, configurable: true });

		// <audio> / <video>: srcObject'teki ses izi, öğe çalarken, seviyesi ve susturmasıyla hoparlöre gider.
		const durumlar = new WeakMap();
		const durum = (oge) => {
			let d = durumlar.get(oge);
			if (!d) durumlar.set(oge, (d = { akis: null, durakladi: true, sessiz: false, seviye: 1, cikis: '', calici: null }));
			return d;
		};
		const olay = (oge, ad) => queueMicrotask(() => oge.dispatchEvent(new window.Event(ad)));
		const guncelle = (oge) => {
			const d = durum(oge);
			const iz = d.akis && typeof d.akis.getAudioTracks === 'function' ? d.akis.getAudioTracks()[0] : null;
			if (iz && !d.durakladi) {
				if (!d.calici) {
					d.calici = { iz: null, sessiz: false, seviye: 1, cikis: '' };
					motor.calicilar.add(d.calici);
					sayfa.ogeler.add(d.calici);
				}
				Object.assign(d.calici, { iz: motor.izKaydi(iz), sessiz: d.sessiz, seviye: d.seviye, cikis: d.cikis });
			} else if (d.calici) {
				motor.calicilar.delete(d.calici);
				sayfa.ogeler.delete(d.calici);
				d.calici = null;
			}
			motor.etkinlikDegisti();
		};
		const tanimla = (ad, ozellik) => Object.defineProperty(window.HTMLMediaElement.prototype, ad, { configurable: true, ...ozellik });
		tanimla('srcObject', {
			get() {
				return durum(this).akis;
			},
			set(akis) {
				const d = durum(this);
				const vardi = !!d.akis;
				d.akis = akis || null;
				if (d.akis) {
					// Yeni akış: autoplay öğe kendiliğinden çalar.
					if (this.autoplay) d.durakladi = false;
					guncelle(this);
					if (!d.durakladi) olay(this, 'playing');
				} else {
					guncelle(this);
					if (vardi) olay(this, 'emptied');
				}
			},
		});
		tanimla('paused', {
			get() {
				return durum(this).durakladi;
			},
		});
		tanimla('muted', {
			get() {
				return durum(this).sessiz;
			},
			set(v) {
				const d = durum(this);
				if (d.sessiz === !!v) return;
				d.sessiz = !!v;
				guncelle(this);
				olay(this, 'volumechange');
			},
		});
		tanimla('volume', {
			get() {
				return durum(this).seviye;
			},
			set(v) {
				v = Number(v);
				if (!(v >= 0 && v <= 1)) throw hataYap('IndexSizeError', 'volume 0 ile 1 arasında olmalı');
				const d = durum(this);
				if (d.seviye === v) return;
				d.seviye = v;
				guncelle(this);
				olay(this, 'volumechange');
			},
		});
		tanimla('sinkId', {
			get() {
				return durum(this).cikis;
			},
		});
		tanimla('setSinkId', {
			writable: true,
			value(ad) {
				durum(this).cikis = typeof ad === 'string' ? ad : '';
				guncelle(this);
				return Promise.resolve();
			},
		});
		tanimla('play', {
			writable: true,
			value() {
				const d = durum(this);
				// Dosyadan çalma (src) yok: yalnızca canlı akışlar. Sohbetteki ses/video dosyaları dışarıda açılır.
				if (!d.akis) return Promise.reject(hataYap('NotSupportedError', 'Bu ortamda yalnızca canlı akışlar çalınır'));
				if (d.durakladi) {
					d.durakladi = false;
					guncelle(this);
					olay(this, 'play');
					olay(this, 'playing');
				}
				return Promise.resolve();
			},
		});
		tanimla('pause', {
			writable: true,
			value() {
				const d = durum(this);
				if (d.durakladi) return;
				d.durakladi = true;
				guncelle(this);
				olay(this, 'pause');
			},
		});
		tanimla('load', {
			writable: true,
			value() {
				const d = durum(this);
				d.durakladi = !this.autoplay || !d.akis;
				guncelle(this);
			},
		});
		// Arayüz, bir öğenin o an gerçekten ses verip vermediğini sorabilir.
		this.ogeDurumu = (oge) => durum(oge);
	}

	rtcKur(window, sayfa) {
		class RTCPeerConnection extends pencereAdlari.RTCPeerConnection {
			constructor(ayar) {
				super(ayar);
				sayfa.baglantilar.add(this);
			}
			close() {
				sayfa.baglantilar.delete(this);
				super.close();
			}
		}
		Object.assign(window, pencereAdlari, { RTCPeerConnection });
		window.Worker = isciSinifi(async (adres) => (await this.kaynakOku(adres)).toString('utf8'), sayfa.isciler);
	}

	dosyaKur(window) {
		const kabuk = this;
		// Blob ve File: Node'unkiler (arrayBuffer, slice, stream tam); blob adresleri burada tutulur.
		window.Blob = Blob;
		window.File = File;
		const adresler = new dosya.BlobAdresleri(this.sunucu);
		this.blobAdresleri = adresler;
		window.URL.createObjectURL = (nesne) => adresler.olustur(nesne);
		window.URL.revokeObjectURL = (adres) => adresler.sil(adres);

		// Dosya seçme: <input type=file>.click() → arayüz yol sorar → 'change'.
		const tikla = window.HTMLInputElement.prototype.click;
		window.HTMLInputElement.prototype.click = function () {
			if (this.type !== 'file') return tikla.call(this);
			const girdi = this;
			Promise.resolve()
				.then(() => kabuk.dosyaSec({ coklu: !!girdi.multiple }))
				.then((yollar) => {
					const liste = kabuk.dosyalar(yollar);
					if (!liste.length || kabuk.window !== window) return;
					Object.defineProperty(girdi, 'files', { configurable: true, value: Object.assign(liste, { item: (i) => liste[i] || null }) });
					girdi.dispatchEvent(new window.Event('change', { bubbles: true }));
				})
				.catch((h) => kabuk.bildir('Dosya seçilemedi: ' + ((h && h.message) || h), true));
		};

		// "Farklı kaydet": büyük dosyalar doğrudan seçilen yere yazılır.
		window.showSaveFilePicker = async (secenek = {}) => {
			const yol = await kabuk.kayitYeriSor(secenek.suggestedName || 'dosya');
			if (!yol) throw hataYap('AbortError', 'Kaydetmekten vazgeçildi');
			kabuk.bildir('Kaydediliyor: ' + yol);
			return dosya.kayitTutamaci(yol);
		};

		// Bağlantılar: indirme bağlantısı (<a download>) diske kaydeder, diğerleri dışarıda açılır.
		window.addEventListener('click', (e) => {
			if (e.defaultPrevented) return;
			const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
			if (!a) return;
			e.preventDefault();
			kabuk.baglantiAc(a.href, a.hasAttribute('download') ? a.download || 'dosya' : null);
		});
	}

	// Yollardan dosya nesneleri (okunamayanlar bildirilir, atlanır).
	dosyalar(yollar) {
		const liste = [];
		for (const y of yollar || []) {
			try {
				liste.push(new dosya.DiskDosyasi(dosya.yolAc(y)));
			} catch (h) {
				this.bildir(`${y}: ${h.code === 'ENOENT' ? 'dosya bulunamadı' : (h && h.message) || h}`, true);
			}
		}
		return liste;
	}

	// Dosyaları sayfaya bırak (terminale sürüklenen ya da yapıştırılan yollar): tarayıcıdaki
	// yapıştırma / sürükle-bırak olaylarının aynısı.
	dosyalariBirak(yollar) {
		const window = this.window;
		const liste = this.dosyalar(yollar);
		if (!liste.length) return false;
		const veri = { files: liste, types: ['Files'], items: [], getData: () => '' };
		const odak = window.document.activeElement;
		if (odak && odak !== window.document.body) {
			const e = Object.assign(new window.Event('paste', { bubbles: true, cancelable: true }), { clipboardData: veri });
			odak.dispatchEvent(e);
			if (e.defaultPrevented) return true;
		}
		const hedef = window.document.querySelector('main') || window.document.body;
		const e = Object.assign(new window.Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: veri });
		hedef.dispatchEvent(e);
		return e.defaultPrevented;
	}

	// Bir adresi aç: blob adresiyse kaydet (indirme) ya da geçici dosyaya yazıp aç; web adresiyse tarayıcıda.
	async baglantiAc(adres, indirmeAdi = null) {
		try {
			const nesne = this.blobAdresleri.bul(adres);
			if (indirmeAdi !== null) {
				if (!nesne) return this.bildir('İndirilecek dosya artık yok.', true);
				const yol = dosya.bosYol(dosya.indirmeKlasoru(), indirmeAdi);
				await dosya.diskeYaz(nesne, yol);
				return this.bildir('Kaydedildi: ' + yol);
			}
			if (nesne instanceof dosya.DiskDosyasi) return this.disariAc(nesne.yol);
			if (nesne) {
				if (!this.geciciKlasor) this.geciciKlasor = fs.mkdtempSync(path.join(os.tmpdir(), 'diszort-'));
				const yol = dosya.bosYol(this.geciciKlasor, nesne.name || 'dosya');
				await dosya.diskeYaz(nesne, yol);
				return this.disariAc(yol);
			}
			if (/^https?:\/\//i.test(adres)) return this.disariAc(adres);
			this.bildir('Açılamadı: ' + adres, true);
		} catch (h) {
			this.bildir('Açılamadı: ' + ((h && h.message) || h), true);
		}
	}

	// Sistemin varsayılan uygulamasıyla aç (xdg-open).
	disariAc(hedef) {
		try {
			const c = spawn('xdg-open', [hedef], { stdio: 'ignore', detached: true });
			c.on('error', () => this.bildir('Açılamadı (xdg-open yok): ' + hedef, true));
			c.unref();
		} catch {
			this.bildir('Açılamadı: ' + hedef, true);
		}
	}

	gezinmeKur(window) {
		// location.reload(): sayfa baştan kurulur (sunucu güncellenince sayfa kendini yeniler). jsdom
		// başka bir belgeye gitmeyi yapmaz; yenileme isteği burada karşılanır.
		const ic = jsdomIc.implForWrapper(window.location);
		if (ic) ic.reload = () => setImmediate(() => this.yenile());
	}

	// Sayfayı kapat: sayfaya haber ver (sesli kanaldan çıkar, bağlantıları kapatır), kalan kaynakları bırak.
	pencereKapat() {
		const window = this.window;
		const sayfa = this.sayfa;
		if (!window) return;
		try {
			window.dispatchEvent(new window.Event('pagehide'));
		} catch (h) {
			this.gunluk('pagehide', h);
		}
		this.window = null;
		this.sayfa = null;
		for (const b of sayfa.baglantilar) {
			try {
				b.close();
			} catch {}
		}
		for (const b of sayfa.baglamlar) b.close().catch(() => {});
		for (const i of sayfa.isciler) i.terminate();
		for (const c of sayfa.ogeler) this.motor.calicilar.delete(c);
		for (const iz of sayfa.izler) {
			try {
				iz.stop();
			} catch {}
		}
		clearTimeout(sayfa.aygitlar.degisimZamani);
		this.motor.etkinlikDegisti();
		// WebSocket'in kapanış iletisi gitsin diye pencere biraz sonra kapatılır.
		setTimeout(() => {
			try {
				window.close();
			} catch {}
		}, 300).unref();
	}

	// Sayfayı yenile (aynı adres ve depolar).
	yenile() {
		if (this.kapandi || !this.window) return;
		this.karma = this.window.location.hash;
		this.pencereKapat();
		this.pencereKur();
	}

	// Kapatmadan önce: süren dosya aktarımı varsa sayfa kapanışı engeller (beforeunload). true: kapatılabilir.
	kapatilabilir() {
		const window = this.window;
		if (!window) return true;
		const e = new window.Event('beforeunload', { cancelable: true });
		window.dispatchEvent(e);
		return !e.defaultPrevented;
	}

	async kapat() {
		if (this.kapandi) return;
		this.kapandi = true;
		this.pencereKapat();
		// Sunucuya giden son iletiler (sesli kanaldan çıkış) için kısa bir süre.
		await new Promise((r) => setTimeout(r, 250));
		this.motor.kapat();
		if (this.pulseSozu) {
			const soz = this.pulseSozu;
			this.pulseSozu = null;
			soz.then((p) => p.kapat()).catch(() => {});
		}
		if (this.geciciKlasor) fs.rmSync(this.geciciKlasor, { recursive: true, force: true });
	}
}

module.exports = { Kabuk };
