// Tarayıcısız arayüz denemesi: gerçek index.html + ana.js, jsdom içinde.
// WebSocket/fetch/getUserMedia/RTCPeerConnection taklit edilir; giriş (kapıyı çalma + anahtar),
// kanal seçimi, mesaj çizimi, kanal ekleme/silme, giriş istekleri, atma, sesli kanal satırları,
// bağlantı istatistikleri ve çık-gir akışı doğrulanır.
// Sunucuda gerçek tarayıcı çalıştırılmaz (VPS'i kastırıyor); jsdom hafif ve ayrı bir Node süreci.
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

// Sayfayı kur: DOM + taklitler + ana.js. Birden çok kez çağrılabilir (hash/çerez senaryoları).
function kur({ url = 'https://chat.deneme/', depo = {} } = {}) {
	const dom = new JSDOM(HTML, { url, pretendToBeVisual: true, runScripts: 'dangerously' });
	const { window } = dom;
	const d = window.document;
	for (const [k, v] of Object.entries(depo)) window.localStorage.setItem(k, v);

	const durum = { gonderilen: [], ws: null, mikrofon: 0 };

	class FakeWS {
		static OPEN = 1;
		constructor(hedef) {
			this.url = hedef;
			this.readyState = 1;
			durum.ws = this;
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
	window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ iceServers: [] }) });
	Object.defineProperty(window.navigator, 'mediaDevices', {
		value: {
			getUserMedia: async () => {
				durum.mikrofon++;
				const parca = { enabled: true, kind: 'audio', readyState: 'live', stop() { this.readyState = 'ended'; } };
				return { getTracks: () => [parca], getAudioTracks: () => [parca] };
			},
		},
		configurable: true,
	});
	class FakePC {
		constructor() {
			FakePC.hepsi.push(this);
			this.signalingState = 'stable';
			this.connectionState = 'new';
			this.remoteDescription = null;
			this._senders = [];
			this._transceivers = [];
		}
		addTransceiver(track, ayar) {
			const parca = typeof track === 'string' ? null : track;
			const tr = {
				sender: { track: parca, replaceTrack: async () => {}, setStreams() {} },
				receiver: { track: { kind: 'audio' } },
				direction: (ayar && ayar.direction) || 'sendrecv',
			};
			this._transceivers.push(tr);
			return tr;
		}
		addTrack(t) {
			this._senders.push({ track: t, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} });
		}
		getSenders() {
			return this._senders;
		}
		getTransceivers() {
			return this._transceivers;
		}
		async setLocalDescription() {
			this.localDescription = { type: 'offer', sdp: 'v=0' };
			this.signalingState = 'have-local-offer';
		}
		async setRemoteDescription(aciklama) {
			this.remoteDescription = aciklama;
			// Tarayıcı gibi: teklifteki ses m-line'ı için transceiver oluşur, varsayılan yön recvonly.
			if (aciklama && aciklama.type === 'offer' && !this._transceivers.length) {
				const tr = { mid: '0', direction: 'recvonly', receiver: { track: { kind: 'audio' } }, sender: { track: null, setStreams() {} } };
				tr.sender.replaceTrack = async (t) => {
					tr.sender.track = t;
				};
				this._transceivers.push(tr);
			}
		}
		async addIceCandidate() {}
		async getStats() {
			// Artan sayaçlar: kayıp/bit hızı iki ölçüm arasındaki farktan hesaplanır.
			const t = Date.now() / 1000;
			const m = new Map();
			m.set('tr', { type: 'transport', selectedCandidatePairId: 'pair' });
			m.set('pair', {
				type: 'candidate-pair',
				state: 'succeeded',
				nominated: true,
				localCandidateId: 'yerel',
				remoteCandidateId: 'uzak',
				currentRoundTripTime: 0.031,
			});
			m.set('yerel', { id: 'yerel', type: 'local-candidate', candidateType: 'srflx' });
			m.set('uzak', { id: 'uzak', type: 'remote-candidate', candidateType: 'srflx' });
			m.set('gelen', {
				type: 'inbound-rtp',
				kind: 'audio',
				packetsReceived: Math.round(t * 50),
				packetsLost: 3,
				bytesReceived: Math.round(t * 8000),
				jitter: 0.011,
			});
			return m;
		}
		restartIce() {}
		close() {
			this.signalingState = 'closed';
		}
	}
	FakePC.hepsi = [];
	window.RTCPeerConnection = FakePC;
	window.AudioContext = class {
		constructor() {
			this.state = 'running';
		}
		createAnalyser() {
			return { fftSize: 256, frequencyBinCount: 128, getByteFrequencyData() {} };
		}
		createMediaStreamSource() {
			return { connect() {}, disconnect() {} };
		}
		resume() {
			return Promise.resolve();
		}
		close() {
			return Promise.resolve();
		}
	};

	window.eval(BETIK);
	return { window, d, ...durum, oc: durum, FakePC };
}

