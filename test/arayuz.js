// Tarayıcısız arayüz denemesi: gerçek index.html + ana.js, jsdom içinde.
// WebSocket/getUserMedia/getDisplayMedia/RTCPeerConnection (veri kanalı dahil)/AudioContext taklit
// edilir. Giriş (kapıyı çalma + anahtar), kanal seçimi, mesaj çizimi (gruplama, bahsetme,
// bağlantılar), kanal ekleme/silme, giriş istekleri (kayıtlı ad uyarısı), atma, kişi limiti, P2P dosya
// (paylaşma, kartlar, indirme ve gönderme protokolü), sesli kanal (mikrofon kısıtları, teklif/yanıt +
// oturum kimliği, mikrofon/yayın sesi/görüntü kanalları, m-line başına Opus ayarı, seviye,
// susturma/sağırlaştırma), yayın (ekranlı ve ekransız paylaşım, ekranı göster/gizle, izle/kapat,
// paylaşımın sesi: susturma/seviye; paylaşamayan tarayıcı; ekran paylaşımı ses vermeyen Firefox/Safari'de
// sesin ses aygıtından, "Monitor of …", alınması), bağlantı kalitesi (kısa kayıp
// ani uyarı vermez, gerçek bozulma verir), kayıplara karşı yedek (RED önde; çözülemeyen RED'in o eşte
// bırakılması), sunucu bağlantısı koparken ses bağlantılarının korunması,
// giriş freninde uygulamada kalma, sunucu penceresi (veritabanı, sohbeti temizle), oturum devri ve
// atılma doğrulanır. Gerçek WebRTC için: test/tarayici.js.
//
//   npm install --no-save jsdom && node test/arayuz.js      (jsdom yoksa deneme atlanır)
'use strict';

const fs = require('node:fs');
const path = require('node:path');

let JSDOM;
try {
	({ JSDOM } = require('jsdom'));
} catch {
	console.log('jsdom kurulu değil; arayüz denemesi atlandı (npm install --no-save jsdom).');
	process.exit(0);
}

