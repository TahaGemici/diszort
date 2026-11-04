// Tarayıcısız arayüz denemesi: gerçek index.html + ana.js, jsdom içinde.
// WebSocket/getUserMedia/RTCPeerConnection/AudioContext taklit edilir. Giriş (kapıyı çalma +
// anahtar), kanal seçimi, mesaj çizimi (gruplama, bahsetme, bağlantılar), kanal ekleme/silme,
// giriş istekleri (kayıtlı ad uyarısı), atma, kişi limiti, sesli kanal (mikrofon kısıtları, teklif/
// yanıt + oturum kimliği, Opus ayarları, seviye, susturma/sağırlaştırma), bağlantı istatistikleri,
// sunucu bağlantısı koparken ses bağlantılarının korunması, giriş freninde uygulamada kalma,
// oturum devri ve atılma doğrulanır. Gerçek WebRTC için: test/tarayici.js.
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

// Sayfayı kur: DOM + taklitler + ana.js. Birden çok kez çağrılabilir (hash/depo senaryoları).
function kur({ url = 'https://chat.deneme/', depo = {}, oturumDepo = {} } = {}) {
	const dom = new JSDOM(HTML, { url, pretendToBeVisual: true, runScripts: 'dangerously' });
	const { window } = dom;
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
	const izYap = () => {
		const iz = {
			enabled: true,
			kind: 'audio',
			readyState: 'live',
			dinleyiciler: {},
			stop() {
				this.readyState = 'ended';
			},
			addEventListener(ad, fn) {
				(this.dinleyiciler[ad] = this.dinleyiciler[ad] || []).push(fn);
			},
			getSettings: () => ({ echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1, sampleRate: 48000 }),
		};
		return iz;
	};
	Object.defineProperty(window.navigator, 'mediaDevices', {
		value: {
			getUserMedia: async (kisitlar) => {
				durum.mikrofon++;
				durum.micKisit = kisitlar && kisitlar.audio ? { ...kisitlar.audio } : null;
				const iz = izYap();
				durum.sonIz = iz;
				return { getTracks: () => [iz], getAudioTracks: () => [iz] };
			},
			enumerateDevices: async () => [],
			addEventListener() {},
			ondevicechange: null,
		},
		configurable: true,
	});
	window.MediaStream = class {
		constructor(izler) {
			this.izler = izler || [];
		}
		getAudioTracks() {
			return this.izler;
		}
		getTracks() {
			return this.izler;
		}
	};
	window.HTMLMediaElement.prototype.play = function () {
		this._caliyor = true;
		return Promise.resolve();
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
		}
		_tr(track, yon, mid) {
			const tr = {
				mid: mid ?? null,
				direction: yon,
				currentDirection: null,
				receiver: { track: { kind: 'audio' } },
				sender: {
					track,
					async replaceTrack(t) {
						this.track = t;
					},
					getParameters: () => ({ encodings: [{}] }),
					async setParameters(p) {
						tr.parametreler = p;
					},
				},
			};
			this._transceivers.push(tr);
			return tr;
		}
		addTransceiver(track, ayar) {
			const tr = this._tr(typeof track === 'string' ? null : track, (ayar && ayar.direction) || 'sendrecv');
			setTimeout(() => this.onnegotiationneeded && this.onnegotiationneeded(), 0);
			return tr;
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
			return { type: 'answer', sdp: OPUS_TEKLIF };
		}
		async setLocalDescription(d) {
			this.localDescription = d;
			this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
		}
		async setRemoteDescription(d) {
			this.remoteDescription = d;
			FakePC.uzaklar.push(d);
			if (d.type === 'offer') {
				this.signalingState = 'have-remote-offer';
				// Tarayıcı gibi: teklifteki ses m-line'ı için transceiver oluşur, varsayılan yön recvonly.
				if (!this._transceivers.length) this._tr(null, 'recvonly', '0');
			} else this.signalingState = 'stable';
		}
		async addIceCandidate() {}
		async getStats() {
			// Artan sayaçlar: kayıp/bit hızı iki ölçüm arasındaki farktan hesaplanır.
			const t = Date.now() / 1000;
			const m = new Map();
			m.set('tr', { type: 'transport', selectedCandidatePairId: 'pair' });
			m.set('pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'yerel', remoteCandidateId: 'uzak', currentRoundTripTime: 0.031 });
			m.set('yerel', { id: 'yerel', type: 'local-candidate', candidateType: FakePC.adayTuru });
			m.set('uzak', { id: 'uzak', type: 'remote-candidate', candidateType: 'srflx' });
			m.set('gelen', { type: 'inbound-rtp', kind: 'audio', packetsReceived: Math.round(t * 50), packetsLost: 3, bytesReceived: Math.round(t * 12000), jitter: 0.011 });
			m.set('giden', { type: 'outbound-rtp', kind: 'audio', bytesSent: Math.round(t * 12000) });
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
	window.RTCPeerConnection = FakePC;
	window.AudioContext = class {
		constructor() {
			this.state = 'running';
			this.currentTime = 0;
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
			return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} };
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
		await bekle(1700);
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
		dosyaMb: 25,
		jeton: 'a'.repeat(32),
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

	// --- 4) geçmiş çizilir (gruplama + gün ayırıcı + bahsetme + resim + bağlantı)
	const simdi = Date.now();
	gelsin({
		type: 'gecmis',
		kanal: 'genel',
		bitti: false,
		mesajlar: [
			{ id: 1, ad: 'bora', metin: 'selam', zaman: simdi - 3600000 },
			{ id: 2, ad: 'bora', metin: 'ikinci mesaj', zaman: simdi - 3500000 },
			{ id: 3, ad: 'bora', metin: '@taha duyuyor musun https://ornek.com/a?b=1.', zaman: simdi - 60000 },
			{ id: 4, ad: 'bora', metin: '', zaman: simdi - 50000, dosya: { id: 'b'.repeat(18), ad: 'resim.png', boyut: 2048, tur: 'image/png' } },
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
		denetle('önizlemeye tıklayınca büyüteç açılır', !b.hidden && /\/dosya\/b{18}$/.test(r.src), r.src);
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
	denetle('TURN sunucuları bağlantıya verildi', ilkPc && ilkPc.ayar.iceServers.length === 2);
	const teklif = son('sdp');
	denetle('teklif gönderildi, oturum kimliği var', teklif && teklif.to === 'bora' && teklif.sdp.type === 'offer' && /^[a-z0-9]{12}$/.test(teklif.oturum || ''), JSON.stringify(teklif));
	// Yanıt: Opus fmtp'si bizim kodlayıcımızı ayarlar (yüksek bit hızı + FEC).
	gelsin({ type: 'sdp', from: 'bora', sdp: { type: 'answer', sdp: OPUS_TEKLIF }, oturum: teklif.oturum });
	await bekle(40);
	const uygulanan = s.FakePC.uzaklar.at(-1);
	denetle('yanıt uygulandı', ilkPc.remoteDescription && ilkPc.remoteDescription.type === 'answer');
	denetle('Opus: maxaveragebitrate=96000 + FEC + DTX kapalı', uygulanan && /maxaveragebitrate=96000/.test(uygulanan.sdp) && /useinbandfec=1/.test(uygulanan.sdp) && /usedtx=0/.test(uygulanan.sdp), uygulanan && uygulanan.sdp);
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
	gelsin({ type: 'sdp', from: 'zeynep', sdp: { type: 'offer', sdp: OPUS_TEKLIF }, oturum: 'zoturum12345' });
	await bekle(60);
	const zPc = s.FakePC.hepsi.at(-1);
	const zTr = zPc._transceivers.find((t) => t.mid != null);
	denetle("teklifin m-line transceiver'ı oluştu", !!zTr);
	denetle('yanıtlayan ses kanalı sendrecv', zTr && zTr.direction === 'sendrecv', zTr && zTr.direction);
	denetle('yanıtlayan mikrofonu bağladı', !!(zTr && zTr.sender.track));
	const yanit = son('sdp');
	denetle('yanıt teklifin oturumuyla gönderildi', yanit && yanit.to === 'zeynep' && yanit.sdp.type === 'answer' && yanit.oturum === 'zoturum12345', JSON.stringify(yanit));
	// Aynı teklif yeniden gelirse yeniden uygulanmaz, yanıt yinelenir.
	const uzakSayisi2 = s.FakePC.uzaklar.length;
	gelsin({ type: 'sdp', from: 'zeynep', sdp: { type: 'offer', sdp: OPUS_TEKLIF }, oturum: 'zoturum12345' });
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

	// --- 12) susturma ve sağırlaştırma
	d.getElementById('ben-mikrofon').click();
	await bekle(20);
	denetle('mikrofon kapatma bildirildi', son('sessiz').sessiz === true && son('sessiz').sagir === false);
	denetle('mikrofon izi kapandı', s.oc.sonIz.enabled === false);
	d.getElementById('ben-mikrofon').click();
	await bekle(20);
	denetle('mikrofon açma bildirildi', son('sessiz').sessiz === false && s.oc.sonIz.enabled === true);
	d.getElementById('kart-sagir').click(); // ses kartındaki düğme (telefonda)
	await bekle(20);
	denetle('sağırlaştırma: gelen sesler kapalı + bildirildi', [...d.querySelectorAll('#ses-akislari audio')].every((a) => a.muted) && son('sessiz').sagir === true && son('sessiz').sessiz === true);
	d.getElementById('ben-sagir').click();
	await bekle(20);
	denetle('sağırlık kalktı', [...d.querySelectorAll('#ses-akislari audio')].every((a) => !a.muted) && son('sessiz').sagir === false);

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
	gelsin({ type: 'hazir', ad: 'taha', kanallar, kimler: [{ ad: 'taha' }], max: 10, maxKullanici: 10, beyazListe: 2, beyazListeAdlari: ['taha', 'bora'], dosyaMb: 25, jeton: 'b'.repeat(32), ice: ICE, surum: 'v1', turnNesli: 'n1' });
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
		gelsin({ type: 'hazir', ad: 'taha', kanallar, kimler: [{ ad: 'taha' }], max: 10, maxKullanici: 10, beyazListe: 2, beyazListeAdlari: ['taha', 'bora'], dosyaMb: 25, jeton: 'e'.repeat(32), ice: ICE, surum: 'v1', turnNesli: 'n1' });
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
	sesDugme().click();
	await bekle(60);
	denetle('yeniden girişte mikrofon tekrar istendi', s.oc.mikrofon === 2, String(s.oc.mikrofon));
	gelsin({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: ['bora'], ice: ICE, devam: false });
	await bekle(40);
	denetle('ses kartı yeniden açıldı', d.getElementById('ses-karti').hidden === false);

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
	gelsin({ type: 'hazir', ad: 'taha', kanallar, kimler: [{ ad: 'taha' }], max: 10, maxKullanici: 10, beyazListe: 2, beyazListeAdlari: ['taha'], dosyaMb: 25, jeton: 'c'.repeat(32), ice: ICE, surum: 'v1' });
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
		const yeniHazir = { type: 'hazir', ad: 'taha', kanallar, kimler: [{ ad: 'taha' }], max: 10, maxKullanici: 10, beyazListe: 1, beyazListeAdlari: ['taha'], dosyaMb: 25, jeton: 'd'.repeat(32), ice: ICE, surum: 'v1' };
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

	console.log(process.exitCode ? 'BAŞARISIZ' : `Arayüz denemeleri geçti (${gecen}).`);
	process.exit(process.exitCode || 0);
})();