const kanallar = [
	{ id: 'genel', ad: 'genel', tur: 'yazi' },
	{ id: 'muhabbet', ad: 'muhabbet', tur: 'yazi' },
	{ id: 'sesli-sohbet', ad: 'Sesli Sohbet', tur: 'ses', kisiler: [] },
	{ id: 'muzik', ad: 'Müzik', tur: 'ses', kisiler: [] },
];

(async () => {
	// --- 0) anahtar kurulum bağlantısı: #anahtar=… → localStorage + otomatik giriş
	{
		const s = kur({ url: 'https://chat.deneme/#anahtar=abc123def456', depo: { ad: 'taha' } });
		await bekle(200); // otomatik giriş ICE'yi bekler
		denetle('hash ile anahtar kaydedildi', s.window.localStorage.getItem('anahtar') === 'abc123def456', String(s.window.localStorage.getItem('anahtar')));
		denetle('adres çubuğu temizlendi', !s.window.location.hash, s.window.location.hash);
		const g = s.oc.gonderilen.find((m) => m.type === 'giris');
		denetle('anahtarla otomatik giriş yapıldı', g && g.anahtar === 'abc123def456', JSON.stringify(g));
	}

	// --- 1) giriş ekranı: sadece ad
	const s = kur();
	const d = s.d;
	const w = s.window;
	denetle('giriş ekranı görünür', !d.getElementById('giris-ekrani').hidden);
	denetle('uygulama gizli', d.getElementById('uygulama').hidden);
	denetle('giriş alanında örnek yazı yok', d.getElementById('ad').getAttribute('placeholder') === null);
	denetle('giriş açıklaması yok', !d.querySelector('#giris .alt') && !/Hesap yok/i.test(d.getElementById('giris').textContent));
	denetle('sunucu şeridi (en sol bar) yok', d.getElementById('kenar') === null);
	denetle('anahtarsız açılışta WebSocket açılmadı', !s.oc.ws);

	// --- 2) ad yaz → kapıyı çal → "izin bekleniyor"
	d.getElementById('ad').value = 'taha';
	d.getElementById('giris').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
	await bekle(80);
	denetle('WebSocket açıldı', !!s.oc.ws && s.oc.ws.url.endsWith('/rtc'), s.oc.ws && s.oc.ws.url);
	const girisMesaji = s.oc.gonderilen.find((m) => m.type === 'giris');
	denetle('giris mesajı gönderildi', girisMesaji && girisMesaji.ad === 'taha', JSON.stringify(girisMesaji));
	denetle('anahtarsız istekte anahtar boş', girisMesaji && !girisMesaji.anahtar);

	s.oc.ws.onmessage({ data: JSON.stringify({ type: 'bekleniyor', ad: 'taha', anahtarGecersiz: false }) });
	await bekle(40);
	denetle('izin bekleniyor durumu gösterildi', /izin bekleniyor/i.test(d.getElementById('giris-durum').textContent), d.getElementById('giris-durum').textContent);
	denetle('ad alanı kilitlendi', d.getElementById('ad').disabled === true);
	denetle('istek geri çek düğmesi göründü', d.getElementById('giris-iptal').hidden === false);

	// --- 3) onaylandı → anahtar saklandı, arayüz açıldı
	const hazir = {
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
	};
	s.oc.ws.onmessage({ data: JSON.stringify(hazir) });
	await bekle(60);

	denetle('giriş ekranı kapandı', d.getElementById('giris-ekrani').hidden);
	denetle('uygulama açıldı', !d.getElementById('uygulama').hidden);
	denetle('verilen anahtar localStorage’a yazıldı', w.localStorage.getItem('anahtar') === 'f'.repeat(128));
	denetle('kendi adı yazıldı', d.getElementById('ben-ad').textContent === 'taha', d.getElementById('ben-ad').textContent);
	denetle('yazılı kanallar çizildi', d.querySelectorAll('#yazi-kanallari .kanal-satir').length === 2, String(d.querySelectorAll('#yazi-kanallari .kanal-satir').length));
	denetle('sesli kanallar çizildi', d.querySelectorAll('#ses-kanallari .kanal-satir').length === 2, String(d.querySelectorAll('#ses-kanallari .kanal-satir').length));
	denetle('kanal silme düğmesi var', d.querySelectorAll('#yazi-kanallari .kanal-sil').length === 2);
	denetle('kanal ekleme düğmeleri var', !!d.getElementById('yazi-ekle') && !!d.getElementById('ses-ekle'));
	denetle('ilk kanal #genel seçildi', d.getElementById('kanal-ad').textContent === '#genel', d.getElementById('kanal-ad').textContent);
	denetle('çevrimiçi sayısı 2', d.getElementById('uye-sayi').textContent === '2', d.getElementById('uye-sayi').textContent);
	denetle('beyaz liste göstergesi', /3\/10/.test(d.getElementById('beyaz-liste').textContent), d.getElementById('beyaz-liste').textContent);
	// Beyaz listede olup çevrimdışı olan kişi de üye panelinde görünür (soluk + "çevrimdışı").
	denetle('çevrimdışı beyaz liste üyesi listelendi', d.querySelectorAll('#uye-listesi .uye').length === 3, String(d.querySelectorAll('#uye-listesi .uye').length));
	denetle('çevrimdışı üye işaretli', d.querySelectorAll('#uye-listesi .uye.cevrimdisi').length === 1, String(d.querySelectorAll('#uye-listesi .uye.cevrimdisi').length));
	denetle('çevrimdışı üye adı + etiketi', /deniz/.test(d.querySelector('#uye-listesi .uye.cevrimdisi')?.textContent || '') && /çevrimdışı/.test(d.querySelector('#uye-listesi .uye.cevrimdisi')?.textContent || ''), d.querySelector('#uye-listesi .uye.cevrimdisi')?.textContent);
	denetle('üye listesinde atma düğmesi (kendinde yok)', d.querySelectorAll('#uye-listesi .uye-at').length === 2, String(d.querySelectorAll('#uye-listesi .uye-at').length));
	denetle('geçmiş istendi', s.oc.gonderilen.some((m) => m.type === 'gecmis' && m.kanal === 'genel'));
	denetle('mic düğmesi sesli kanal yokken kapalı', d.getElementById('ben-mikrofon').disabled === true);

	// --- 4) geçmiş çizilir (gruplama + gün ayırıcı + bahsetme + resim)
	const simdi = Date.now();
	s.oc.ws.onmessage({
		data: JSON.stringify({
			type: 'gecmis',
			kanal: 'genel',
			bitti: false,
			mesajlar: [
				{ id: 1, ad: 'bora', metin: 'selam', zaman: simdi - 3600000 },
				{ id: 2, ad: 'bora', metin: 'ikinci mesaj', zaman: simdi - 3500000 },
				{ id: 3, ad: 'bora', metin: '@taha duyuyor musun', zaman: simdi - 60000 },
				{ id: 4, ad: 'bora', metin: '', zaman: simdi - 50000, dosya: { id: 'b'.repeat(18), ad: 'resim.png', boyut: 2048, tur: 'image/png' } },
			],
		}),
	});
	await bekle(40);
	const mesajlar = d.querySelectorAll('#mesajlar .mesaj');
	denetle('4 mesaj çizildi', mesajlar.length === 4, String(mesajlar.length));
	denetle('gruplama: 2. mesaj gruplu', mesajlar[1].classList.contains('gruplu'));
	denetle('gün ayırıcı var', d.querySelectorAll('#mesajlar .gun').length >= 1);
	denetle('bahsetme vurgulandı', d.querySelectorAll('#mesajlar .bahsetme').length === 1);
	denetle('resim önizlemesi var', !!d.querySelector('#mesajlar img.onizleme'));
	denetle('daha eski düğmesi görünür', d.getElementById('daha-eski').hidden === false);

	// --- 5) yeni mesaj + okunmamış rozeti
	s.oc.ws.onmessage({ data: JSON.stringify({ type: 'yazi', kanal: 'genel', mesaj: { id: 5, ad: 'bora', metin: 'yeni mesaj', zaman: Date.now() } }) });
	await bekle(30);
	denetle('yeni mesaj eklendi', d.querySelectorAll('#mesajlar .mesaj').length === 5, String(d.querySelectorAll('#mesajlar .mesaj').length));
	s.oc.ws.onmessage({ data: JSON.stringify({ type: 'yazi', kanal: 'muhabbet', mesaj: { id: 6, ad: 'bora', metin: 'başka kanal', zaman: Date.now() } }) });
	await bekle(30);
	const muhabbetDugme = [...d.querySelectorAll('#yazi-kanallari .kanal')].find((b) => b.textContent.includes('muhabbet'));
	denetle('okunmamış rozeti', !!muhabbetDugme.querySelector('.rozet'));
	denetle('sekme başlığı rozetli', d.title.startsWith('(1)'), d.title);

	// --- 6) mesaj gönderme
	d.getElementById('metin').value = 'merhaba dünya';
	d.getElementById('yazma').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
	await bekle(30);
	const yazi = s.oc.gonderilen.filter((m) => m.type === 'yazi').at(-1);
	denetle('yazi gönderildi', yazi && yazi.metin === 'merhaba dünya' && yazi.kanal === 'genel', JSON.stringify(yazi));
	denetle('yazma kutusu temizlendi', d.getElementById('metin').value === '');

	// --- 7) kanal değiştirme
	muhabbetDugme.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	await bekle(40);
	denetle('kanal değişti', d.getElementById('kanal-ad').textContent === '#muhabbet', d.getElementById('kanal-ad').textContent);
	denetle('yeni kanal için geçmiş istendi', s.oc.gonderilen.filter((m) => m.type === 'gecmis').at(-1).kanal === 'muhabbet');
	denetle('rozet temizlendi', !d.title.startsWith('('), d.title);

	// --- 8) kanal ekleme / silme
	d.getElementById('yazi-ekle').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	await bekle(20);
	denetle('ekleme penceresi açıldı', d.getElementById('pencere').hidden === false);
	denetle('pencere başlığı yazılı kanal', /Yazılı kanal ekle/.test(d.getElementById('pencere-baslik').textContent));
	denetle('girdi odaklandı', d.activeElement === d.getElementById('pencere-girdi'));
	d.getElementById('pencere-girdi').value = 'duyurular';
	d.getElementById('pencere-form').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
	await bekle(30);
	const ekleMesaji = s.oc.gonderilen.filter((m) => m.type === 'kanal-ekle').at(-1);
	denetle('kanal-ekle gönderildi', ekleMesaji && ekleMesaji.tur === 'yazi' && ekleMesaji.ad === 'duyurular', JSON.stringify(ekleMesaji));

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
	await bekle(30);
	const silMesaji = s.oc.gonderilen.filter((m) => m.type === 'kanal-sil').at(-1);
	denetle('kanal-sil gönderildi', silMesaji && silMesaji.kanal === 'genel', JSON.stringify(silMesaji));

	// --- 9) giriş istekleri: kabul / red
	s.oc.ws.onmessage({ data: JSON.stringify({ type: 'giris-istegi', id: 'i1', ad: 'deniz' }) });
	await bekle(30);
	const istekKarti = d.querySelector('#istekler .istek');
	denetle('giriş isteği kartı göründü', !!istekKarti && /deniz/.test(istekKarti.textContent), istekKarti && istekKarti.textContent);
	const dugmeler = istekKarti.querySelectorAll('button');
	denetle('kabul/red düğmeleri var', dugmeler.length === 2, String(dugmeler.length));
	dugmeler[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	await bekle(30);
	const karar = s.oc.gonderilen.filter((m) => m.type === 'giris-karari').at(-1);
	denetle('kabul kararı gönderildi', karar && karar.id === 'i1' && karar.kabul === true, JSON.stringify(karar));
	denetle('istek kartı kapandı', d.querySelectorAll('#istekler .istek').length === 0);

	s.oc.ws.onmessage({ data: JSON.stringify({ type: 'giris-istegi', id: 'i2', ad: 'kerem' }) });
	await bekle(30);
	const kart2 = d.querySelector('#istekler .istek');
	kart2.querySelectorAll('button')[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	await bekle(30);
	const karar2 = s.oc.gonderilen.filter((m) => m.type === 'giris-karari').at(-1);
	denetle('red kararı gönderildi', karar2 && karar2.id === 'i2' && karar2.kabul === false, JSON.stringify(karar2));

	// --- 10) üye atmak (onaylı)
	const atDugme = d.querySelector('#uye-listesi .uye-at');
	atDugme.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	await bekle(20);
	denetle('atma onayı istendi', d.getElementById('pencere').hidden === false && /bora/.test(d.getElementById('pencere-metin').textContent), d.getElementById('pencere-metin').textContent);
	d.getElementById('pencere-form').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
	await bekle(30);
	const atMesaji = s.oc.gonderilen.filter((m) => m.type === 'at').at(-1);
	denetle('at mesajı gönderildi', atMesaji && atMesaji.ad === 'bora', JSON.stringify(atMesaji));

	// --- 10b) kişi limiti arttır/azalt (beyaz listedekiler)
	denetle('limit düğmeleri etkin', !d.getElementById('limit-cok').disabled && !d.getElementById('limit-az').disabled);
	d.getElementById('limit-cok').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	await bekle(20);
	const limitArti = s.oc.gonderilen.filter((m) => m.type === 'kisi-limiti').at(-1);
	denetle('limit arttırma mesajı gönderildi', limitArti && limitArti.deger === 11, JSON.stringify(limitArti));
	// Sunucu yeni limiti duyurur → gösterge güncellenmeli.
	s.oc.ws.onmessage({ data: JSON.stringify({ type: 'kimler', kimler: [], beyazListe: 2, maxKullanici: 11 }) });
	await bekle(20);
	denetle('limit göstergesi güncellendi', /2\/11/.test(d.getElementById('beyaz-liste').textContent), d.getElementById('beyaz-liste').textContent);
	d.getElementById('limit-az').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	await bekle(20);
	const limitEksi = s.oc.gonderilen.filter((m) => m.type === 'kisi-limiti').at(-1);
	denetle('limit azaltma mesajı gönderildi', limitEksi && limitEksi.deger === 10, JSON.stringify(limitEksi));

	// --- 11) sesli kanala gir
	const sesDugme = [...d.querySelectorAll('#ses-kanallari .kanal')].find((b) => b.textContent.includes('Sesli Sohbet'));
	sesDugme.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	await bekle(60);
	denetle('mikrofon istendi', s.oc.mikrofon === 1, String(s.oc.mikrofon));
	denetle('ses-gir gönderildi', s.oc.gonderilen.some((m) => m.type === 'ses-gir' && m.kanal === 'sesli-sohbet'));

	s.oc.ws.onmessage({ data: JSON.stringify({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: ['bora'] }) });
	await bekle(60);
	denetle('ses kartı göründü', d.getElementById('ses-karti').hidden === false);
	denetle('kendi satırı + eş satırı', d.querySelectorAll('#ses-kisiler .ses-kisi').length === 2, String(d.querySelectorAll('#ses-kisiler .ses-kisi').length));
	denetle('eş satırında ses seviyesi kaydırıcısı', !!d.querySelector('#ses-kisiler input.ses-seviye'));
	// Tek yönlü ses hatası sınıfı: ses kanalı MİKROFON İZİYLE açılmalı. İzsiz açılırsa Firefox
	// yanıtı "recvonly"ye kilitliyor ve karşı taraf hiç ses almıyor.
	const ilkPc = s.FakePC.hepsi[s.FakePC.hepsi.length - 1];
	const ilkTr = ilkPc && ilkPc._transceivers[0];
	denetle('ses kanalı mikrofon iziyle açıldı', !!(ilkTr && ilkTr.sender.track), ilkTr && ilkTr.sender.track ? 'iz var' : 'iz yok');
	denetle('ses kanalı sendrecv', !!(ilkTr && ilkTr.direction === 'sendrecv'), ilkTr && ilkTr.direction);
	denetle('mikrofon düğmesi açıldı', d.getElementById('ben-mikrofon').disabled === false);
	denetle('sessiz durumu bildirildi', s.oc.gonderilen.some((m) => m.type === 'sessiz'));

	// Yanıtlayan taraf (adı büyük olan teklif eder → 'zeynep' > 'taha'): transceiver'ı ÖNCEDEN açmamalı,
	// teklifteki m-line'ın transceiver'ını sendrecv'e çevirip mikrofonu ona bağlamalı.
	// (Önceden açılan transceiver m-line ile eşleşmiyordu → yanıt recvonly → tek yönlü ses.)
	s.oc.ws.onmessage({ data: JSON.stringify({ type: 'ses-kisi-girdi', ad: 'zeynep' }) });
	await bekle(40);
	const yPc = s.FakePC.hepsi[s.FakePC.hepsi.length - 1];
	denetle('yanıtlayan tarafta önceden transceiver yok', yPc._transceivers.length === 0, String(yPc._transceivers.length));
	s.oc.ws.onmessage({ data: JSON.stringify({ type: 'sdp', from: 'zeynep', sdp: { type: 'offer', sdp: 'v=0' } }) });
	await bekle(120);
	const yTr = yPc._transceivers.find((t) => t.mid != null);
	denetle('teklifin m-line transceiver\'ı oluştu', !!yTr);
	denetle('yanıtlayan ses kanalı sendrecv', !!(yTr && yTr.direction === 'sendrecv'), yTr && yTr.direction);
	denetle('yanıtlayan mikrofonu bağladı', !!(yTr && yTr.sender.track));

	// istatistikler: iki ölçüm arası fark gerekir (2 sn aralık) → ~4,5 sn bekle
	await bekle(4600);
	const istatistik = d.querySelector('#ses-kisiler .ses-istatistik');
	denetle('istatistik alanı dolu', istatistik && /P2P/.test(istatistik.textContent), istatistik && istatistik.textContent);
	denetle('gecikme gösteriliyor', /ms/.test(istatistik.textContent));
	denetle('paket kaybı gösteriliyor', /kayıp/.test(istatistik.textContent));
	denetle('bit hızı gösteriliyor', /kbps/.test(istatistik.textContent));

	// --- 12) mikrofonu kapat + çık-gir
	d.getElementById('ben-mikrofon').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	await bekle(30);
	denetle('mikrofon kapatma bildirildi', s.oc.gonderilen.filter((m) => m.type === 'sessiz').at(-1).sessiz === true);

	d.getElementById('ben-kapat').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	await bekle(40);
	denetle('ses-cik gönderildi', s.oc.gonderilen.some((m) => m.type === 'ses-cik'));
	denetle('ses kartı kapandı', d.getElementById('ses-karti').hidden === true);

	sesDugme.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	await bekle(80);
	denetle('yeniden girişte mikrofon tekrar istendi', s.oc.mikrofon === 2, String(s.oc.mikrofon));
	denetle('yeniden ses-gir gönderildi', s.oc.gonderilen.filter((m) => m.type === 'ses-gir').length === 2);
	s.oc.ws.onmessage({ data: JSON.stringify({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: ['bora'] }) });
	await bekle(60);
	denetle('ses kartı yeniden açıldı', d.getElementById('ses-karti').hidden === false);

	// --- 13) kanal silinirse: aktif kanal ilk yazılı kanala döner, sesli kanaldan çıkılır
	s.oc.ws.onmessage({ data: JSON.stringify({ type: 'kanallar', kanallar: [{ id: 'muhabbet', ad: 'muhabbet', tur: 'yazi' }] }) });
	await bekle(60);
	denetle('silinen sesli kanaldan çıkıldı', d.getElementById('ses-karti').hidden === true);

	// --- 14) atıldım: anahtar silinir, giriş ekranına dönülür
	s.oc.ws.onmessage({ data: JSON.stringify({ type: 'atildi', message: 'Sunucudan atıldın; tekrar izin iste.' }) });
	await bekle(60);
	denetle('atılınca anahtar silindi', !w.localStorage.getItem('anahtar'), String(w.localStorage.getItem('anahtar')));
	denetle('atılınca giriş ekranı açıldı', d.getElementById('giris-ekrani').hidden === false && d.getElementById('uygulama').hidden === true);
	denetle('atılma mesajı gösterildi', /atıldın/i.test(d.getElementById('giris-durum').textContent), d.getElementById('giris-durum').textContent);

	// --- 15) hata gösterimi
	d.getElementById('giris-ekrani').hidden = true;
	d.getElementById('uygulama').hidden = false;
	s.oc.ws.onmessage({ data: JSON.stringify({ type: 'hata', message: 'Çok hızlı yazıyorsun; birkaç saniye bekle.' }) });
	await bekle(20);
	denetle('hata bildirimi göründü', d.getElementById('durum').textContent.includes('hızlı'), d.getElementById('durum').textContent);
	denetle('hata kırmızı', d.getElementById('durum').classList.contains('hata'));

	console.log(process.exitCode ? 'BAŞARISIZ' : `Arayüz denemeleri geçti (${gecen}).`);
	process.exit(process.exitCode || 0);
})();
