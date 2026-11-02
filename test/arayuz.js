// Tarayıcısız arayüz denemesi: gerçek index.html + ana.js, jsdom içinde.
// WebSocket/fetch/getUserMedia/RTCPeerConnection taklit edilir; DOM'un doğru kurulduğu, giriş,
// kanal seçimi, mesaj çizimi, kanal ekleme/silme penceresi, sesli kanal satırları, bağlantı
// istatistikleri ve çık-gir akışı doğrulanır.
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

const kanallar = [
	{ id: 'genel', ad: 'genel', tur: 'yazi' },
	{ id: 'muhabbet', ad: 'muhabbet', tur: 'yazi' },
	{ id: 'sesli-sohbet', ad: 'Sesli Sohbet', tur: 'ses', kisiler: [] },
	{ id: 'muzik', ad: 'Müzik', tur: 'ses', kisiler: [] },
];

(async () => {
	const html = fs.readFileSync(path.join(KOK, 'web/index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
	const dom = new JSDOM(html, { url: 'https://chat.deneme/', pretendToBeVisual: true, runScripts: 'dangerously' });
	const { window } = dom;
	const d = window.document;

	// --- taklitler
	const gonderilen = [];
	let ornekWs = null;
	class FakeWS {
		static OPEN = 1;
		constructor(url) {
			this.url = url;
			this.readyState = 1;
			ornekWs = this;
			setTimeout(() => this.onopen && this.onopen(), 0);
		}
		send(metin) {
			gonderilen.push(JSON.parse(metin));
		}
		close() {
			this.readyState = 3;
			if (this.onclose) this.onclose();
		}
	}
	window.WebSocket = FakeWS;
	window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ iceServers: [] }) });
	let mikrofonIstenen = 0;
	Object.defineProperty(window.navigator, 'mediaDevices', {
		value: {
			getUserMedia: async () => {
				mikrofonIstenen++;
				const parca = { enabled: true, kind: 'audio', readyState: 'live', stop() { this.readyState = 'ended'; } };
				return { getTracks: () => [parca], getAudioTracks: () => [parca] };
			},
		},
		configurable: true,
	});
	class FakePC {
		constructor() {
			this.signalingState = 'stable';
			this.connectionState = 'new';
			this.remoteDescription = null;
			this._senders = [];
			this._transceivers = [];
		}
		addTransceiver(track, ayar) {
			const parca = typeof track === 'string' ? null : track;
			const tr = { sender: { track: parca, replaceTrack: async () => {}, setStreams() {} }, receiver: { track: { kind: 'audio' } }, direction: (ayar && ayar.direction) || 'sendrecv' };
			this._transceivers.push(tr);
			return tr;
		}
		addTrack(t, akis) {
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
		async setRemoteDescription() {}
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

	// --- betiği sayfaya yükle
	window.eval(fs.readFileSync(path.join(KOK, 'web/ana.js'), 'utf8'));

	// --- 1) giriş ekranı: sadece ad
	denetle('giriş ekranı görünür', !d.getElementById('giris-ekrani').hidden);
	denetle('uygulama gizli', d.getElementById('uygulama').hidden);
	denetle('giriş alanında örnek yazı yok', d.getElementById('ad').getAttribute('placeholder') === null, String(d.getElementById('ad').getAttribute('placeholder')));
	denetle('giriş açıklaması yok', !d.querySelector('#giris .alt') && !/Hesap yok/i.test(d.getElementById('giris').textContent));
	denetle('sunucu şeridi (en sol bar) yok', d.getElementById('kenar') === null);

	// --- 2) ad gir → WebSocket + giris
	d.getElementById('ad').value = 'taha';
	d.getElementById('giris').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
	await bekle(60);
	denetle('WebSocket açıldı', !!ornekWs && ornekWs.url.endsWith('/rtc'), ornekWs && ornekWs.url);
	const girisMesaji = gonderilen.find((m) => m.type === 'giris');
	denetle('giris mesajı gönderildi', girisMesaji && girisMesaji.ad === 'taha', JSON.stringify(girisMesaji));
	denetle('sekme kimliği var', !!(girisMesaji && girisMesaji.id));

	// --- 3) hazir → arayüz açılır, kanallar çizilir
	const hazir = {
		type: 'hazir',
		ad: 'taha',
		kanallar,
		kimler: [
			{ ad: 'taha', sessiz: false, ses: null },
			{ ad: 'bora', sessiz: true, ses: null },
		],
		max: 10,
		dosyaMb: 25,
		jeton: 'a'.repeat(32),
	};
	ornekWs.onmessage({ data: JSON.stringify(hazir) });
	await bekle(60);

	denetle('giriş ekranı kapandı', d.getElementById('giris-ekrani').hidden);
	denetle('uygulama açıldı', !d.getElementById('uygulama').hidden);
	denetle('kendi adı yazıldı', d.getElementById('ben-ad').textContent === 'taha', d.getElementById('ben-ad').textContent);
	denetle('yazılı kanallar çizildi', d.querySelectorAll('#yazi-kanallari .kanal-satir').length === 2, String(d.querySelectorAll('#yazi-kanallari .kanal-satir').length));
	denetle('sesli kanallar çizildi', d.querySelectorAll('#ses-kanallari .kanal-satir').length === 2, String(d.querySelectorAll('#ses-kanallari .kanal-satir').length));
	denetle('kanal silme düğmesi var', d.querySelectorAll('#yazi-kanallari .kanal-sil').length === 2);
	denetle('kanal ekleme düğmeleri var', !!d.getElementById('yazi-ekle') && !!d.getElementById('ses-ekle'));
	denetle('ilk kanal #genel seçildi', d.getElementById('kanal-ad').textContent === '#genel', d.getElementById('kanal-ad').textContent);
	denetle('çevrimiçi sayısı 2', d.getElementById('uye-sayi').textContent === '2', d.getElementById('uye-sayi').textContent);
	denetle('üye listesi 2 kişi', d.querySelectorAll('#uye-listesi .uye').length === 2);
	denetle('geçmiş istendi', gonderilen.some((m) => m.type === 'gecmis' && m.kanal === 'genel'));
	denetle('mic düğmesi sesli kanal yokken kapalı', d.getElementById('ben-mikrofon').disabled === true);

	// --- 4) geçmiş çizilir (gruplama + gün ayırıcı + bahsetme + resim)
	const simdi = Date.now();
	ornekWs.onmessage({
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

	// --- 5) yeni mesaj: aktif kanalda eklenir, diğerinde rozet
	ornekWs.onmessage({ data: JSON.stringify({ type: 'yazi', kanal: 'genel', mesaj: { id: 5, ad: 'bora', metin: 'yeni mesaj', zaman: Date.now() } }) });
	await bekle(30);
	denetle('yeni mesaj eklendi', d.querySelectorAll('#mesajlar .mesaj').length === 5, String(d.querySelectorAll('#mesajlar .mesaj').length));
	ornekWs.onmessage({ data: JSON.stringify({ type: 'yazi', kanal: 'muhabbet', mesaj: { id: 6, ad: 'bora', metin: 'başka kanal', zaman: Date.now() } }) });
	await bekle(30);
	const muhabbetDugme = [...d.querySelectorAll('#yazi-kanallari .kanal')].find((b) => b.textContent.includes('muhabbet'));
	denetle('okunmamış rozeti', !!muhabbetDugme.querySelector('.rozet'), muhabbetDugme.innerHTML);
	denetle('sekme başlığı rozetli', d.title.startsWith('(1)'), d.title);

	// --- 6) mesaj gönderme
	d.getElementById('metin').value = 'merhaba dünya';
	d.getElementById('yazma').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
	await bekle(30);
	const yazi = gonderilen.filter((m) => m.type === 'yazi').at(-1);
	denetle('yazi gönderildi', yazi && yazi.metin === 'merhaba dünya' && yazi.kanal === 'genel', JSON.stringify(yazi));
	denetle('yazma kutusu temizlendi', d.getElementById('metin').value === '');

	// --- 7) kanal değiştirme
	muhabbetDugme.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await bekle(40);
	denetle('kanal değişti', d.getElementById('kanal-ad').textContent === '#muhabbet', d.getElementById('kanal-ad').textContent);
	denetle('yeni kanal için geçmiş istendi', gonderilen.filter((m) => m.type === 'gecmis').at(-1).kanal === 'muhabbet');
	denetle('rozet temizlendi', !d.title.startsWith('('), d.title);

	// --- 8) kanal ekleme penceresi
	d.getElementById('yazi-ekle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await bekle(20);
	denetle('ekleme penceresi açıldı', d.getElementById('pencere').hidden === false);
	denetle('pencere başlığı yazılı kanal', /Yazılı kanal ekle/.test(d.getElementById('pencere-baslik').textContent), d.getElementById('pencere-baslik').textContent);
	denetle('girdi alanı görünür', d.getElementById('pencere-girdi').hidden === false);
	denetle('girdi odaklandı', d.activeElement === d.getElementById('pencere-girdi'));
	d.getElementById('pencere-girdi').value = 'duyurular';
	d.getElementById('pencere-form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
	await bekle(30);
	const ekleMesaji = gonderilen.filter((m) => m.type === 'kanal-ekle').at(-1);
	denetle('kanal-ekle gönderildi', ekleMesaji && ekleMesaji.tur === 'yazi' && ekleMesaji.ad === 'duyurular', JSON.stringify(ekleMesaji));
	denetle('pencere kapandı', d.getElementById('pencere').hidden === true);

	// Escape ile kapanma
	d.getElementById('ses-ekle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await bekle(20);
	denetle('sesli kanal penceresi açıldı', /Sesli kanal ekle/.test(d.getElementById('pencere-baslik').textContent));
	d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	await bekle(20);
	denetle('Escape pencereyi kapattı', d.getElementById('pencere').hidden === true);

	// --- 9) kanal silme onayı
	d.querySelector('#yazi-kanallari .kanal-sil').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await bekle(20);
	denetle('silme penceresi açıldı', d.getElementById('pencere').hidden === false);
	denetle('silme penceresinde girdi yok', d.getElementById('pencere-girdi').hidden === true);
	denetle('onay düğmesi "Sil"', d.getElementById('pencere-tamam').textContent === 'Sil', d.getElementById('pencere-tamam').textContent);
	denetle('tehlike rengi', d.getElementById('pencere-tamam').classList.contains('tehlike'));
	d.getElementById('pencere-form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
	await bekle(30);
	const silMesaji = gonderilen.filter((m) => m.type === 'kanal-sil').at(-1);
	denetle('kanal-sil gönderildi', silMesaji && silMesaji.kanal === 'genel', JSON.stringify(silMesaji));

	// --- 10) sesli kanala gir
	const sesDugme = [...d.querySelectorAll('#ses-kanallari .kanal')].find((b) => b.textContent.includes('Sesli Sohbet'));
	sesDugme.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await bekle(60);
	denetle('mikrofon istendi', mikrofonIstenen === 1, String(mikrofonIstenen));
	denetle('ses-gir gönderildi', gonderilen.some((m) => m.type === 'ses-gir' && m.kanal === 'sesli-sohbet'));

	ornekWs.onmessage({ data: JSON.stringify({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: ['bora'] }) });
	await bekle(60);
	denetle('ses kartı göründü', d.getElementById('ses-karti').hidden === false);
	denetle('ses kartı kanal adı', d.getElementById('ses-kart-kanal').textContent === 'Sesli Sohbet', d.getElementById('ses-kart-kanal').textContent);
	denetle('kendi satırı + eş satırı', d.querySelectorAll('#ses-kisiler .ses-kisi').length === 2, String(d.querySelectorAll('#ses-kisiler .ses-kisi').length));
	denetle('eş satırında ses seviyesi kaydırıcısı', !!d.querySelector('#ses-kisiler input.ses-seviye'));
	denetle('ayrılma düğmesi göründü', d.getElementById('ben-kapat').hidden === false);
	denetle('mikrofon düğmesi açıldı', d.getElementById('ben-mikrofon').disabled === false);
	denetle('sessiz durumu bildirildi', gonderilen.some((m) => m.type === 'sessiz'));

	// istatistikler: iki ölçüm arası fark gerekir (2 sn aralık) → ~4,5 sn bekle
	await bekle(4600);
	const istatistik = d.querySelector('#ses-kisiler .ses-istatistik');
	denetle('istatistik alanı dolu', istatistik && /P2P/.test(istatistik.textContent), istatistik && istatistik.textContent);
	denetle('gecikme gösteriliyor', /ms/.test(istatistik.textContent), istatistik && istatistik.textContent);
	denetle('paket kaybı gösteriliyor', /kayıp/.test(istatistik.textContent), istatistik && istatistik.textContent);
	denetle('bit hızı gösteriliyor', /kbps/.test(istatistik.textContent), istatistik && istatistik.textContent);

	// --- 11) mikrofonu kapat
	d.getElementById('ben-mikrofon').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await bekle(30);
	denetle('mikrofon kapatma bildirildi', gonderilen.filter((m) => m.type === 'sessiz').at(-1).sessiz === true);

	// --- 12) çık-gir: sesli kanaldan ayrıl, yeniden gir
	d.getElementById('ben-kapat').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await bekle(40);
	denetle('ses-cik gönderildi', gonderilen.some((m) => m.type === 'ses-cik'));
	denetle('ses kartı kapandı', d.getElementById('ses-karti').hidden === true);
	denetle('eş satırları temizlendi', d.querySelectorAll('#ses-kisiler .ses-kisi').length === 1, String(d.querySelectorAll('#ses-kisiler .ses-kisi').length));

	sesDugme.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await bekle(80);
	denetle('yeniden girişte mikrofon tekrar istendi', mikrofonIstenen === 2, String(mikrofonIstenen));
	denetle('yeniden ses-gir gönderildi', gonderilen.filter((m) => m.type === 'ses-gir').length === 2);
	ornekWs.onmessage({ data: JSON.stringify({ type: 'ses-girdi', kanal: 'sesli-sohbet', kisiler: ['bora'] }) });
	await bekle(60);
	denetle('ses kartı yeniden açıldı', d.getElementById('ses-karti').hidden === false);
	denetle('yeni eş bağlantısı kuruldu (transceiver)', d.querySelectorAll('#ses-kisiler .ses-kisi').length === 2);

	// --- 13) kanal silinirse: aktif kanal ilk yazılı kanala döner, sesli kanaldan çıkılır
	ornekWs.onmessage({ data: JSON.stringify({ type: 'kanallar', kanallar: [{ id: 'muhabbet', ad: 'muhabbet', tur: 'yazi' }] }) });
	await bekle(60);
	denetle('silinen sesli kanaldan çıkıldı', d.getElementById('ses-karti').hidden === true);
	denetle('aktif kanal hâlâ muhabbet', d.getElementById('kanal-ad').textContent === '#muhabbet');

	// --- 14) hata gösterimi
	ornekWs.onmessage({ data: JSON.stringify({ type: 'hata', message: 'Çok hızlı yazıyorsun; birkaç saniye bekle.' }) });
	await bekle(20);
	denetle('hata bildirimi göründü', d.getElementById('durum').textContent.includes('hızlı'), d.getElementById('durum').textContent);
	denetle('hata kırmızı', d.getElementById('durum').classList.contains('hata'));

	console.log(process.exitCode ? 'BAŞARISIZ' : `Arayüz denemeleri geçti (${gecen}).`);
	process.exit(process.exitCode || 0);
})();