const KOK = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(KOK, 'web/index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
const BETIK = fs.readFileSync(path.join(KOK, 'web/ana.js'), 'utf8');
const bekle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let gecen = 0;
const denetle = (ad, kosul, ek = '') => {
	if (kosul) {
		gecen++;
		console.log('ok   ' + ad);
	} else {
		process.exitCode = 1;
		console.error('HATA ' + ad + (ek ? ' — ' + ek : ''));
	}
};

const OPUS_TEKLIF = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n';
// Yeni sürümün teklifi: mikrofon + yayın sesi + görüntü.
const UC_KANALLI =
	'v=0\r\n' +
	'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n' +
	'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:1\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n' +
	'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:2\r\na=rtpmap:96 VP8/90000\r\n';

// Sayfayı kur: DOM + taklitler + ana.js. Birden çok kez çağrılabilir (hash/depo senaryoları).
// ekranYok: tarayıcı ekran paylaşımı sunmuyor (ör. telefon). red: tarayıcı RED'i (RFC 2198) biliyor
// (RTCRtpReceiver.getCapabilities onu da listeler; yoksa RTCRtpReceiver hiç yok). dokunmatik:
// telefon gibi (pointer: coarse). android: tarayıcı kimliği Android'deki Chrome. firefox: masaüstü
// Firefox (Linux).
function kur({ url = 'https://chat.deneme/', depo = {}, oturumDepo = {}, ekranYok = false, red = false, dokunmatik = false, android = false, firefox = false } = {}) {
	const dom = new JSDOM(HTML, { url, pretendToBeVisual: true, runScripts: 'dangerously' });
	const { window } = dom;
	if (dokunmatik) window.matchMedia = (q) => ({ matches: /pointer:\s*coarse/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
	if (firefox) Object.defineProperty(window.navigator, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0' });
	if (android) {
		Object.defineProperty(window.navigator, 'userAgent', {
			configurable: true,
			get: () => 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
		});
	}
	for (const [k, v] of Object.entries(depo)) window.localStorage.setItem(k, v);
	for (const [k, v] of Object.entries(oturumDepo)) window.sessionStorage.setItem(k, v);
	const durum = { gonderilen: [], ws: null, wsler: [], mikrofon: 0, micKisit: null };

	class FakeWS {
		static OPEN = 1;
		constructor(hedef) {
			this.url = hedef;
			this.readyState = 1;
			durum.ws = this;
			durum.wsler.push(this);
			setTimeout(() => this.onopen && this.onopen(), 0);
		}
		send(metin) {
			durum.gonderilen.push(JSON.parse(metin));
		}
		close() {
			this.readyState = 3;
			if (this.onclose) this.onclose();
		}
	}
	window.WebSocket = FakeWS;
	window.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
	// jsdom'da blob adresi yok: sahte adres; indirme bağlantısına tıklama kaydedilir.
	let urlSayac = 0;
	window.URL.createObjectURL = () => 'blob:sahte/' + ++urlSayac;
	window.URL.revokeObjectURL = () => {};
	durum.indirilen = [];
	window.HTMLAnchorElement.prototype.click = function () {
		durum.indirilen.push({ ad: this.download, href: this.href });
	};
	const izYap = (kind = 'audio') => {
		const iz = {
			id: 'iz-' + Math.random().toString(36).slice(2),
			enabled: true,
			kind,
			readyState: 'live',
			muted: false,
			dinleyiciler: {},
			stop() {
				this.readyState = 'ended';
			},
			applyConstraints(k) {
				this.kisit = k;
				return Promise.resolve();
			},
			addEventListener(ad, fn) {
				(this.dinleyiciler[ad] = this.dinleyiciler[ad] || []).push(fn);
			},
			bitir() {
				this.readyState = 'ended';
				for (const fn of this.dinleyiciler.ended || []) fn();
			},
			getSettings: () => ({ echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1, sampleRate: 48000 }),
		};
		return iz;
	};
	durum.izYap = izYap;
	const akisYap = (izler) => ({
		getTracks: () => izler,
		getAudioTracks: () => izler.filter((i) => i.kind === 'audio'),
		getVideoTracks: () => izler.filter((i) => i.kind === 'video'),
	});
	durum.ekranSesiVer = true;
	// Firefox/Safari taklidi: ekran paylaşımı ses vermez, ekran sesi kısıtlarını tanımaz.
	durum.ekranSesiYok = false;
	// Ses aygıtları (enumerateDevices). etiketGizli: izin verilmeden adlar boş gelir.
	durum.aygitlar = [];
	durum.etiketGizli = false;
	durum.izinIstegi = 0;
	// Paylaşım için ses aygıtından alınan ses (mikrofon sayılmaz): son kısıt, iz, hata adı.
	durum.aygitKisit = null;
	durum.aygitIzi = null;
	durum.aygitHata = '';
	// getUserMedia sırası: mikrofon mu aygıt mı; açılırken (önceki) mikrofon açık mıydı.
	durum.gumSirasi = [];
	// Aygıt değişikliği (devicechange) dinleyicileri; durum.aygitDegisti() tetikler.
	durum.aygitDinleyicileri = {};
	durum.aygitDegisti = () => (durum.aygitDinleyicileri.devicechange || []).forEach((fn) => fn(new window.Event('devicechange')));
	Object.defineProperty(window.navigator, 'mediaDevices', {
		value: {
			getUserMedia: async (kisitlar) => {
				const ses = kisitlar && kisitlar.audio;
				// Yalnızca izin (aygıt adları görünsün diye): mikrofon sayılmaz.
				if (ses === true) {
					durum.izinIstegi++;
					durum.etiketGizli = false;
					return akisYap([izYap()]);
				}
				const id = ses && ses.deviceId && ses.deviceId.exact;
				if (id && id !== 'mik-1') {
					durum.gumSirasi.push({ tur: 'aygit', mikAcik: !!(durum.sonIz && durum.sonIz.readyState === 'live') });
					if (durum.aygitHata) throw Object.assign(new Error('aygıt'), { name: durum.aygitHata });
					durum.aygitKisit = { ...ses };
					const iz = izYap();
					durum.aygitIzi = iz;
					return akisYap([iz]);
				}
				durum.mikrofon++;
				durum.gumSirasi.push({ tur: 'mik', oncekiAcik: !!(durum.sonIz && durum.sonIz.readyState === 'live') });
				durum.micKisit = ses ? { ...ses } : null;
				const iz = izYap();
				const ayarlar = iz.getSettings();
				iz.getSettings = () => ({ ...ayarlar, deviceId: 'mik-1' });
				durum.sonIz = iz;
				return akisYap([iz]);
			},
			// Masaüstü ekran paylaşımı: görüntü + (seçildiyse) bilgisayar sesi. ekranReddet: seçim
			// penceresi açılmadan reddeden tarayıcı.
			getDisplayMedia: ekranYok
				? undefined
				: async (secenek) => {
						durum.ekranSayisi = (durum.ekranSayisi || 0) + 1;
						if (durum.ekranReddet) throw Object.assign(new Error('izin yok'), { name: 'NotAllowedError' });
						durum.ekranSecenek = secenek;
						const izler = [izYap('video')];
						if (durum.ekranSesiVer) izler.push(izYap('audio'));
						durum.ekranIzleri = izler;
						return akisYap(izler);
					},
			getSupportedConstraints: () => (durum.ekranSesiYok ? { echoCancellation: true, deviceId: true } : { restrictOwnAudio: true, suppressLocalAudioPlayback: true }),
			enumerateDevices: async () => durum.aygitlar.map((a) => (durum.etiketGizli ? { ...a, label: '' } : { ...a })),
			addEventListener(tur, fn) {
				(durum.aygitDinleyicileri[tur] = durum.aygitDinleyicileri[tur] || []).push(fn);
			},
			ondevicechange: null,
		},
		configurable: true,
	});
	window.MediaStream = class {
		constructor(izler) {
			this.izler = izler || [];
		}
		getAudioTracks() {
			return this.izler.filter((i) => i.kind !== 'video');
		}
		getVideoTracks() {
			return this.izler.filter((i) => i.kind === 'video');
		}
		getTracks() {
			return this.izler;
		}
	};
	window.HTMLMediaElement.prototype.play = function () {
		const once = this._caliyor;
		this._caliyor = true;
		if (!once) this.dispatchEvent(new window.Event('playing'));
		return Promise.resolve();
	};
	window.HTMLMediaElement.prototype.pause = function () {
		const once = this._caliyor;
		this._caliyor = false;
		if (once) this.dispatchEvent(new window.Event('pause'));
	};
	window.HTMLMediaElement.prototype.load = function () {};
	// Ekranı açık tutma (Screen Wake Lock): alınan kilitler (bırakılınca released).
	const durumEk = { ekranKilitleri: [], medyaIsleyicileri: {} };
	Object.defineProperty(window.navigator, 'wakeLock', {
		configurable: true,
		value: {
			async request(tur) {
				const kilit = {
					type: tur,
					released: false,
					dinleyiciler: [],
					addEventListener(olay, fn) {
						if (olay === 'release') this.dinleyiciler.push(fn);
					},
					async release() {
						if (this.released) return;
						this.released = true;
						for (const fn of this.dinleyiciler) fn();
					},
				};
				durumEk.ekranKilitleri.push(kilit);
				return kilit;
			},
		},
	});
	// Medya oturumu (bildirimdeki oynatıcı).
	Object.defineProperty(window.navigator, 'mediaSession', {
		configurable: true,
		value: {
			metadata: null,
			playbackState: 'none',
			setActionHandler(eylem, fn) {
				durumEk.medyaIsleyicileri[eylem] = fn;
			},
		},
	});
	window.MediaMetadata = class {
		constructor(o) {
			Object.assign(this, o);
		}
	};
	Object.defineProperty(window.HTMLMediaElement.prototype, 'paused', {
		get() {
			return !this._caliyor;
		},
		configurable: true,
	});

	class FakePC {
		constructor(ayar) {
			FakePC.hepsi.push(this);
			this.ayar = ayar;
			this.signalingState = 'stable';
			this.connectionState = 'new';
			this.iceConnectionState = 'new';
			this.remoteDescription = null;
			this.localDescription = null;
			this._transceivers = [];
			this.kanallar = [];
			// İstatistik sayaçları: her getStats'ta geçen süre kadar artar (kayıp/gizleme oranı ayarlanabilir).
			this.sayac = { zaman: Date.now(), alinan: 0, kayip: 3, ornek: 0, gizli: 0, bayt: 0, giden: 0 };
			this.kayipHizi = null; // saniyede kayıp paket (null: FakePC.kayipHizi)
			this.gizlemeOrani = null; // uydurulan ses oranı (null: FakePC.gizlemeOrani)
		}
		_tr(track, yon, mid, tur = 'audio') {
			const tr = {
				mid: mid ?? null,
				direction: yon,
				currentDirection: null,
				// setCodecPreferences ile verilen sıra; anlaşılan: yanıttan sonra (taklit: karşı taraf
				// bizim sıramızı kabul eder) gönderilen/alınan kodekler.
				kodekler: null,
				anlasilan: [],
				setCodecPreferences(k) {
					tr.kodekler = k;
				},
				receiver: { track: { kind: tur }, getParameters: () => ({ codecs: tr.anlasilan }) },
				sender: {
					track,
					async replaceTrack(t) {
						this.track = t;
					},
					getParameters: () => ({ encodings: [{}], codecs: tr.anlasilan }),
					async setParameters(p) {
						tr.parametreler = p;
					},
				},
			};
			this._transceivers.push(tr);
			return tr;
		}
		addTransceiver(track, ayar) {
			const tur = typeof track === 'string' ? track : (track && track.kind) || 'audio';
			const tr = this._tr(typeof track === 'string' ? null : track, (ayar && ayar.direction) || 'sendrecv', null, tur);
			if (!this._muzakere) {
				this._muzakere = true;
				setTimeout(() => this.onnegotiationneeded && this.onnegotiationneeded(), 0);
			}
			return tr;
		}
		// Veri kanalı (P2P dosya): deneme açar, mesaj gönderir, kapatır.
		createDataChannel(label, secenek) {
			const pc = this;
			const k = {
				label,
				secenek,
				readyState: 'connecting',
				bufferedAmount: 0,
				binaryType: 'blob',
				gonderilen: [],
				send(d) {
					if (this.readyState !== 'open') throw new Error('kanal açık değil');
					this.gonderilen.push(d);
				},
				close() {
					if (this.readyState === 'closed') return;
					this.readyState = 'closed';
					setTimeout(() => this.onclose && this.onclose(), 0);
				},
				ac() {
					this.readyState = 'open';
					if (this.onopen) this.onopen();
				},
				gelsin(d) {
					if (this.onmessage) this.onmessage({ data: d });
				},
			};
			pc.kanallar.push(k);
			return k;
		}
		getTransceivers() {
			return this._transceivers;
		}
		getSenders() {
			return this._transceivers.map((t) => t.sender);
		}
		getConfiguration() {
			return { ...this.ayar };
		}
		setConfiguration(a) {
			this.ayar = a;
		}
		async createOffer() {
			return { type: 'offer', sdp: OPUS_TEKLIF };
		}
		async createAnswer() {
			// Yanıt üretilirken kanalların kodek sırası (RED önde mi?).
			this.yanitKodekleri = this._transceivers.map((t) => (t.kodekler && t.kodekler[0] ? t.kodekler[0].mimeType : null));
			return { type: 'answer', sdp: OPUS_TEKLIF };
		}
		_anlas() {
			for (const t of this._transceivers) t.anlasilan = t.kodekler ? [...t.kodekler] : [];
		}
		async setLocalDescription(d) {
			this.localDescription = d;
			this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
			if (d.type === 'answer') this._anlas();
		}
		async setRemoteDescription(d) {
			this.remoteDescription = d;
			FakePC.uzaklar.push(d);
			if (d.type === 'answer') this._anlas();
			if (d.type === 'offer') {
				this.signalingState = 'have-remote-offer';
				// Tarayıcı gibi: teklifteki her m-line için transceiver oluşur, varsayılan yön recvonly.
				if (!this._transceivers.length) {
					const satirlar = String(d.sdp || '').split(/\r?\n/).filter((s) => s.startsWith('m='));
					satirlar.forEach((s, i) => this._tr(null, 'recvonly', String(i), s.startsWith('m=video') ? 'video' : 'audio'));
				}
			} else this.signalingState = 'stable';
		}
		async addIceCandidate() {}
		async getStats() {
			// Artan sayaçlar: kayıp/gizleme/bit hızı iki ölçüm arasındaki farktan hesaplanır.
			const s = this.sayac;
			const simdi = Date.now();
			const dt = (simdi - s.zaman) / 1000;
			s.zaman = simdi;
			const kayipHizi = this.kayipHizi ?? FakePC.kayipHizi;
			const gizleme = this.gizlemeOrani ?? FakePC.gizlemeOrani;
			s.alinan += Math.round(50 * dt);
			s.kayip += Math.round(kayipHizi * dt);
			if (!this.ornekDurdu) s.ornek += Math.round(48000 * dt); // ornekDurdu: ses geliyor ama çalınmıyor
			// Alıcı tamponu: çalınan her örnek 60 ms beklemiş, hedef 50 ms.
			const yayilan = this.ornekDurdu ? 0 : Math.round(48000 * dt);
			s.yayilan = (s.yayilan || 0) + yayilan;
			s.tampon = (s.tampon || 0) + yayilan * (this.tamponSn ?? 0.06);
			s.hedef = (s.hedef || 0) + yayilan * (this.hedefSn ?? 0.05);
			// Tamponu eritmek için atılan örnekler (birikme varken).
			s.hizlandirma = (s.hizlandirma || 0) + Math.round(yayilan * (this.hizlandirmaOrani ?? 0));
			s.gizli += Math.round(48000 * dt * gizleme);
			s.bayt += Math.round(12000 * dt);
			s.giden += Math.round(12000 * dt);
			const m = new Map();
			m.set('tr', { type: 'transport', selectedCandidatePairId: 'pair' });
			m.set('pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'yerel', remoteCandidateId: 'uzak', currentRoundTripTime: 0.031 });
			m.set('yerel', { id: 'yerel', type: 'local-candidate', candidateType: FakePC.adayTuru });
			m.set('uzak', { id: 'uzak', type: 'remote-candidate', candidateType: 'srflx' });
			m.set('gelen', {
				type: 'inbound-rtp',
				kind: 'audio',
				packetsReceived: s.alinan,
				packetsLost: s.kayip,
				bytesReceived: s.bayt,
				jitter: 0.011,
				totalSamplesReceived: s.ornek,
				concealedSamples: s.gizli,
				silentConcealedSamples: 0,
				jitterBufferEmittedCount: s.yayilan,
				jitterBufferDelay: s.tampon,
				jitterBufferTargetDelay: s.hedef,
				removedSamplesForAcceleration: s.hizlandirma,
				insertedSamplesForDeceleration: 0,
				concealmentEvents: 0,
			});
			m.set('giden', { type: 'outbound-rtp', kind: 'audio', bytesSent: s.giden });
			return m;
		}
		close() {
			this.signalingState = 'closed';
			this.kapandi = true;
		}
	}
	FakePC.hepsi = [];
	FakePC.uzaklar = [];
	FakePC.adayTuru = 'srflx'; // 'relay' → bağlantı TURN üzerinden görünür
	FakePC.kayipHizi = 0;
	FakePC.gizlemeOrani = 0;
	window.RTCPeerConnection = FakePC;
	if (red) {
		// Chrome'un sırası: Opus, RED, sonra ötekiler.
		window.RTCRtpReceiver = {
			getCapabilities: (tur) =>
				tur === 'audio'
					? { codecs: ['audio/opus', 'audio/red', 'audio/G722', 'audio/PCMU', 'audio/telephone-event'].map((mimeType) => ({ mimeType, clockRate: 48000 })) }
					: { codecs: [] },
		};
	}
	// Paylaşılan sesten kanaldakilerin sesini çıkaran düzenek (AudioWorklet + Worker) taklidi.
	// workletYok: tarayıcı AudioWorklet sunmuyor. hedefIzleri: çıkarıcının çıkışları (gönderilen iz).
	durum.workletYok = false;
	durum.workletModulu = null;
	durum.workletDugumleri = [];
	durum.isciler = [];
	durum.hedefIzleri = [];
	window.AudioWorkletNode = class {
		constructor(ac, ad, secenek) {
			this.ad = ad;
			this.secenek = secenek;
			this.baglar = [];
			this.giden = [];
			const dugum = this;
			this.port = {
				onmessage: null,
				postMessage(v) {
					dugum.giden.push(v);
				},
			};
			durum.workletDugumleri.push(this);
		}
		connect(h) {
			this.baglar.push(h);
		}
		disconnect() {
			this.koptu = true;
		}
	};
	window.Worker = class {
		constructor(adres) {
			this.adres = adres;
			this.gelen = [];
			durum.isciler.push(this);
		}
		postMessage(v) {
			this.gelen.push(v);
		}
		terminate() {
			this.bitti = true;
		}
	};
	window.AudioContext = class {
		constructor() {
			this.state = 'running';
			this.sampleRate = 48000;
			this.currentTime = 0;
			this.destination = { connect() {} };
			this.audioWorklet = {
				addModule: async (adres) => {
					if (durum.workletYok) throw new Error('AudioWorklet yok');
					durum.workletModulu = adres;
				},
			};
		}
		createMediaStreamDestination() {
			const iz = izYap();
			durum.hedefIzleri.push(iz);
			return { stream: akisYap([iz]), connect() {}, disconnect() {} };
		}
		createAnalyser() {
			return { fftSize: 1024, getFloatTimeDomainData(v) { v.fill(0.1); } };
		}
		createMediaStreamSource() {
			return { connect() {}, disconnect() {} };
		}
		createOscillator() {
			return { frequency: {}, connect() {}, start() {}, stop() {} };
		}
		createGain() {
			return {
				gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
				connect(hedef, cikis, giris) {
					this.baglanti = [hedef, cikis, giris];
				},
				disconnect() {
					this.baglanti = null;
				},
			};
		}
		resume() {
			return Promise.resolve();
		}
	};
	// <script> öğesiyle yükle (tarayıcıdaki gibi): üst düzey let/const genel kapsamda olur ve
	// deneme window.eval('esler') gibi iç duruma bakabilir. window.eval(BETIK) 'use strict' yüzünden
	// bunları o eval'e hapsediyordu.
	const betik = window.document.createElement('script');
	betik.textContent = BETIK;
	window.document.body.append(betik);
	Object.assign(durum, durumEk);
	return { window, d: window.document, oc: durum, FakePC };
}

const kanallar = [
	{ id: 'genel', ad: 'genel', tur: 'yazi' },
	{ id: 'muhabbet', ad: 'muhabbet', tur: 'yazi' },
	{ id: 'sesli-sohbet', ad: 'Sesli Sohbet', tur: 'ses', kisiler: [] },
	{ id: 'muzik', ad: 'Müzik', tur: 'ses', kisiler: [] },
];
const ICE = { iceServers: [{ urls: ['stun:1.2.3.4:3478'] }, { urls: ['turn:1.2.3.4:3478?transport=udp'], username: 'u', credential: 'c' }] };

(async () => {
	// --- 0) anahtar kurulum bağlantısı: #anahtar=… → localStorage + otomatik giriş
	{
		const s = kur({ url: 'https://chat.deneme/#anahtar=abc123def456', depo: { ad: 'taha' } });
		await bekle(50);
		denetle('hash ile anahtar kaydedildi', s.window.localStorage.getItem('anahtar') === 'abc123def456', String(s.window.localStorage.getItem('anahtar')));
		denetle('adres çubuğu temizlendi', !s.window.location.hash, s.window.location.hash);
		const g = s.oc.gonderilen.find((m) => m.type === 'giris');
		denetle('anahtarla otomatik giriş yapıldı', g && g.anahtar === 'abc123def456' && g.ad === '', JSON.stringify(g));
		// Sunucu kapalıyken açıldı: bağlantı kopunca kendiliğinden yeniden denenmeli (eskiden takılıyordu).
		s.oc.ws.close();
		await bekle(1500);
		denetle('anahtarla açılışta sunucu yoksa yeniden denenir', s.oc.wsler.length >= 2, String(s.oc.wsler.length));
		// Giriş freni: söylenen süre kadar bekleyip yeniden dener.
		s.oc.ws.onmessage({ data: JSON.stringify({ type: 'giris-red', message: 'Çok sık deneme; 1 saniye sonra tekrar dene.', kod: 'fren', bekle: 200 }) });
		await bekle(80);
		denetle('frende giriş ekranında geri sayım', /yeniden denenecek/.test(s.d.getElementById('giris-durum').textContent), s.d.getElementById('giris-durum').textContent);
		const once = s.oc.wsler.length;
		// Sayfa öne gelse (ya da ağ değişse) de frenin söylediği bekleme kısaltılmaz.
		s.d.dispatchEvent(new s.window.Event('visibilitychange'));
		await bekle(200);
		denetle('frende öne gelmek beklemeyi kısaltmaz', s.oc.wsler.length === once, `${once} → ${s.oc.wsler.length}`);
		await bekle(1500);
		denetle('frenden sonra kendiliğinden yeniden denendi', s.oc.wsler.length > once, `${once} → ${s.oc.wsler.length}`);
	}

	// --- 1) giriş ekranı: sadece ad
	const s = kur();
	const d = s.d;
	const w = s.window;
	const gelsin = (m) => s.oc.ws.onmessage({ data: JSON.stringify(m) });
	const son = (tur) => s.oc.gonderilen.filter((m) => m.type === tur).at(-1);
	denetle('giriş ekranı görünür', !d.getElementById('giris-ekrani').hidden);
	denetle('uygulama gizli', d.getElementById('uygulama').hidden);
	denetle('giriş alanında örnek yazı yok', d.getElementById('ad').getAttribute('placeholder') === null);
	denetle('giriş açıklaması yok', !d.querySelector('#giris .alt') && !/Hesap yok/i.test(d.getElementById('giris').textContent));
	denetle('sunucu şeridi (en sol bar) yok', d.getElementById('kenar') === null);
	denetle('anahtarsız açılışta WebSocket açılmadı', !s.oc.ws);
	denetle('simgeler SVG olarak çizildi', d.querySelectorAll('#ben-mikrofon svg.ikon').length === 1);
	denetle('sekme başlığı Diszort', d.title === 'Diszort', d.title);
	denetle('giriş ekranında Diszort adı ve logosu', d.querySelector('#giris h1').textContent === 'Diszort' && !!d.querySelector('.giris-logo svg rect'));
	denetle('sol üstte Diszort adı ve çarpılı logo', d.querySelector('.sunucu-baslik b').textContent === 'Diszort' && d.querySelectorAll('.sunucu-logo svg path[stroke="#f23f43"]').length === 1);

	// --- 2) ad yaz → kapıyı çal → "izin bekleniyor"
	d.getElementById('ad').value = 'taha';
	d.getElementById('giris').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
	await bekle(40);
	denetle('WebSocket açıldı', !!s.oc.ws && s.oc.ws.url.endsWith('/rtc'), s.oc.ws && s.oc.ws.url);
	const girisMesaji = s.oc.gonderilen.find((m) => m.type === 'giris');
	denetle('giris mesajı gönderildi', girisMesaji && girisMesaji.ad === 'taha', JSON.stringify(girisMesaji));
	denetle('anahtarsız istekte anahtar boş', girisMesaji && !girisMesaji.anahtar);
	gelsin({ type: 'bekleniyor', ad: 'taha', anahtarGecersiz: false });
	await bekle(30);
	denetle('izin bekleniyor durumu gösterildi', /izin bekleniyor/i.test(d.getElementById('giris-durum').textContent), d.getElementById('giris-durum').textContent);
	denetle('ad alanı kilitlendi', d.getElementById('ad').disabled === true);
	denetle('istek geri çek düğmesi göründü', d.getElementById('giris-iptal').hidden === false);

	// --- 3) onaylandı → anahtar saklandı, arayüz açıldı
	gelsin({
		type: 'hazir',
		ad: 'taha',
		kanallar,
		kimler: [
			{ ad: 'taha', sessiz: false, ses: null },
			{ ad: 'bora', sessiz: true, ses: null },
		],
		max: 10,
		maxKullanici: 10,
		beyazListe: 3,
		beyazListeAdlari: ['taha', 'bora', 'deniz'],
		sunulanDosyalar: [],
		anahtar: 'f'.repeat(128),
		ice: ICE,
		surum: 'v1',
		turnNesli: 'n1',
	});
	await bekle(50);
	denetle('giriş ekranı kapandı', d.getElementById('giris-ekrani').hidden);
	denetle('uygulama açıldı', !d.getElementById('uygulama').hidden);
	denetle('verilen anahtar localStorage’a yazıldı', w.localStorage.getItem('anahtar') === 'f'.repeat(128));
	denetle('TURN bilgisi hazir mesajından alındı', w.eval('ice.iceServers.length') === 2);
	denetle('kendi adı yazıldı', d.getElementById('ben-ad').textContent === 'taha', d.getElementById('ben-ad').textContent);
	denetle('yazılı kanallar çizildi', d.querySelectorAll('#yazi-kanallari .kanal-satir').length === 2, String(d.querySelectorAll('#yazi-kanallari .kanal-satir').length));
	denetle('sesli kanallar çizildi', d.querySelectorAll('#ses-kanallari .kanal-satir').length === 2, String(d.querySelectorAll('#ses-kanallari .kanal-satir').length));
	denetle('kanal silme düğmesi var', d.querySelectorAll('#yazi-kanallari .kanal-sil').length === 2);
	denetle('kanal ekleme düğmeleri var', !!d.getElementById('yazi-ekle') && !!d.getElementById('ses-ekle'));
	denetle('ilk kanal genel seçildi', d.getElementById('kanal-ad').textContent === 'genel', d.getElementById('kanal-ad').textContent);
	denetle('çevrimiçi sayısı 2', d.getElementById('uye-sayi').textContent === '2', d.getElementById('uye-sayi').textContent);
	denetle('beyaz liste göstergesi', /3\/10/.test(d.getElementById('beyaz-liste').textContent), d.getElementById('beyaz-liste').textContent);
	denetle('çevrimdışı beyaz liste üyesi listelendi', d.querySelectorAll('#uye-listesi .uye').length === 3, String(d.querySelectorAll('#uye-listesi .uye').length));
	denetle('çevrimdışı üye işaretli', d.querySelectorAll('#uye-listesi .uye.cevrimdisi').length === 1);
	const cevrimdisi = d.querySelector('#uye-listesi .uye.cevrimdisi');
	denetle('çevrimdışı üye adı + etiketi', /deniz/.test(cevrimdisi?.textContent || '') && /çevrimdışı/.test(cevrimdisi?.textContent || ''), cevrimdisi?.textContent);
	denetle('üye listesinde atma düğmesi (kendinde yok)', d.querySelectorAll('#uye-listesi .uye-at').length === 2, String(d.querySelectorAll('#uye-listesi .uye-at').length));
	denetle('geçmiş istendi', s.oc.gonderilen.some((m) => m.type === 'gecmis' && m.kanal === 'genel'));
	denetle('mikrofon düğmesi sesli kanal dışında da kullanılabilir (kanala susturulmuş girmek için)', d.getElementById('ben-mikrofon').disabled === false);

	// --- 4) geçmiş çizilir (gruplama + gün ayırıcı + bahsetme + resim + bağlantı). Resim P2P dosya:
	// önizlemesi paylaşandan doğrudan alınmış gibi.
	const RESIM = 'b'.repeat(24);
	w.eval(`alinanlar.set('${RESIM}', { dosya: null, url: 'blob:sahte/resim', disk: false, onizleme: true })`);
	const simdi = Date.now();
	gelsin({
		type: 'gecmis',
		kanal: 'genel',
		bitti: false,
		mesajlar: [
			{ id: 1, ad: 'bora', metin: 'selam', zaman: simdi - 3600000 },
			{ id: 2, ad: 'bora', metin: 'ikinci mesaj', zaman: simdi - 3500000 },
			{ id: 3, ad: 'bora', metin: '@taha duyuyor musun https://ornek.com/a?b=1.', zaman: simdi - 60000 },
			{ id: 4, ad: 'bora', metin: '', zaman: simdi - 50000, dosya: { id: RESIM, ad: 'resim.png', boyut: 2048, tur: 'image/png' } },
		],
	});
	await bekle(30);
	const mesajlar = d.querySelectorAll('#mesajlar .mesaj');
	denetle('4 mesaj çizildi', mesajlar.length === 4, String(mesajlar.length));
	denetle('gruplama: 2. mesaj gruplu', mesajlar[1].classList.contains('gruplu'));
	denetle('gruplu mesajda saat yan tarafta', !!mesajlar[1].querySelector('.yan-saat'));
	denetle('gün ayırıcı var', d.querySelectorAll('#mesajlar .gun').length >= 1);
	denetle('bahsetme vurgulandı', d.querySelectorAll('#mesajlar .bahsetme').length === 1);
	denetle('bahseden mesaj işaretli', d.querySelectorAll('#mesajlar .mesaj.bahsediliyor').length === 1);
	const baglanti = d.querySelector('#mesajlar .metin a');
	denetle('bağlantı tıklanabilir (sondaki nokta hariç)', baglanti && baglanti.getAttribute('href') === 'https://ornek.com/a?b=1', baglanti && baglanti.getAttribute('href'));
	denetle('bağlantı yeni sekmede, noopener', baglanti && baglanti.target === '_blank' && /noopener/.test(baglanti.rel));
	denetle('resim önizlemesi var', !!d.querySelector('#mesajlar img.onizleme'));
	denetle('daha eski düğmesi görünür', d.getElementById('daha-eski').hidden === false);
	// Metin HTML olarak yorumlanmaz.
	gelsin({ type: 'yazi', kanal: 'genel', mesaj: { id: 9, ad: 'bora', metin: '<img src=x onerror=alert(1)>', zaman: Date.now() } });
	await bekle(20);
	denetle('mesaj metni HTML olarak çalışmaz', !d.querySelector('#mesajlar .metin img'));

	// --- 5) yeni mesaj + okunmamış rozeti
	gelsin({ type: 'yazi', kanal: 'genel', mesaj: { id: 5, ad: 'bora', metin: 'yeni mesaj', zaman: Date.now() } });
	await bekle(20);
	denetle('yeni mesaj eklendi', d.querySelectorAll('#mesajlar .mesaj').length === 6, String(d.querySelectorAll('#mesajlar .mesaj').length));
	gelsin({ type: 'yazi', kanal: 'muhabbet', mesaj: { id: 6, ad: 'bora', metin: 'başka kanal', zaman: Date.now() } });
	await bekle(20);
	const muhabbetDugme = () => [...d.querySelectorAll('#yazi-kanallari .kanal')].find((b) => b.textContent.includes('muhabbet'));
	denetle('okunmamış rozeti', !!muhabbetDugme().querySelector('.rozet'));
	denetle('sekme başlığı rozetli', d.title.startsWith('(1)'), d.title);

	// --- 6) mesaj gönderme (Enter) ve IME
	const metin = d.getElementById('metin');
	metin.value = 'merhaba dünya';
	d.getElementById('yazma').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
	await bekle(20);
	const yazi = son('yazi');
	denetle('yazi gönderildi', yazi && yazi.metin === 'merhaba dünya' && yazi.kanal === 'genel', JSON.stringify(yazi));
	denetle('yazma kutusu temizlendi', metin.value === '');
	await bekle(300);
	metin.value = 'kanji';
	metin.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
	await bekle(20);
	denetle('IME ile yazarken Enter göndermez', metin.value === 'kanji' && son('yazi').metin === 'merhaba dünya');
	metin.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
	await bekle(20);
	denetle('normal Enter gönderir', son('yazi').metin === 'kanji');

	// --- 6b) dipte kalma: mesaj alanı küçülünce (ses kartı açıldı, telefonda klavye açıldı) yeni
	// mesajda yine dibe inilir; yukarı kaydıran bölünmez. jsdom'da yerleşim yok: ölçüler taklit edilir.
	{
		const alan = d.getElementById('mesaj-alani');
		const olcu = { yukseklik: 2000, gorunen: 500, yer: 1500 };
		Object.defineProperty(alan, 'scrollHeight', { get: () => olcu.yukseklik, configurable: true });
		Object.defineProperty(alan, 'clientHeight', { get: () => olcu.gorunen, configurable: true });
		Object.defineProperty(alan, 'scrollTop', {
			get: () => olcu.yer,
			set: (v) => (olcu.yer = Math.max(0, Math.min(v, olcu.yukseklik - olcu.gorunen))),
			configurable: true,
		});
		const kaydir = (yer) => {
			olcu.yer = yer;
			alan.dispatchEvent(new w.Event('scroll'));
		};
		w.eval('dibeKaydir()');
		kaydir(1500);
		olcu.gorunen = 300; // alan küçüldü: dip 200 px aşağıda kaldı (kaydırma olayı gelmez)
		olcu.yukseklik += 40;
		gelsin({ type: 'yazi', kanal: 'genel', mesaj: { id: 20, ad: 'bora', metin: 'alan küçüldükten sonra', zaman: Date.now() } });
		await bekle(20);
		denetle('alan küçülünce de yeni mesajda dibe inilir', olcu.yer === olcu.yukseklik - olcu.gorunen && d.getElementById('yeni-mesaj').hidden, JSON.stringify(olcu));
		kaydir(900); // kullanıcı yukarı kaydırdı
		olcu.yukseklik += 40;
		gelsin({ type: 'yazi', kanal: 'genel', mesaj: { id: 21, ad: 'bora', metin: 'yukarıdayken', zaman: Date.now() } });
		await bekle(20);
		denetle('yukarı kaydıran bölünmez, "yeni mesaj" düğmesi çıkar', olcu.yer === 900 && !d.getElementById('yeni-mesaj').hidden, JSON.stringify(olcu));
		kaydir(olcu.yukseklik - olcu.gorunen - 30); // dibe döndü: yeniden yapışır
		denetle('dibe dönünce düğme kaybolur', d.getElementById('yeni-mesaj').hidden);
		delete alan.scrollHeight;
		delete alan.clientHeight;
		delete alan.scrollTop;
	}

	// --- 6c) resim büyüteci: uzun dikey resim tam genişlikte (kaydırılabilir) açılır, resme dokununca
	// sığdırılır; Esc ve telefonun geri tuşu kapatır (geri tuşu siteden çıkmaz).
	{
		const bag = d.querySelector('#mesajlar img.onizleme').parentElement;
		const b = d.getElementById('buyutec');
		const r = d.getElementById('buyutec-resim');
		const kap = d.getElementById('buyutec-kaydir');
		const boyut = (en, boy) => {
			Object.defineProperty(r, 'naturalWidth', { value: en, configurable: true });
			Object.defineProperty(r, 'naturalHeight', { value: boy, configurable: true });
		};
		Object.defineProperty(kap, 'clientWidth', { value: 1334, configurable: true });
		Object.defineProperty(kap, 'clientHeight', { value: 788, configurable: true });
		bag.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
		await bekle(10);
		denetle('önizlemeye tıklayınca büyüteç açılır', !b.hidden && r.src === 'blob:sahte/resim', r.src);
		denetle('büyüteç geçmişe girdi ekler (geri tuşu kapatsın)', !!(w.history.state && w.history.state.buyutec));
		boyut(600, 4200);
		r.dispatchEvent(new w.Event('load'));
		denetle('uzun dikey resim tam genişlikte (kaydırılabilir) açılır', b.classList.contains('tam') && b.classList.contains('buyuyebilir') && !d.getElementById('buyutec-boy').hidden, b.className);
		r.dispatchEvent(new w.MouseEvent('click', { bubbles: true, clientY: 100 }));
		denetle('resme dokununca ekrana sığdırılır (büyüteç açık kalır)', !b.hidden && !b.classList.contains('tam'), b.className);
		d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await bekle(50);
		denetle('Esc kapatır, geçmiş girdisi geri alınır', b.hidden && !(w.history.state && w.history.state.buyutec));
		boyut(1600, 900);
		bag.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
		r.dispatchEvent(new w.Event('load'));
		denetle('yatay resim sığdırılmış açılır, büyütme düğmesi yok', !b.hidden && !b.classList.contains('tam') && d.getElementById('buyutec-boy').hidden, b.className);
		w.history.back();
		await bekle(50);
		denetle('geri tuşu büyüteci kapatır', b.hidden);
		delete r.naturalWidth;
		delete r.naturalHeight;
	}

	// --- 6d) P2P dosya: sunucuya yüklenmez; sohbete kaydı düşer, dosya paylaşanın tarayıcısından
	// doğrudan (veri kanalıyla) alınır. Sınır yok; kopunca kaldığı yerden sürer.
	{
		const kart = (id) => d.querySelector(`#mesajlar .p2p-dosya[data-dosya="${id}"]`);
		const metin = (id) => (kart(id) ? kart(id).textContent : '');
		// Kendi paylaşımım: dosya-paylas gider (dosyanın kendisi değil).
		w.eval('dosyalariPaylas([new File(["merhaba dünya"], "not.txt", { type: "text/plain" })])');
		const pay = son('dosya-paylas');
		denetle('dosya paylaşınca yalnızca kaydı gönderildi', pay && /^[0-9a-f]{24}$/.test(pay.id) && pay.ad === 'not.txt' && pay.boyut === 14 && pay.kanal === 'genel', JSON.stringify(pay));
		gelsin({ type: 'yazi', kanal: 'genel', mesaj: { id: 30, ad: 'taha', metin: '', zaman: Date.now(), dosya: { id: pay.id, ad: 'not.txt', boyut: 14, tur: 'text/plain' } } });
		gelsin({ type: 'dosya-durum', sunulan: [pay.id] });
		await bekle(60);
		denetle('kendi P2P dosyam: "senin paylaşımın" ve durdur düğmesi', /senin paylaşımın/.test(metin(pay.id)) && /Paylaşımı durdur/.test(metin(pay.id)), metin(pay.id));

		// Başkasının dosyası: paylaşan çevrimdışıyken indirilemez, çevrimiçi olunca indirilir.
		const id = 'c'.repeat(24);
		const icerik = 'P2P içerik: ' + 'x'.repeat(100);
		const boyut = new w.TextEncoder().encode(icerik).length;
		gelsin({ type: 'yazi', kanal: 'genel', mesaj: { id: 31, ad: 'bora', metin: '', zaman: Date.now(), dosya: { id, ad: 'rapor.txt', boyut, tur: 'text/plain' } } });
		await bekle(30);
		const indirDugmesi = () => [...kart(id).querySelectorAll('button')].find((b) => b.textContent === 'İndir');
		denetle('paylaşan sunmuyorken İndir kapalı', indirDugmesi() && indirDugmesi().disabled && /şu an sunmuyor/.test(metin(id)), metin(id));
		gelsin({ type: 'dosya-durum', sunulan: [pay.id, id] });
		await bekle(30);
		denetle('paylaşan çevrimiçi: İndir açık', indirDugmesi() && !indirDugmesi().disabled && /çevrimiçi/.test(metin(id)), metin(id));
		w.localStorage.setItem('dosya-yazici', 'bellek');
		const pcOnce = s.FakePC.hepsi.length;
		indirDugmesi().click();
		await bekle(40);
		const teklif = son('dosya-sinyal');
		denetle('indirince paylaşana doğrudan bağlantı teklifi gider', teklif && teklif.to === 'bora' && teklif.veri.tur === 'teklif' && typeof teklif.veri.bag === 'string', JSON.stringify(teklif));
		const pc = s.FakePC.hepsi[pcOnce];
		const kanal = pc && pc.kanallar[0];
		denetle('dosya için veri kanalı açıldı (sıralı, güvenilir)', !!kanal && kanal.secenek && kanal.secenek.ordered === true);
		denetle('aktarım panelde ve kartta görünür', !d.getElementById('aktarimlar').hidden && /rapor\.txt/.test(d.getElementById('aktarimlar').textContent) && !!kart(id).querySelector('.ilerleme'));
		gelsin({ type: 'dosya-sinyal', from: 'bora', veri: { tur: 'yanit', bag: teklif.veri.bag, sdp: { type: 'answer', sdp: 'v=0' } } });
		await bekle(20);
		denetle('yanıt bağlantıya uygulandı', pc.remoteDescription && pc.remoteDescription.type === 'answer');
		kanal.ac();
		const istek = JSON.parse(kanal.gonderilen[0] || '{}');
		denetle('kanal açılınca dosya istendi (baştan)', istek.istek === id && istek.baslangic === 0, JSON.stringify(istek));
		// Gönderen: önce yarısı, sonra kopma → kaldığı yerden yeniden istenir.
		const bayt = new w.TextEncoder().encode(icerik);
		kanal.gelsin(JSON.stringify({ tamam: true, boyut, baslangic: 0 }));
		kanal.gelsin(bayt.slice(0, 50).buffer);
		await bekle(20);
		kanal.close();
		await bekle(1300);
		const kanal2 = pc.kanallar[1];
		denetle('kopan aktarım aynı bağlantıda yeni kanalla sürüyor', !!kanal2);
		kanal2.ac();
		const istek2 = JSON.parse(kanal2.gonderilen[0] || '{}');
		denetle('kaldığı yerden istendi (50. bayttan)', istek2.istek === id && istek2.baslangic === 50, JSON.stringify(istek2));
		kanal2.gelsin(JSON.stringify({ tamam: true, boyut, baslangic: 50 }));
		kanal2.gelsin(bayt.slice(50).buffer);
		await bekle(20);
		const onay = kanal2.gonderilen.map((x) => (typeof x === 'string' ? JSON.parse(x) : {})).find((x) => x.onay != null);
		denetle('yazılan bildirildi (onay)', onay && onay.onay === boyut, JSON.stringify(onay));
		kanal2.gelsin(JSON.stringify({ bitti: true }));
		await bekle(60);
		const alinan = w.eval(`alinanlar.get('${id}')`);
		const yazilan = alinan && alinan.dosya ? await alinan.dosya.text() : '';
		denetle('dosya eksiksiz alındı (iki parça birleşti)', yazilan === icerik, yazilan.length + '/' + icerik.length);
		denetle('indirilen dosya kaydedildi (İndirilenler)', s.oc.indirilen.some((x) => x.ad === 'rapor.txt'), JSON.stringify(s.oc.indirilen));
		denetle('kartta "indirildi"', /indirildi/.test(metin(id)), metin(id));
		denetle('bitince aktarım paneli kapandı', d.getElementById('aktarimlar').hidden);

		// Gönderen taraf: biri benim dosyamı istiyor.
		const bagId = 'gelenbag1234';
		gelsin({ type: 'dosya-sinyal', from: 'bora', veri: { tur: 'teklif', bag: bagId, sdp: { type: 'offer', sdp: 'v=0' } } });
		await bekle(40);
		const yanit = son('dosya-sinyal');
		denetle('dosya bağlantı teklifine yanıt verildi', yanit && yanit.to === 'bora' && yanit.veri.tur === 'yanit' && yanit.veri.bag === bagId, JSON.stringify(yanit));
		const gpc = s.FakePC.hepsi.at(-1);
		const gk = {
			readyState: 'open',
			bufferedAmount: 0,
			gonderilen: [],
			send(x) {
				this.gonderilen.push(x);
			},
			close() {
				this.readyState = 'closed';
				if (this.onclose) this.onclose();
			},
		};
		gpc.ondatachannel({ channel: gk });
		gk.onmessage({ data: JSON.stringify({ istek: pay.id, baslangic: 3 }) });
		await bekle(60);
		const ilk = JSON.parse(gk.gonderilen[0]);
		const veri = gk.gonderilen.filter((x) => typeof x !== 'string');
		const gidenBayt = veri.reduce((t, x) => t + x.byteLength, 0);
		denetle('istenen dosya kaldığı yerden gönderildi', ilk.tamam && ilk.boyut === 14 && gidenBayt === 11 && JSON.parse(gk.gonderilen.at(-1)).bitti === true, `${JSON.stringify(ilk)} ${gidenBayt}`);
		denetle('gönderim panelde', /not\.txt/.test(d.getElementById('aktarimlar').textContent));
		gk.onmessage({ data: JSON.stringify({ onay: 14 }) });
		await bekle(20);
		denetle('alan onaylayınca gönderim bitti', d.getElementById('aktarimlar').hidden && /gönderildi/.test(d.getElementById('durum').textContent), d.getElementById('durum').textContent);
		// Sunmadığım dosya istenirse "yok" denir.
		const gk2 = { ...gk, gonderilen: [], readyState: 'open' };
		gpc.ondatachannel({ channel: gk2 });
		gk2.onmessage({ data: JSON.stringify({ istek: 'd'.repeat(24), baslangic: 0 }) });
		denetle('sunulmayan dosya için "yok"', JSON.parse(gk2.gonderilen[0]).hata === 'yok');
		// Paylaşımı durdur: sunucuya kalan liste bildirilir.
		[...kart(pay.id).querySelectorAll('button')].find((b) => b.textContent === 'Paylaşımı durdur').click();
		await bekle(20);
		denetle('paylaşım durdurulunca sunulanlar güncellendi', son('dosya-sun') && son('dosya-sun').idler.length === 0 && /artık sunulmuyor/.test(metin(pay.id)), metin(pay.id));
		w.localStorage.removeItem('dosya-yazici');
		// Dosya bağlantılarını kapat (aşağıdaki ses denetimleri yalnızca ses bağlantılarını saysın).
		w.eval('for (const b of [...dosyaBaglari.values()]) bagKapat(b, "")');
		denetle('dosya bağlantıları kapanınca karşıya bildirildi', son('dosya-sinyal').veri.tur === 'kapat');
	}

	// --- 7) kanal değiştirme
	muhabbetDugme().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	await bekle(30);
	denetle('kanal değişti', d.getElementById('kanal-ad').textContent === 'muhabbet', d.getElementById('kanal-ad').textContent);
	denetle('yeni kanal için geçmiş istendi', son('gecmis').kanal === 'muhabbet');
	denetle('rozet temizlendi', !d.title.startsWith('('), d.title);
	// Yanıt gelmeden başka kanala geçilirse o kanalın geçmişi de istenmeli (eskiden takılıyordu).
	const gecmisSayisi = s.oc.gonderilen.filter((m) => m.type === 'gecmis').length;
	[...d.querySelectorAll('#yazi-kanallari .kanal')].find((b) => b.textContent.includes('genel')).click();
	await bekle(20);
	denetle('yanıtsız geçmiş isteği yeni kanalı engellemez', s.oc.gonderilen.filter((m) => m.type === 'gecmis').length === gecmisSayisi + 1 && son('gecmis').kanal === 'genel');
	muhabbetDugme().click();
	await bekle(20);

	// --- 8) kanal ekleme / silme
	d.getElementById('yazi-ekle').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	await bekle(20);
	denetle('ekleme penceresi açıldı', d.getElementById('pencere').hidden === false);
	denetle('pencere başlığı yazılı kanal', /Yazılı kanal ekle/.test(d.getElementById('pencere-baslik').textContent));
	denetle('girdi odaklandı', d.activeElement === d.getElementById('pencere-girdi'));
	d.getElementById('pencere-girdi').value = 'duyurular';
	d.getElementById('pencere-form').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
	await bekle(20);
	const ekle = son('kanal-ekle');
	denetle('kanal-ekle gönderildi', ekle && ekle.tur === 'yazi' && ekle.ad === 'duyurular', JSON.stringify(ekle));
	d.getElementById('ses-ekle').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	await bekle(20);
	denetle('sesli kanal penceresi açıldı', /Sesli kanal ekle/.test(d.getElementById('pencere-baslik').textContent));
	d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	await bekle(20);
	denetle('Escape pencereyi kapattı', d.getElementById('pencere').hidden === true);
	d.querySelector('#yazi-kanallari .kanal-sil').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	await bekle(20);
	denetle('silme penceresi açıldı', d.getElementById('pencere').hidden === false);
	denetle('silme penceresinde girdi yok', d.getElementById('pencere-girdi').hidden === true);
	denetle('onay düğmesi "Sil"', d.getElementById('pencere-tamam').textContent === 'Sil');
	d.getElementById('pencere-form').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
	await bekle(20);
	denetle('kanal-sil gönderildi', son('kanal-sil') && son('kanal-sil').kanal === 'genel', JSON.stringify(son('kanal-sil')));

	// --- 9) giriş istekleri: kabul / red, kayıtlı ad uyarısı
	gelsin({ type: 'giris-istegi', id: 'i1', ad: 'deniz', kayitli: true });
	await bekle(20);
	const istekKarti = d.querySelector('#istekler .istek');
	denetle('giriş isteği kartı göründü', !!istekKarti && /deniz/.test(istekKarti.textContent), istekKarti && istekKarti.textContent);
	denetle('kayıtlı ad için uyarı var', !!istekKarti.querySelector('.istek-uyari') && /anahtarı iptal/.test(istekKarti.textContent));
	const dugmeler = istekKarti.querySelectorAll('button');
	denetle('kabul/red düğmeleri var', dugmeler.length === 2, String(dugmeler.length));
	dugmeler[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	await bekle(20);
	denetle('kabul kararı gönderildi', son('giris-karari') && son('giris-karari').id === 'i1' && son('giris-karari').kabul === true);
	denetle('istek kartı kapandı', d.querySelectorAll('#istekler .istek').length === 0);
	gelsin({ type: 'giris-istegi', id: 'i2', ad: 'kerem', kayitli: false });
	await bekle(20);
	const kart2 = d.querySelector('#istekler .istek');
	denetle('kayıtsız ad için uyarı yok', !kart2.querySelector('.istek-uyari'));
	kart2.querySelectorAll('button')[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	await bekle(20);
	denetle('red kararı gönderildi', son('giris-karari').id === 'i2' && son('giris-karari').kabul === false);

	// --- 10) üye atmak (onaylı)
	d.querySelector('#uye-listesi .uye-at').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	await bekle(20);
	denetle('atma onayı istendi', d.getElementById('pencere').hidden === false && /bora/.test(d.getElementById('pencere-metin').textContent), d.getElementById('pencere-metin').textContent);
	d.getElementById('pencere-form').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
	await bekle(20);
	denetle('at mesajı gönderildi', son('at') && son('at').ad === 'bora', JSON.stringify(son('at')));

	// --- 10b) kişi limiti arttır/azalt (beyaz listedekiler)
	denetle('limit düğmeleri etkin', !d.getElementById('limit-cok').disabled && !d.getElementById('limit-az').disabled);
	d.getElementById('limit-cok').click();
	await bekle(20);
	denetle('limit arttırma mesajı gönderildi', son('kisi-limiti') && son('kisi-limiti').deger === 11, JSON.stringify(son('kisi-limiti')));
	gelsin({ type: 'kimler', kimler: [{ ad: 'taha' }], beyazListe: 2, maxKullanici: 11 });
	await bekle(20);
	denetle('limit göstergesi güncellendi', /2\/11/.test(d.getElementById('beyaz-liste').textContent), d.getElementById('beyaz-liste').textContent);
	d.getElementById('limit-az').click();
	await bekle(20);
	denetle('limit azaltma mesajı gönderildi', son('kisi-limiti').deger === 10);

	// --- 11) sesli kanala gir
	const sesDugme = () => [...d.querySelectorAll('#ses-kanallari .kanal')].find((b) => b.textContent.includes('Sesli Sohbet'));
	sesDugme().click();
	sesDugme().click(); // çift tıklama: ikinci mikrofon akışı açılmamalı
	await bekle(60);
	denetle('mikrofon bir kez istendi (çift tıklamada sızıntı yok)', s.oc.mikrofon === 1, String(s.oc.mikrofon));
	denetle('AGC kapalı istendi', s.oc.micKisit && s.oc.micKisit.autoGainControl === false, JSON.stringify(s.oc.micKisit));
	denetle('yankı ve gürültü giderme açık istendi', s.oc.micKisit && s.oc.micKisit.echoCancellation === true && s.oc.micKisit.noiseSuppression === true);
	const sesGir = son('ses-gir');
	denetle('ses-gir gönderildi (sessiz/sağır durumu ile)', sesGir && sesGir.kanal === 'sesli-sohbet' && sesGir.sessiz === false && sesGir.sagir === false, JSON.stringify(sesGir));
	gelsin({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: ['bora'], ice: ICE, devam: false });
	await bekle(60);
	denetle('ses kartı göründü', d.getElementById('ses-karti').hidden === false);
	denetle('ses bağlantı paneli göründü', d.getElementById('ses-baglanti').hidden === false);
	denetle('kendi kutusu + eş kutusu', d.querySelectorAll('#ses-kisiler .ses-kisi').length === 2, String(d.querySelectorAll('#ses-kisiler .ses-kisi').length));
	const kaydirici = d.querySelector('#ses-kisiler input.ses-seviye');
	denetle('eş kutusunda ses seviyesi kaydırıcısı', !!kaydirici);
	kaydirici.value = '37';
	kaydirici.dispatchEvent(new w.Event('input', { bubbles: true }));
	denetle('ses seviyesi saklandı', w.localStorage.getItem('ses-seviye-bora') === '37', String(w.localStorage.getItem('ses-seviye-bora')));
	const sesOgesi = d.querySelector('#ses-akislari audio.ses-akis');
	denetle('ses seviyesi uygulandı', sesOgesi && sesOgesi.volume === 0.37, String(sesOgesi && sesOgesi.volume));
	denetle('gelen ses öğesi gizli değil (iOS)', sesOgesi && !sesOgesi.hidden && sesOgesi.getAttribute('playsinline') === '');
	// Teklif eden biziz ('taha' > 'bora'): ses kanalı mikrofon iziyle açılmalı, teklif oturum kimliği taşımalı.
	const ilkPc = s.FakePC.hepsi.at(-1);
	const ilkTr = ilkPc && ilkPc._transceivers[0];
	denetle('ses kanalı mikrofon iziyle açıldı', !!(ilkTr && ilkTr.sender.track));
	denetle('ses kanalı sendrecv', ilkTr && ilkTr.direction === 'sendrecv', ilkTr && ilkTr.direction);
	// Yayın için iki kanal daha önceden açılır: yayın sesi (ikinci ses) ve görüntü; yayın yokken boş.
	const turler = ilkPc ? ilkPc._transceivers.map((t) => t.receiver.track.kind).join(',') : '';
	denetle('mikrofon + yayın sesi + görüntü kanalları açıldı', turler === 'audio,audio,video', turler);
	denetle('yayın yokken yayın kanalları boş, sendrecv', ilkPc._transceivers.slice(1).every((t) => t.sender.track === null && t.direction === 'sendrecv'));
	denetle('RED bilmeyen tarayıcıda kodek sırasına dokunulmaz', ilkPc._transceivers.every((t) => t.kodekler === null));
	denetle('TURN sunucuları bağlantıya verildi', ilkPc && ilkPc.ayar.iceServers.length === 2);
	const teklif = son('sdp');
	denetle('teklif gönderildi, oturum kimliği var', teklif && teklif.to === 'bora' && teklif.sdp.type === 'offer' && /^[a-z0-9]{12}$/.test(teklif.oturum || ''), JSON.stringify(teklif));
	// Yanıt: Opus fmtp'si bizim kodlayıcımızı ayarlar (yüksek bit hızı + FEC). Her ses m-line'ı ayrı:
	// mikrofon mono konuşma, yayın sesi stereo müzik kalitesi.
	gelsin({ type: 'sdp', from: 'bora', sdp: { type: 'answer', sdp: UC_KANALLI }, oturum: teklif.oturum });
	await bekle(40);
	const uygulanan = s.FakePC.uzaklar.at(-1);
	denetle('yanıt uygulandı', ilkPc.remoteDescription && ilkPc.remoteDescription.type === 'answer');
	denetle('Opus: maxaveragebitrate=96000 + FEC + DTX kapalı', uygulanan && /maxaveragebitrate=96000/.test(uygulanan.sdp) && /useinbandfec=1/.test(uygulanan.sdp) && /usedtx=0/.test(uygulanan.sdp), uygulanan && uygulanan.sdp);
	const bolumler = uygulanan.sdp.split('m=').slice(1);
	denetle('mikrofon m-line: mono', /stereo=0/.test(bolumler[0]) && !/sprop-stereo/.test(bolumler[0]), bolumler[0]);
	denetle('yayın sesi m-line: stereo, 510 kbps (varsayılan: sistem kalitesi)', /stereo=1/.test(bolumler[1]) && /sprop-stereo=1/.test(bolumler[1]) && /maxaveragebitrate=510000/.test(bolumler[1]), bolumler[1]);
	denetle('görüntü m-line değişmedi', !/fmtp/.test(bolumler[2]), bolumler[2]);
	denetle('gönderici bit hızı tavanı 96 kbps', ilkTr.parametreler && ilkTr.parametreler.encodings[0].maxBitrate === 96000, JSON.stringify(ilkTr.parametreler));
	// Teklif yoldayken (ICE yenileme) eski oturuma ait yanıt yok sayılır, doğru oturumunki uygulanır.
	w.eval("iceYenile(esler.get('bora'))");
	await bekle(30);
	denetle('ICE yenileme teklifi gönderildi', ilkPc.signalingState === 'have-local-offer' && son('sdp').oturum === teklif.oturum);
	const uzakSayisi = s.FakePC.uzaklar.length;
	gelsin({ type: 'sdp', from: 'bora', sdp: { type: 'answer', sdp: OPUS_TEKLIF }, oturum: 'eskioturum12' });
	await bekle(30);
	denetle('eski oturumun yanıtı yok sayıldı', s.FakePC.uzaklar.length === uzakSayisi && ilkPc.signalingState === 'have-local-offer');
	gelsin({ type: 'sdp', from: 'bora', sdp: { type: 'answer', sdp: OPUS_TEKLIF }, oturum: teklif.oturum });
	await bekle(30);
	denetle('doğru oturumun yanıtı uygulandı', s.FakePC.uzaklar.length === uzakSayisi + 1 && ilkPc.signalingState === 'stable');

	// Yanıtlayan taraf ('zeynep' > 'taha'): bağlantıyı önceden açmaz, teklifin oturumuyla kurar.
	gelsin({ type: 'ses-kisi-girdi', kanal: 'sesli-sohbet', ad: 'zeynep', devam: false });
	await bekle(30);
	denetle('yanıtlayan taraf teklif gelmeden bağlantı açmadı', w.eval("!esler.get('zeynep').pc"));
	gelsin({ type: 'sdp', from: 'zeynep', sdp: { type: 'offer', sdp: UC_KANALLI }, oturum: 'zoturum12345' });
	await bekle(60);
	const zPc = s.FakePC.hepsi.at(-1);
	const zTr = zPc._transceivers.find((t) => t.mid != null);
	denetle("teklifin m-line transceiver'ı oluştu", !!zTr);
	denetle('yanıtlayan ses kanalı sendrecv', zTr && zTr.direction === 'sendrecv', zTr && zTr.direction);
	denetle('yanıtlayan mikrofonu bağladı', !!(zTr && zTr.sender.track));
	denetle('yanıtlayan yayın kanallarını eşledi (sendrecv, boş)', zPc._transceivers.length === 3 && zPc._transceivers.every((t) => t.direction === 'sendrecv') && !zPc._transceivers[1].sender.track && !zPc._transceivers[2].sender.track);
	denetle('yanıtlayan kanalları doğru sırayla tanıdı', w.eval("(() => { const e = esler.get('zeynep'); const t = e.pc._transceivers; return e.tr === t[0] && e.trSes === t[1] && e.trGoruntu === t[2]; })()"));
	const yanit = son('sdp');
	denetle('yanıt teklifin oturumuyla gönderildi', yanit && yanit.to === 'zeynep' && yanit.sdp.type === 'answer' && yanit.oturum === 'zoturum12345', JSON.stringify(yanit));
	// Aynı teklif yeniden gelirse yeniden uygulanmaz, yanıt yinelenir.
	const uzakSayisi2 = s.FakePC.uzaklar.length;
	gelsin({ type: 'sdp', from: 'zeynep', sdp: { type: 'offer', sdp: UC_KANALLI }, oturum: 'zoturum12345' });
	await bekle(40);
	denetle('yinelenen teklif yeniden uygulanmadı, yanıt yinelendi', s.FakePC.uzaklar.length === uzakSayisi2 && son('sdp') !== yanit && son('sdp').oturum === 'zoturum12345');

	// Sessiz/sağır simgeleri sunucudan gelir.
	gelsin({ type: 'sessiz', ad: 'zeynep', sessiz: true, sagir: false });
	await bekle(20);
	denetle('eşin mikrofon-kapalı simgesi', !!d.querySelector('#ses-kisiler .ses-kisi[data-ad="zeynep"].sessiz .durum-ikon svg'));

	// Teşhis turu: micAyarlar (AGC kapalı gerçekte uygulandı mı) ile gönderilir.
	await bekle(10300);
	const tani = s.oc.gonderilen.filter((m) => m.type === 'tani');
	const sonTani = tani.filter((m) => m.veri && m.veri.esler).at(-1);
	denetle('tanı gönderildi', !!sonTani, String(tani.length));
	denetle('tanıda mikrofon ayarları var', !!(sonTani && sonTani.veri.micAyarlar && sonTani.veri.micAyarlar.agc === false));
	denetle('yanıt teşhisi gönderildi', tani.some((m) => m.veri.olay === 'yanit'));

	// İstatistik: bağlantı "connected" olunca ölçülür (iki ölçüm arası fark gerekir).
	for (const pc of s.FakePC.hepsi) pc.connectionState = 'connected';
	await bekle(4500);
	const ist = d.querySelector('#ses-kisiler .ses-kisi[data-ad="bora"] .ses-istatistik');
	denetle('istatistik: bağlantı türü ve gecikme', ist && /P2P/.test(ist.textContent) && /ms/.test(ist.textContent), ist && ist.textContent);
	denetle('istatistik ayrıntısı (kayıp, bit hızları) ipucunda', ist && /kayıp/.test(ist.title) && /kbps/.test(ist.title), ist && ist.title);
	denetle('doğrudan (P2P) bağlantı yeşil (turuncu değil)', ist && !ist.classList.contains('turn'), ist && ist.className);
	s.FakePC.adayTuru = 'relay';
	await bekle(2300);
	denetle('TURN (relay) bağlantısı turuncu', ist && /TURN/.test(ist.textContent) && ist.classList.contains('turn'), ist && ist.className + ' ' + ist.textContent);
	s.FakePC.adayTuru = 'srflx';
	denetle('ses paneli bağlı', /Ses bağlı/.test(d.getElementById('ses-baglanti-durum').textContent), d.getElementById('ses-baglanti-durum').textContent);

	// --- 11b) bağlantı kalitesi: kısa bir kayıp patlaması (FEC/gizleme sesi kurtarır, ses bozulmaz)
	// "Bağlantı zayıf" demez (eskiden tek 2 sn'lik ölçümde %5 kayıp kırmızı uyarı veriyordu). Gerçekten
	// bozulan (uydurulan ses ~%30) tek kişi yalnızca kendi kutusunda kırmızı; herkesten gelen bozuksa panel kırmızı.
	{
		const panel = () => d.getElementById('ses-baglanti-durum').textContent;
		const alt = () => d.getElementById('ses-baglanti-kanal').textContent;
		const kutu = (ad) => d.querySelector(`#ses-kisiler .ses-kisi[data-ad="${ad}"] .ses-istatistik`);
		// Uzun beklemelerde sunucu "sessiz" kalmasın (yoksa canlılık yoklaması devreye girer).
		const nabiz = setInterval(() => gelsin({ type: 'pong' }), 2000);
		s.FakePC.kayipHizi = 12; // ~%20 kayıp (tek ölçümde), ses kurtarılıyor (gizleme yok)
		await bekle(2300);
		s.FakePC.kayipHizi = 0;
		denetle('kısa kayıp patlaması "Bağlantı zayıf" demez (ses bozulmadı)', /Ses bağlı/.test(panel()) && !d.getElementById('ses-baglanti').classList.contains('kotu'), panel());
		denetle('kısa kayıpta kişi kutusu kırmızı değil', !kutu('bora').classList.contains('kotu'), kutu('bora').className + ' ' + kutu('bora').textContent);
		ilkPc.gizlemeOrani = 0.3; // bora'dan gelen ses gerçekten kesik
		await bekle(4700);
		denetle('gerçekten bozulan kişinin kutusu kırmızı', kutu('bora').classList.contains('kotu'), kutu('bora').className + ' ' + kutu('bora').textContent);
		denetle('tek kişinin sorunu paneli kırmızı yapmaz, alt satırda belirtilir', /Ses bağlı/.test(panel()) && /bora: bağlantısı zayıf/.test(alt()), panel() + ' | ' + alt());
		denetle('kutuda ipucu: uydurulan ses oranı', /ses uyduruldu/.test(kutu('bora').title), kutu('bora').title);
		zPc.gizlemeOrani = 0.3; // herkesten gelen bozuk: sorun bizde
		await bekle(4700);
		denetle('herkesten gelen ses bozuksa "Bağlantı zayıf"', /Bağlantı zayıf/.test(panel()) && d.getElementById('ses-baglanti').classList.contains('kotu'), panel());
		ilkPc.gizlemeOrani = null;
		zPc.gizlemeOrani = null;
		clearInterval(nabiz);
	}

	// --- 12) susturma ve sağırlaştırma: susturunca mikrofon aygıtı tamamen bırakılır (her cihazda),
	// açınca yeniden alınıp eşlere bağlanır.
	const susturmadanOnce = s.oc.sonIz;
	d.getElementById('ben-mikrofon').click();
	await bekle(20);
	denetle('mikrofon kapatma bildirildi', son('sessiz').sessiz === true && son('sessiz').sagir === false);
	denetle('susturunca mikrofon aygıtı bırakıldı (masaüstünde de)', susturmadanOnce.readyState === 'ended' && w.eval('mikrofon === null && mikBirakildi === true'));
	d.getElementById('ben-mikrofon').click();
	await bekle(40);
	denetle('mikrofon açma bildirildi, mikrofon yeniden alındı', son('sessiz').sessiz === false && s.oc.sonIz !== susturmadanOnce && s.oc.sonIz.readyState === 'live' && s.oc.sonIz.enabled === true);
	denetle('yeniden alınan mikrofon eşlere bağlandı', ilkPc._transceivers[0].sender.track === s.oc.sonIz && zPc._transceivers[0].sender.track === s.oc.sonIz);
	d.getElementById('kart-sagir').click(); // ses kartındaki düğme (telefonda)
	await bekle(20);
	denetle('sağırlaştırma: gelen sesler kapalı + bildirildi', [...d.querySelectorAll('#ses-akislari audio')].every((a) => a.muted) && son('sessiz').sagir === true && son('sessiz').sessiz === true);
	d.getElementById('ben-sagir').click();
	await bekle(20);
	denetle('sağırlık kalktı', [...d.querySelectorAll('#ses-akislari audio')].every((a) => !a.muted) && son('sessiz').sagir === false);

	// --- 12b) yayın: ekran paylaşımı, ekranlı ya da ekransız. Ekransız paylaşım da bir ekran
	// paylaşımıdır: görüntü izi yakalanmaya devam eder ama kimseye gönderilmez, yalnızca sesi gider;
	// ekran yeniden seçmeden gösterilip gizlenir. Ses herkese gider (herkes yayın kartından kendi için
	// susturur, kısar); görüntü yalnızca izleyene (izle/kapat). İzler önceden açık kanallara takılır.
	{
		const menu = () => d.getElementById('yayin-menu');
		const menuOgesi = (metin) => [...menu().querySelectorAll('button')].find((b) => b.textContent.includes(metin));
		const menuyuAc = async () => {
			if (menu().hidden) d.getElementById('yayin-ac').click();
			await bekle(20);
		};
		const benimKart = () => d.querySelector('#yayinlar .yayin-kart.ben');
		const esKarti = (ad) => [...d.querySelectorAll('#yayinlar .yayin-kart:not(.ben)')].find((e) => e.dataset.ad === ad);
		const kartDugmesi = (kart, metin) => kart && [...kart.querySelectorAll('button')].find((b) => b.textContent === metin);
		const kanalDurumu = (t, z) => kanallar.map((k) => (k.id === 'sesli-sohbet' ? { ...k, kisiler: [{ ad: 'taha', ...t }, { ad: 'bora' }, { ad: 'zeynep', ...z }] } : k));
		const yayinSesi = (pc) => pc._transceivers[1].sender.track;
		const goruntusu = (pc) => pc._transceivers[2].sender.track;
		const ekransizYayin = { yayin: { goruntu: false, ses: true } };

		await menuyuAc();
		denetle('paylaşım menüsü: ekranlı ve ekransız (ayrı "sekme sesi" yolu yok)', !menu().hidden && !!menuOgesi('Ekranını paylaş') && !!menuOgesi('Ekransız paylaş') && !menuOgesi('Sekme sesi'));
		// Ekransız paylaşım: yakalanan sekmenin/bilgisayarın yalnızca sesi gider; ad sorulmaz.
		menuOgesi('Ekransız paylaş').click();
		await bekle(40);
		denetle('ekransız paylaşımda ad sorulmaz', d.getElementById('pencere').hidden);
		const y1 = son('yayin');
		denetle('ekransız paylaşım bildirildi: görüntü yok, ses var', y1 && y1.yayin && y1.yayin.goruntu === false && y1.yayin.ses === true, JSON.stringify(y1));
		const sec = s.oc.ekranSecenek || {};
		denetle(
			'yakalama: sekme seçimi önde, sistem sesi istendi, işleme kapalı, sekmenin kendi sesi hariç',
			sec.video && sec.video.displaySurface === 'browser' && sec.systemAudio === 'include' && sec.audio && sec.audio.echoCancellation === false && sec.audio.restrictOwnAudio === true,
			JSON.stringify(sec),
		);
		const [gIz, sIz] = s.oc.ekranIzleri;
		denetle('görüntü izi durdurulmadı (yakalama sürer), saniyede bir kareye indirildi', gIz.readyState === 'live' && gIz.kisit && gIz.kisit.frameRate.max === 1, JSON.stringify(gIz.kisit));
		denetle('ses herkesin yayın sesi kanalında, görüntü kimseye gitmiyor', yayinSesi(ilkPc) === sIz && yayinSesi(zPc) === sIz && goruntusu(ilkPc) === null && goruntusu(zPc) === null);
		denetle('mikrofon kanalı değişmedi', ilkPc._transceivers[0].sender.track === s.oc.sonIz);
		denetle(
			'kendi kartım: ekransız, önizleme yok, "Ekranı göster" ve "Durdur" var',
			!!benimKart() && benimKart().classList.contains('ekransiz') && /Ekransız paylaşıyorsun/.test(benimKart().textContent) && benimKart().querySelector('video').hidden && !!kartDugmesi(benimKart(), 'Ekranı göster') && !!kartDugmesi(benimKart(), 'Durdur'),
			benimKart() && benimKart().textContent,
		);
		denetle('paylaşılan ses kanalda ayrı kişi gibi görünmez', !d.querySelector('.sanal') && d.querySelectorAll('#ses-kisiler .ses-kisi').length === 3);
		await bekle(250);
		denetle('kendi kartım ses geldikçe ışır, çubuk dolar', benimKart().classList.contains('ses-var') && parseInt(benimKart().querySelector('.seviye-cubuk > div').style.width, 10) > 0, benimKart().className);
		gelsin({ type: 'kanallar', kanallar: kanalDurumu(ekransizYayin, {}) });
		await bekle(20);
		const benimRozet = d.querySelector('#ses-kanallari .ses-uyesi[data-ad="taha"] .canli');
		denetle('kenar çubuğunda CANLI rozeti (ekransız), ayrı kişi yok', !!benimRozet && /Ekransız/.test(benimRozet.title) && d.querySelectorAll('#ses-kanallari .ses-uyesi').length === 3);
		const sayac = [...d.querySelectorAll('#ses-kanallari .kanal')].find((b) => b.textContent.includes('Sesli Sohbet')).textContent;
		denetle('kanal sayacı gerçek kişileri sayar', /3\/10/.test(sayac), sayac);
		// Görüntüyü kapatmak sesi etkilemez.
		gelsin({ type: 'izle', from: 'bora', izle: false });
		await bekle(30);
		denetle('görüntüyü kapatan da sesi alır', yayinSesi(ilkPc) === sIz);
		gelsin({ type: 'izle', from: 'bora', izle: true });
		await bekle(20);
		// Ekranı göster: aynı yakalamanın görüntüsü izleyenlere gider; yeniden seçim yok.
		const secimSayisi = s.oc.ekranSayisi;
		kartDugmesi(benimKart(), 'Ekranı göster').click();
		await bekle(30);
		denetle('ekran gösterilince görüntü herkese takıldı, yeniden seçim istenmedi', goruntusu(ilkPc) === gIz && goruntusu(zPc) === gIz && s.oc.ekranSayisi === secimSayisi);
		denetle('görüntü yeniden 30 kareye çıktı', gIz.kisit.frameRate.max === 30, JSON.stringify(gIz.kisit));
		denetle('bildirildi: görüntü + ses', son('yayin').yayin.goruntu === true && son('yayin').yayin.ses === true, JSON.stringify(son('yayin')));
		denetle(
			'kendi kartım: önizleme ve izleyen sayısı',
			!benimKart().classList.contains('ekransiz') && !benimKart().querySelector('video').hidden && /Ekranını paylaşıyorsun · 2\/2 kişi izliyor/.test(benimKart().textContent),
			benimKart().textContent,
		);
		const vk = ilkPc._transceivers[2].parametreler;
		denetle('ekran için bit hızı tavanı ve 30 kare', !!vk && vk.encodings[0].maxBitrate > 0 && vk.encodings[0].maxFramerate === 30, JSON.stringify(vk));
		gelsin({ type: 'izle', from: 'bora', izle: false });
		await bekle(30);
		denetle('görüntüyü kapatana görüntü gitmez, ses gider; diğerine ikisi de', goruntusu(ilkPc) === null && yayinSesi(ilkPc) === sIz && goruntusu(zPc) === gIz);
		denetle('izleyen sayısı düştü', /1\/2 kişi izliyor/.test(benimKart().textContent), benimKart().textContent);
		// Menüden gizle: görüntü herkesten kalkar, yakalama ve ses sürer.
		await menuyuAc();
		menuOgesi('Ekranı gizle').click();
		await bekle(30);
		denetle('ekran gizlenince görüntü kimseye gitmiyor, ses ve yakalama sürüyor', goruntusu(ilkPc) === null && goruntusu(zPc) === null && yayinSesi(zPc) === sIz && gIz.readyState === 'live' && son('yayin').yayin.goruntu === false);
		gelsin({ type: 'izle', from: 'bora', izle: true });
		await bekle(20);
		denetle('ekransızken izlemeye dönen kişiye de görüntü gitmez', goruntusu(ilkPc) === null);

		// Başkasının paylaşımı: zeynep ekransız (yalnızca ses) paylaşıyor. Bağlantı kurulurken yayın
		// sesi kanalının izi gelmişti (paylaşım yokken sessiz).
		zPc.ontrack({ transceiver: zPc._transceivers[1], track: zPc._transceivers[1].receiver.track });
		gelsin({ type: 'kanallar', kanallar: kanalDurumu(ekransizYayin, ekransizYayin) });
		await bekle(30);
		const zKart = () => esKarti('zeynep');
		denetle(
			"zeynep'in ekransız kartı: görüntü alanı ve izle düğmesi yok, ses satırı var",
			!!zKart() && zKart().classList.contains('ekransiz') && /ekransız paylaşıyor/.test(zKart().textContent) && zKart().querySelector('.yayin-sahne').hidden && kartDugmesi(zKart(), 'Görüntüyü kapat').hidden && !zKart().querySelector('.yayin-ses').hidden,
			zKart() && zKart().textContent,
		);
		denetle('haber verildi', /zeynep ekransız paylaşıyor/.test(d.getElementById('durum').textContent), d.getElementById('durum').textContent);
		denetle('zeynep kişi kutusunda CANLI', !!d.querySelector('#ses-kisiler .ses-kisi[data-ad="zeynep"] .canli'));
		const zOge = w.eval("esler.get('zeynep').yayinSesOgesi");
		denetle('paylaşımın sesi ayrı bir öğede çalıyor', !!zOge && !zOge.paused && !zOge.muted);
		await bekle(250);
		denetle("zeynep'in sesi geldikçe kartı ışır", zKart().classList.contains('ses-var'));
		// Paylaşılan sesi yalnızca kendim için sustur (kalıcı; yayıncıya bir şey gitmez) ve kıs.
		const izleSayisi = s.oc.gonderilen.filter((m) => m.type === 'izle').length;
		zKart().querySelector('.yayin-ses button.sus').click();
		await bekle(150);
		denetle(
			'paylaşılan sesi kendim için susturdum (kalıcı)',
			w.eval("esler.get('zeynep').yayinSusturuldu") === true && zOge.muted === true && w.localStorage.getItem('yayin-sustur-zeynep') === '1' && zKart().classList.contains('susturuldu'),
		);
		denetle('susturunca kart ışımaz', !zKart().classList.contains('ses-var'));
		denetle('susturmak yalnızca yerel (izle gitmez)', s.oc.gonderilen.filter((m) => m.type === 'izle').length === izleSayisi);
		zKart().querySelector('.yayin-ses button.sus').click();
		await bekle(20);
		denetle('susturma kalktı', w.eval("esler.get('zeynep').yayinSusturuldu") === false && !zOge.muted && !w.localStorage.getItem('yayin-sustur-zeynep'));
		const zSeviye = zKart().querySelector('.yayin-ses input.ses-seviye');
		zSeviye.value = '40';
		zSeviye.dispatchEvent(new w.Event('input', { bubbles: true }));
		denetle('paylaşımın ses seviyesi yalnızca bende, kalıcı', zOge.volume === 0.4 && w.localStorage.getItem('yayin-seviye-zeynep') === '40', String(zOge.volume));
		// zeynep ekranını gösteriyor: görüntü alanı ve "Görüntüyü kapat".
		gelsin({ type: 'kanallar', kanallar: kanalDurumu(ekransizYayin, { yayin: { goruntu: true, ses: true } }) });
		await bekle(30);
		denetle(
			'zeynep ekranını gösterince görüntü alanı açıldı',
			!zKart().classList.contains('ekransiz') && !zKart().querySelector('.yayin-sahne').hidden && !kartDugmesi(zKart(), 'Görüntüyü kapat').hidden && /ekranını gösteriyor/.test(d.getElementById('durum').textContent),
		);
		kartDugmesi(zKart(), 'Görüntüyü kapat').click();
		await bekle(20);
		denetle(
			'görüntüyü kapatınca yayıncıya izle:false gider, ses satırı kalır',
			son('izle') && son('izle').to === 'zeynep' && son('izle').izle === false && zKart().querySelector('.yayin-sahne').hidden && !zKart().querySelector('.yayin-ses').hidden && !!kartDugmesi(zKart(), 'Görüntüyü aç'),
		);
		gelsin({ type: 'kanallar', kanallar: kanalDurumu(ekransizYayin, {}) });
		await bekle(20);
		denetle('paylaşım bitince kart kalktı, ölçer durdu, sonraki paylaşım yine izlenir', !zKart() && w.eval("esler.get('zeynep').izliyorum") === true && !w.eval("esler.get('zeynep').yayinOlcer"));
		// Kendi paylaşımımı durdur.
		kartDugmesi(benimKart(), 'Durdur').click();
		await bekle(20);
		denetle('durdurunca bildirildi, kanallar boşaldı, yakalama bitti', son('yayin').yayin === null && yayinSesi(ilkPc) === null && goruntusu(ilkPc) === null && sIz.readyState === 'ended' && gIz.readyState === 'ended' && !benimKart());
		denetle('yayın alanı gizlendi', d.getElementById('yayinlar').hidden);

		// Ekranlı paylaşım (sesiyle); tarayıcının "Paylaşımı durdur" çubuğu paylaşımı bütünüyle bitirir.
		await menuyuAc();
		menuOgesi('Ekranını paylaş').click();
		await bekle(40);
		const [gIz2, sIz2] = s.oc.ekranIzleri;
		denetle('ekran paylaşımı başladı (ekran + ses)', son('yayin').yayin.goruntu === true && son('yayin').yayin.ses === true && goruntusu(ilkPc) === gIz2 && yayinSesi(ilkPc) === sIz2);
		denetle('ekranlı paylaşımda seçim penceresi bir türe zorlanmaz', !s.oc.ekranSecenek.video.displaySurface && !gIz2.kisit);
		gIz2.bitir();
		await bekle(20);
		denetle('tarayıcı paylaşımı durdurunca hepsi biter', son('yayin').yayin === null && sIz2.readyState === 'ended' && goruntusu(ilkPc) === null && yayinSesi(ilkPc) === null);
		// Sesi seçilmeyen ekransız paylaşım başlamaz.
		s.oc.ekranSesiVer = false;
		const yayinSayisi = s.oc.gonderilen.filter((m) => m.type === 'yayin').length;
		await menuyuAc();
		menuOgesi('Ekransız paylaş').click();
		await bekle(40);
		denetle(
			'sesi seçilmeyen ekransız paylaşım başlamaz, yakalama bırakılır',
			s.oc.gonderilen.filter((m) => m.type === 'yayin').length === yayinSayisi && s.oc.ekranIzleri[0].readyState === 'ended' && /Ses gelmedi/.test(d.getElementById('durum').textContent),
			d.getElementById('durum').textContent,
		);
		// Sesi olmayan ekranlı paylaşımda "Ekranı gizle" yok (gidecek bir şey kalmazdı).
		await menuyuAc();
		menuOgesi('Ekranını paylaş').click();
		await bekle(40);
		denetle('sessiz ekran paylaşımında gizle düğmesi yok', son('yayin').yayin.goruntu === true && son('yayin').yayin.ses === false && kartDugmesi(benimKart(), 'Ekranı gizle').hidden);
		kartDugmesi(benimKart(), 'Durdur').click();
		await bekle(20);
		s.oc.ekranSesiVer = true;
		// Seçim penceresi açılmadan reddeden tarayıcı (ör. "masaüstü sitesi" kipindeki telefon): bir kez
		// söylenir, paylaş düğmesi gizlenir.
		s.oc.ekranReddet = true;
		await menuyuAc();
		menuOgesi('Ekranını paylaş').click();
		await bekle(40);
		denetle('hemen reddedilen paylaşımda düğme gizlenir', d.getElementById('yayin-ac').hidden && /izin vermiyor/.test(d.getElementById('durum').textContent), d.getElementById('durum').textContent);
		s.oc.ekranReddet = false;
	}

	// --- 12c) Firefox/Safari: ekran paylaşımı, ne seçilirse seçilsin, ses vermez. Ekransız paylaşım seçim
	// penceresi açmaz; ses bir ses aygıtından alınır (Linux'ta bilgisayarın sesi "Monitor of …"). Ekran
	// sonradan eklenir (bir kez seçilir); ekranlı paylaşıma ses sonradan eklenir ("Ses ekle").
	{
		w.eval('yayinDesteklenmiyor = false'); // önceki bölümde "izin vermiyor" denendi
		s.oc.ekranSesiYok = true;
		s.oc.ekranSesiVer = false;
		const MIK = { kind: 'audioinput', deviceId: 'mik-1', label: 'Dahili Mikrofon', groupId: 'a' };
		const MONITOR = { kind: 'audioinput', deviceId: 'monitor-1', label: 'Monitor of Built-in Audio Analog Stereo', groupId: 'b' };
		s.oc.aygitlar = [MIK, MONITOR, { kind: 'audiooutput', deviceId: 'cikis-1', label: 'Built-in Audio Analog Stereo', groupId: 'b' }];
		const menu = () => d.getElementById('yayin-menu');
		const menuOgesi = (metin) => [...menu().querySelectorAll('button')].find((b) => b.textContent.includes(metin));
		const menuyuAc = async () => {
			if (menu().hidden) d.getElementById('yayin-ac').click();
			await bekle(20);
		};
		const benimKart = () => d.querySelector('#yayinlar .yayin-kart.ben');
		const kartDugmesi = (kart, metin) => kart && [...kart.querySelectorAll('button')].find((b) => b.textContent === metin);
		const yayinSesi = (pc) => pc._transceivers[1].sender.track;
		const goruntusu = (pc) => pc._transceivers[2].sender.track;
		const pencere = d.getElementById('ses-kaynagi');
		const secim = d.getElementById('ses-kaynagi-aygit');
		const durumMetni = () => d.getElementById('durum').textContent;
		const kayitliAyar = () => JSON.parse(w.localStorage.getItem('ses-ayarlari') || '{}');
		const ekransizAc = async () => {
			await menuyuAc();
			menuOgesi('Ekransız paylaş').click();
			await bekle(40);
		};

		await menuyuAc();
		denetle(
			'Firefox: menü ekransız paylaşımın sesini ses aygıtından alacağını ve "Monitor of" aygıtını söylüyor',
			/ses aygıtından/.test(menuOgesi('Ekransız paylaş').textContent) && /Monitor of/.test(menu().querySelector('.yayin-menu-not').textContent),
			menu().textContent,
		);
		// Tarayıcının hangi çıkışa çaldığı bilinmiyor ve bilgisayar sesi gibi iki aygıt var: sorulur.
		const MONITOR2 = { kind: 'audioinput', deviceId: 'monitor-2', label: 'Monitor of HDMI Output', groupId: 'c' };
		const CIKIS1 = { kind: 'audiooutput', deviceId: 'cikis-1', label: 'Built-in Audio Analog Stereo', groupId: 'b' };
		const CIKIS2 = { kind: 'audiooutput', deviceId: 'cikis-2', label: 'HDMI Output', groupId: 'c' };
		s.oc.aygitlar = [MIK, MONITOR, MONITOR2];
		const ekranOnce = s.oc.ekranSayisi;
		menuOgesi('Ekransız paylaş').click();
		await bekle(40);
		denetle('Firefox: ekransız paylaşım seçim penceresi açmaz; çıkış bilinmiyor ve iki "Monitor" varsa ses aygıtı sorar', s.oc.ekranSayisi === ekranOnce && !pencere.hidden);
		const secenekler = () => [...secim.options].map((o) => o.textContent);
		denetle(
			'bilgisayarın sesleri (Monitor of …) başta, ilki seçili; mikrofon da listede, işaretli',
			secim.options.length === 3 && secim.options[0].value === 'monitor-1' && /^Bilgisayarın sesi · Monitor of/.test(secim.options[0].textContent) && secim.value === 'monitor-1' && /Dahili Mikrofon · mikrofonun/.test(secim.options[2].textContent),
			secenekler().join(' | '),
		);
		denetle(
			'pencerede yankı engelleme seçeneği yok (kanaldakilerin sesi hep çıkarılır), "bulunamadı" ipucu gizli',
			!d.getElementById('ses-kaynagi-yanki') && !pencere.querySelector('input[type=checkbox]') && /kendiliğinden çıkarılır/.test(pencere.textContent) && d.getElementById('ses-kaynagi-ipucu').hidden,
		);
		d.getElementById('ses-kaynagi-iptal').click();
		await bekle(10);
		denetle('iptal: pencere kapandı, paylaşım başlamadı', pencere.hidden && !w.eval('yayinVar()') && s.oc.aygitKisit === null);

		// Tarayıcının çaldığı çıkış (çıkışların ilki: sistemin varsayılanı) belli: onun "Monitor"u sorulmadan.
		s.oc.aygitlar = [MIK, MONITOR, MONITOR2, CIKIS1, CIKIS2];
		await ekransizAc();
		await bekle(40);
		const k = s.oc.aygitKisit || {};
		denetle('sorulmadan (pencere açılmadan) tarayıcının çaldığı çıkışın "Monitor"u paylaşıldı', pencere.hidden && k.deviceId && k.deviceId.exact === 'monitor-1', JSON.stringify(k));
		denetle(
			'ses seçilen aygıttan: stereo, tarayıcının yankı engelleme, gürültü bastırma ve otomatik kazancı kapalı',
			k.deviceId && k.deviceId.exact === 'monitor-1' && k.echoCancellation === false && k.noiseSuppression === false && k.autoGainControl === false && k.channelCount && k.channelCount.ideal === 2,
			JSON.stringify(k),
		);
		const aIz = s.oc.aygitIzi;
		denetle('ekransız paylaşım bildirildi: görüntü yok, ses var', pencere.hidden && son('yayin').yayin && son('yayin').yayin.goruntu === false && son('yayin').yayin.ses === true, JSON.stringify(son('yayin')));
		// Kanaldakilerin sesini çıkaran düzenek: worklet + worker; giden iz onun çıkışı.
		const cDugum = s.oc.workletDugumleri.at(-1);
		const cIsci = s.oc.isciler.at(-1);
		const cIz = s.oc.hedefIzleri.at(-1);
		denetle(
			'çıkarıcı kuruldu: worklet (yakalanan + 20 yuva, stereo çıkış) ve tahmin işçisi yanki.js\'ten',
			s.oc.workletModulu === 'yanki.js' && cDugum && cDugum.ad === 'yanki-cikarici' && cDugum.secenek.numberOfInputs === 21 && cDugum.secenek.outputChannelCount[0] === 2 && cIsci && cIsci.adres === 'yanki.js' && cIsci.gelen[0].tur === 'kur' && cIsci.gelen[0].hiz === 48000,
		);
		denetle(
			'herkese çıkarıcının çıkışı gidiyor (aygıtın ham sesi değil); görüntü yok; mikrofon kanalı değişmedi',
			cIz && yayinSesi(ilkPc) === cIz && yayinSesi(zPc) === cIz && w.eval('yayin.hamSes') === aIz && goruntusu(ilkPc) === null && goruntusu(zPc) === null && ilkPc._transceivers[0].sender.track === s.oc.sonIz,
		);
		denetle('çıkarılamıyor uyarısı yok', !/çıkarılamıyor/.test(durumMetni()) && /Monitor of/.test(durumMetni()), durumMetni());
		// Referans: kanaldakilerin çalınan sesleri, <audio>'su ne çalıyorsa o seviyede (bora'yı %37'ye
		// kısmıştık; zeynep'in paylaşımının sesi de çalıyor). Mikrofon izleri şimdi gelsin.
		for (const pc of [ilkPc, zPc]) pc.ontrack({ transceiver: pc._transceivers[0], track: pc._transceivers[0].receiver.track });
		await bekle(10);
		const referans = () => w.eval('[...yayin.yanki.referans.entries()].map(([a, r]) => ({ akis: a, g: r.kazanc.gain.value }))');
		const ogeler = () => w.eval('[...esler.values()].flatMap((e) => [e.ses, e.yayinSesOgesi]).filter((a) => a && a.srcObject)');
		const uyuyor = () => {
			const r = referans();
			const o = ogeler();
			return r.length === o.length && o.every((a) => {
				const x = r.find((y) => y.akis === a.srcObject);
				return x && Math.abs(x.g - (a.muted || a.paused ? 0 : a.volume)) < 1e-9;
			});
		};
		const refKazanc = (ad) => (referans().find((r) => r.akis === w.eval(`esler.get('${ad}').ses.srcObject`)) || {}).g;
		denetle(
			'referans: çalınan her ses (iki mikrofon, bir paylaşım), <audio>\'su ne çalıyorsa o seviyede',
			referans().length === 3 && uyuyor() && Math.abs(refKazanc('bora') - 0.37) < 1e-9,
			JSON.stringify({ referans: referans().map((r) => r.g), ogeler: ogeler().map((a) => [a.volume, a.muted, a.paused]) }),
		);
		w.eval("esler.get('zeynep').seviye = 40; esSesUygula(esler.get('zeynep'))");
		denetle('referans seviyeyi izler', Math.abs(refKazanc('zeynep') - 0.4) < 1e-9 && uyuyor(), String(refKazanc('zeynep')));
		w.eval("esler.get('zeynep').susturuldu = true; esSesUygula(esler.get('zeynep'))");
		denetle('susturulan eş referansta 0 (çalınmıyor)', refKazanc('zeynep') === 0 && uyuyor(), String(refKazanc('zeynep')));
		w.eval("esler.get('zeynep').susturuldu = false; esler.get('zeynep').seviye = 100; esSesUygula(esler.get('zeynep'))");
		denetle('susturma kalkınca referans geri geldi', refKazanc('zeynep') === 1 && uyuyor(), String(refKazanc('zeynep')));
		w.eval("esler.get('bora').ses.pause()");
		denetle('duran <audio> referansta hemen 0', refKazanc('bora') === 0, String(refKazanc('bora')));
		w.eval("esler.get('bora').ses.play()");
		denetle('yeniden çalınca referansa döndü', Math.abs(refKazanc('bora') - 0.37) < 1e-9 && uyuyor(), String(refKazanc('bora')));
		// Sayfa worklet ile işçi arasında iletir: örnekler işçiye, süzgeç worklet'e (ve teşhise).
		// Her çalınan akış kendi yuvasında (gecikmeleri ayrı olabilir): worklet'in 1 + yuva girişine bağlı.
		const yuvalar = () => w.eval('[...yayin.yanki.referans.values()]');
		denetle(
			'her akış ayrı yuvada, worklet\'in kendi girişine bağlı',
			yuvalar().length === 3 && new Set(yuvalar().map((r) => r.yuva)).size === 3 && yuvalar().every((r) => r.yuva >= 0 && r.yuva < 20 && r.kazanc.baglanti && r.kazanc.baglanti[0] === cDugum && r.kazanc.baglanti[2] === 1 + r.yuva),
			JSON.stringify(yuvalar().map((r) => [r.yuva, r.kazanc.baglanti && r.kazanc.baglanti[2]])),
		);
		const ornek = { tur: 'ornek', m: new w.Float32Array(8), r: { 0: new w.Float32Array(8), 2: new w.Float32Array(8) } };
		cDugum.port.onmessage({ data: ornek });
		denetle('worklet örnekleri (yakalanan + sesi olan yuvalar) işçiye iletildi', cIsci.gelen.at(-1) === ornek);
		const taniOnce = s.oc.gonderilen.filter((m) => m.type === 'tani').length;
		const suzgec = { tur: 'suzgec', yuva: 2, D0: 3500, w: new w.Float32Array(48), azalmaDb: 21.3, guven: 80, kazanc: 0.9 };
		cIsci.onmessage({ data: suzgec });
		const tani = s.oc.gonderilen.filter((m) => m.type === 'tani').slice(taniOnce);
		denetle(
			'işçinin süzgeci (yuvasıyla) worklet\'e iletildi; ilk süzgeç teşhise yazıldı (gecikme)',
			cDugum.giden.at(-1) === suzgec && tani.length === 1 && tani[0].veri.olay === 'yayin-yanki' && tani[0].veri.gecikmeMs === 73.4 && tani[0].veri.yuva === 2,
			JSON.stringify(tani),
		);
		// Yakalama gecikmesi sondası: sayfa çıkışına tiz, kısık bir ses çalınır, worklet'e ne zaman çalındığı
		// bildirilir; worklet'in ölçtüğü gecikme teşhise yazılır. Yakalanan sesteki kopukluklar da (toplanarak).
		w.eval('yakalamaSondasi()');
		const sonda = cDugum.giden.filter((v) => v.tur === 'sonda').at(-1);
		denetle('sonda: worklet\'e çalınma zamanı ve süresi bildirildi', sonda && typeof sonda.t0 === 'number' && sonda.sure === 0.04, JSON.stringify(sonda));
		cDugum.port.onmessage({ data: { tur: 'sonda', gecikme: 0.2154, snr: 420 } });
		const sTani = s.oc.gonderilen.filter((m) => m.type === 'tani' && m.veri.olay === 'yakalama-gecikmesi').at(-1);
		denetle('sonda sonucu teşhise yazıldı (ms, mikrofon açık mı)', sTani && sTani.veri.ms === 215 && sTani.veri.snr === 420 && typeof sTani.veri.mikrofon === 'boolean' && w.eval('yayin.yanki.sondalar.at(-1)') === 215, JSON.stringify(sTani));
		cDugum.port.onmessage({ data: { tur: 'kopukluk', olaylar: [{ ms: 40, uzun: false }] } });
		cDugum.port.onmessage({ data: { tur: 'kopukluk', olaylar: [{ ms: 900, uzun: true }] } });
		await bekle(3200);
		const kTani = s.oc.gonderilen.filter((m) => m.type === 'tani' && m.veri.olay === 'yakalama-kopuklugu');
		denetle('yakalamadaki kopukluklar toplanıp tek satırda teşhise yazıldı', kTani.length === 1 && JSON.stringify(kTani[0].veri.ms) === JSON.stringify([40, '900*']), JSON.stringify(kTani));
		// Akış gidince (bağlantı yeniden kuruldu, kişi çıktı) yuvası boşalır: worklet de işçi de unutur.
		const boraYuva = w.eval("yayin.yanki.referans.get(esler.get('bora').ses.srcObject).yuva");
		const boraKazanc = w.eval("yayin.yanki.referans.get(esler.get('bora').ses.srcObject).kazanc");
		const boraAkis = w.eval("esler.get('bora').ses.srcObject");
		w.eval("esler.get('bora').ses.srcObject = null; yankiReferansGuncelle()");
		denetle(
			'giden akışın yuvası boşaldı, worklet\'e ve işçiye bildirildi',
			yuvalar().length === 2 && !boraKazanc.baglanti && cDugum.giden.some((v) => v.tur === 'yuva-bos' && v.yuva === boraYuva) && cIsci.gelen.some((v) => v.tur === 'yuva-bos' && v.yuva === boraYuva),
		);
		w.eval('(a) => { esler.get("bora").ses.srcObject = a; yankiReferansGuncelle(); }')(boraAkis);
		denetle('yeniden gelen akışa boş yuva verildi', yuvalar().length === 3 && new Set(yuvalar().map((r) => r.yuva)).size === 3);
		// Ses bağlamı durursa çıkarıcının çıkışı sessizleşir: ham ses gider; bağlam dönünce çıkarıcıya dönülür.
		const bag = w.eval('baglam');
		bag.state = 'suspended';
		bag.onstatechange();
		await bekle(10);
		denetle('ses bağlamı durunca aygıtın ham sesi gidiyor', yayinSesi(ilkPc) === aIz && yayinSesi(zPc) === aIz);
		bag.state = 'running';
		bag.onstatechange();
		await bekle(10);
		denetle('bağlam dönünce yeniden çıkarıcının çıkışı', yayinSesi(ilkPc) === cIz && yayinSesi(zPc) === cIz);
		denetle('seçilen aygıt hatırlandı (yankı engelleme seçimi artık yok)', kayitliAyar().yayinAygitId === 'monitor-1' && !('yayinYanki' in kayitliAyar()), JSON.stringify(kayitliAyar()));
		denetle(
			'kendi kartım: ekransız, "Ekranı göster" var, "Ses ekle" yok, kaynak aygıt yazıyor',
			!!benimKart() && benimKart().classList.contains('ekransiz') && !!kartDugmesi(benimKart(), 'Ekranı göster') && kartDugmesi(benimKart(), 'Ses ekle').hidden && /Monitor of/.test(benimKart().querySelector('.yayin-metin').title) && /Monitor of/.test(durumMetni()),
			benimKart() && benimKart().textContent,
		);
		// Ekranı göster: seçim penceresi bir kez açılır, yalnızca görüntü istenir.
		kartDugmesi(benimKart(), 'Ekranı göster').click();
		await bekle(40);
		const gIz = s.oc.ekranIzleri[0];
		denetle(
			'ekran eklendi: seçim penceresinden yalnızca görüntü istendi, izleyenlere gidiyor, ses aynı',
			s.oc.ekranSayisi === ekranOnce + 1 && s.oc.ekranSecenek.audio === false && goruntusu(ilkPc) === gIz && goruntusu(zPc) === gIz && yayinSesi(ilkPc) === cIz && son('yayin').yayin.goruntu === true,
			JSON.stringify(s.oc.ekranSecenek),
		);
		kartDugmesi(benimKart(), 'Ekranı gizle').click();
		await bekle(30);
		denetle('ekran gizlendi: görüntü gitmiyor, yakalama ve ses sürüyor', goruntusu(ilkPc) === null && gIz.readyState === 'live' && yayinSesi(ilkPc) === cIz && son('yayin').yayin.goruntu === false);
		kartDugmesi(benimKart(), 'Ekranı göster').click();
		await bekle(30);
		denetle('ekran yeniden göründü, seçim penceresi yeniden açılmadı', goruntusu(ilkPc) === gIz && s.oc.ekranSayisi === ekranOnce + 1);
		// Tarayıcının "Paylaşımı durdur"u yalnızca ekranı bitirir: ses aygıttan geldiği için sürer.
		gIz.bitir();
		await bekle(30);
		denetle(
			'ekran bitince paylaşım ekransız sürüyor',
			son('yayin').yayin && son('yayin').yayin.goruntu === false && son('yayin').yayin.ses === true && goruntusu(ilkPc) === null && yayinSesi(ilkPc) === cIz && aIz.readyState === 'live' && !!benimKart(),
			JSON.stringify(son('yayin')),
		);
		// Aygıt kapandı (çıkarıldı, izin geri alındı): paylaşılacak bir şey kalmadı.
		aIz.bitir();
		await bekle(30);
		denetle('ses aygıtı kapanınca paylaşım bitti, söylendi', son('yayin').yayin === null && yayinSesi(ilkPc) === null && !benimKart() && /Ses aygıtı kapandı/.test(durumMetni()), durumMetni());
		denetle(
			'paylaşım bitince çıkarıcı kapandı: işçi durdu, worklet bitti, çıkış izi bırakıldı',
			cIsci.bitti === true && cDugum.koptu === true && cDugum.giden.some((v) => v.tur === 'bitir') && cIz.readyState === 'ended' && w.eval('yayin.yanki') === null && w.eval('yayin.hamSes') === null,
		);

		// Ekranlı paylaşım: ses gelmez; "Ses ekle" ile aygıttan eklenir. Bu kez tarayıcı AudioWorklet
		// sunmuyor: aygıtın ham sesi gider, kanaldakilerin sesinin çıkarılamadığı söylenir.
		await menuyuAc();
		menuOgesi('Ekranını paylaş').click();
		await bekle(40);
		const gIz2 = s.oc.ekranIzleri[0];
		denetle(
			'Firefox: sessiz ekran paylaşımında "Ses ekle" önerilir',
			son('yayin').yayin.goruntu === true && son('yayin').yayin.ses === false && !!kartDugmesi(benimKart(), 'Ses ekle') && !kartDugmesi(benimKart(), 'Ses ekle').hidden && /Ses ekle/.test(durumMetni()),
			durumMetni(),
		);
		await menuyuAc();
		denetle('menüde de "Ses ekle" var', !!menuOgesi('Ses ekle'));
		// Ses ayarlarında başka bir hoparlör seçili: sayfa oraya çalıyor, onun "Monitor"u alınır.
		w.eval("ayar.cikisId = 'cikis-2'");
		s.oc.workletYok = true;
		w.eval('yankiModulu = null');
		const isciOnce = s.oc.isciler.length;
		menuOgesi('Ses ekle').click();
		await bekle(60);
		denetle('ses ayarlarında seçili hoparlörün "Monitor"u sorulmadan alındı', pencere.hidden && s.oc.aygitKisit.deviceId.exact === 'monitor-2', JSON.stringify(s.oc.aygitKisit));
		w.eval("ayar.cikisId = ''");
		const aIz2 = s.oc.aygitIzi;
		denetle(
			'ekranlı paylaşıma ses eklendi (AudioWorklet yok: ham ses), ekran sürüyor',
			aIz2 !== aIz && s.oc.aygitKisit.echoCancellation === false && yayinSesi(ilkPc) === aIz2 && goruntusu(ilkPc) === gIz2 && son('yayin').yayin.goruntu === true && son('yayin').yayin.ses === true && s.oc.isciler.length === isciOnce && w.eval('yayin.yanki') === null,
		);
		denetle('kanaldakilerin sesi çıkarılamıyorsa söylenir', /çıkarılamıyor/.test(durumMetni()) && d.getElementById('durum').classList.contains('hata'), durumMetni());
		s.oc.workletYok = false;
		w.eval('yankiModulu = null');
		denetle('ses eklenince "Ses ekle" kalktı, "Ekranı gizle" geldi', kartDugmesi(benimKart(), 'Ses ekle').hidden && !!kartDugmesi(benimKart(), 'Ekranı gizle') && !kartDugmesi(benimKart(), 'Ekranı gizle').hidden);
		kartDugmesi(benimKart(), 'Durdur').click();
		await bekle(20);
		denetle('durdurunca ekran da aygıt da bırakıldı', son('yayin').yayin === null && gIz2.readyState === 'ended' && aIz2.readyState === 'ended' && !benimKart());

		// İzin verilmezse paylaşım başlamaz.
		s.oc.aygitHata = 'NotAllowedError';
		await ekransizAc();
		await bekle(40);
		denetle('aygıta izin verilmezse paylaşım başlamaz, söylenir', !w.eval('yayinVar()') && /izin verilmedi/.test(durumMetni()), durumMetni());
		s.oc.aygitHata = '';

		// Bilgisayarın sesi gibi bir aygıt yoksa ipucu görünür; mikrofon olmayan ilk aygıt seçilir. Adlar
		// izin verilmeden gizliyse bir kez izin istenir.
		s.oc.aygitlar = [MIK, { kind: 'audioinput', deviceId: 'usb-1', label: 'USB Ses Kartı', groupId: 'c' }];
		s.oc.etiketGizli = true;
		const izinOnce = s.oc.izinIstegi;
		await ekransizAc();
		denetle('aygıt adları gizliyse bir kez izin istendi, adlar göründü', s.oc.izinIstegi === izinOnce + 1 && secenekler().includes('USB Ses Kartı'), secenekler().join(' | '));
		denetle('bilgisayarın sesi yoksa ipucu görünür, mikrofon olmayan aygıt seçilir', !d.getElementById('ses-kaynagi-ipucu').hidden && secim.value === 'usb-1', secim.value);
		d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await bekle(10);
		denetle('Escape ses kaynağı penceresini kapattı', pencere.hidden && !w.eval('yayinVar()'));

		s.oc.ekranSesiYok = false;
		s.oc.ekranSesiVer = true;
		s.oc.aygitlar = [];
	}

	// --- 13) sunucu bağlantısı koptu: ses bağlantıları KAPANMAZ, geri gelince kanala devam edilir
	const pcSayisi = s.FakePC.hepsi.filter((p) => !p.kapandi).length;
	const eskiWs = s.oc.ws;
	eskiWs.close();
	await bekle(30);
	denetle('kopunca uygulama ekranında kalındı', d.getElementById('giris-ekrani').hidden === true);
	denetle('kopunca ses bağlantıları kapanmadı', s.FakePC.hepsi.filter((p) => !p.kapandi).length === pcSayisi && w.eval('esler.size') === 2, `${pcSayisi} → ${s.FakePC.hepsi.filter((p) => !p.kapandi).length}`);
	denetle('bağlantı rozeti göründü', d.getElementById('baglanti-durumu').hidden === false);
	await bekle(800);
	denetle('yeniden bağlanıldı', s.oc.ws !== eskiWs);
	const yeniGiris = son('giris');
	denetle('yeniden girişte sürdürülecek sesli kanal bildirildi', yeniGiris && yeniGiris.ses === 'sesli-sohbet' && yeniGiris.anahtar === 'f'.repeat(128), JSON.stringify(yeniGiris));
	// Giriş freni: uygulamadan atılmadan bekleyip yeniden dener.
	gelsin({ type: 'giris-red', message: 'Çok sık deneme; 1 saniye sonra tekrar dene.', kod: 'fren', bekle: 100 });
	await bekle(30);
	denetle('frende uygulama ekranında kalındı', d.getElementById('giris-ekrani').hidden === true && w.eval('esler.size') === 2);
	await bekle(1500);
	gelsin({ type: 'hazir', ad: 'taha', kanallar, kimler: [{ ad: 'taha' }], max: 10, maxKullanici: 10, beyazListe: 2, beyazListeAdlari: ['taha', 'bora'], sunulanDosyalar: [], ice: ICE, surum: 'v1', turnNesli: 'n1' });
	await bekle(40);
	const devamGir = son('ses-gir');
	denetle('geri gelince kanala devam edildi (devam:true)', devamGir && devamGir.devam === true && devamGir.kanal === 'sesli-sohbet', JSON.stringify(devamGir));
	gelsin({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: ['bora', 'zeynep'], ice: ICE, devam: true });
	await bekle(40);
	denetle('devamda bağlantılar yeniden kurulmadı', s.FakePC.hepsi.filter((p) => !p.kapandi).length === pcSayisi);

	// --- 13b) ölü bağlantı: telefon uyanınca (sayfa öne gelince) sunucu yoklanır. Yanıt gelirse
	// bağlantı korunur; gelmezse (TCP sessizce kopmuş, tarayıcı fark etmemiş) hemen yeniden bağlanılır
	// ve sesli kanala devam edilir; P2P ses bağlantıları kapanmaz.
	{
		// Önceki adımların uzun beklemelerinden kalmış olabilecek yoklamayı temizle (senaryo yalıtılsın).
		gelsin({ type: 'pong' });
		w.eval('clearTimeout(canlilikZamanlayici); canlilikZamanlayici = null');
		const once = s.oc.wsler.length;
		const pingler = () => s.oc.gonderilen.filter((m) => m.type === 'ping').length;
		const p0 = pingler();
		d.dispatchEvent(new w.Event('visibilitychange'));
		await bekle(20);
		denetle('öne gelince sunucu yoklanır (ping)', pingler() === p0 + 1, `${p0} → ${pingler()}`);
		gelsin({ type: 'pong' });
		await bekle(6300);
		denetle('yanıt veren bağlantı korunur', s.oc.wsler.length === once, `${once} → ${s.oc.wsler.length}`);
		d.dispatchEvent(new w.Event('visibilitychange'));
		await bekle(7200);
		denetle('yanıtsız bağlantı ölü sayılır, hemen yeniden bağlanılır', s.oc.wsler.length === once + 1, `${once} → ${s.oc.wsler.length}`);
		denetle('ölü bağlantıda ses bağlantıları kapanmadı', s.FakePC.hepsi.filter((p) => !p.kapandi).length === pcSayisi && w.eval('esler.size') === 2);
		denetle('yeniden girişte sesli kanal sürdürülür', son('giris') && son('giris').ses === 'sesli-sohbet', JSON.stringify(son('giris')));
		gelsin({ type: 'hazir', ad: 'taha', kanallar, kimler: [{ ad: 'taha' }], max: 10, maxKullanici: 10, beyazListe: 2, beyazListeAdlari: ['taha', 'bora'], sunulanDosyalar: [], ice: ICE, surum: 'v1', turnNesli: 'n1' });
		await bekle(40);
		denetle('ölü bağlantıdan sonra kanala devam edildi (devam:true)', son('ses-gir') && son('ses-gir').devam === true);
		gelsin({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: ['bora', 'zeynep'], ice: ICE, devam: true });
		await bekle(40);
		denetle('ölü bağlantıdan sonra ses bağlantıları yeniden kurulmadı', s.FakePC.hepsi.filter((p) => !p.kapandi).length === pcSayisi);

		// Arka plana geçerken sesli kanal not edilir (tarayıcı sayfayı kapatırsa geri dönülsün); öne
		// gelince silinir.
		Object.defineProperty(d, 'visibilityState', { value: 'hidden', configurable: true });
		d.dispatchEvent(new w.Event('visibilitychange'));
		const not = JSON.parse(w.sessionStorage.getItem('ses-devam') || 'null');
		denetle('arka plana geçerken sesli kanal not edilir', not && not.kanal === 'sesli-sohbet', JSON.stringify(not));
		delete d.visibilityState;
		d.dispatchEvent(new w.Event('visibilitychange'));
		gelsin({ type: 'pong' });
		denetle('öne gelince not silinir', !w.sessionStorage.getItem('ses-devam'));
	}

	// --- 14) çık-gir
	d.getElementById('ben-kapat').click();
	await bekle(30);
	denetle('ses-cik gönderildi', s.oc.gonderilen.some((m) => m.type === 'ses-cik'));
	denetle('ses kartı kapandı', d.getElementById('ses-karti').hidden === true);
	denetle('ayrılınca bağlantılar kapandı', s.FakePC.hepsi.every((p) => p.kapandi));
	denetle('ayrılınca mikrofon bırakıldı', s.oc.sonIz.readyState === 'ended');
	const mikIstekleri = s.oc.mikrofon; // susturma/sağırlık da mikrofonu bırakıp yeniden aldı (yukarıda)
	sesDugme().click();
	await bekle(60);
	denetle('yeniden girişte mikrofon tekrar istendi', s.oc.mikrofon === mikIstekleri + 1, `${mikIstekleri} → ${s.oc.mikrofon}`);
	gelsin({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: ['bora'], ice: ICE, devam: false });
	await bekle(40);
	denetle('ses kartı yeniden açıldı', d.getElementById('ses-karti').hidden === false);

	// --- 14b) sunucu penceresi: veritabanı boyutu ve sohbeti temizle (beyaz liste dokunulmaz)
	{
		d.getElementById('sunucu-ac').click();
		await bekle(20);
		denetle('sunucu penceresi açıldı, bilgi istendi', !d.getElementById('sunucu-pencere').hidden && !!son('sunucu-bilgi'));
		gelsin({ type: 'sunucu-bilgi', veritabani: 5 * 1048576 + 300000, mesaj: 1234, dosya: 12, bosAlan: 8 * 1024 ** 3, surum: 'v9' });
		await bekle(20);
		denetle('veritabanı boyutu ve mesaj sayısı gösterildi', d.getElementById('vt-boyut').textContent === '5,3 MB' && d.getElementById('vt-mesaj').textContent === '1.234' && d.getElementById('vt-bos').textContent === '8 GB', `${d.getElementById('vt-boyut').textContent} ${d.getElementById('vt-mesaj').textContent} ${d.getElementById('vt-bos').textContent}`);
		const secenekler = [...d.getElementById('temizle-kanal').options].map((o) => o.value).join(',');
		denetle('temizlik için kanal seçenekleri (tümü + yazılı kanallar)', secenekler === ',genel,muhabbet', secenekler);
		d.getElementById('temizle-kanal').value = 'genel';
		d.getElementById('temizle-gun').value = '30';
		d.getElementById('temizle').click();
		await bekle(20);
		const onayMetni = d.getElementById('pencere-metin').textContent;
		denetle('temizlik onay ister, kapsamı ve kalanları söyler', !d.getElementById('pencere').hidden && /#genel kanalındaki 1 aydan eski mesajlar/.test(onayMetni) && /Beyaz liste, kanallar ve ayarlar değişmez/.test(onayMetni), onayMetni);
		d.getElementById('pencere-form').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
		await bekle(20);
		denetle('onaylayınca sohbet-temizle gönderildi', son('sohbet-temizle') && son('sohbet-temizle').kanal === 'genel' && son('sohbet-temizle').gun === 30, JSON.stringify(son('sohbet-temizle')));
		const gecmisOnce = s.oc.gonderilen.filter((m) => m.type === 'gecmis').length;
		gelsin({ type: 'sohbet-temizlendi', kanal: '', gun: 0, ad: 'bora', silinen: 1234 });
		await bekle(20);
		denetle('temizlenince açık kanalın geçmişi yeniden istendi', s.oc.gonderilen.filter((m) => m.type === 'gecmis').length === gecmisOnce + 1 && d.querySelectorAll('#mesajlar .mesaj').length === 0);
		denetle('temizlik herkese bildirildi', /bora sohbeti temizledi/.test(d.getElementById('durum').textContent), d.getElementById('durum').textContent);
		d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await bekle(20);
		denetle('Escape sunucu penceresini kapattı', d.getElementById('sunucu-pencere').hidden);
	}

	// --- 15) kanal silinirse: aktif kanal ilk yazılı kanala döner, sesli kanaldan çıkılır
	gelsin({ type: 'kanallar', kanallar: [{ id: 'muhabbet', ad: 'muhabbet', tur: 'yazi' }] });
	await bekle(40);
	denetle('silinen sesli kanaldan çıkıldı', d.getElementById('ses-karti').hidden === true);

	// --- 16) oturum başka sekmeye geçti
	sesDugme; // (sesli kanal yok artık)
	gelsin({ type: 'oturum-devralindi', message: 'Bu hesapla başka bir sekmede ya da cihazda girildi.' });
	await bekle(30);
	denetle('devirde giriş ekranı', d.getElementById('giris-ekrani').hidden === false);
	denetle('"Bu sekmede devam et" düğmesi', d.getElementById('burada-devam').hidden === false && d.getElementById('gir').hidden === true);
	const wsSayisi = s.oc.wsler.length;
	await bekle(1200);
	denetle('devirde kendiliğinden yeniden bağlanılmadı', s.oc.wsler.length === wsSayisi);
	d.getElementById('burada-devam').click();
	await bekle(30);
	denetle('"Bu sekmede devam et" yeniden bağlanır', s.oc.wsler.length === wsSayisi + 1);
	gelsin({ type: 'hazir', ad: 'taha', kanallar, kimler: [{ ad: 'taha' }], max: 10, maxKullanici: 10, beyazListe: 2, beyazListeAdlari: ['taha'], sunulanDosyalar: [], ice: ICE, surum: 'v1' });
	await bekle(30);
	denetle('devamdan sonra uygulama açık', d.getElementById('uygulama').hidden === false);

	// --- 17) atıldım: anahtar silinir, giriş ekranına dönülür
	gelsin({ type: 'atildi', message: 'Sunucudan atıldın; tekrar izin iste.' });
	await bekle(40);
	denetle('atılınca anahtar silindi', !w.localStorage.getItem('anahtar'));
	denetle('atılınca giriş ekranı açıldı', d.getElementById('giris-ekrani').hidden === false && d.getElementById('uygulama').hidden === true);
	denetle('atılma mesajı gösterildi', /atıldın/i.test(d.getElementById('giris-durum').textContent), d.getElementById('giris-durum').textContent);

	// --- 18) hata gösterimi
	d.getElementById('giris-ekrani').hidden = true;
	d.getElementById('uygulama').hidden = false;
	w.eval('baglan()');
	await bekle(20);
	gelsin({ type: 'hata', message: 'Çok hızlı yazıyorsun; birkaç saniye bekle.' });
	await bekle(20);
	denetle('hata bildirimi göründü', d.getElementById('durum').textContent.includes('hızlı'), d.getElementById('durum').textContent);
	denetle('hata kırmızı', d.getElementById('durum').classList.contains('hata'));

	// --- 19) ses ayarları penceresi
	d.getElementById('ben-ayarlar').click();
	await bekle(30);
	denetle('ses ayarları açıldı', d.getElementById('ayarlar').hidden === false);
	denetle('ayarlar varsayılanları gösteriyor', d.getElementById('ayar-gurultu').checked && d.getElementById('ayar-yanki').checked && !d.getElementById('ayar-kazanc').checked && d.getElementById('ayar-kalite').value === '96');
	d.getElementById('ayar-kalite').value = '128';
	d.getElementById('ayar-kalite').dispatchEvent(new w.Event('change', { bubbles: true }));
	denetle('kalite ayarı kalıcı', JSON.parse(w.localStorage.getItem('ses-ayarlari')).kalite === 128);
	d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	await bekle(20);
	denetle('Escape ayarları kapattı', d.getElementById('ayarlar').hidden === true);

	// --- 20) sesli kanaldayken sayfa arka planda tarayıcı tarafından kapatıldıysa (bellek), geri
	// dönülünce sesli kanala kendiliğinden girilir; eski (10 dakikadan eski) not yok sayılır.
	{
		const yeniHazir = { type: 'hazir', ad: 'taha', kanallar, kimler: [{ ad: 'taha' }], max: 10, maxKullanici: 10, beyazListe: 1, beyazListeAdlari: ['taha'], sunulanDosyalar: [], ice: ICE, surum: 'v1' };
		const notla = (dk) => ({ 'ses-devam': JSON.stringify({ kanal: 'sesli-sohbet', zaman: Date.now() - dk * 60000 }) });
		const t = kur({ depo: { anahtar: 'f'.repeat(128), ad: 'taha' }, oturumDepo: notla(1) });
		await bekle(40);
		t.oc.ws.onmessage({ data: JSON.stringify(yeniHazir) });
		await bekle(600);
		const sg = t.oc.gonderilen.filter((m) => m.type === 'ses-gir').at(-1);
		denetle('arka planda kapatılan sayfa açılınca sesli kanala geri girer', sg && sg.kanal === 'sesli-sohbet', JSON.stringify(sg));
		denetle('not kullanılınca silinir', !t.window.sessionStorage.getItem('ses-devam'));
		const u = kur({ depo: { anahtar: 'f'.repeat(128), ad: 'taha' }, oturumDepo: notla(20) });
		await bekle(40);
		u.oc.ws.onmessage({ data: JSON.stringify(yeniHazir) });
		await bekle(600);
		denetle('10 dakikadan eski not yok sayılır', !u.oc.gonderilen.some((m) => m.type === 'ses-gir'));
	}

	// --- 21) ekran paylaşımı sunmayan tarayıcı (çoğu telefon): paylaş düğmesi yok; paylaşılanı izler
	// ve dinler (yukarıdaki yayın kartları her cihazda aynı).
	{
		const t = kur({ ekranYok: true });
		await bekle(20);
		denetle('ekran paylaşımı olmayan tarayıcıda paylaş düğmesi gizli', t.d.getElementById('yayin-ac').hidden === true);
		const u = kur();
		await bekle(20);
		denetle('ekran paylaşımı olan tarayıcıda paylaş düğmesi görünür', u.d.getElementById('yayin-ac').hidden === false);
	}

	// --- 22) kayıplara karşı yedek (RED): tarayıcı RED biliyorsa iki ses kanalında (mikrofon, paylaşımın
	// sesi) RED Opus'un önünde (teklifte de yanıtta da; görüntüye dokunulmaz). Bir eşten gelen ses
	// RED'le çözülemiyorsa (paket geliyor, ses hep uyduruluyor) o eşte RED bırakılır ve yeniden anlaşılır.
	{
		const t = kur({ red: true, depo: { anahtar: 'f'.repeat(128), ad: 'taha' } });
		const tw = t.window;
		const tgel = (m) => t.oc.ws.onmessage({ data: JSON.stringify(m) });
		const tson = (tur) => t.oc.gonderilen.filter((m) => m.type === tur).at(-1);
		await bekle(40);
		tgel({ type: 'hazir', ad: 'taha', kanallar, kimler: [{ ad: 'taha' }, { ad: 'bora' }, { ad: 'zeynep' }], max: 10, maxKullanici: 10, beyazListe: 3, beyazListeAdlari: ['taha', 'bora', 'zeynep'], sunulanDosyalar: [], ice: ICE, surum: 'v1' });
		await bekle(40);
		tw.eval("sesAc('sesli-sohbet')");
		await bekle(60);
		tgel({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: ['bora'], ice: ICE, devam: false });
		await bekle(60);
		const bPc = t.FakePC.hepsi.at(-1);
		const ilk = (tr) => (tr.kodekler && tr.kodekler[0] ? tr.kodekler[0].mimeType : null);
		denetle('RED: teklifte iki ses kanalında RED önde, görüntüye dokunulmadı', bPc && ilk(bPc._transceivers[0]) === 'audio/red' && ilk(bPc._transceivers[1]) === 'audio/red' && bPc._transceivers[2].kodekler === null, bPc && bPc._transceivers.map(ilk).join(','));
		denetle('RED: Opus hemen ardında, ötekiler korunur', bPc._transceivers[0].kodekler.map((k) => k.mimeType).join(',') === 'audio/red,audio/opus,audio/G722,audio/PCMU,audio/telephone-event', bPc._transceivers[0].kodekler.map((k) => k.mimeType).join(','));
		const bTeklif = tson('sdp');
		tgel({ type: 'sdp', from: 'bora', sdp: { type: 'answer', sdp: UC_KANALLI }, oturum: bTeklif.oturum });
		await bekle(40);
		// Yanıtlayan taraf: teklifin kanalları kurulunca, yanıt üretilmeden RED öne alınır.
		tgel({ type: 'ses-kisi-girdi', kanal: 'sesli-sohbet', ad: 'zeynep', devam: false });
		await bekle(30);
		tgel({ type: 'sdp', from: 'zeynep', sdp: { type: 'offer', sdp: UC_KANALLI }, oturum: 'zoturum12345' });
		await bekle(60);
		const zPc = t.FakePC.hepsi.at(-1);
		denetle('RED: yanıt üretilirken iki ses kanalında RED önde', zPc !== bPc && zPc.yanitKodekleri && zPc.yanitKodekleri.join(',') === 'audio/red,audio/red,', zPc.yanitKodekleri && zPc.yanitKodekleri.join(','));
		denetle('RED: anlaşıldığı görülür (giden ve gelen)', tw.eval("redAnlasildi(esler.get('bora').tr, 'giden') && redAnlasildi(esler.get('bora').tr, 'gelen')"));
		// bora'dan gelen ses çözülemiyor: paket geliyor (~96 kbps), sesin %97'si uyduruluyor.
		const nabiz = setInterval(() => tgel({ type: 'pong' }), 2000);
		for (const pc of t.FakePC.hepsi) pc.connectionState = 'connected';
		bPc.gizlemeOrani = 0.97;
		const teklifSayisi = t.oc.gonderilen.filter((m) => m.type === 'sdp' && m.to === 'bora' && m.sdp.type === 'offer').length;
		await bekle(9000);
		clearInterval(nabiz);
		const tani = t.oc.gonderilen.filter((m) => m.type === 'tani').map((m) => m.veri);
		const coz = tani.find((v) => v.olay === 'cozulemiyor' && v.es === 'bora');
		denetle('çözülemeyen ses teşhise yazıldı (RED anlaşılmıştı)', coz && coz.kanal === 'mik' && coz.red === true, JSON.stringify(coz));
		denetle('o eşte RED bırakıldı', tw.eval("esler.get('bora').redKapali === true") && tani.some((v) => v.olay === 'red-birakildi' && v.es === 'bora'));
		denetle('RED bırakılınca kodek sırasında RED yok, Opus önde', bPc._transceivers.slice(0, 2).every((tr) => tr.kodekler && tr.kodekler[0].mimeType === 'audio/opus' && !tr.kodekler.some((k) => k.mimeType === 'audio/red')), bPc._transceivers.map(ilk).join(','));
		denetle('RED bırakılınca teklif eden yeniden teklif verdi', t.oc.gonderilen.filter((m) => m.type === 'sdp' && m.to === 'bora' && m.sdp.type === 'offer').length === teklifSayisi + 1);
		denetle('öteki eşte RED sürüyor', tw.eval("!esler.get('zeynep').redKapali") && ilk(zPc._transceivers[0]) === 'audio/red');
		const zKutu = t.d.querySelector('#ses-kisiler .ses-kisi[data-ad="zeynep"] .ses-istatistik');
		denetle('RED: kişinin ipucunda yedekli olduğu yazar', zKutu && /yedekli \(RED\)/.test(zKutu.title), zKutu && zKutu.title);
		// Çözülebilen ama kayıplı ses (uydurma %30) RED'i bırakmaz.
		zPc.gizlemeOrani = 0.3;
		const nabiz2 = setInterval(() => tgel({ type: 'pong' }), 2000);
		await bekle(9000);
		clearInterval(nabiz2);
		denetle('kayıplı ama çözülen seste RED bırakılmaz', tw.eval("!esler.get('zeynep').redKapali"));
		// Yanıtlayan tarafta çözülemezse teklif edenden yeni teklif istenir (yanıttaki sıra RED'siz olur).
		zPc.gizlemeOrani = 0.97;
		const nabiz3 = setInterval(() => tgel({ type: 'pong' }), 2000);
		await bekle(9000);
		clearInterval(nabiz3);
		denetle('yanıtlayan tarafta RED bırakılınca yeni teklif istendi', tw.eval("esler.get('zeynep').redKapali === true") && t.oc.gonderilen.some((m) => m.type === 'yenile' && m.to === 'zeynep'));
		const sonTani = tani.concat(t.oc.gonderilen.filter((m) => m.type === 'tani').map((m) => m.veri)).filter((v) => v.esler).at(-1);
		const boraTani = sonTani && sonTani.esler.find((e) => e.ad === 'bora');
		denetle('tanıda RED durumu', boraTani && boraTani.red && boraTani.red.birakildi === true, JSON.stringify(boraTani && boraTani.red));
		tw.eval('sesKapat()');
	}

	// --- 23) telefonda (dokunmatik) susturunca mikrofon tamamen bırakılır: telefon görüşme kipinden
	// çıkar (Bluetooth kulaklık müzik profiline döner, görüşme işlemleri çalan sesi değiştirmez); açınca
	// yeniden alınır. Susturulmuş girilen kanalda mikrofon hiç açılmaz. (Masaüstünde de böyle; yukarıda.)
	// Sesli kanaldayken ekran kendiliğinden kapanmaz (Screen Wake Lock); kanaldan çıkınca bırakılır.
	{
		const t = kur({ dokunmatik: true, depo: { anahtar: 'f'.repeat(128), ad: 'taha' } });
		const tw = t.window;
		const td = t.d;
		const tgel = (m) => t.oc.ws.onmessage({ data: JSON.stringify(m) });
		const tson = (tur) => t.oc.gonderilen.filter((m) => m.type === tur).at(-1);
		const tikla = (id) => td.getElementById(id).click();
		await bekle(40);
		tgel({ type: 'hazir', ad: 'taha', kanallar, kimler: [{ ad: 'taha' }, { ad: 'bora' }], max: 10, maxKullanici: 10, beyazListe: 2, beyazListeAdlari: ['taha', 'bora'], sunulanDosyalar: [], ice: ICE, surum: 'v1' });
		await bekle(40);
		denetle('susturunca mikrofonu bırakma artık bir ayar değil', tw.eval("typeof ayar.mikBirak === 'undefined'") && !td.getElementById('ayar-mik-birak'));
		denetle('kanala girmeden ekran kilidi istenmedi', t.oc.ekranKilitleri.length === 0);
		tw.eval("sesAc('sesli-sohbet')");
		await bekle(60);
		denetle('susturulmamışken kanala girince mikrofon alındı', t.oc.mikrofon === 1, String(t.oc.mikrofon));
		tgel({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: ['bora'], ice: ICE, devam: false });
		await bekle(60);
		const pc = t.FakePC.hepsi.at(-1);
		const gidenIzi = () => pc._transceivers[0].sender.track;
		const ilkIz = t.oc.sonIz;
		denetle('telefon: mikrofon eşe bağlı', gidenIzi() === ilkIz);
		tikla('ben-mikrofon'); // sustur
		await bekle(40);
		denetle('telefon: susturunca mikrofon aygıtı bırakıldı', ilkIz.readyState === 'ended' && tw.eval('mikrofon === null && mikBirakildi === true'));
		denetle('telefon: susturunca eşe iz gitmiyor', gidenIzi() === null);
		denetle('telefon: susturma bildirildi', tson('sessiz').sessiz === true);
		denetle('telefon: "mikrofon kapalı" yazar, "yalnızca dinliyorsun" uyarısı çıkmaz', td.getElementById('ben-alt').textContent === 'mikrofon kapalı' && td.getElementById('ses-uyari').hidden, td.getElementById('ben-alt').textContent);
		tikla('ben-mikrofon'); // aç
		await bekle(60);
		denetle('telefon: açınca mikrofon yeniden alındı', t.oc.mikrofon === 2 && t.oc.sonIz !== ilkIz && t.oc.sonIz.readyState === 'live');
		denetle('telefon: açınca eşe yeni mikrofon bağlandı, açık', gidenIzi() === t.oc.sonIz && t.oc.sonIz.enabled === true);
		denetle('telefon: açma bildirildi', tson('sessiz').sessiz === false);
		denetle('telefon: açınca kanal adı yazar', td.getElementById('ben-alt').textContent === 'Sesli Sohbet', td.getElementById('ben-alt').textContent);
		// Hızlı sustur → aç → sustur (mikrofon alınırken): sonunda bırakılmış, açık aygıt kalmamış olmalı.
		tikla('ben-mikrofon');
		tikla('ben-mikrofon');
		tikla('ben-mikrofon');
		await bekle(80);
		denetle('telefon: hızlı sustur/aç/sustur sonunda mikrofon bırakılmış', tw.eval('mikrofon === null && mikBirakildi === true') && t.oc.sonIz.readyState === 'ended' && gidenIzi() === null, `${t.oc.mikrofon} ${t.oc.sonIz.readyState}`);
		tikla('ben-mikrofon'); // aç
		await bekle(60);
		tikla('ben-sagir'); // sağırlaştır: mikrofon da bırakılır
		await bekle(40);
		denetle('telefon: sağırlaştırınca da mikrofon bırakıldı', tw.eval('mikrofon === null && mikBirakildi === true') && gidenIzi() === null);
		const sayi = t.oc.mikrofon;
		tikla('ben-sagir');
		await bekle(60);
		denetle('telefon: sağırlık kalkınca mikrofon yeniden alındı', t.oc.mikrofon === sayi + 1 && gidenIzi() === t.oc.sonIz && t.oc.sonIz.readyState === 'live');
		// Susturulmuşken kanala girilirse mikrofon hiç açılmaz.
		tikla('ben-mikrofon'); // sustur
		await bekle(40);
		tw.eval('sesKapat()');
		await bekle(30);
		const once = t.oc.mikrofon;
		tw.eval("sesAc('sesli-sohbet')");
		await bekle(60);
		denetle('telefon: susturulmuşken girince mikrofon açılmadı', t.oc.mikrofon === once && tw.eval('mikBirakildi === true'), String(t.oc.mikrofon - once));
		denetle('telefon: ses-gir susturulmuş', tson('ses-gir').sessiz === true);
		tgel({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: ['bora'], ice: ICE, devam: false });
		await bekle(60);
		denetle('telefon: susturulmuş girişte uyarı yok, "mikrofon kapalı"', td.getElementById('ses-uyari').hidden && td.getElementById('ben-alt').textContent === 'mikrofon kapalı', td.getElementById('ben-alt').textContent);
		// Ekran kilidi: kanaldayken alınır; sayfa gizlenince tarayıcı bırakır, öne gelince yeniden alınır.
		const kilitler = t.oc.ekranKilitleri;
		const etkin = () => kilitler.filter((k) => !k.released);
		denetle('telefon: sesli kanaldayken ekran açık tutuluyor', etkin().length === 1 && etkin()[0].type === 'screen', String(kilitler.length));
		let gorunurluk = 'visible';
		Object.defineProperty(td, 'visibilityState', { configurable: true, get: () => gorunurluk });
		gorunurluk = 'hidden';
		await etkin()[0].release(); // tarayıcı, sayfa gizlenince kilidi kendisi bırakır
		td.dispatchEvent(new tw.Event('visibilitychange'));
		await bekle(20);
		denetle('telefon: arka plandayken kilit istenmez', etkin().length === 0);
		gorunurluk = 'visible';
		td.dispatchEvent(new tw.Event('visibilitychange'));
		await bekle(40);
		denetle('telefon: öne gelince ekran kilidi yeniden alındı', etkin().length === 1, String(kilitler.length));
		td.body.dispatchEvent(new tw.Event('pointerdown', { bubbles: true }));
		await bekle(20);
		denetle('telefon: dokununca ikinci kilit alınmaz', etkin().length === 1 && kilitler.length === 3, String(kilitler.length));
		tw.eval('sesKapat()');
		await bekle(20);
		denetle('telefon: kanaldan çıkınca ekran kilidi bırakıldı', etkin().length === 0);
		denetle('Android değil: arka plan sesi (medya oturumu) açılmadı', !td.querySelector('#ses-akislari audio[loop]') && tw.navigator.mediaSession.playbackState === 'none');
		// Masaüstünde de susturunca mikrofon bırakılır (yukarıda); ekran kilidi istenmez.
		const u = kur({ depo: { anahtar: 'f'.repeat(128), ad: 'taha' } });
		await bekle(40);
		u.oc.ws.onmessage({ data: JSON.stringify({ type: 'hazir', ad: 'taha', kanallar, kimler: [{ ad: 'taha' }], max: 10, maxKullanici: 10, beyazListe: 1, beyazListeAdlari: ['taha'], sunulanDosyalar: [], ice: ICE, surum: 'v1' }) });
		await bekle(20);
		u.window.eval("sesAc('sesli-sohbet')");
		await bekle(40);
		u.oc.ws.onmessage({ data: JSON.stringify({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: [], ice: ICE, devam: false }) });
		await bekle(40);
		denetle('masaüstünde ekran kilidi istenmez', u.oc.ekranKilitleri.length === 0 && u.window.eval('sesKanal') === 'sesli-sohbet');
		u.window.eval('sesKapat()');
	}

	// --- 24) Android: sesli kanaldayken döngüde sessiz bir ses çalınır (tarayıcı oynatma bildirimi
	// açar, sayfa arka planda donmaz); bildirimdeki duraklat bir şey yapmaz; başka uygulama sesi
	// alırsa geri alınmaz; kanaldan çıkınca durur. Ses gelip çalınmıyorsa (çözülen örnek artmıyor) öğe
	// yeniden bağlanır. Teşhis yalnızca sunucu günlüğüne gider (arka plana geçiş/dönüş, alıcı tamponu).
	{
		const t = kur({ dokunmatik: true, android: true, depo: { anahtar: 'f'.repeat(128), ad: 'taha' } });
		const tw = t.window;
		const td = t.d;
		const tgel = (m) => t.oc.ws.onmessage({ data: JSON.stringify(m) });
		await bekle(40);
		tgel({ type: 'hazir', ad: 'taha', kanallar, kimler: [{ ad: 'taha' }, { ad: 'bora' }], max: 10, maxKullanici: 10, beyazListe: 2, beyazListeAdlari: ['taha', 'bora'], sunulanDosyalar: [], ice: ICE, surum: 'v1' });
		await bekle(40);
		tw.eval('ayar.mikKapali = true');
		tw.eval("sesAc('sesli-sohbet')");
		await bekle(40);
		tgel({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: ['bora'], ice: ICE, devam: false });
		await bekle(60);
		const oge = () => td.querySelector('#ses-akislari audio[loop]');
		const ms = tw.navigator.mediaSession;
		denetle('Android: kanala girince sessiz ses döngüde çalıyor', !!oge() && !oge().paused && /^blob:/.test(oge().src), oge() && oge().src);
		denetle('Android: medya oturumu kanal adıyla, oynatılıyor', ms.metadata && ms.metadata.title === 'Sesli Sohbet' && ms.playbackState === 'playing', ms.metadata && ms.metadata.title + ' ' + ms.playbackState);
		denetle('Android: sesli kanalda ekran da açık tutuluyor', t.oc.ekranKilitleri.filter((k) => !k.released).length === 1);
		t.oc.medyaIsleyicileri.pause();
		await bekle(20);
		denetle('Android: bildirimdeki duraklat sesi durdurmaz (kulaklığın "konuşunca duraklat"ı da)', !oge().paused && ms.playbackState === 'playing');
		oge().pause(); // başka uygulama sesi aldı (müzik, arama): tarayıcı durdurur
		await bekle(20);
		denetle('Android: başka uygulama durdurunca bildirim duraklatıldı görünür', ms.playbackState === 'paused');
		td.body.dispatchEvent(new tw.Event('pointerdown', { bubbles: true }));
		tw.eval('sesUyandir()');
		await bekle(20);
		denetle('Android: başka uygulamanın durdurduğu ses dokunarak ya da öne gelince geri alınmaz', oge().paused);
		t.oc.medyaIsleyicileri.play();
		await bekle(20);
		denetle('Android: bildirimden "oynat" ile sürer', !oge().paused && ms.playbackState === 'playing');
		// Kanal değiştirince (çıkmadan) bildirimdeki kanal adı güncellenir, ses tek öğede sürer.
		tw.eval("sesAc('muzik')");
		await bekle(40);
		tgel({ type: 'ses-girdi', kanal: 'muzik', kisiler: [], ice: ICE, devam: false });
		await bekle(40);
		denetle('Android: kanal değişince bildirimde yeni kanal adı', ms.metadata && ms.metadata.title === 'Müzik' && td.querySelectorAll('#ses-akislari audio[loop]').length === 1 && !oge().paused, ms.metadata && ms.metadata.title);
		tw.eval("sesAc('sesli-sohbet')");
		await bekle(40);
		tgel({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: ['bora'], ice: ICE, devam: false });
		await bekle(60);
		denetle('Android: geri dönünce yine kanal adı', ms.metadata && ms.metadata.title === 'Sesli Sohbet');
		// Arka plana geçip (20 sn) dönüş: tanıya yazılır (dönüşten ~6 sn sonra durumun tamamı).
		const nabiz = setInterval(() => tgel({ type: 'pong' }), 2000);
		let gorunurluk = 'visible';
		Object.defineProperty(td, 'visibilityState', { configurable: true, get: () => gorunurluk });
		gorunurluk = 'hidden';
		td.dispatchEvent(new tw.Event('visibilitychange'));
		await bekle(20);
		tw.eval('gizlenme = Date.now() - 20000');
		gorunurluk = 'visible';
		td.dispatchEvent(new tw.Event('visibilitychange'));
		// Ses gelip çalınmıyor: paket geliyor, çözülen örnek artmıyor → öğe akışa yeniden bağlanır.
		const pc = t.FakePC.hepsi.at(-1);
		pc.connectionState = 'connected';
		tw.eval("esDurumDegisti(esler.get('bora'))");
		const sesOgesi = tw.eval("esler.get('bora').ses");
		let atama = 0;
		Object.defineProperty(sesOgesi, 'srcObject', {
			configurable: true,
			get() {
				return this._akis || null;
			},
			set(v) {
				atama++;
				this._akis = v;
			},
		});
		sesOgesi._akis = new tw.MediaStream([t.oc.izYap()]);
		sesOgesi.play();
		pc.ornekDurdu = true;
		await bekle(7000);
		const tani = t.oc.gonderilen.filter((m) => m.type === 'tani').map((m) => m.veri);
		denetle('çalmayan ses teşhise yazıldı', tani.some((v) => v.olay === 'calma-takildi' && v.es === 'bora' && v.kanal === 'mik'), JSON.stringify(tani.filter((v) => v.olay)));
		denetle('çalmayan sesin öğesi akışa yeniden bağlandı', atama >= 2 && !!sesOgesi.srcObject && !sesOgesi.paused, String(atama));
		pc.ornekDurdu = false;
		// Günlüğe giden tanı: dönüşten sonra durumun tamamı; sayfa durumu ve alıcı tamponu (gecikme).
		await bekle(2300); // ses yeniden çalınıyor: bir istatistik turu
		clearInterval(nabiz);
		const tanilar = t.oc.gonderilen.filter((m) => m.type === 'tani').map((m) => m.veri);
		denetle('tanı: arka plana geçiş yazıldı', tanilar.some((v) => v.olay === 'arka-plan'));
		const donus = tanilar.find((v) => v.olay === 'one-geldi');
		denetle('tanı: öne gelince (yeniden bağlanma bitince) durumun tamamı, arka planda kalınan süreyle', donus && donus.arkaPlanSn >= 19 && donus.arkaPlanSn <= 22 && donus.kanal === 'sesli-sohbet' && Array.isArray(donus.esler), JSON.stringify(donus && { sn: donus.arkaPlanSn, kanal: donus.kanal }));
		const v = await tw.eval('taniVeri()');
		denetle('tanı: sayfa durumu (önde, ekran açık, arka plan sesi)', v.sayfa && v.sayfa.gorunur === 'visible' && v.sayfa.ekranAcik === true && v.sayfa.arkaPlanSesi === 'caliyor', JSON.stringify(v.sayfa));
		const boraTani = v.esler.find((e) => e.ad === 'bora');
		denetle('tanı: konuşmanın alıcı tarafı (tampon, hedef, titreşim, paket/sn, çözülüyor, çalıyor)', boraTani && boraTani.alici && boraTani.alici.tamponMs === 60 && boraTani.alici.hedefMs === 50 && boraTani.alici.titresimMs === 11 && boraTani.alici.paketSn > 0 && boraTani.alici.cozuluyor === true && boraTani.alici.caliyor === true, JSON.stringify(boraTani && boraTani.alici));
		denetle('tanı satırı sunucunun sınırına sığar', JSON.stringify(v).length < 6000, String(JSON.stringify(v).length));
		denetle('arayüzde teşhis bölümü yok (yalnızca günlük)', !td.getElementById('ayar-teshis'));
		tw.eval('sesKapat()');
		await bekle(20);
		denetle('Android: kanaldan çıkınca sessiz ses durdu, medya oturumu kapandı', !oge() && ms.playbackState === 'none' && ms.metadata === null);
	}

	// --- 25) alıcı tamponunda birikme: çıkış bir an durunca paketler tamponda birikir, tarayıcı bunu
	// ancak sesi hızlandırarak eritir (2 sn'lik duruş ~10 sn sürer). Tampon hedefinin 350 ms üstünde iki ölçüm
	// sürerse o eşle bağlantı baştan kurulur: teklif eden kendisi kurar, yanıtlayan ondan ister (yenile,
	// tam). Normal tamponda bir şey yapılmaz; aynı eşle en çok 30 sn'de bir.
	{
		const t = kur({ depo: { anahtar: 'f'.repeat(128), ad: 'taha' } });
		const tw = t.window;
		const tgel = (m) => t.oc.ws.onmessage({ data: JSON.stringify(m) });
		await bekle(40);
		tgel({ type: 'hazir', ad: 'taha', kanallar, kimler: [{ ad: 'taha' }, { ad: 'bora' }, { ad: 'zeynep' }], max: 10, maxKullanici: 10, beyazListe: 3, beyazListeAdlari: ['taha', 'bora', 'zeynep'], sunulanDosyalar: [], ice: ICE, surum: 'v1' });
		await bekle(40);
		tw.eval('ayar.mikKapali = true');
		tw.eval("sesAc('sesli-sohbet')");
		await bekle(40);
		tgel({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: ['bora', 'zeynep'], ice: ICE, devam: false });
		await bekle(60);
		// bora'ya teklifi taha verir; zeynep'in teklifi gelir (taha yanıtlar).
		tgel({ type: 'sdp', from: 'zeynep', sdp: { type: 'offer', sdp: UC_KANALLI }, oturum: 'zoturum12345' });
		await bekle(60);
		const bPc = tw.eval("esler.get('bora').pc");
		const zPc = tw.eval("esler.get('zeynep').pc");
		denetle('birikme: iki bağlantı (biri teklif eden, biri yanıtlayan)', !!bPc && !!zPc && bPc !== zPc && tw.eval("esler.get('bora').teklifci === true && esler.get('zeynep').teklifci === false"));
		const nabiz = setInterval(() => tgel({ type: 'pong' }), 2000);
		for (const pc of [bPc, zPc]) pc.connectionState = 'connected';
		tw.eval("for (const e of esler.values()) { esDurumDegisti(e); e.baglandiZaman = Date.now() - 10000; }");
		await bekle(4500);
		const pcSayisi = t.FakePC.hepsi.length;
		denetle('normal tamponda (60 ms, hedef 50) bağlantıya dokunulmaz', t.FakePC.hepsi.length === pcSayisi && !bPc.kapandi && !zPc.kapandi && !t.oc.gonderilen.some((m) => m.type === 'tani' && m.veri.olay === 'birikme'));
		const v0 = await tw.eval('taniVeri()');
		const ab = v0.esler.find((e) => e.ad === 'bora').alici;
		denetle('tanı: alıcı tamponu ve hızlandırma alanları', ab && ab.tamponMs === 60 && ab.hedefMs === 50 && ab.hizlandirmaMs === 0 && ab.gizlemeOlayi === 0, JSON.stringify(ab));
		// bora'dan gelen seste 1,5 sn birikme (hedef 80 ms), tarayıcı yavaşça hızlandırıyor.
		bPc.tamponSn = 1.5;
		bPc.hedefSn = 0.08;
		bPc.hizlandirmaOrani = 0.02;
		await bekle(5000);
		const birikme = t.oc.gonderilen.filter((m) => m.type === 'tani' && m.veri.olay === 'birikme').map((m) => m.veri);
		denetle('birikme teşhise yazıldı', birikme.some((v) => v.es === 'bora' && v.kanal === 'mik' && v.tamponMs === 1500 && v.hedefMs === 80), JSON.stringify(birikme));
		denetle('teklif eden: bağlantı baştan kuruldu (eski kapandı, yeni oturum)', bPc.kapandi === true && tw.eval("esler.get('bora').pc") !== bPc && t.FakePC.hepsi.length === pcSayisi + 1);
		// Yanıtlayan tarafta: zeynep'ten gelen seste birikme → zeynep'ten baştan kurmasını iste.
		zPc.tamponSn = 1.2;
		zPc.hedefSn = 0.06;
		await bekle(5000);
		const iste = t.oc.gonderilen.filter((m) => m.type === 'yenile' && m.to === 'zeynep');
		denetle('yanıtlayan: teklif edenden baştan kurmasını istedi (yenile, tam)', iste.some((m) => m.tam === true && m.oturum === 'zoturum12345'), JSON.stringify(iste));
		denetle('yanıtlayan kendi bağlantısını kapatmaz (teklif eden kuracak)', !zPc.kapandi);
		const tamSayisi = iste.filter((m) => m.tam).length;
		await bekle(4500);
		denetle('aynı eşle 30 sn dolmadan yeniden istenmez', t.oc.gonderilen.filter((m) => m.type === 'yenile' && m.to === 'zeynep' && m.tam).length === tamSayisi);
		// Karşıdan gelen "baştan kur" isteği (teklif eden bizsek): bağlantı yeniden kurulur.
		const yeniB = tw.eval("esler.get('bora').pc");
		tgel({ type: 'yenile', from: 'bora', oturum: tw.eval("esler.get('bora').oturum"), tam: true });
		await bekle(40);
		denetle('gelen "yenile, tam": teklif eden bağlantıyı baştan kurar', yeniB.kapandi === true && tw.eval("esler.get('bora').pc") !== yeniB);
		denetle('gelen "yenile, tam" teşhise yazıldı', t.oc.gonderilen.some((m) => m.type === 'tani' && m.veri.olay === 'yeniden-kur-istendi' && m.veri.es === 'bora'));
		clearInterval(nabiz);
		tw.eval('sesKapat()');
	}

	// --- 26) Firefox: paylaşılan ses aygıtı ilk açılan ses girişi olmalı (sonradan açılan aygıt ayrı bir
	// arabellekten geçiyor: şikayette 0,8-0,9 sn yakalama gecikmesi, saniyelerce boşluk). Mikrofon
	// açıkken aygıttan paylaşım başlatılırsa mikrofon önce bırakılır, aygıt açılır, mikrofon geri
	// alınır. Ölçülen yakalama gecikmesi yüksekse yakalama aynı sırayla yeniden açılır (paylaşım başına
	// en çok 2 kez, 2 dk arayla).
	{
		const t = kur({ firefox: true, depo: { anahtar: 'f'.repeat(128), ad: 'taha' } });
		const tw = t.window;
		const td = t.d;
		const tgel = (m) => t.oc.ws.onmessage({ data: JSON.stringify(m) });
		const tanilar = (olay) => t.oc.gonderilen.filter((m) => m.type === 'tani' && m.veri.olay === olay).map((m) => m.veri);
		await bekle(40);
		tgel({ type: 'hazir', ad: 'taha', kanallar, kimler: [{ ad: 'taha' }, { ad: 'bora' }], max: 10, maxKullanici: 10, beyazListe: 2, beyazListeAdlari: ['taha', 'bora'], sunulanDosyalar: [], ice: ICE, surum: 'v1' });
		await bekle(40);
		tw.eval("sesAc('sesli-sohbet')");
		await bekle(60);
		tgel({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: ['bora'], ice: ICE, devam: false });
		await bekle(60);
		const pc = t.FakePC.hepsi.at(-1);
		const ilkMik = t.oc.sonIz;
		denetle('Firefox: kanalda mikrofon açık, eşe bağlı', ilkMik.readyState === 'live' && t.oc.mikrofon === 1 && pc._transceivers[0].sender.track === ilkMik);
		t.oc.ekranSesiYok = true;
		t.oc.ekranSesiVer = false;
		// Kullanıcının bilgisayarı: ses FiiO'dan çıkıyor (varsayılan çıkış), mikrofon anakartta.
		t.oc.aygitlar = [
			{ kind: 'audioinput', deviceId: 'mik-1', label: 'Starship/Matisse HD Audio Controller Analog Stereo', groupId: 'a' },
			{ kind: 'audioinput', deviceId: 'monitor-1', label: 'Monitor of FIIO KA13 Pro', groupId: 'b' },
			{ kind: 'audioinput', deviceId: 'monitor-2', label: 'Monitor of Starship/Matisse HD Audio Controller Analog Stereo', groupId: 'a' },
			{ kind: 'audiooutput', deviceId: 'cikis-fiio', label: 'FIIO KA13 Pro', groupId: 'b' },
			{ kind: 'audiooutput', deviceId: 'cikis-dahili', label: 'Starship/Matisse HD Audio Controller Analog Stereo', groupId: 'a' },
		];
		t.oc.gumSirasi = [];
		td.getElementById('yayin-ac').click();
		await bekle(20);
		[...td.querySelectorAll('#yayin-menu button')].find((b) => b.textContent.includes('Ekransız paylaş')).click();
		await bekle(60);
		denetle('Firefox: aygıt sorulmadı (pencere açılmadı)', td.getElementById('ses-kaynagi').hidden);
		denetle('Firefox: paylaşım başlarken mikrofon önce bırakıldı (konuşma bir an kesilir)', ilkMik.readyState === 'ended' && tw.eval('mikrofon === null') && pc._transceivers[0].sender.track === null);
		await bekle(800);
		const sira = t.oc.gumSirasi;
		denetle('Firefox: aygıt mikrofon kapalıyken açıldı (asıl giriş), mikrofon ondan sonra geri alındı', sira.length === 2 && sira[0].tur === 'aygit' && sira[0].mikAcik === false && sira[1].tur === 'mik', JSON.stringify(sira));
		denetle('Firefox: varsayılan çıkışın (FiiO) "Monitor"u paylaşıldı', t.oc.aygitKisit && t.oc.aygitKisit.deviceId.exact === 'monitor-1', JSON.stringify(t.oc.aygitKisit));
		const monitorIz = t.oc.aygitIzi;
		denetle(
			'Firefox: mikrofon geri geldi ve eşe bağlı; paylaşım çıkarıcının çıkışı',
			t.oc.mikrofon === 2 && t.oc.sonIz.readyState === 'live' && pc._transceivers[0].sender.track === t.oc.sonIz && pc._transceivers[1].sender.track === t.oc.hedefIzleri.at(-1) && monitorIz.readyState === 'live',
		);
		denetle('Firefox: mikrofon susturulmuş görünmedi', !t.oc.gonderilen.some((m) => m.type === 'sessiz' && m.sessiz === true) && /Ekransız paylaşıyorsun/.test(td.getElementById('durum').textContent));
		const aygitTani = tanilar('yayin-aygit').at(-1);
		denetle('teşhis: mikrofon önce bırakıldı yazıldı', aygitTani && aygitTani.mikOnceBirakildi === true && aygitTani.tazele === false, JSON.stringify(aygitTani));
		// Ölçülen yakalama gecikmesi yüksek (850 ms): yakalama aynı sırayla yeniden açılır.
		const dugum = t.oc.workletDugumleri.at(-1);
		const mik2 = t.oc.sonIz;
		const yayinMesaji = t.oc.gonderilen.filter((m) => m.type === 'yayin').length;
		t.oc.gumSirasi = [];
		dugum.port.onmessage({ data: { tur: 'sonda', gecikme: 0.85, snr: 1000 } });
		await bekle(60);
		const tz = tanilar('yakalama-tazele');
		denetle('yüksek yakalama gecikmesi: tazeleme teşhise yazıldı', tz.length === 1 && tz[0].ms === 850 && tz[0].mikrofon === true && tz[0].kez === 1, JSON.stringify(tz));
		denetle('tazeleme: eski yakalama ve mikrofon önce kapandı', monitorIz.readyState === 'ended' && mik2.readyState === 'ended');
		await bekle(800);
		const sira2 = t.oc.gumSirasi;
		denetle(
			'tazeleme: aygıt mikrofon kapalıyken yeniden açıldı, mikrofon sonra; eşe yeni izler',
			sira2.length === 2 && sira2[0].tur === 'aygit' && !sira2[0].mikAcik && sira2[1].tur === 'mik' && t.oc.aygitIzi !== monitorIz && t.oc.aygitIzi.readyState === 'live' && pc._transceivers[1].sender.track === t.oc.hedefIzleri.at(-1) && pc._transceivers[0].sender.track === t.oc.sonIz && t.oc.sonIz.readyState === 'live',
			JSON.stringify(sira2),
		);
		const yayinlar = t.oc.gonderilen.filter((m) => m.type === 'yayin').slice(yayinMesaji);
		denetle('tazelemede paylaşım bitmiş sayılmadı (yayın hep sesli bildirildi)', yayinlar.length >= 1 && yayinlar.every((m) => m.yayin && m.yayin.ses === true), JSON.stringify(yayinlar));
		denetle('tazelemede kullanıcıya ileti yok, teşhiste tazele', tanilar('yayin-aygit').at(-1).tazele === true && /Ekransız paylaşıyorsun/.test(td.getElementById('durum').textContent));
		// 2 dakika dolmadan yeniden yüksek ölçülürse yeniden denenmez.
		const aygitIzi2 = t.oc.aygitIzi;
		t.oc.workletDugumleri.at(-1).port.onmessage({ data: { tur: 'sonda', gecikme: 0.9, snr: 1000 } });
		await bekle(700);
		denetle('2 dk dolmadan ikinci tazeleme yok', tanilar('yakalama-tazele').length === 1 && t.oc.aygitIzi === aygitIzi2 && aygitIzi2.readyState === 'live');
		// Susturulmuşken başlatılan paylaşımda mikrofona dokunulmaz.
		tw.eval('yayinDurdur()');
		td.getElementById('ben-mikrofon').click(); // sustur: mikrofon bırakılır
		await bekle(40);
		const mikSayisi = t.oc.mikrofon;
		t.oc.gumSirasi = [];
		td.getElementById('yayin-ac').click();
		await bekle(20);
		[...td.querySelectorAll('#yayin-menu button')].find((b) => b.textContent.includes('Ekransız paylaş')).click();
		await bekle(200);
		denetle('susturulmuşken paylaşım: beklemeden aygıt açılır, mikrofon alınmaz', t.oc.gumSirasi.length === 1 && t.oc.gumSirasi[0].tur === 'aygit' && t.oc.mikrofon === mikSayisi && tw.eval('!!yayin.ses'), JSON.stringify(t.oc.gumSirasi));
		tw.eval('sesKapat()');
	}

	// --- 27) Telefonda (Android) kulaklıkla konuşurken çalan ses tam kalitede kalsın: Chrome yankı
	// engellemeli mikrofon açılınca telefonu görüşme kipine alır (Bluetooth kulaklık tek kanallı görüşme
	// profiline düşer); yankı engellemesi kapalı mikrofonda almaz. Kulaklık varsa yankı engelleme kapalı
	// istenir; yalnızca Bluetooth kulaklık varsa mikrofon telefonun kendisinden ("Speakerphone").
	{
		const t = kur({ dokunmatik: true, android: true, depo: { anahtar: 'f'.repeat(128), ad: 'taha' } });
		const tw = t.window;
		const td = t.d;
		const tgel = (m) => t.oc.ws.onmessage({ data: JSON.stringify(m) });
		await bekle(40);
		tgel({ type: 'hazir', ad: 'taha', kanallar, kimler: [{ ad: 'taha' }], max: 10, maxKullanici: 10, beyazListe: 1, beyazListeAdlari: ['taha'], sunulanDosyalar: [], ice: ICE, surum: 'v1' });
		await bekle(40);
		// Chrome Android'in mikrofon listesi (sabit adlar).
		const VARSAYILAN = { kind: 'audioinput', deviceId: 'default', label: 'Default', groupId: 'v' };
		const TELEFON = { kind: 'audioinput', deviceId: 'mik-1', label: 'Speakerphone', groupId: 'a' };
		const AHIZE = { kind: 'audioinput', deviceId: 'ahize', label: 'Headset earpiece', groupId: 'b' };
		const gir = async () => {
			tw.eval("sesAc('sesli-sohbet')");
			await bekle(60);
			tgel({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: [], ice: ICE, devam: false });
			await bekle(40);
			return t.oc.micKisit || {};
		};
		const cik = async () => {
			tw.eval('sesKapat()');
			await bekle(30);
		};
		t.oc.aygitlar = [VARSAYILAN, TELEFON, AHIZE, { kind: 'audioinput', deviceId: 'bt', label: 'Bluetooth headset', groupId: 'c' }];
		let k = await gir();
		denetle('Bluetooth kulaklık: mikrofon telefonun kendisinden, yankı engelleme kapalı (görüşme kipine geçilmez)', k.echoCancellation === false && k.deviceId && k.deviceId.exact === 'mik-1', JSON.stringify(k));
		denetle('Bluetooth kulaklık: gürültü bastırma ve otomatik kazanç ayardaki gibi', k.noiseSuppression === tw.eval('ayar.gurultu') && k.autoGainControl === tw.eval('ayar.kazanc'), JSON.stringify(k));
		denetle('Bluetooth kulaklık: kullanıcıya bir kez söylendi', /telefonun mikrofonundan/.test(td.getElementById('durum').textContent), td.getElementById('durum').textContent);
		const tani = await tw.eval('taniVeri()');
		denetle('tanıda kulaklık kipi', tani.micAyarlar && tani.micAyarlar.kulaklik === 'bluetooth', JSON.stringify(tani.micAyarlar));
		// Konuşurken Bluetooth koptu: ses artık telefonun hoparlöründen; mikrofon önce bırakılıp yankı
		// engellemeli yeniden açılır (Chrome görüşme kipine ancak açık başka giriş yokken karar veriyor).
		const kulaklikOlaylari = () => t.oc.gonderilen.filter((m) => m.type === 'tani' && m.veri.olay === 'kulaklik-degisti').map((m) => m.veri);
		t.oc.aygitlar = [VARSAYILAN, TELEFON, AHIZE];
		t.oc.gumSirasi = [];
		t.oc.aygitDegisti();
		t.oc.aygitDegisti(); // art arda gelir
		await bekle(1300);
		k = t.oc.micKisit;
		denetle('Bluetooth koptu: mikrofon yankı engellemeli yeniden açıldı (hoparlörden çalıyor)', k.echoCancellation === true && !k.deviceId && t.oc.gumSirasi.length === 1, JSON.stringify({ k, sira: t.oc.gumSirasi }));
		denetle('Bluetooth koptu: eski mikrofon önce kapatıldı', t.oc.gumSirasi[0] && t.oc.gumSirasi[0].oncekiAcik === false, JSON.stringify(t.oc.gumSirasi));
		denetle('kulaklık değişimi teşhise yazıldı', kulaklikOlaylari().some((v) => v.eski === 'bluetooth' && v.yeni === null), JSON.stringify(kulaklikOlaylari()));
		// Yeniden bağlandı: telefonun mikrofonuna, yankı engellemesiz.
		t.oc.aygitlar = [VARSAYILAN, TELEFON, AHIZE, { kind: 'audioinput', deviceId: 'bt', label: 'Bluetooth headset', groupId: 'c' }];
		t.oc.gumSirasi = [];
		t.oc.aygitDegisti();
		await bekle(1300);
		k = t.oc.micKisit;
		denetle('Bluetooth bağlandı: mikrofon telefonun kendisinden, yankı engellemesiz', k.echoCancellation === false && k.deviceId && k.deviceId.exact === 'mik-1' && t.oc.gumSirasi.length === 1 && !t.oc.gumSirasi[0].oncekiAcik, JSON.stringify({ k, sira: t.oc.gumSirasi }));
		// Kipi değiştirmeyen aygıt değişikliğinde mikrofona dokunulmaz.
		const mikSayisi = t.oc.mikrofon;
		t.oc.aygitDegisti();
		await bekle(1300);
		denetle('kip değişmediyse mikrofon yeniden açılmaz', t.oc.mikrofon === mikSayisi && tw.eval('!!mikrofon'));
		await cik();
		t.oc.aygitlar = [VARSAYILAN, TELEFON, AHIZE, { kind: 'audioinput', deviceId: 'kablo', label: 'Wired headset', groupId: 'd' }];
		k = await gir();
		denetle('kablolu kulaklık: yankı engelleme kapalı, varsayılan aygıt (kulaklığın kendisi)', k.echoCancellation === false && !k.deviceId, JSON.stringify(k));
		await cik();
		t.oc.aygitlar = [VARSAYILAN, TELEFON, AHIZE];
		k = await gir();
		denetle('kulaklık yokken (hoparlör): yankı engelleme ayardaki gibi açık', k.echoCancellation === true && !k.deviceId, JSON.stringify(k));
		await cik();
		t.oc.aygitlar = [VARSAYILAN, TELEFON, AHIZE, { kind: 'audioinput', deviceId: 'bt', label: 'Bluetooth headset', groupId: 'c' }];
		tw.eval("ayar.mikId = 'mik-1'");
		k = await gir();
		denetle('ses ayarlarında mikrofon seçildiyse ona dokunulmaz', k.echoCancellation === true && k.deviceId && k.deviceId.exact === 'mik-1', JSON.stringify(k));
		tw.eval("ayar.mikId = ''");
		await cik();
		// Android değilse (iPhone gibi) bir şey değişmez.
		const u = kur({ dokunmatik: true, depo: { anahtar: 'f'.repeat(128), ad: 'taha' } });
		await bekle(40);
		u.oc.ws.onmessage({ data: JSON.stringify({ type: 'hazir', ad: 'taha', kanallar, kimler: [{ ad: 'taha' }], max: 10, maxKullanici: 10, beyazListe: 1, beyazListeAdlari: ['taha'], sunulanDosyalar: [], ice: ICE, surum: 'v1' }) });
		await bekle(40);
		u.oc.aygitlar = [VARSAYILAN, TELEFON, { kind: 'audioinput', deviceId: 'bt', label: 'Bluetooth headset', groupId: 'c' }];
		u.window.eval("sesAc('sesli-sohbet')");
		await bekle(60);
		denetle('Android değilse kulaklık kipi yok', u.oc.micKisit && u.oc.micKisit.echoCancellation === true && !u.oc.micKisit.deviceId, JSON.stringify(u.oc.micKisit));
		u.window.eval('sesKapat()');
	}

	// --- 28) paylaşım kalitesi: paylaşılan ses varsayılan olarak Opus'un en yükseğinde (510 kbps,
	// stereo) gider, ses ayarlarından düşürülebilir. Chrome'da tavan hemen (setParameters); Firefox'ta
	// Opus hedefi ancak yeniden anlaşmada uygulanır: teklif ettiğimiz bağlantıda yeni teklif,
	// yanıtladığımızda karşıdan yeni teklif isteği (yenile, teklif; ICE yenilenmez). Ekran kalitesi
	// (çözünürlük, kare hızı, bit hızı tavanı) seçilir ve paylaşım sürerken de uygulanır; sunucu
	// üzerinden (TURN) giden bağlantıda ekran en çok 3 Mbit/s.
	{
		const t = kur({ depo: { anahtar: 'f'.repeat(128), ad: 'taha' } });
		const tw = t.window;
		const td = t.d;
		const tgel = (m) => t.oc.ws.onmessage({ data: JSON.stringify(m) });
		const sec = (id, deger) => {
			td.getElementById(id).value = deger;
			td.getElementById(id).dispatchEvent(new tw.Event('change', { bubbles: true }));
		};
		const yayinBolumu = (pc) => String(pc.remoteDescription && pc.remoteDescription.sdp).split('m=').slice(1)[1] || '';
		const sp = (pc) => (pc._transceivers[1].parametreler || { encodings: [{}] }).encodings[0];
		const vp = (pc) => (pc._transceivers[2].parametreler || { encodings: [{}] }).encodings[0];
		const sdpler = (ad) => t.oc.gonderilen.filter((m) => m.type === 'sdp' && m.to === ad);
		const istekler = (ad) => t.oc.gonderilen.filter((m) => m.type === 'yenile' && m.to === ad);
		await bekle(40);
		tgel({ type: 'hazir', ad: 'taha', kanallar, kimler: [{ ad: 'taha' }, { ad: 'bora' }, { ad: 'zeynep' }], max: 10, maxKullanici: 10, beyazListe: 3, beyazListeAdlari: ['taha', 'bora', 'zeynep'], sunulanDosyalar: [], ice: ICE, surum: 'v1' });
		await bekle(40);
		tw.eval('ayar.mikKapali = true');
		tw.eval("sesAc('sesli-sohbet')");
		await bekle(40);
		tgel({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: ['bora', 'zeynep'], ice: ICE, devam: false });
		await bekle(60);
		// bora'ya teklifi taha verir; zeynep'in teklifi gelir (taha yanıtlar).
		tgel({ type: 'sdp', from: 'zeynep', sdp: { type: 'offer', sdp: UC_KANALLI }, oturum: 'zoturum12345' });
		await bekle(60);
		const bPc = tw.eval("esler.get('bora').pc");
		const zPc = tw.eval("esler.get('zeynep').pc");
		tgel({ type: 'sdp', from: 'bora', sdp: { type: 'answer', sdp: UC_KANALLI }, oturum: sdpler('bora').at(-1).oturum });
		await bekle(40);
		denetle('kalite: iki bağlantı (biri teklif eden, biri yanıtlayan), ikisi de anlaştı', bPc.signalingState === 'stable' && zPc.signalingState === 'stable' && tw.eval("esler.get('bora').teklifci === true && esler.get('zeynep').teklifci === false"));
		denetle('varsayılan: paylaşılan sesin Opus hedefi 510 kbps, stereo (iki yönde de)', /maxaveragebitrate=510000/.test(yayinBolumu(bPc)) && /stereo=1/.test(yayinBolumu(bPc)) && /maxaveragebitrate=510000/.test(yayinBolumu(zPc)), yayinBolumu(bPc));
		// Ekranını sesiyle paylaşır: yakalama seçilen ekran kalitesiyle (varsayılan standart) istenir.
		t.oc.ekranSesiVer = true;
		await tw.eval('yayinBaslat(false)');
		await bekle(60);
		const gIz = t.oc.ekranIzleri[0];
		const istenen = t.oc.ekranSecenek.video;
		denetle('standart: yakalama 1080p, 30 kare istendi', istenen.width.max === 1920 && istenen.height.max === 1080 && istenen.frameRate.max === 30, JSON.stringify(istenen));
		denetle('gönderim tavanları: ses 510 kbps; ekran 2,5 Mbit/s, 30 kare', sp(bPc).maxBitrate === 510000 && sp(zPc).maxBitrate === 510000 && vp(bPc).maxBitrate === 2500000 && vp(bPc).maxFramerate === 30, JSON.stringify([sp(bPc), vp(bPc)]));
		td.getElementById('ben-ayarlar').click();
		await bekle(30);
		denetle('ayarlarda paylaşım seçenekleri görünür: ses 510 (sistem kalitesi), ekran standart', td.getElementById('ayar-paylasim').hidden === false && td.getElementById('ayar-yayin-kalite').value === '510' && td.getElementById('ayar-ekran-kalite').value === 'standart');
		// Paylaşılan ses Standart'a (160) iner.
		const bOnce = sdpler('bora').length;
		sec('ayar-yayin-kalite', '160');
		await bekle(30);
		denetle('Chrome yolu: paylaşılan sesin tavanı hemen 160 kbps', sp(bPc).maxBitrate === 160000 && sp(zPc).maxBitrate === 160000, JSON.stringify([sp(bPc), sp(zPc)]));
		denetle('seçim kalıcı', JSON.parse(tw.localStorage.getItem('ses-ayarlari')).yayinKalite === 160);
		denetle('yeniden anlaşma hemen değil (art arda seçim beklenir)', sdpler('bora').length === bOnce && istekler('zeynep').length === 0);
		await bekle(700);
		denetle('teklif ettiğimiz bağlantıda yeni teklif (aynı oturum)', sdpler('bora').length === bOnce + 1 && sdpler('bora').at(-1).oturum === tw.eval("esler.get('bora').oturum") && bPc.signalingState === 'have-local-offer');
		const istek = istekler('zeynep');
		denetle('yanıtladığımız bağlantıda karşıdan yeni teklif istendi (yenile, teklif)', istek.length === 1 && istek[0].teklif === true && !istek[0].tam && istek[0].oturum === 'zoturum12345', JSON.stringify(istek));
		tgel({ type: 'sdp', from: 'bora', sdp: { type: 'answer', sdp: UC_KANALLI }, oturum: sdpler('bora').at(-1).oturum });
		// Karşının yeni teklifi (tarayıcı her teklifte oturum sürümünü artırır: metin farklı).
		tgel({ type: 'sdp', from: 'zeynep', sdp: { type: 'offer', sdp: UC_KANALLI.replace('v=0', 'v=0\r\no=- 1 2 IN IP4 127.0.0.1') }, oturum: 'zoturum12345' });
		await bekle(60);
		denetle('Firefox yolu: yeni açıklamalarla Opus hedefi 160 kbps (iki bağlantıda)', /maxaveragebitrate=160000/.test(yayinBolumu(bPc)) && /maxaveragebitrate=160000/.test(yayinBolumu(zPc)) && zPc.signalingState === 'stable', yayinBolumu(zPc));
		// Art arda iki seçim: bir kez yeniden anlaşılır, son seçimle.
		sec('ayar-yayin-kalite', '256');
		await bekle(60);
		sec('ayar-yayin-kalite', '510');
		await bekle(800);
		denetle('art arda seçimde bir kez yeniden anlaşılır', istekler('zeynep').length === 2 && sdpler('bora').length === bOnce + 2, `${istekler('zeynep').length} ${sdpler('bora').length - bOnce}`);
		tgel({ type: 'sdp', from: 'bora', sdp: { type: 'answer', sdp: UC_KANALLI }, oturum: sdpler('bora').at(-1).oturum });
		await bekle(40);
		denetle('son seçim geçerli: 510 kbps', /maxaveragebitrate=510000/.test(yayinBolumu(bPc)) && sp(bPc).maxBitrate === 510000);
		// Karşıdan "kalitemi değiştirdim, yeni teklif ver" (teklif eden bizsek): yalnızca yeni teklif.
		let secenek = 'yok';
		const asilTeklif = bPc.createOffer.bind(bPc);
		bPc.createOffer = (o) => {
			secenek = o;
			return asilTeklif(o);
		};
		const bSayi = sdpler('bora').length;
		tgel({ type: 'yenile', from: 'bora', oturum: 'baskaoturum1', teklif: true });
		await bekle(30);
		denetle('başka oturumun teklif isteği yok sayılır', sdpler('bora').length === bSayi && secenek === 'yok');
		tgel({ type: 'yenile', from: 'bora', oturum: tw.eval("esler.get('bora').oturum"), teklif: true });
		await bekle(30);
		denetle('gelen "yenile, teklif": yeni teklif, ICE yenilenmez, bağlantı kurulmaz', sdpler('bora').length === bSayi + 1 && secenek === undefined && !bPc.kapandi && tw.eval("esler.get('bora').pc") === bPc);
		tgel({ type: 'sdp', from: 'bora', sdp: { type: 'answer', sdp: UC_KANALLI }, oturum: sdpler('bora').at(-1).oturum });
		await bekle(40);
		// Ekran kalitesi paylaşım sürerken: yakalama kısıtı ve tavan hemen değişir.
		sec('ayar-ekran-kalite', 'yuksek');
		await bekle(30);
		denetle('yüksek: yakalama 1080p, 60 kare', gIz.kisit.frameRate.max === 60 && gIz.kisit.width.max === 1920 && gIz.kisit.height.max === 1080, JSON.stringify(gIz.kisit));
		denetle('yüksek: ekran tavanı 5 Mbit/s, 60 kare (iki eşe)', vp(bPc).maxBitrate === 5000000 && vp(bPc).maxFramerate === 60 && vp(zPc).maxBitrate === 5000000, JSON.stringify([vp(bPc), vp(zPc)]));
		sec('ayar-ekran-kalite', 'kaynak');
		await bekle(30);
		denetle('en yüksek: çözünürlük sınırı yok, 60 kare, 10 Mbit/s', !gIz.kisit.width && !gIz.kisit.height && gIz.kisit.frameRate.max === 60 && vp(bPc).maxBitrate === 10000000, JSON.stringify(gIz.kisit));
		tw.eval("esler.get('bora').sonTip = 'TURN'; bitHiziAyarla(esler.get('bora'))");
		await bekle(30);
		denetle('sunucu üzerinden (TURN) giden eşe ekran en çok 3 Mbit/s, öbürü etkilenmez', vp(bPc).maxBitrate === 3000000 && vp(zPc).maxBitrate === 10000000, JSON.stringify([vp(bPc), vp(zPc)]));
		tw.eval("esler.get('bora').sonTip = 'P2P'; bitHiziAyarla(esler.get('bora'))");
		await bekle(30);
		tw.eval('ekransizAyarla(true)');
		await bekle(30);
		denetle('ekran gizlenince yakalama saniyede bir kareye iner', gIz.kisit.frameRate.max === 1, JSON.stringify(gIz.kisit));
		tw.eval('ekransizAyarla(false)');
		await bekle(30);
		denetle('gösterilince seçilen kaliteye döner', gIz.kisit.frameRate.max === 60 && !gIz.kisit.width && vp(bPc).maxBitrate === 10000000, JSON.stringify(gIz.kisit));
		sec('ayar-ekran-kalite', 'dusuk');
		await bekle(30);
		denetle('düşük: 720p, 15 kare, 1 Mbit/s', gIz.kisit.width.max === 1280 && gIz.kisit.height.max === 720 && gIz.kisit.frameRate.max === 15 && vp(bPc).maxBitrate === 1000000 && vp(bPc).maxFramerate === 15, JSON.stringify([gIz.kisit, vp(bPc)]));
		denetle('ekran kalitesi kalıcı', JSON.parse(tw.localStorage.getItem('ses-ayarlari')).ekranKalite === 'dusuk');
		const v = await tw.eval('taniVeri()');
		denetle('tanı: paylaşım kalitesi', v.yayinKalite === 510 && v.ekranKalite === 'dusuk', JSON.stringify([v.yayinKalite, v.ekranKalite]));
		td.dispatchEvent(new tw.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		tw.eval('yayinDurdur()');
		tw.eval('sesKapat()');
		// Kalabalık kanal: paylaşılan ses toplam ~3 Mbit/s'yi geçmesin (kişi başı düşer, en az 64).
		tw.eval("ayar.yayinKalite = 510; for (let i = 0; i < 9; i++) esler.set('kalabalik' + i, { ad: 'kalabalik' + i, bekleniyor: 0 })");
		denetle('kalabalıkta (9 eş) paylaşılan ses kişi başı 333 kbps', tw.eval('yayinSesHizi()') === 333, String(tw.eval('yayinSesHizi()')));
		tw.eval('ayar.yayinKalite = 160');
		denetle('160 seçiliyken kalabalıkta da 160', tw.eval('yayinSesHizi()') === 160);
		tw.eval("for (let i = 0; i < 9; i++) esler.delete('kalabalik' + i)");
	}
	// Paylaşamayan tarayıcıda (çoğu telefon) paylaşım seçenekleri gizli; bozuk kayıtlı değer varsayılana döner.
	{
		const u = kur({ ekranYok: true, depo: { anahtar: 'f'.repeat(128), ad: 'taha', 'ses-ayarlari': JSON.stringify({ yayinKalite: 999, ekranKalite: 'uydurma' }) } });
		await bekle(40);
		u.oc.ws.onmessage({ data: JSON.stringify({ type: 'hazir', ad: 'taha', kanallar, kimler: [{ ad: 'taha' }], max: 10, maxKullanici: 10, beyazListe: 1, beyazListeAdlari: ['taha'], sunulanDosyalar: [], ice: ICE, surum: 'v1' }) });
		await bekle(40);
		denetle('bozuk kayıtlı kalite varsayılana döndü', u.window.eval('ayar.yayinKalite') === 510 && u.window.eval('ayar.ekranKalite') === 'standart');
		u.d.getElementById('ben-ayarlar').click();
		await bekle(30);
		denetle('paylaşamayan tarayıcıda paylaşım seçenekleri gizli', u.d.getElementById('ayar-paylasim').hidden === true);
	}

	console.log(process.exitCode ? 'BAŞARISIZ' : `Arayüz denemeleri geçti (${gecen}).`);
	process.exit(process.exitCode || 0);
})();
