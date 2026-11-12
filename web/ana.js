// Diszort — tarayıcı tarafı.
// Discord'umsu tek sunucu: solda yazılı/sesli kanallar, ortada sohbet, sağda üyeler.
// Yazılı mesajlar sunucudan geçer ve SQLite'ta saklanır; sesli kanallarda ses ve ekran paylaşımı
// (ekranlı ya da ekransız, yalnızca ses) P2P akar (mesh WebRTC, doğrudan bağlanamayanlar TURN
// üzerinden). Dosyalar da P2P'dir: sunucuya yüklenmez, paylaşanın tarayıcısından doğrudan alınır.
//
// Sunucuyla bağlantı koparsa (ağ değişti, sunucu güncellendi) ses bağlantıları KAPATILMAZ: ses
// sunucudan geçmediği için konuşma sürer; geri bağlanınca kanala "devam" denir ve yalnızca bozulan
// eş bağlantıları yeniden kurulur. Her eş bağlantısının bir "oturum" kimliği vardır (teklif eden
// üretir); eski bağlantıya ait yanıt/adaylar bununla ayıklanır.
'use strict';

// ---------------------------------------------------------------- yardımcılar

const $ = (id) => document.getElementById(id);
function el(etiket, sinif, metin) {
	const e = document.createElement(etiket);
	if (sinif) e.className = sinif;
	if (metin != null) e.textContent = metin;
	return e;
}
function depoOku(ad, varsayilan = '') {
	try {
		const d = localStorage.getItem(ad);
		return d === null ? varsayilan : d;
	} catch {
		return varsayilan;
	}
}
function depoYaz(ad, deger) {
	try {
		if (deger === null || deger === undefined) localStorage.removeItem(ad);
		else localStorage.setItem(ad, String(deger));
	} catch {}
}
const medyaSorgu = (q) => typeof window.matchMedia === 'function' && window.matchMedia(q).matches;
const dokunmatik = () => medyaSorgu('(pointer: coarse)');
function rastgeleKimlik(n = 12) {
	const harf = 'abcdefghijklmnopqrstuvwxyz0123456789';
	const dizi = new Uint8Array(n);
	try {
		crypto.getRandomValues(dizi);
	} catch {
		for (let i = 0; i < n; i++) dizi[i] = Math.floor(Math.random() * 256);
	}
	let s = '';
	for (const b of dizi) s += harf[b % harf.length];
	return s;
}
function rastgeleHex(n = 24) {
	const dizi = new Uint8Array(Math.ceil(n / 2));
	try {
		crypto.getRandomValues(dizi);
	} catch {
		for (let i = 0; i < dizi.length; i++) dizi[i] = Math.floor(Math.random() * 256);
	}
	return [...dizi].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, n);
}
// play() bazı ortamlarda söz döndürmez ya da hemen hata atar; hep söz döndür.
function oynat(ses) {
	try {
		const p = ses.play();
		return p && typeof p.then === 'function' ? p : Promise.resolve();
	} catch (h) {
		return Promise.reject(h);
	}
}

// ---------------------------------------------------------------- simgeler (satır içi SVG)

const SIMGE_HOPARLOR = '<path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z"/>';
const SIMGE_KULAKLIK =
	'<path d="M3.5 17v-4.5a8.5 8.5 0 0 1 17 0V17"/><path d="M20.5 15.5V17a2.5 2.5 0 0 1-2.5 2.5h-1v-6h1a2.5 2.5 0 0 1 2.5 2z"/>' +
	'<path d="M3.5 15.5V17A2.5 2.5 0 0 0 6 19.5h1v-6H6a2.5 2.5 0 0 0-2.5 2z"/>';
const SIMGELER = {
	// Diszort: Discord'a benzeyen oyun kolu yüzü (kendi çizimimiz) ve üstünde kırmızı çarpı. Renkleri
	// kendinden (simgelerin currentColor çizgisi kullanılmaz).
	diszort:
		'<rect width="24" height="24" rx="6.5" fill="#5865f2" stroke="none"/><g transform="translate(12 12.3) scale(0.84) translate(-12 -12)"><path fill="#fff" stroke="none" fill-rule="evenodd" d="M6.6 4.9C9.6 5.9 14.4 5.9 17.4 4.9C19.4 5.6 20.6 7.2 21.2 9.6C22 12.6 21.9 15.4 21.2 17.3C20 18.4 18.6 19.1 17.3 19.4L16.3 17.9C13.5 18.6 10.5 18.6 7.7 17.9L6.7 19.4C5.4 19.1 4 18.4 2.8 17.3C2.1 15.4 2 12.6 2.8 9.6C3.4 7.2 4.6 5.6 6.6 4.9ZM7.35 12.5a1.65 1.85 0 1 0 3.3 0a1.65 1.85 0 1 0 -3.3 0ZM13.35 12.5a1.65 1.85 0 1 0 3.3 0a1.65 1.85 0 1 0 -3.3 0Z"/></g><path d="M5.6 5.6 18.4 18.4M18.4 5.6 5.6 18.4" fill="none" stroke="#5865f2" stroke-width="3" stroke-linecap="round"/><path d="M5.6 5.6 18.4 18.4M18.4 5.6 5.6 18.4" fill="none" stroke="#f23f43" stroke-width="1.75" stroke-linecap="round"/>',
	mik: '<rect x="9" y="3" width="6" height="11.5" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3"/>',
	'mik-kapali':
		'<path d="M15 10.5V6a3 3 0 0 0-5.6-1.5"/><path d="M9 9v2.5a3 3 0 0 0 4.4 2.6"/><path d="M5.5 11.5a6.5 6.5 0 0 0 10.6 5"/>' +
		'<path d="M18.5 11.5a6.4 6.4 0 0 1-.7 2.9"/><path d="M12 18v3"/><path d="M3.5 3.5l17 17"/>',
	kulaklik: SIMGE_KULAKLIK,
	'kulaklik-kapali': SIMGE_KULAKLIK + '<path d="M3 3l18 18"/>',
	ayar:
		'<path d="M4 6h8M16 6h4M4 12h2M10 12h10M4 18h10M18 18h2"/><circle cx="14" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
	ayril:
		'<path d="M3.3 13.7c4.8-4.3 12.6-4.3 17.4 0 .5.5.6 1.3.1 1.8l-1.5 1.6c-.4.5-1.1.5-1.6.2l-2-1.4a1.2 1.2 0 0 1-.5-1.2l.2-1.3a10 10 0 0 0-6.8 0l.2 1.3c.1.5-.1.9-.5 1.2l-2 1.4c-.5.3-1.2.3-1.6-.2l-1.5-1.6a1.3 1.3 0 0 1 .1-1.8z"/>',
	kare: '<path d="M5 9h15M4 15h15M10.5 3.5 8.5 20.5M16 3.5l-2 17"/>',
	hoparlor: SIMGE_HOPARLOR + '<path d="M15.5 8.8a4.5 4.5 0 0 1 0 6.4"/><path d="M18.4 6a8.5 8.5 0 0 1 0 12"/>',
	'hoparlor-kapali': SIMGE_HOPARLOR + '<path d="M16 9.5l5 5M21 9.5l-5 5"/>',
	arti: '<path d="M12 5v14M5 12h14"/>',
	x: '<path d="M6 6l12 12M18 6 6 18"/>',
	ekle: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
	gonder: '<path d="M4.4 12 3.2 4.6a.8.8 0 0 1 1.1-.8l16 7.5a.8.8 0 0 1 0 1.4l-16 7.5a.8.8 0 0 1-1.1-.8z"/><path d="M4.4 12H11"/>',
	kisiler: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.5 14a6.5 6.5 0 0 1 3 6"/>',
	menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
	sinyal: '<path stroke-width="2.6" d="M5 19v-3M10 19v-7M15 19V8M20 19V4"/>',
	asagi: '<path d="m6 9 6 6 6-6"/>',
	uyari: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
	dosya: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5"/>',
	indir: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
	buyut: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M10.5 7.5v6M7.5 10.5h6"/>',
	kucult: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M7.5 10.5h6"/>',
	disari: '<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 13.5v5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h5"/>',
	ekran: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
	'ekran-kapali': '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M3 3l18 18"/>',
	yayin: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M12 13V7.5M9.5 10 12 7.5l2.5 2.5"/>',
	dur: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
	'tam-ekran': '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
	veritabani:
		'<ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13"/><path d="M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5"/>',
	yukari: '<path d="M12 20V9M7 13.5l5-5 5 5M5 4h14"/>',
};
const SVG_NS = 'http://www.w3.org/2000/svg';
function ikon(ad, sinif) {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');
	svg.setAttribute('class', 'ikon' + (sinif ? ' ' + sinif : ''));
	try {
		svg.innerHTML = SIMGELER[ad] || '';
	} catch {}
	return svg;
}
function ikonKoy(e, ad) {
	if (!e || e.dataset.ikonAdi === ad) return;
	e.dataset.ikonAdi = ad;
	e.replaceChildren(ikon(ad));
}
function simgeleriCiz(kok) {
	for (const e of kok.querySelectorAll('[data-ikon]')) ikonKoy(e, e.dataset.ikon);
}

// ---------------------------------------------------------------- bildirim

let tostZaman = null;
// hata=true: bildirim kırmızı gösterilir (kullanıcı hatayı normal bilgiden ayırsın).
function durum(metin, hata = false) {
	const e = $('durum');
	clearTimeout(tostZaman);
	e.textContent = metin || '';
	e.classList.toggle('hata', !!hata);
	e.classList.toggle('gorunur', !!metin);
	if (metin) tostZaman = setTimeout(() => e.classList.remove('gorunur'), hata ? 6000 : 3500);
}
function girisDurum(metin, hata = false, bekliyor = false) {
	const e = $('giris-durum');
	if (!e) return;
	e.textContent = metin || '';
	e.classList.toggle('hata', !!hata);
	e.classList.toggle('bekliyor', !!bekliyor && !!metin);
}
function ekran(hangi) {
	$('giris-ekrani').hidden = hangi !== 'giris';
	$('uygulama').hidden = hangi !== 'uygulama';
}

// ---------------------------------------------------------------- kalıcı ses ayarları

const AYAR_VARSAYILAN = {
	mikId: '', // seçili mikrofon ('' = sistemin varsayılanı)
	cikisId: '', // seçili hoparlör ('' = varsayılan)
	gurultu: true, // gürültü bastırma
	yanki: true, // yankı engelleme
	kazanc: false, // otomatik kazanç (AGC). Kapalı: AGC konuşma boyunca seviyeyi oynatıyordu.
	mikSeviye: 100, // gönderilen mikrofon seviyesi (%); 100 dışında WebAudio kazancı devreye girer
	kalite: 96, // gönderilen Opus bit hızı tavanı (kbps)
	sesler: true, // giriş/çıkış sesleri
	mikKapali: false, // kendini susturdun (kanala girerken de geçerli)
	sagir: false, // gelen sesleri kapattın
	// Susturunca mikrofonu bırak (telefonda varsayılan): açık mikrofon telefonu görüşme kipinde tutar,
	// Bluetooth kulaklık tek kanallı görüşme profiline (HFP) geçer ve çalan ses görüşme işlemlerinden
	// geçer. Bırakılınca yalnızca dinlenir, müzik tam kalitede çalar; açarken mikrofon yeniden alınır.
	mikBirak: dokunmatik(),
	// Ekran paylaşımı ses vermeyen tarayıcıda (Firefox, Safari) paylaşılan sesin alındığı aygıt
	// ('' = henüz seçilmedi).
	yayinAygitId: '',
};
const ayar = { ...AYAR_VARSAYILAN };
try {
	const kayitli = JSON.parse(depoOku('ses-ayarlari', '{}'));
	for (const k of Object.keys(AYAR_VARSAYILAN)) {
		if (kayitli && typeof kayitli[k] === typeof AYAR_VARSAYILAN[k]) ayar[k] = kayitli[k];
	}
} catch {}
ayar.mikSeviye = Math.min(200, Math.max(0, Math.round(ayar.mikSeviye / 5) * 5));
if (![48, 96, 128].includes(ayar.kalite)) ayar.kalite = AYAR_VARSAYILAN.kalite;
const ayarKaydet = () => depoYaz('ses-ayarlari', JSON.stringify(ayar));

// ---------------------------------------------------------------- durum

// Aynı sekme yeniden bağlanınca sunucu eski bağlantıyı tanısın.
let SEKME = '';
try {
	SEKME = sessionStorage.getItem('sekme') || rastgeleKimlik(16);
	sessionStorage.setItem('sekme', SEKME);
} catch {
	SEKME = rastgeleKimlik(16);
}

let ws = null; // geçerli WebSocket (eskilerinin işleyicileri kendini yok sayar)
let bagliyim = false; // sunucuya girildi ('hazir') ve bağlantı açık
let oturumVardi = false; // bu sayfada girildi: koparsa uygulama ekranında kalıp kendiliğinden döner
let durduruldu = false; // kalıcı durum (atıldın, başka sekme, red): kendiliğinden bağlanma
let bekleyenIstek = false; // kapıyı çaldık, içeridekilerin kararı bekleniyor
let yenidenZamanlayici = null;
let yenidenDene = 0;
let frenDenemesi = 0;
let girisAdi = ''; // girişte gönderilen ad (anahtarla girerken boş: ad anahtardan gelir)
let benimAdim = '';
let anahtar = '';
let sunucu = { max: 10 };
let beyazListe = 0;
let beyazListeAdlari = [];
let maxKullanici = 10;
let kanallar = [];
let kimlerListesi = [];
let aktifKanal = '';
let ice = { iceServers: [] };
let iceZamani = 0;

let mesajVerisi = []; // aktif kanalın mesajları (eskiden yeniye)
let gecmisBitti = true;
let gecmisIstegi = { kanal: '', zaman: 0 }; // yanıtı beklenen geçmiş isteği (aynı kanala üst üste istenmesin)
const okunmamis = new Map(); // kanal id -> okunmamış mesaj sayısı
const yaziyorlar = new Map(); // ad -> son "yazıyor" zamanı
const istekler = new Map(); // giriş isteği id -> { ad, kart }

// Ses
let sesKanal = ''; // içinde olduğum sesli kanal
let sesHedef = ''; // girmeye çalıştığım kanal ('ses-girdi' bekleniyor)
let sesGiriliyor = false;
let mikrofon = null; // getUserMedia akışı
let mikIslem = null; // mikrofon seviyesi %100 değilse: { kaynak, kazanc, hedef }
let gidenIz = null; // eşlere gönderilen iz (mikrofon izi ya da kazançlı iz)
let mikHatasi = ''; // mikrofon alınamadıysa nedeni (yalnızca dinleme)
let mikBirakildi = false; // susturulduğu için mikrofon bırakıldı (ayar.mikBirak); açınca yeniden alınır
let mikAliniyor = null; // susturma kalkınca mikrofon yeniden alınıyor (söz)
let kendiOlcer = null;
const esler = new Map(); // ad -> eş (bağlantı + arayüz)
const sesDurumlari = new Map(); // ad -> { sessiz, sagir, askida } (sunucudan)
const konusanlar = new Set(); // şu an konuşanlar (benim kanalımda, ben dahil)

// ---------------------------------------------------------------- sunucu bağlantısı

function soketBirak(sok) {
	if (!sok) return;
	sok.onopen = sok.onmessage = sok.onclose = sok.onerror = null;
	try {
		sok.close();
	} catch {}
	if (ws === sok) ws = null;
}

function baglan() {
	clearTimeout(yenidenZamanlayici);
	yenidenZamanlayici = null;
	if (ws) soketBirak(ws);
	durduruldu = false;
	if (oturumVardi) baglantiRozeti('bağlanılıyor…');
	const sok = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/rtc');
	ws = sok;
	// Her işleyici yalnızca kendi soketine bakar: eski bir soketin geç gelen olayı (kapanış, mesaj)
	// geçerli bağlantıyı bozamaz.
	sok.onopen = () => {
		if (ws !== sok) return;
		sok.send(JSON.stringify({ type: 'giris', ad: girisAdi, id: SEKME, anahtar, ses: sesKanal || '' }));
	};
	sok.onmessage = (olay) => {
		if (ws !== sok) return;
		sonSunucuMesaji = Date.now();
		let m;
		try {
			m = JSON.parse(olay.data);
		} catch {
			return;
		}
		if (m && typeof m === 'object') mesaj(m);
	};
	sok.onclose = () => {
		if (ws !== sok) return;
		ws = null;
		baglantiKoptu();
	};
	sok.onerror = () => {};
}

function gonder(nesne) {
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(nesne));
}

function baglantiKoptu() {
	bagliyim = false;
	sesPaneliCiz();
	if (durduruldu) return;
	if (bekleyenIstek) {
		// Kapıyı çalarken koptu: istek sunucuda düştü, kullanıcı yeniden denesin.
		bekleyenIstek = false;
		girisBekliyor(false);
		girisDurum('Bağlantı koptu; istek düştü. Tekrar dene.', true);
		return;
	}
	if (oturumVardi || anahtar) {
		if (oturumVardi) durum('Sunucu bağlantısı koptu; yeniden bağlanılıyor…' + (sesKanal ? ' (ses sürüyor)' : ''), true);
		yenidenBaglanmayiPlanla();
		return;
	}
	girisBekliyor(false);
	girisDurum('Sunucuya bağlanılamadı; tekrar dene.', true);
}

let frenBekleniyor = false; // bekleyen deneme giriş freninin söylediği süreyi bekliyor
function yenidenBaglanmayiPlanla(ms) {
	clearTimeout(yenidenZamanlayici);
	// Sunucu güncellemesi birkaç saniye sürer: ilk denemeler sık, sonra seyrekleşir (en fazla 15 sn).
	const TAKVIM = [500, 1000, 1000, 2000, 2000, 4000, 8000, 15000];
	const bekle = ms ?? TAKVIM[Math.min(yenidenDene++, TAKVIM.length - 1)] * (0.8 + Math.random() * 0.4);
	const sn = Math.max(1, Math.round(bekle / 1000));
	if (oturumVardi) baglantiRozeti(`bağlantı koptu · ${sn} sn sonra yeniden`);
	else girisDurum(ms ? `Sunucu yoğun; ${sn} sn sonra yeniden denenecek…` : `Sunucuya ulaşılamadı; ${sn} sn sonra yeniden denenecek…`, false, true);
	frenBekleniyor = ms != null;
	yenidenZamanlayici = setTimeout(baglan, bekle);
}

// Ağ geri geldiğinde ya da sekme öne alındığında beklemeden dene. Giriş freninin söylediği bekleme
// kısaltılmaz (sunucu yine reddederdi; ağ değişimi gibi sık olaylar deneme hakkını tüketirdi).
function hemenDene() {
	if (yenidenZamanlayici && !durduruldu && !frenBekleniyor) {
		yenidenDene = Math.max(0, yenidenDene - 1);
		baglan();
	}
}

// Canlılık: telefon arka plandan/uykudan dönünce ya da ağ değişince (Wi-Fi → mobil) WebSocket "açık"
// görünüp ölü kalabilir; tarayıcı bunu dakikalarca fark etmez, mesajlar gitmez, ses kurtarılamaz.
// Sunucu 'ping'e hemen 'pong' der: yanıt gelmezse bağlantı ölü sayılır ve hemen yeniden bağlanılır
// (sesli kanaldaysan P2P ses sürer, sunucu yerini askıda tutar). Arka planda zamanlayıcılar geç
// çalışabilir (sayfa kısıldı/donduruldu): geç çalışan denetim karar vermez, yeniden ölçer.
let sonSunucuMesaji = 0;
let canlilikZamanlayici = null;
function canlilikDenetle(sureMs) {
	if (durduruldu) return;
	if (!ws || ws.readyState !== WebSocket.OPEN) return hemenDene();
	if (!bagliyim || canlilikZamanlayici) return;
	const sok = ws;
	const baslangic = Date.now();
	gonder({ type: 'ping' });
	canlilikZamanlayici = setTimeout(() => {
		canlilikZamanlayici = null;
		if (ws !== sok || sonSunucuMesaji >= baslangic) return;
		if (Date.now() - baslangic > sureMs + 3000) return canlilikDenetle(sureMs);
		soketBirak(sok);
		baglantiKoptu();
	}, sureMs);
}
// Sunucudan uzun süre bir şey gelmezse yokla.
setInterval(() => {
	if (bagliyim && Date.now() - sonSunucuMesaji > 25000) canlilikDenetle(10000);
}, 15000);
// Öne alınınca, ağ gelince/değişince, dondurulmuş sayfa uyanınca: hemen yokla, sesi uyandır.
function uyandi() {
	if (document.visibilityState === 'hidden') return canlilikDenetle(10000);
	canlilikDenetle(6000);
	sesUyandir();
}
window.addEventListener('online', uyandi);
document.addEventListener('resume', uyandi);
document.addEventListener('visibilitychange', () => {
	sesDevamKaydet();
	if (document.visibilityState === 'visible') uyandi();
});
try {
	if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener('change', uyandi);
} catch {}

// Sesli kanaldayken sayfa arka planda tarayıcı tarafından kapatılırsa (bellek için; bazı telefonlarda
// sık olur) geri dönülünce sesli kanala kendiliğinden girilir. Sayfa arka plana geçerken kanal not
// edilir; öne gelince, kanaldan çıkınca ya da sayfa normal kapanınca not silinir.
function sesDevamKaydet() {
	try {
		if (document.visibilityState === 'hidden' && sesKanal) sessionStorage.setItem('ses-devam', JSON.stringify({ kanal: sesKanal, zaman: Date.now() }));
		else sessionStorage.removeItem('ses-devam');
	} catch {}
}
function kapatildiysaSeseDon() {
	let kayit = null;
	try {
		kayit = JSON.parse(sessionStorage.getItem('ses-devam') || 'null');
		sessionStorage.removeItem('ses-devam');
	} catch {}
	if (!kayit || !kayit.kanal || !(Date.now() - kayit.zaman < 10 * 60000) || sesKanal || sesGiriliyor) return;
	if (!kanalBilgi(kayit.kanal)) return;
	durum('Sesli kanala geri dönülüyor…');
	setTimeout(() => sesAc(kayit.kanal), 300);
}

function baglantiRozeti(metin) {
	const e = $('baglanti-durumu');
	e.hidden = !metin;
	e.textContent = metin || '';
}

// Oturum bitti (atıldı, reddedildi, başka sekme): sesi kapat, giriş ekranına dön.
function oturumuBitir(metin) {
	clearTimeout(yenidenZamanlayici);
	yenidenZamanlayici = null;
	bagliyim = false;
	oturumVardi = false;
	if (ws) soketBirak(ws);
	sesKapat(false);
	istekleriTemizle();
	pencereKapat();
	ayarlarKapat();
	sunucuPenceresiKapat();
	yayinMenuKapat();
	ekran('giris');
	girisBekliyor(false);
	girisDurum(metin, true);
}

function anahtarSil() {
	anahtar = '';
	depoYaz('anahtar', null);
}

function mesaj(m) {
	switch (m.type) {
		case 'hazir':
			oturumHazir(m);
			break;
		case 'bekleniyor':
			// Kapıyı çaldık: içeridekiler karar verene kadar bekle.
			bekleyenIstek = true;
			girisBekliyor(true);
			ekran('giris');
			girisDurum(m.anahtarGecersiz ? 'Anahtar geçersiz; izin bekleniyor…' : 'İçeridekilere soruldu; izin bekleniyor…', false, true);
			break;
		case 'giris-red':
			girisReddi(m);
			break;
		case 'oturum-devralindi':
			durduruldu = true;
			oturumuBitir(m.message || 'Bu hesapla başka bir sekmede girildi.');
			$('gir').hidden = true;
			$('burada-devam').hidden = false;
			$('ad').disabled = true;
			break;
		case 'atildi':
			durduruldu = true;
			anahtarSil();
			oturumuBitir(m.message || 'Sunucudan atıldın; tekrar izin iste.');
			break;
		case 'kanallar':
			kanallarGeldi(m.kanallar || []);
			break;
		case 'kimler':
			kimlerListesi = m.kimler || [];
			if (m.beyazListe != null) beyazListe = m.beyazListe;
			if (m.beyazListeAdlari) beyazListeAdlari = m.beyazListeAdlari;
			if (m.maxKullanici) maxKullanici = m.maxKullanici;
			uyeleriCiz();
			break;
		case 'giris-istegi':
			istekEkle(m.id, m.ad, !!m.kayitli);
			break;
		case 'istek-kapandi':
			istekSil(m.id);
			if (m.kabul) durum(`${m.ad} içeri alındı.`);
			break;
		case 'yazi':
			mesajGeldi(m.kanal, m.mesaj);
			break;
		case 'gecmis':
			gecmisGeldi(m);
			break;
		case 'yaziyor':
			yaziyorGeldi(m.kanal, m.ad);
			break;
		case 'ses-girdi':
			sesKatil(m);
			break;
		case 'ses-kisi-girdi':
			if (sesKanal && m.kanal === sesKanal) esGirdi(m.ad, !!m.devam, true);
			break;
		case 'ses-kisi-cikti':
			if (sesKanal && m.kanal === sesKanal) esCikti(m.ad);
			break;
		case 'ses-kapatildi':
			durum('Kanal silindi; sesli kanaldan çıkarıldın.', true);
			sesKapat(false);
			break;
		case 'sessiz':
			sesDurumuGeldi(m.ad, { sessiz: !!m.sessiz, sagir: !!m.sagir });
			break;
		case 'sdp':
			sdpGeldi(m.from, m.sdp, m.oturum);
			break;
		case 'ice':
			iceGeldi(m.from, m.ice, m.oturum);
			break;
		case 'yenile':
			yenileGeldi(m.from, m.oturum);
			break;
		case 'izle':
			izleGeldi(m.from, !!m.izle);
			break;
		case 'dosya-durum':
			sunulanlarGeldi(m.sunulan);
			break;
		case 'dosya-sun':
			sunduklarimOnaylandi(m.idler);
			break;
		case 'dosya-sinyal':
			dosyaSinyaliGeldi(m.from, m.veri);
			break;
		case 'sunucu-bilgi':
			sunucuBilgisiGeldi(m);
			break;
		case 'sohbet-temizlendi':
			sohbetTemizlendi(m);
			break;
		case 'ice-sunuculari':
			iceAyarla(m.ice);
			break;
		case 'hata':
			durum(m.message, true);
			if (m.kod === 'ses-dolu' || m.kod === 'ses-kanal-yok') sesGirisiBasarisiz();
			if ($('temizle').disabled) gonder({ type: 'sunucu-bilgi' }); // temizlik reddedildiyse düğme geri gelsin
			break;
	}
}

let sunucuSurumu = '';
let turnNesli = '';
let girisAraligi = 10000; // sunucunun giriş freni (hazir'den)
let girisKovasi = 1;
// Sunucu yeni sürüme geçti (yeniden bağlanınca 'hazir.surum' değişti): eski arayüz yeni sunucuyla
// konuşmasın diye sayfayı yenile. Sesli kanal ve yazılmakta olan mesaj yenilemeden sonra geri gelir.
function surumYenile() {
	try {
		sessionStorage.setItem('surum-yenile', JSON.stringify({ ses: sesKanal || '', taslak: $('metin').value || '' }));
	} catch {}
	durum('Sunucu güncellendi; sayfa yenileniyor…');
	if (sesKanal) gonder({ type: 'ses-cik' });
	durduruldu = true;
	setTimeout(() => location.reload(), 600);
}
function surumYenilemesindenDon() {
	let kayit = null;
	try {
		kayit = JSON.parse(sessionStorage.getItem('surum-yenile') || 'null');
		sessionStorage.removeItem('surum-yenile');
	} catch {}
	if (!kayit) return;
	if (kayit.taslak && !$('metin').value) $('metin').value = kayit.taslak;
	if (kayit.ses && kanalBilgi(kayit.ses)) setTimeout(() => sesAc(kayit.ses), 300);
}

function oturumHazir(m) {
	if (m.surum) {
		if (sunucuSurumu && m.surum !== sunucuSurumu) return surumYenile();
		sunucuSurumu = m.surum;
	}
	const ilk = !oturumVardi;
	// coturn yeniden başladıysa (yeni sır) TURN üzerinden akan bağlantılar birkaç saniye içinde ölür:
	// beklemeden taze şifreyle yenile. Doğrudan (P2P) bağlantılara dokunulmaz.
	const turnYenilendi = !!turnNesli && !!m.turnNesli && m.turnNesli !== turnNesli;
	if (m.turnNesli) turnNesli = m.turnNesli;
	if (Number(m.girisAralikMs) >= 0) girisAraligi = Number(m.girisAralikMs);
	if (Number(m.girisKova) >= 1) girisKovasi = Number(m.girisKova);
	bagliyim = true;
	oturumVardi = true;
	durduruldu = false;
	bekleyenIstek = false;
	yenidenDene = 0;
	frenDenemesi = 0;
	if (m.ice) iceAyarla(m.ice);
	// Yeni anahtar verildiyse sakla; bir daha izin sorulmaz.
	if (m.anahtar) {
		anahtar = m.anahtar;
		depoYaz('anahtar', anahtar);
	}
	if (m.ad) {
		benimAdim = m.ad;
		girisAdi = m.ad;
		$('ad').value = m.ad;
		depoYaz('ad', m.ad);
	}
	beyazListe = m.beyazListe != null ? m.beyazListe : beyazListe;
	beyazListeAdlari = m.beyazListeAdlari || [];
	maxKullanici = m.maxKullanici || maxKullanici;
	sunucu = { max: m.max || 10 };
	kimlerListesi = m.kimler || [];
	// Bu sekmenin sunduğu dosyaları (yeniden) bildir; kimin neyi sunduğu listesi hazir'de gelir.
	sunulanlar = new Set(Array.isArray(m.sunulanDosyalar) ? m.sunulanDosyalar : []);
	if (paylasimlarim.size) gonder({ type: 'dosya-sun', idler: [...paylasimlarim.keys()] });
	girisBekliyor(false);
	girisDurum('');
	$('gir').hidden = false;
	$('burada-devam').hidden = true;
	baglantiRozeti('');
	istekleriTemizle(); // sunucu bekleyen istekleri hemen yeniden gönderir
	ekran('uygulama');
	$('ben-ad').textContent = m.ad;
	$('ben-avatar').textContent = basHarf(m.ad);
	$('ben-avatar').style.setProperty('--renk', renkBul(m.ad));
	kanallarGeldi(m.kanallar || []);
	uyeleriCiz();
	mikDugmeleriCiz();
	if (ilk) {
		kanalSec(ilkKanal(), false);
		surumYenilemesindenDon();
		kapatildiysaSeseDon();
	} else {
		durum('Yeniden bağlandın.');
		gecmisTazele();
		// Sesli kanaldaydık: eş bağlantıları ayakta, kanala devam et.
		if (sesKanal) {
			// TURN'den geçen bağlantılar işaretlenir; karşı taraf kanalda görünür görünmez yenilenir
			// (o daha dönmeden gönderilen teklif sunucuda düşerdi).
			if (turnYenilendi) for (const es of esler.values()) if (es.sonTip === 'TURN' && es.pc) es.turnYenile = true;
			gonder({ type: 'ses-gir', kanal: sesKanal, devam: true, sessiz: mikSessizMi(), sagir: ayar.sagir, yayin: yayinBilgisi() });
		}
	}
	sesPaneliCiz();
	dosyaKartlariniGuncelle();
}

function girisReddi(m) {
	const metin = m.message || 'Giriş reddedildi.';
	const kod = m.kod || '';
	bagliyim = false;
	if (ws) soketBirak(ws);
	if (kod === 'fren' && ++frenDenemesi <= 30) {
		// Sunucu yoğun (giriş freni, ör. güncellemeden sonra herkes aynı anda dönüyor): söylenen
		// süre kadar bekleyip kendiliğinden yeniden dene. Uygulama ekranındaysak orada kal.
		const bekle = (Number(m.bekle) || 10000) + 150 + Math.random() * 1200;
		yenidenBaglanmayiPlanla(bekle);
		return;
	}
	durduruldu = true;
	if (kod === 'anahtar') anahtarSil();
	oturumuBitir(metin);
	$('ad').focus();
}

// Giriş ekranı: beklerken ad alanı kilitli, "İsteği geri çek" görünür.
function girisBekliyor(bekle) {
	$('ad').disabled = bekle;
	$('gir').disabled = bekle;
	$('giris-iptal').hidden = !bekle;
}

$('giris').addEventListener('submit', (e) => {
	e.preventDefault();
	if (bagliyim || bekleyenIstek) return;
	const ad = $('ad').value.trim().slice(0, 32);
	if (!ad) return;
	girisAdi = ad;
	depoYaz('ad', ad);
	frenDenemesi = 0;
	girisDurum('İçeridekilere soruluyor…', false, true);
	$('ad').disabled = true;
	$('gir').disabled = true;
	baglan();
});

// Kapıyı çaldıktan sonra vazgeç.
$('giris-iptal').addEventListener('click', () => {
	gonder({ type: 'giris-iptal' });
	durduruldu = true;
	bekleyenIstek = false;
	clearTimeout(yenidenZamanlayici);
	if (ws) soketBirak(ws);
	girisBekliyor(false);
	girisDurum('İstek geri çekildi.');
	$('ad').focus();
});

// Oturum başka sekmeye geçtiyse: kullanıcı isterse bu sekmede sürdür (diğeri kapanır).
$('burada-devam').addEventListener('click', () => {
	$('burada-devam').hidden = true;
	$('gir').hidden = false;
	$('gir').disabled = true;
	girisDurum('Bağlanılıyor…', false, true);
	baglan();
});

let iceTekrarZamanlayici = null;
function iceAyarla(yeni) {
	if (!yeni || !Array.isArray(yeni.iceServers)) return;
	ice = { iceServers: yeni.iceServers };
	iceZamani = Date.now();
	// Açık bağlantılar da taze şifreyi alsın: ICE yenilemesinde İKİ taraf da yeniden aday toplar.
	// Yalnızca teklif eden tazelenirse, yanıtlayan eski (coturn yeniden başlayınca geçersizleşen)
	// şifreyle relay adayı alamıyor, TURN bağlantısı ICE yenilemesiyle kurtarılamıyordu.
	if (ice.iceServers.length) for (const es of esler.values()) pcSunuculariniTazele(es.pc);
	clearTimeout(iceTekrarZamanlayici);
	// Boş liste: sunucunun TURN'ü henüz hazır değil (ya da kapalı). Biraz sonra yeniden sor; yoksa
	// TURN'e muhtaç bağlantılar hiç kurulamaz.
	if (!ice.iceServers.length) iceTekrarZamanlayici = setTimeout(() => gonder({ type: 'ice-iste' }), 3000);
}

// TURN şifresi bir günlük: uzun süre açık kalan sekmede yeni bağlantı kurmadan önce tazele.
function iceTazeMi() {
	if (Date.now() - iceZamani > 6 * 3600 * 1000) gonder({ type: 'ice-iste' });
}

// ---------------------------------------------------------------- avatar / renk

function renkBul(ad) {
	let h = 0;
	for (const ch of String(ad)) h = (h * 31 + ch.codePointAt(0)) % 360;
	return Math.round(25 + h * 0.85);
}
const basHarf = (ad) => [...String(ad).trim()][0]?.toLocaleUpperCase('tr') || '?';
function avatarYap(ad, sinif = 'avatar') {
	const e = el('span', sinif, basHarf(ad));
	e.style.setProperty('--renk', renkBul(ad));
	return e;
}

// ---------------------------------------------------------------- kanal listesi / üyeler

const kanalBilgi = (id) => kanallar.find((k) => k.id === id) || null;
const kanalAdi = (id) => kanalBilgi(id)?.ad || id;

function kanallarGeldi(liste) {
	kanallar = liste;
	const onceki = new Map(sesDurumlari);
	sesDurumlari.clear();
	for (const k of kanallar) {
		if (k.tur !== 'ses') continue;
		for (const p of k.kisiler || []) {
			sesDurumlari.set(p.ad, { sessiz: !!p.sessiz, sagir: !!p.sagir, askida: !!p.askida, kanal: k.id, yayin: p.yayin || null });
		}
	}
	yayinDurumlariDegisti(onceki);
	// Baktığım kanal silindiyse ilk yazılı kanala geç; sesli kanalım silindiyse çık.
	if (aktifKanal && !kanalBilgi(aktifKanal)) {
		aktifKanal = '';
		mesajVerisi = [];
		$('mesajlar').replaceChildren();
		const ilk = ilkKanal();
		if (ilk) kanalSec(ilk, false);
		else $('kanal-ad').textContent = '—';
	}
	if (sesKanal && !kanalBilgi(sesKanal)) sesKapat(false);
	for (const es of esler.values()) esDurumIkonlariCiz(es);
	kanalListesiCiz();
	sesKartiOzetCiz();
	yayinlarCiz();
}

function ilkKanal() {
	let istenen = '';
	try {
		istenen = decodeURIComponent(location.hash.slice(1));
	} catch {
		istenen = location.hash.slice(1);
	}
	for (const a of [istenen, depoOku('kanal', '')]) {
		const k = kanalBilgi(a);
		if (k && k.tur === 'yazi') return a;
	}
	return (kanallar.find((k) => k.tur === 'yazi') || {}).id || '';
}

function cevrimiciSayaci() {
	$('cevrimici-sayac').textContent = String(kimlerListesi.length);
	$('uye-sayi').textContent = String(kimlerListesi.length);
}

function kanalSatiri(kanal, parcalar, { aktif, okunmamisVar }, tikla) {
	const satir = el('div', 'kanal-satir');
	const d = el('button', 'kanal' + (aktif ? ' aktif' : '') + (okunmamisVar ? ' okunmamis' : ''));
	d.type = 'button';
	d.append(...parcalar);
	d.onclick = tikla;
	if (aktif) d.setAttribute('aria-current', 'true');
	const sil = el('button', 'kanal-sil');
	sil.type = 'button';
	sil.title = 'Kanalı sil';
	sil.setAttribute('aria-label', `${kanal.ad} kanalını sil`);
	sil.append(ikon('x'));
	sil.onclick = (e) => {
		e.stopPropagation();
		kanalSilIste(kanal);
	};
	satir.append(d, sil);
	return satir;
}

function isaret(ad) {
	const s = el('span', 'kanal-isaret');
	s.append(ikon(ad));
	return s;
}

function kanalListesiCiz() {
	const y = $('yazi-kanallari');
	const s = $('ses-kanallari');
	y.replaceChildren();
	s.replaceChildren();
	for (const k of kanallar.filter((x) => x.tur === 'yazi')) {
		const n = okunmamis.get(k.id) || 0;
		const parcalar = [isaret('kare'), el('span', 'kanal-adi', k.ad)];
		if (n) parcalar.push(el('span', 'rozet', n > 99 ? '99+' : String(n)));
		y.append(kanalSatiri(k, parcalar, { aktif: k.id === aktifKanal, okunmamisVar: n > 0 }, () => kanalSec(k.id)));
	}
	for (const k of kanallar.filter((x) => x.tur === 'ses')) {
		const kisi = k.kisiler || [];
		const parcalar = [isaret('hoparlor'), el('span', 'kanal-adi', k.ad)];
		if (kisi.length) parcalar.push(el('span', 'rozet-yazi', `${kisi.length}/${sunucu.max}`));
		s.append(kanalSatiri(k, parcalar, { aktif: k.id === sesKanal }, () => sesAc(k.id)));
		if (kisi.length) {
			const liste = el('div', 'ses-uyeleri');
			for (const p of kisi) liste.append(sesUyesiSatiri(p, k.id));
			s.append(liste);
		}
	}
	cevrimiciSayaci();
	baslikGuncelle();
}

function durumIkonlari(sessiz, sagir) {
	const kap = el('span', 'durum-ikon');
	if (sagir) kap.append(ikon('kulaklik-kapali'));
	else if (sessiz) kap.append(ikon('mik-kapali'));
	kap.title = sagir ? 'sağırlaştırılmış' : sessiz ? 'mikrofonu kapalı' : '';
	return kap;
}

function sesUyesiSatiri(p, kanal) {
	const ben = p.ad === benimAdim;
	const satir = el('div', 'ses-uyesi' + (ben ? ' ben' : '') + (p.askida ? ' askida' : '') + (kanal === sesKanal && konusanlar.has(p.ad) ? ' konusuyor' : ''));
	satir.dataset.ad = p.ad;
	satir.append(avatarYap(p.ad, 'avatar mini-avatar'), el('span', 'ad', p.ad + (ben ? ' (sen)' : '')));
	if (p.askida) satir.title = 'Bağlantısı koptu; geri dönmesi bekleniyor';
	const rozet = yayinRozeti(p);
	if (rozet) satir.append(rozet);
	if (p.sessiz || p.sagir) satir.append(durumIkonlari(p.sessiz, p.sagir));
	return satir;
}

// Üye panelinde önce çevrimiçiler, sonra beyaz listede olup şu an bağlı olmayanlar.
// Çevrimdışı satırlar soluk ve "çevrimdışı" yazılı; atma düğmesi onlarda da var (anahtarı iptal eder).
function uyeSatiri(ad, k, cevrimdisi) {
	const ben = ad === benimAdim;
	const d = el('div', 'uye' + (cevrimdisi ? ' cevrimdisi' : '') + (ben ? ' ben' : ''));
	const av = avatarYap(ad, 'avatar kucuk-avatar');
	av.append(el('span', 'durum-nokta' + (cevrimdisi ? ' kapali' : '')));
	const bilgi = el('span', 'uye-bilgi');
	bilgi.append(el('span', 'ad', ad + (ben ? ' (sen)' : '')));
	const alt = el('small');
	if (cevrimdisi) alt.textContent = 'çevrimdışı';
	else if (k && k.ses) {
		alt.append(ikon('hoparlor'), document.createTextNode(kanalAdi(k.ses)));
	} else alt.textContent = 'çevrimiçi';
	bilgi.append(alt);
	d.append(av, bilgi);
	if (!ben) {
		const at = el('button', 'uye-at');
		at.type = 'button';
		at.title = cevrimdisi ? 'Beyaz listeden çıkar (anahtarı iptal edilir)' : 'Sunucudan at (anahtarı iptal edilir)';
		at.setAttribute('aria-label', ad + ' kişisini sunucudan at');
		at.append(ikon('x'));
		at.onclick = () => kisiAtIste(ad);
		d.append(at);
	}
	return d;
}

function uyeleriCiz() {
	const kap = $('uye-listesi');
	kap.replaceChildren();
	for (const k of kimlerListesi) kap.append(uyeSatiri(k.ad, k, false));
	const cevrimici = new Set(kimlerListesi.map((k) => k.ad));
	const disarida = beyazListeAdlari.filter((ad) => ad && !cevrimici.has(ad)).sort((a, b) => a.localeCompare(b, 'tr'));
	if (disarida.length) {
		const b = el('div', 'bolum-baslik uye-bolum');
		b.append(el('span', null, `Çevrimdışı — ${disarida.length}`));
		kap.append(b);
		for (const ad of disarida) kap.append(uyeSatiri(ad, null, true));
	}
	$('beyaz-liste').textContent = beyazListe ? `Beyaz liste ${beyazListe}/${maxKullanici}` : '';
	$('limit-az').disabled = !bagliyim || maxKullanici <= 2;
	$('limit-cok').disabled = !bagliyim || maxKullanici >= 50;
	cevrimiciSayaci();
}

function baslikGuncelle() {
	let toplam = 0;
	for (const n of okunmamis.values()) toplam += n;
	document.title = (toplam ? `(${toplam}) ` : '') + 'Diszort';
}

// ---------------------------------------------------------------- giriş istekleri (kapıyı çalanlar)

function istekEkle(id, ad, kayitli) {
	if (!id || istekler.has(id)) return;
	const kart = el('div', 'istek');
	const ust = el('div', 'istek-ust');
	const yazi = el('div');
	yazi.append(el('b', null, ad), document.createTextNode(' girmek istiyor.'));
	ust.append(avatarYap(ad, 'avatar kucuk-avatar'), yazi);
	kart.append(ust);
	if (kayitli) {
		// Ad zaten beyaz listede: yeni cihaz da olabilir, adı taklit eden biri de. Kabul edilirse
		// o kişinin eski cihazındaki anahtar iptal olur.
		const u = el('div', 'istek-uyari');
		u.append(ikon('uyari'), el('span', null, 'Bu ad beyaz listede kayıtlı. Kabul edersen eski cihazının anahtarı iptal olur; gerçekten o mu, emin ol.'));
		kart.append(u);
	}
	const dugmeler = el('div', 'istek-dugmeler');
	const kabul = el('button', null, 'Kabul et');
	kabul.type = 'button';
	kabul.onclick = () => {
		gonder({ type: 'giris-karari', id, kabul: true });
		istekSil(id);
	};
	const red = el('button', 'red', 'Reddet');
	red.type = 'button';
	red.onclick = () => {
		gonder({ type: 'giris-karari', id, kabul: false });
		istekSil(id);
	};
	dugmeler.append(kabul, red);
	kart.append(dugmeler, el('div', 'istek-sure'));
	$('istekler').append(kart);
	istekler.set(id, { ad, kart });
	sesCal('kapi');
}

function istekSil(id) {
	const k = istekler.get(id);
	if (!k) return;
	k.kart.remove();
	istekler.delete(id);
}
function istekleriTemizle() {
	for (const id of [...istekler.keys()]) istekSil(id);
}

function kisiAtIste(ad) {
	pencereAc({
		baslik: 'Sunucudan at',
		metin: `"${ad}" beyaz listeden çıkarılacak ve anahtarı iptal edilecek. Tekrar girmek için izin istemesi gerekir.`,
		girdi: false,
		tamam: 'At',
		tehlike: true,
		onay: () => gonder({ type: 'at', ad }),
	});
}

// ---------------------------------------------------------------- pencere (kanal ekle / sil / at)

let pencereOnay = null;
let pencereOncekiOdak = null;
let pencereBosOlabilir = false;

// girdi: tek satırlık metin alanı (deger: başlangıç, yerTutucu, etiket: erişilebilir ad, uzunluk:
// en fazla karakter, bosOlabilir: boş bırakılınca da onaylanır).
function pencereAc({ baslik, metin, girdi, tamam, tehlike, onay, deger = '', yerTutucu = '', etiket = 'Kanal adı', uzunluk = 24, bosOlabilir = false }) {
	pencereOncekiOdak = document.activeElement;
	$('pencere-baslik').textContent = baslik;
	$('pencere-metin').textContent = metin || '';
	const g = $('pencere-girdi');
	g.hidden = !girdi;
	g.value = deger;
	g.maxLength = uzunluk;
	g.placeholder = yerTutucu;
	g.setAttribute('aria-label', etiket);
	pencereBosOlabilir = !!bosOlabilir;
	$('pencere-tamam').textContent = tamam || 'Tamam';
	$('pencere-tamam').classList.toggle('tehlike', !!tehlike);
	pencereOnay = onay;
	$('pencere').hidden = false;
	if (girdi) {
		g.focus();
		g.select();
	} else $('pencere-tamam').focus();
}

function pencereKapat() {
	if ($('pencere').hidden) return;
	$('pencere').hidden = true;
	pencereOnay = null;
	if (pencereOncekiOdak && pencereOncekiOdak.focus) pencereOncekiOdak.focus();
}

function kanalEkleIste(tur) {
	const sesli = tur === 'ses';
	pencereAc({
		baslik: sesli ? 'Sesli kanal ekle' : 'Yazılı kanal ekle',
		metin: sesli ? 'Kanala bir ad ver (örn. Oyun Odası).' : 'Kanala bir ad ver (örn. duyurular).',
		girdi: true,
		tamam: 'Ekle',
		onay: (ad) => gonder({ type: 'kanal-ekle', tur, ad }),
	});
}

function kanalSilIste(kanal) {
	const dolu = kanal.tur === 'ses' && (kanal.kisiler || []).length;
	pencereAc({
		baslik: 'Kanalı sil',
		metin:
			`"${kanal.ad}" kanalı silinecek` +
			(kanal.tur === 'yazi' ? ' ve içindeki mesajlar ile dosyalar da silinecek.' : dolu ? '; içindeki kişiler kanaldan çıkarılacak.' : '.'),
		girdi: false,
		tamam: 'Sil',
		tehlike: true,
		onay: () => gonder({ type: 'kanal-sil', kanal: kanal.id }),
	});
}

$('pencere-iptal').addEventListener('click', pencereKapat);
$('pencere').addEventListener('click', (e) => {
	if (e.target === $('pencere')) pencereKapat();
});
$('pencere-form').addEventListener('submit', (e) => {
	e.preventDefault();
	const girdiVar = !$('pencere-girdi').hidden;
	const girdi = girdiVar ? $('pencere-girdi').value.trim() : '';
	if (girdiVar && !girdi && !pencereBosOlabilir) {
		$('pencere-girdi').focus();
		return;
	}
	const onay = pencereOnay;
	pencereKapat();
	if (onay) onay(girdi);
});
$('yazi-ekle').addEventListener('click', () => kanalEkleIste('yazi'));
$('ses-ekle').addEventListener('click', () => kanalEkleIste('ses'));

// Kişi limiti: beyaz listedekiler arttırıp azaltabilir (sunucu değeri veritabanına yazar).
$('limit-az').addEventListener('click', () => kisiLimitiDegistir(-1));
$('limit-cok').addEventListener('click', () => kisiLimitiDegistir(1));
function kisiLimitiDegistir(fark) {
	const yeni = Math.min(50, Math.max(2, maxKullanici + fark));
	if (yeni !== maxKullanici) gonder({ type: 'kisi-limiti', deger: yeni });
}

// ---------------------------------------------------------------- sohbet

function kanalSec(id, odakla = true) {
	const k = kanalBilgi(id);
	if (!k || k.tur !== 'yazi') return;
	aktifKanal = id;
	okunmamis.delete(id);
	$('kanal-ad').textContent = k.ad;
	$('metin').placeholder = `#${k.ad} kanalına mesaj gönder`;
	$('metin').disabled = false;
	$('birak-kanal').textContent = `#${k.ad} kanalında paylaşılır (sunucuya yüklenmez)`;
	mesajVerisi = [];
	$('mesajlar').replaceChildren();
	$('daha-eski').hidden = true;
	$('yeni-mesaj').hidden = true;
	yaziyorlar.clear();
	yaziyorCiz();
	gecmisBitti = true;
	gecmisIstegi = { kanal: '', zaman: 0 };
	gecmisYukle();
	kanalListesiCiz();
	depoYaz('kanal', id);
	if (location.hash.slice(1) !== id) history.replaceState(null, '', '#' + id);
	cekmeceleriKapat();
	// Telefonda kanala dokununca klavye açılmasın.
	if (odakla && !dokunmatik()) $('metin').focus();
}

const gecmisBekleniyor = () => gecmisIstegi.kanal === aktifKanal && Date.now() - gecmisIstegi.zaman < 8000;
function gecmisYukle() {
	if (!bagliyim || !aktifKanal || gecmisBekleniyor()) return;
	gecmisIstegi = { kanal: aktifKanal, zaman: Date.now() };
	gonder({ type: 'gecmis', kanal: aktifKanal, once: mesajVerisi.length ? mesajVerisi[0].id : 0 });
}

// Yeniden bağlanınca: kaçırılan mesajları al (kaydırma yeri korunur).
function gecmisTazele() {
	if (!bagliyim || !aktifKanal) return;
	gecmisIstegi = { kanal: aktifKanal, zaman: Date.now() };
	gonder({ type: 'gecmis', kanal: aktifKanal, once: 0 });
}

function gecmisGeldi(m) {
	if (gecmisIstegi.kanal === m.kanal) gecmisIstegi = { kanal: '', zaman: 0 };
	if (m.kanal !== aktifKanal) return;
	const gelen = m.mesajlar || [];
	if (!mesajVerisi.length) {
		gecmisBitti = !!m.bitti;
		mesajVerisi = gelen;
		mesajlariCiz(true);
		return;
	}
	const bilinen = new Set(mesajVerisi.map((x) => x.id));
	const yeniler = gelen.filter((x) => !bilinen.has(x.id));
	if (!yeniler.length) {
		if (gelen.length && gelen[0].id < mesajVerisi[0].id) gecmisBitti = !!m.bitti;
		$('daha-eski').hidden = gecmisBitti;
		return;
	}
	const enYeni = mesajVerisi[mesajVerisi.length - 1].id;
	if (yeniler.every((x) => x.id < mesajVerisi[0].id)) {
		// "Daha eski" sayfası: başa ekle, kaydırma yerini koru.
		gecmisBitti = !!m.bitti;
		mesajVerisi = yeniler.concat(mesajVerisi);
		mesajlariCiz(false);
	} else if (gelen.length && gelen[0].id > enYeni) {
		// Kopukken 50'den fazla mesaj gelmiş: aradaki boşluk yüzünden baştan çiz.
		gecmisBitti = !!m.bitti;
		mesajVerisi = gelen;
		mesajlariCiz(true);
	} else {
		// Kopukken gelenler: sona ekle.
		const yakin = dibeYapisik || dibeYakin();
		mesajVerisi = mesajVerisi.concat(yeniler.filter((x) => x.id > enYeni)).sort((a, b) => a.id - b.id);
		mesajlariCiz(false);
		if (yakin) dibeKaydir();
	}
}

$('daha-eski').addEventListener('click', () => {
	if (!gecmisBitti) gecmisYukle();
});

const gunAnahtari = (z) => new Date(z).toDateString();
function gunEtiketi(z) {
	const d = new Date(z);
	const bugun = new Date();
	const dun = new Date(Date.now() - 86400000);
	if (d.toDateString() === bugun.toDateString()) return 'Bugün';
	if (d.toDateString() === dun.toDateString()) return 'Dün';
	return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
}
const saatYaz = (z) => new Date(z).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
function zamanYaz(z) {
	const d = new Date(z);
	const bugun = new Date().toDateString() === d.toDateString();
	return bugun ? 'Bugün ' + saatYaz(z) : d.toLocaleDateString('tr-TR') + ' ' + saatYaz(z);
}

function boyutYaz(n) {
	n = Number(n) || 0;
	const ondalik = (x) => x.toLocaleString('tr-TR', { maximumFractionDigits: 1 });
	if (n < 1024) return n + ' B';
	if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
	if (n < 1024 ** 3) return ondalik(n / 1024 ** 2) + ' MB';
	return ondalik(n / 1024 ** 3) + ' GB';
}
function sureYaz(sn) {
	sn = Math.max(0, Math.round(Number(sn) || 0));
	const s = Math.floor(sn / 3600);
	const d = Math.floor((sn % 3600) / 60);
	const k = String(sn % 60).padStart(2, '0');
	return s ? `${s}:${String(d).padStart(2, '0')}:${k}` : `${d}:${k}`;
}

// Bağlantılar tıklanabilir, @adın vurgulanır. Metin hep textContent ile eklenir (HTML çalışmaz).
const BAGLANTI_KALIBI = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}])/giu;
function bahsediyorMu(metin) {
	if (!benimAdim) return false;
	const benimKucuk = benimAdim.toLocaleLowerCase('tr');
	return String(metin)
		.split(/(@[\p{L}\p{N}_.-]+)/u)
		.some((p) => p.startsWith('@') && p.slice(1).toLocaleLowerCase('tr') === benimKucuk);
}
function metinCiz(hedef, metin) {
	if (!metin) return;
	const benimKucuk = benimAdim.toLocaleLowerCase('tr');
	for (const parca of String(metin).split(BAGLANTI_KALIBI)) {
		if (!parca) continue;
		if (/^https?:\/\//i.test(parca)) {
			const a = el('a', null, parca);
			a.href = parca;
			a.target = '_blank';
			a.rel = 'noopener noreferrer nofollow';
			hedef.append(a);
			continue;
		}
		for (const p of parca.split(/(@[\p{L}\p{N}_.-]+)/u)) {
			if (!p) continue;
			if (p.startsWith('@') && p.slice(1).toLocaleLowerCase('tr') === benimKucuk) hedef.append(el('span', 'bahsetme', p));
			else hedef.append(document.createTextNode(p));
		}
	}
}

const ONIZLEME = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const SES_TURLERI = ['mp3', 'ogg', 'oga', 'm4a', 'wav'];
const VIDEO_TURLERI = ['mp4', 'webm'];
const dosyaUzanti = (ad) => (String(ad).split('.').pop() || '').toLowerCase();

function mesajElemani(m, onceki) {
	const gruplu = !!(onceki && onceki.ad === m.ad && m.zaman - onceki.zaman < 5 * 60000);
	const d = el('div', 'mesaj' + (gruplu ? ' gruplu' : '') + (m.metin && bahsediyorMu(m.metin) ? ' bahsediliyor' : ''));
	d.dataset.id = m.id;
	if (gruplu) {
		const s = el('span', 'yan-saat', saatYaz(m.zaman));
		s.title = zamanYaz(m.zaman);
		d.append(s);
	} else d.append(avatarYap(m.ad));
	const govde = el('div', 'govde');
	if (!gruplu) {
		const ust = el('div', 'mesaj-ust');
		const ad = el('b', 'ad', m.ad);
		ad.style.setProperty('--renk', renkBul(m.ad));
		const saat = el('span', 'saat', saatYaz(m.zaman));
		saat.title = zamanYaz(m.zaman);
		ust.append(ad, saat);
		govde.append(ust);
	}
	if (m.metin) {
		const metin = el('div', 'metin');
		metinCiz(metin, m.metin);
		govde.append(metin);
	}
	if (m.dosya) govde.append(p2pDosyaElemani(m.dosya, m.ad));
	d.append(govde);
	return d;
}

function kanalHosgeldin() {
	const k = kanalBilgi(aktifKanal);
	const kap = el('div', 'kanal-hos');
	const isaretKutu = el('div', 'buyuk-isaret');
	isaretKutu.append(ikon('kare'));
	kap.append(isaretKutu, el('h2', null, `#${k ? k.ad : ''} kanalına hoş geldin!`), el('p', null, `#${k ? k.ad : ''} kanalının başlangıcı burası.`));
	return kap;
}

function mesajlariCiz(dibe) {
	const kap = $('mesajlar');
	const alan = $('mesaj-alani');
	const oncekiYukseklik = alan.scrollHeight;
	const oncekiKaydirma = alan.scrollTop;
	kap.replaceChildren();
	$('daha-eski').hidden = gecmisBitti;
	if (gecmisBitti) kap.append(kanalHosgeldin());
	if (!mesajVerisi.length) {
		kap.append(el('div', 'bos-kanal', 'Henüz mesaj yok. İlk mesajı sen yaz.'));
		return;
	}
	let onceki = null;
	let gun = '';
	for (const m of mesajVerisi) {
		const g = gunAnahtari(m.zaman);
		if (g !== gun) {
			gun = g;
			kap.append(el('div', 'gun', gunEtiketi(m.zaman)));
			onceki = null;
		}
		kap.append(mesajElemani(m, onceki));
		onceki = m;
	}
	if (dibe) dibeKaydir();
	else alan.scrollTop = oncekiKaydirma + (alan.scrollHeight - oncekiYukseklik);
}

// Dipte kalma: dipteyken (dibeYapisik) yeni mesaj, yüklenen resim ya da mesaj alanının küçülmesi
// (ses kartı açıldı, telefonda klavye açıldı, yazı kutusu büyüdü) seni dipte tutar. Dipten yalnızca
// kullanıcı yukarı kaydırınca ayrılınır; yukarıda okuyan kişi bölünmez ("Yeni mesaj ↓" çıkar).
// Eskiden yalnızca "dibe 120 px'ten yakın mıyım" bakılıyordu: alan küçülünce bu bozuluyordu.
let dibeYapisik = true;
let sonKaydirma = 0;
function dibeYakin() {
	const alan = $('mesaj-alani');
	return alan.scrollHeight - alan.scrollTop - alan.clientHeight < 80;
}
function dibeKaydir() {
	const alan = $('mesaj-alani');
	alan.scrollTop = alan.scrollHeight;
	sonKaydirma = alan.scrollTop;
	dibeYapisik = true;
	$('yeni-mesaj').hidden = true;
}
let yeniMesajSayisi = 0;
$('mesaj-alani').addEventListener(
	'scroll',
	() => {
		const alan = $('mesaj-alani');
		const yer = alan.scrollTop;
		if (dibeYakin()) dibeYapisik = true;
		// Yukarı kaydırıldı: dipten ayrıl. Alan küçülünce ya da içerik büyüyünce scrollTop azalmaz,
		// bu yüzden yapışıklık yalnızca kullanıcının kaydırmasıyla bozulur.
		else if (yer < sonKaydirma - 2) dibeYapisik = false;
		sonKaydirma = yer;
		if (dibeYapisik && !$('yeni-mesaj').hidden) $('yeni-mesaj').hidden = true;
		// En üste gelince eski mesajları kendiliğinden yükle.
		if (yer < 40 && !gecmisBitti && mesajVerisi.length) gecmisYukle();
	},
	{ passive: true },
);
$('yeni-mesaj').addEventListener('click', dibeKaydir);
// Mesaj alanının ya da içeriğinin boyu değişince (ses kartı, klavye, resim, yükleme çubuğu) dipte kal.
if (typeof ResizeObserver === 'function') {
	const dipGozcusu = new ResizeObserver(() => {
		if (dibeYapisik) dibeKaydir();
	});
	dipGozcusu.observe($('mesaj-alani'));
	dipGozcusu.observe($('mesajlar'));
}

function mesajGeldi(kanal, m) {
	if (!m) return;
	if (kanal === aktifKanal) {
		if (mesajVerisi.some((x) => x.id === m.id)) return;
		const yakin = dibeYapisik || dibeYakin();
		const onceki = mesajVerisi.length ? mesajVerisi[mesajVerisi.length - 1] : null;
		mesajVerisi.push(m);
		$('mesajlar').querySelectorAll('.bos-kanal').forEach((x) => x.remove());
		const ayniGun = onceki && gunAnahtari(m.zaman) === gunAnahtari(onceki.zaman);
		if (!ayniGun) $('mesajlar').append(el('div', 'gun', gunEtiketi(m.zaman)));
		const e = mesajElemani(m, ayniGun ? onceki : null);
		if (m.ad !== benimAdim) e.classList.add('yeni');
		$('mesajlar').append(e);
		yaziyorlar.delete(m.ad);
		yaziyorCiz();
		if (yakin || m.ad === benimAdim) dibeKaydir();
		else {
			yeniMesajSayisi = $('yeni-mesaj').hidden ? 1 : yeniMesajSayisi + 1;
			$('yeni-mesaj').textContent = yeniMesajSayisi > 1 ? `${yeniMesajSayisi} yeni mesaj ↓` : 'Yeni mesaj ↓';
			$('yeni-mesaj').hidden = false;
		}
	} else if (m.ad !== benimAdim) {
		okunmamis.set(kanal, (okunmamis.get(kanal) || 0) + 1);
		kanalListesiCiz();
	}
}

// --- yazma

$('metin').addEventListener('input', () => {
	const t = $('metin');
	t.style.height = 'auto';
	t.style.height = Math.min(t.scrollHeight, 200) + 'px';
	yaziyorBildir();
});
$('metin').addEventListener('keydown', (e) => {
	// IME ile yazarken (ör. Japonca) Enter seçimi onaylar; mesajı göndermesin.
	if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
		e.preventDefault();
		yaziyiGonder();
	}
});
$('yazma').addEventListener('submit', (e) => {
	e.preventDefault();
	yaziyiGonder();
});

let yaziyorZaman = 0;
function yaziyorBildir() {
	if (!aktifKanal || !bagliyim || !$('metin').value.trim()) return;
	const simdi = Date.now();
	if (simdi - yaziyorZaman < 4000) return;
	yaziyorZaman = simdi;
	gonder({ type: 'yaziyor', kanal: aktifKanal });
}

let yaziZaman = 0;
function yaziyiGonder() {
	const t = $('metin');
	const metin = t.value.trim();
	if (!metin || !aktifKanal) return;
	if (!bagliyim) return durum('Sunucuya bağlı değilsin; mesaj gönderilemedi (yazdığın duruyor).', true);
	if (Date.now() - yaziZaman < 250) return; // çift Enter
	yaziZaman = Date.now();
	yaziyorZaman = 0;
	gonder({ type: 'yazi', kanal: aktifKanal, metin });
	t.value = '';
	t.style.height = 'auto';
	if (!dokunmatik()) t.focus();
}

function yaziyorGeldi(kanal, ad) {
	if (kanal !== aktifKanal || ad === benimAdim) return;
	yaziyorlar.set(ad, Date.now());
	yaziyorCiz();
}

function yaziyorCiz() {
	const simdi = Date.now();
	const adlar = [];
	for (const [ad, zaman] of yaziyorlar) {
		if (simdi - zaman > 5000) yaziyorlar.delete(ad);
		else adlar.push(ad);
	}
	const e = $('yaziyor');
	if (!adlar.length) {
		e.replaceChildren();
		e.classList.remove('gorunur');
		return;
	}
	const noktalar = el('span', 'yazma-noktalar');
	noktalar.append(el('i'), el('i'), el('i'));
	const metin = adlar.length === 1 ? `${adlar[0]} yazıyor…` : `${adlar.slice(0, 3).join(', ')}${adlar.length > 3 ? ' ve diğerleri' : ''} yazıyor…`;
	e.replaceChildren(noktalar, el('span', null, metin));
	e.classList.add('gorunur');
}
setInterval(yaziyorCiz, 1000);

// --- dosya

$('dosya-sec').addEventListener('click', () => $('dosya').click());
$('dosya').addEventListener('change', () => {
	const liste = [...(($('dosya').files) || [])];
	$('dosya').value = '';
	dosyalariPaylas(liste);
});

// Sürükle-bırak: tüm sohbet alanını kaplayan bırakma yeri (alt öğelerde titremesin diye sayaçlı).
let surukleSayac = 0;
const dosyaSurukleniyor = (e) => !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files'));
$('ana').addEventListener('dragenter', (e) => {
	if (!dosyaSurukleniyor(e)) return;
	e.preventDefault();
	surukleSayac++;
	$('birak').hidden = false;
});
$('ana').addEventListener('dragover', (e) => {
	if (dosyaSurukleniyor(e)) e.preventDefault();
});
$('ana').addEventListener('dragleave', () => {
	if (--surukleSayac <= 0) {
		surukleSayac = 0;
		$('birak').hidden = true;
	}
});
$('ana').addEventListener('drop', (e) => {
	surukleSayac = 0;
	$('birak').hidden = true;
	const liste = [...((e.dataTransfer && e.dataTransfer.files) || [])];
	if (!liste.length) return;
	e.preventDefault();
	dosyalariPaylas(liste);
});
$('metin').addEventListener('paste', (e) => {
	const liste = [...((e.clipboardData && e.clipboardData.files) || [])];
	if (!liste.length) return;
	e.preventDefault();
	dosyalariPaylas(liste);
});

// ---------------------------------------------------------------- P2P dosya paylaşımı
//
// Dosyalar sunucuya yüklenmez. Paylaşan seçtiği dosyayı tarayıcısında tutar; sohbete yalnızca adı,
// boyutu ve türü yazılır. İsteyen, paylaşanla doğrudan bir WebRTC bağlantısı kurar (sunucu yalnızca
// tanıştırır; doğrudan bağlanamayanlar TURN üzerinden) ve dosya bir veri kanalından parça parça akar.
// Boyut sınırı yoktur: büyük dosyalar belleğe değil diske yazılır (Chrome/Edge'de "Farklı kaydet"
// ile doğrudan seçilen yere; diğer tarayıcılarda tarayıcının dosya alanına, sonra İndirilenler'e).
// Paylaşan sayfayı açık tuttukça dosya alınabilir ("Yeniden paylaş" ile sayfa yenilendikten sonra
// geri açılabilir). Kopan aktarım kaldığı yerden sürer.
//
// Veri kanalı protokolü (alan açar): alan → {istek: id, baslangic}; gönderen → {tamam, boyut} ya da
// {hata: 'yok' | 'iptal'}, sonra ikili parçalar ve {bitti}. Alan diske yazdıkça {onay: bayt} der;
// gönderen, alanın yazdığından en fazla PENCERE kadar ileri gider (yavaş disk belleği şişirmesin).

const PARCA = 64 * 1024; // veri kanalı mesajı
const OKUMA = 1024 * 1024; // diskten bir seferde okunan
const TAMPON_UST = 4 * 1024 * 1024; // gönderim tamponu bunu geçince beklenir
const PENCERE = 32 * 1024 * 1024; // alanın diske yazdığından en fazla bu kadar ileri
const ONAY_ARALIGI = 4 * 1024 * 1024; // alan her bu kadar yazınca bildirir
const ONIZLEME_SINIRI = 8 * 1024 * 1024; // bu boyuta kadar resimler kendiliğinden alınıp gösterilir
const BELLEK_SINIRI = 128 * 1024 * 1024; // bundan büyük dosyalar diske akıtılır
const BELLEK_BIRLESTIR = 16 * 1024 * 1024; // bellekte biriktirirken parçalar bu boyutta birleştirilir

const paylasimlarim = new Map(); // id -> File (bu sekmenin sunduğu dosyalar)
let sunulanlar = new Set(); // şu an çevrimiçi biri tarafından sunulan dosya id'leri (sunucudan)
const dosyaBilgileri = new Map(); // id -> { id, ad, boyut, tur, sahip } (görülen dosya mesajları)
const alinanlar = new Map(); // id -> { dosya, url, disk } (bu oturumda indirilenler)
const indirmeler = new Map(); // id -> gelen aktarım
const gonderimler = new Set(); // giden aktarımlar
const yerelUrller = new Map(); // id -> blob URL (kendi paylaştığım dosyanın önizlemesi)
const onizlemeHatalari = new Set(); // kendiliğinden alınamayan önizlemeler (yeniden denenmez)
const dosyaBaglari = new Map(); // bağlantı id -> P2P dosya bağlantısı

function dosyalariPaylas(liste) {
	liste = (liste || []).filter(Boolean);
	if (!liste.length) return;
	if (!aktifKanal || !bagliyim) return durum('Dosya paylaşmak için önce sunucuya bağlan.', true);
	let adet = 0;
	for (const dosya of liste.slice(0, 20)) {
		if (!dosya.size) {
			durum(`${dosya.name || 'dosya'}: boş dosya paylaşılamaz.`, true);
			continue;
		}
		const id = rastgeleHex(24);
		paylasimlarim.set(id, dosya);
		gonder({ type: 'dosya-paylas', kanal: aktifKanal, id, ad: dosya.name || 'dosya', boyut: dosya.size, tur: dosya.type || '' });
		adet++;
	}
	if (liste.length > 20) durum('Bir seferde en fazla 20 dosya paylaşılır.', true);
	else if (adet) durum((adet > 1 ? `${adet} dosya paylaşıldı` : 'Dosya paylaşıldı') + '; sayfan açık kaldıkça indirilebilir.');
}

function sunulanlarGeldi(liste) {
	const yeni = new Set(Array.isArray(liste) ? liste : []);
	// Paylaşanı geri gelen dosyanın önizlemesi (önceden alınamadıysa) yeniden denenebilir.
	for (const id of yeni) if (!sunulanlar.has(id)) onizlemeHatalari.delete(id);
	sunulanlar = yeni;
	dosyaKartlariniGuncelle();
}

// Sunucu yalnızca hâlâ sohbette duran ve benim paylaştığım dosyaları kabul eder; gerisini bırak.
function sunduklarimOnaylandi(idler) {
	const gecerli = new Set(Array.isArray(idler) ? idler : []);
	for (const id of [...paylasimlarim.keys()]) if (!gecerli.has(id)) paylasimiBirak(id, false);
	dosyaKartlariniGuncelle();
}

function paylasimiBirak(id, bildir = true) {
	if (!paylasimlarim.delete(id)) return;
	const url = yerelUrller.get(id);
	if (url) URL.revokeObjectURL(url);
	yerelUrller.delete(id);
	for (const akt of [...gonderimler]) if (akt.id === id) gonderimiIptalEt(akt);
	if (bildir) gonder({ type: 'dosya-sun', idler: [...paylasimlarim.keys()] });
	dosyaKartlariniGuncelle(id);
}

// Sayfa yenilendikten sonra (dosya bellekten gitti) aynı dosyayı yeniden seçip sunmaya devam et.
function yenidenPaylas(id) {
	const bilgi = dosyaBilgileri.get(id);
	if (!bilgi) return;
	const girdi = el('input');
	girdi.type = 'file';
	girdi.addEventListener('change', () => {
		const dosya = girdi.files && girdi.files[0];
		if (!dosya) return;
		if (dosya.size !== bilgi.boyut) return durum(`Bu aynı dosya değil (boyut ${boyutYaz(dosya.size)}, beklenen ${boyutYaz(bilgi.boyut)}).`, true);
		paylasimlarim.set(id, dosya);
		gonder({ type: 'dosya-sun', idler: [...paylasimlarim.keys()] });
		durum(`${bilgi.ad} yeniden paylaşılıyor.`);
		dosyaKartlariniGuncelle(id);
	});
	girdi.click();
}

function yerelUrl(id, dosya) {
	let url = yerelUrller.get(id);
	if (!url) {
		url = URL.createObjectURL(dosya);
		yerelUrller.set(id, url);
	}
	return url;
}

// --- bağlantılar: indiren taraf kurar ve teklif eder (her yönün kendi bağlantısı vardır, çakışma
// olmaz). Aynı kişiden indirilen dosyalar aynı bağlantıyı kullanır, her dosya ayrı bir veri
// kanalıdır. Boşta kalan bağlantı kapanır.

const dosyaSinyali = (ad, veri) => gonder({ type: 'dosya-sinyal', to: ad, veri });

function bagOlustur(id, ad, alici) {
	let pc;
	try {
		pc = new RTCPeerConnection(pcAyari());
	} catch (h) {
		console.warn('dosya bağlantısı kurulamadı', h);
		return null;
	}
	const bag = { id, ad, alici, pc, adaylar: [], kanallar: new Set(), aktarimlar: new Set(), kapandi: false, turn: false, sonKullanim: Date.now() };
	dosyaBaglari.set(id, bag);
	pc.onicecandidate = (e) => {
		if (e.candidate && !bag.kapandi) dosyaSinyali(ad, { tur: 'aday', bag: id, aday: e.candidate });
	};
	pc.onconnectionstatechange = () => {
		if (bag.kapandi) return;
		const d = pc.connectionState;
		if (d === 'connected') bagTuruOlc(bag);
		else if (d === 'failed' || d === 'closed') bagKapat(bag, 'Bağlantı koptu');
	};
	return bag;
}

function aliciBagi(ad) {
	for (const b of dosyaBaglari.values()) {
		if (b.alici && b.ad === ad && !b.kapandi && !['failed', 'closed', 'disconnected'].includes(b.pc.connectionState)) return b;
	}
	const bag = bagOlustur(rastgeleKimlik(16), ad, true);
	if (!bag) return null;
	// Teklif, ilk veri kanalı açıldıktan sonra (SCTP satırı teklife girsin diye) gönderilir.
	setTimeout(async () => {
		try {
			const teklif = await bag.pc.createOffer();
			if (bag.kapandi) return;
			await bag.pc.setLocalDescription(teklif);
			dosyaSinyali(ad, { tur: 'teklif', bag: bag.id, sdp: bag.pc.localDescription });
		} catch (h) {
			bagKapat(bag, 'Bağlantı kurulamadı');
		}
	}, 0);
	return bag;
}

function bagKapat(bag, neden, karsiKapatti = false) {
	if (bag.kapandi) return;
	bag.kapandi = true;
	dosyaBaglari.delete(bag.id);
	if (!karsiKapatti && bagliyim) dosyaSinyali(bag.ad, { tur: 'kapat', bag: bag.id });
	for (const akt of [...bag.aktarimlar]) {
		if (akt.yon === 'gelen') aktarimKoptu(akt, neden || 'Bağlantı koptu');
		else gonderimBitti(akt, neden || 'bağlantı koptu');
	}
	for (const k of bag.kanallar) {
		try {
			k.close();
		} catch {}
	}
	try {
		bag.pc.close();
	} catch {}
}

// Bağlantı TURN üzerinden mi? (Aktarımda "yavaş olabilir" bilgisi için.)
async function bagTuruOlc(bag) {
	try {
		const rapor = await bag.pc.getStats();
		rapor.forEach((r) => {
			if (r.type === 'transport' && r.selectedCandidatePairId) {
				const c = rapor.get(r.selectedCandidatePairId);
				const y = c && rapor.get(c.localCandidateId);
				const u = c && rapor.get(c.remoteCandidateId);
				bag.turn = !!((y && y.candidateType === 'relay') || (u && u.candidateType === 'relay'));
			}
		});
	} catch {}
}

// Boşta kalan bağlantıları kapat (indiren 1, gönderen 3 dakika sonra).
setInterval(() => {
	const simdi = Date.now();
	for (const bag of [...dosyaBaglari.values()]) {
		if (bag.aktarimlar.size) {
			bag.sonKullanim = simdi;
			continue;
		}
		if (simdi - bag.sonKullanim > (bag.alici ? 60000 : 180000)) bagKapat(bag, '');
	}
}, 15000);

function dosyaSinyaliGeldi(ad, veri) {
	if (!ad || !veri || typeof veri !== 'object') return;
	const bag = typeof veri.bag === 'string' ? dosyaBaglari.get(veri.bag) : null;
	if (bag && bag.ad !== ad) return; // başkasının bağlantısına karışılamaz
	switch (veri.tur) {
		case 'teklif':
			dosyaTeklifiGeldi(ad, veri, bag);
			break;
		case 'yanit':
			if (bag && bag.alici && veri.sdp && bag.pc.signalingState === 'have-local-offer') {
				bag.pc
					.setRemoteDescription(veri.sdp)
					.then(() => adaylariEkle(bag))
					.catch(() => bagKapat(bag, 'Bağlantı kurulamadı'));
			}
			break;
		case 'aday':
			if (!bag || !veri.aday) return;
			if (bag.pc.remoteDescription) bag.pc.addIceCandidate(veri.aday).catch(() => {});
			else if (bag.adaylar.length < 100) bag.adaylar.push(veri.aday);
			break;
		case 'kapat':
			if (bag) bagKapat(bag, 'Karşı taraf bağlantıyı kapattı', true);
			break;
		case 'ulasilamadi':
			// Hedef çevrimiçi değil: o kişiyle kurulan tüm dosya bağlantıları düşer.
			for (const b of [...dosyaBaglari.values()]) if (b.ad === ad) bagKapat(b, `${ad} çevrimdışı`, true);
			break;
	}
}

async function adaylariEkle(bag) {
	for (const a of bag.adaylar.splice(0)) await bag.pc.addIceCandidate(a).catch(() => {});
}

// Gönderen taraf: biri dosyalarımdan birini istemek için bağlanıyor.
async function dosyaTeklifiGeldi(ad, veri, bag) {
	if (typeof veri.bag !== 'string' || !/^[a-z0-9]{8,40}$/.test(veri.bag) || !veri.sdp) return;
	if (bag && bag.alici) return;
	if (!paylasimlarim.size) return dosyaSinyali(ad, { tur: 'kapat', bag: veri.bag });
	if (!bag) {
		bag = bagOlustur(veri.bag, ad, false);
		if (!bag) return dosyaSinyali(ad, { tur: 'kapat', bag: veri.bag });
		bag.pc.ondatachannel = (e) => gidenKanal(bag, e.channel);
	}
	try {
		await bag.pc.setRemoteDescription(veri.sdp);
		await adaylariEkle(bag);
		const yanit = await bag.pc.createAnswer();
		await bag.pc.setLocalDescription(yanit);
		dosyaSinyali(ad, { tur: 'yanit', bag: bag.id, sdp: bag.pc.localDescription });
	} catch (h) {
		console.warn('dosya teklifi', h);
		bagKapat(bag, '');
	}
}

// --- gönderen: istenen dosyayı parça parça gönder

function gidenKanal(bag, kanal) {
	kanal.binaryType = 'arraybuffer';
	bag.kanallar.add(kanal);
	bag.sonKullanim = Date.now();
	let akt = null;
	kanal.onmessage = (e) => {
		if (typeof e.data !== 'string') return;
		let m;
		try {
			m = JSON.parse(e.data);
		} catch {
			return;
		}
		if (m.istek != null && !akt) {
			const id = String(m.istek);
			const dosya = paylasimlarim.get(id);
			if (!dosya) {
				kanalaYaz(kanal, { hata: 'yok' });
				setTimeout(() => kanal.close(), 300);
				return;
			}
			const baslangic = Math.max(0, Math.min(dosya.size, Math.floor(Number(m.baslangic) || 0)));
			const bilgi = dosyaBilgileri.get(id);
			akt = { yon: 'giden', id, ad: (bilgi && bilgi.ad) || dosya.name, dosya, kisi: bag.ad, kanal, bag, gonderilen: baslangic, onaylanan: baslangic, boyut: dosya.size, bitti: false, uyandir: null };
			hizBaslat(akt, baslangic);
			gonderimler.add(akt);
			bag.aktarimlar.add(akt);
			aktarimlariCiz();
			kapanisUyarisi();
			gonderimDongusu(akt);
		} else if (m.onay != null && akt) {
			akt.onaylanan = Math.max(akt.onaylanan, Number(m.onay) || 0);
			if (akt.uyandir) akt.uyandir();
			ilerlemeGuncelle(akt, Math.max(akt.ilerleme || 0, akt.onaylanan));
			if (akt.onaylanan >= akt.boyut) gonderimBitti(akt, '');
		}
	};
	kanal.onclose = () => {
		bag.kanallar.delete(kanal);
		if (akt && !akt.bitti) gonderimBitti(akt, akt.onaylanan >= akt.boyut ? '' : 'yarıda kaldı');
	};
}

function kanalaYaz(kanal, nesne) {
	try {
		if (kanal.readyState === 'open') kanal.send(JSON.stringify(nesne));
	} catch {}
}

async function gonderimDongusu(akt) {
	const { kanal, dosya } = akt;
	const sctp = akt.bag.pc.sctp;
	const parcaBoyu = Math.max(16 * 1024, Math.min(PARCA, (sctp && sctp.maxMessageSize) || PARCA));
	kanal.bufferedAmountLowThreshold = TAMPON_UST / 4;
	const bekle = () =>
		new Promise((coz) => {
			const zaman = setTimeout(() => akt.uyandir && akt.uyandir(), 1000);
			akt.uyandir = () => {
				clearTimeout(zaman);
				akt.uyandir = null;
				coz();
			};
			kanal.onbufferedamountlow = () => akt.uyandir && akt.uyandir();
		});
	try {
		kanalaYaz(kanal, { tamam: true, boyut: dosya.size, baslangic: akt.gonderilen });
		while (akt.gonderilen < dosya.size) {
			if (akt.bitti || kanal.readyState !== 'open') return;
			// Tampon doluysa ya da alan diske yazmakta geride kaldıysa bekle.
			if (kanal.bufferedAmount > TAMPON_UST || akt.gonderilen - akt.onaylanan > PENCERE) {
				await bekle();
				continue;
			}
			const son = Math.min(dosya.size, akt.gonderilen + OKUMA);
			const blok = await dosya.slice(akt.gonderilen, son).arrayBuffer();
			if (akt.bitti || kanal.readyState !== 'open') return;
			for (let i = 0; i < blok.byteLength; i += parcaBoyu) kanal.send(blok.slice(i, Math.min(blok.byteLength, i + parcaBoyu)));
			akt.gonderilen = son;
			// Görünen ilerleme: ağa çıkan (tampondaki hariç); bitiş alanın onayıyla belli olur.
			ilerlemeGuncelle(akt, Math.max(akt.onaylanan, akt.gonderilen - kanal.bufferedAmount));
		}
		kanalaYaz(kanal, { bitti: true });
	} catch (h) {
		console.warn('dosya gönderilemedi', h);
		kanalaYaz(kanal, { hata: 'okunamadi' });
		gonderimBitti(akt, 'dosya okunamadı');
		setTimeout(() => kanal.close(), 300);
	}
}

function gonderimBitti(akt, hata) {
	if (akt.bitti) return;
	akt.bitti = true;
	akt.hata = hata;
	gonderimler.delete(akt);
	akt.bag.aktarimlar.delete(akt);
	akt.bag.sonKullanim = Date.now();
	if (akt.uyandir) akt.uyandir();
	if (!hata) durum(`${akt.ad} → ${akt.kisi} gönderildi.`);
	aktarimlariCiz();
	kapanisUyarisi();
}

function gonderimiIptalEt(akt) {
	kanalaYaz(akt.kanal, { hata: 'iptal' });
	gonderimBitti(akt, 'iptal edildi');
	setTimeout(() => {
		try {
			akt.kanal.close();
		} catch {}
	}, 300);
}

// --- indiren: yazıcı (dosyanın gideceği yer) seç, kanal aç, gelen parçaları sırayla yaz

const opfsVar = () =>
	!!(navigator.storage && typeof navigator.storage.getDirectory === 'function' && typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype);

// Yazıcı: (1) Chrome/Edge masaüstü, büyük dosya: "Farklı kaydet" ile seçilen dosyaya doğrudan
// (sınırsız); (2) diğer tarayıcılar, büyük dosya: tarayıcının dosya alanı (OPFS), bitince
// İndirilenler'e kaydedilir; (3) küçük dosyalar ve önizlemeler: bellek. Deneme için localStorage
// 'dosya-yazici' = 'bellek' | 'opfs'.
async function yaziciAc(akt) {
	const zorla = depoOku('dosya-yazici', '');
	const buyuk = akt.bilgi.boyut > BELLEK_SINIRI;
	if (!zorla && buyuk && !akt.onizleme && typeof window.showSaveFilePicker === 'function') {
		let tutamac = null;
		try {
			tutamac = await window.showSaveFilePicker({ suggestedName: akt.bilgi.ad });
		} catch (h) {
			if (h && h.name === 'AbortError') throw h; // kullanıcı vazgeçti
		}
		if (tutamac) {
			const yazilabilir = await tutamac.createWritable();
			return {
				tur: 'disk',
				yaz: (p) => yazilabilir.write(p),
				bitir: async () => {
					await yazilabilir.close();
					try {
						return await tutamac.getFile();
					} catch {
						return null;
					}
				},
				iptal: () => yazilabilir.abort(),
			};
		}
	}
	if (zorla !== 'bellek' && (zorla === 'opfs' || (buyuk && !akt.onizleme)) && opfsVar()) {
		try {
			return await opfsYazici(akt);
		} catch (h) {
			console.warn('tarayıcının dosya alanı kullanılamadı', h);
		}
	}
	if (buyuk && !akt.onizleme) durum('Bu tarayıcı dosyayı diske akıtamıyor; bellekte toplanacak (çok büyük dosyada Chrome/Edge kullan).', true);
	return bellekYazici(akt);
}

async function opfsYazici(akt) {
	try {
		const t = await navigator.storage.estimate();
		if (t && t.quota && t.quota - (t.usage || 0) < akt.bilgi.boyut + 64 * 1024 * 1024) throw new Error('tarayıcının dosya alanında yer yok');
	} catch (h) {
		if (/yer yok/.test(String(h && h.message))) throw h;
	}
	const kok = await navigator.storage.getDirectory();
	const klasor = await kok.getDirectoryHandle('indirilenler', { create: true });
	const ad = akt.bilgi.id + '-' + rastgeleKimlik(6);
	const tutamac = await klasor.getFileHandle(ad, { create: true });
	const yazilabilir = await tutamac.createWritable();
	return {
		tur: 'opfs',
		yaz: (p) => yazilabilir.write(p),
		bitir: async () => {
			await yazilabilir.close();
			return tutamac.getFile();
		},
		iptal: async () => {
			try {
				await yazilabilir.abort();
			} catch {}
			try {
				await klasor.removeEntry(ad);
			} catch {}
		},
	};
}

function bellekYazici(akt) {
	let parcalar = [];
	let bekleyen = [];
	let bekleyenBoyut = 0;
	return {
		tur: 'bellek',
		yaz: (p) => {
			bekleyen.push(p);
			bekleyenBoyut += p.byteLength;
			// Küçük parçaları ara ara birleştir (çok sayıda ArrayBuffer belleği şişirmesin).
			if (bekleyenBoyut >= BELLEK_BIRLESTIR) {
				parcalar.push(new Blob(bekleyen));
				bekleyen = [];
				bekleyenBoyut = 0;
			}
		},
		bitir: () => {
			if (bekleyen.length) parcalar.push(new Blob(bekleyen));
			return new Blob(parcalar, { type: akt.bilgi.tur || '' });
		},
		iptal: async () => {
			parcalar = [];
			bekleyen = [];
		},
	};
}

// Önceki oturumlardan tarayıcının dosya alanında kalan geçici indirmeleri sil.
async function eskiIndirmeleriSil() {
	if (!opfsVar()) return;
	try {
		const kok = await navigator.storage.getDirectory();
		await kok.removeEntry('indirilenler', { recursive: true });
	} catch {}
}

async function dosyaIndir(id, { onizleme = false } = {}) {
	const bilgi = dosyaBilgileri.get(id);
	if (!bilgi) return;
	const suren = indirmeler.get(id);
	if (suren) {
		// Önizlemesi alınmakta olan dosyaya "İndir" basıldı: aynı aktarım indirmeye dönüşür.
		if (!onizleme && suren.onizleme) {
			suren.onizleme = false;
			dosyaKartlariniGuncelle(id);
			aktarimlariCiz();
			kapanisUyarisi();
		}
		return;
	}
	if (!bagliyim) return onizleme || durum('Sunucuya bağlı değilsin.', true);
	if (!sunulanlar.has(id)) {
		if (!onizleme) durum(`${bilgi.sahip} şu an bu dosyayı sunmuyor (sayfası kapalı).`, true);
		return;
	}
	const akt = { yon: 'gelen', id, bilgi, ad: bilgi.ad, kisi: bilgi.sahip, boyut: bilgi.boyut, onizleme, alinan: 0, yazilan: 0, onaylanan: 0, deneme: 0, bekleme: 0, durum: 'baglaniyor', bitti: false, yazici: null, yazma: Promise.resolve(), kanal: null, bag: null };
	indirmeler.set(id, akt);
	hizBaslat(akt, 0);
	// "Farklı kaydet" penceresi tıklamanın içinde açılmalı: önce yazıcı, sonra bağlantı.
	const yaziciSozu = yaziciAc(akt);
	dosyaKartlariniGuncelle(id);
	aktarimlariCiz();
	try {
		akt.yazici = await yaziciSozu;
	} catch (h) {
		indirmeler.delete(id);
		if (!(h && h.name === 'AbortError')) durum('Dosya kaydedilemiyor: ' + ((h && h.message) || h), true);
		dosyaKartlariniGuncelle(id);
		aktarimlariCiz();
		return;
	}
	if (akt.bitti) {
		akt.yazici.iptal().catch(() => {});
		return;
	}
	kapanisUyarisi();
	indirmeKanaliAc(akt);
}

function indirmeKanaliAc(akt) {
	const bag = aliciBagi(akt.kisi);
	if (!bag) return indirmeBitti(akt, 'Bağlantı kurulamadı.');
	let kanal;
	try {
		kanal = bag.pc.createDataChannel('dosya', { ordered: true });
	} catch (h) {
		return indirmeBitti(akt, 'Bağlantı kurulamadı.');
	}
	akt.bag = bag;
	akt.kanal = kanal;
	akt.durum = 'baglaniyor';
	bag.aktarimlar.add(akt);
	bag.kanallar.add(kanal);
	bag.sonKullanim = Date.now();
	kanal.binaryType = 'arraybuffer';
	kanal.onopen = () => {
		clearTimeout(akt.acilisZamani);
		kanalaYaz(kanal, { istek: akt.id, baslangic: akt.alinan });
	};
	kanal.onmessage = (e) => indirmeMesaji(akt, kanal, e.data);
	kanal.onclose = () => {
		bag.kanallar.delete(kanal);
		if (akt.kanal === kanal) aktarimKoptu(akt, 'Bağlantı koptu');
	};
	clearTimeout(akt.acilisZamani);
	akt.acilisZamani = setTimeout(() => {
		if (akt.kanal !== kanal || kanal.readyState === 'open') return;
		// Bağlantı hiç kurulamadıysa takılı kalmıştır: kapat, yeniden denemede yenisi kurulur.
		if (bag.pc.connectionState !== 'connected') bagKapat(bag, `${akt.kisi} ile bağlantı kurulamadı`);
		else aktarimKoptu(akt, `${akt.kisi} yanıt vermedi`);
	}, 25000);
	ilerlemeGuncelle(akt, akt.alinan, true);
}

function indirmeMesaji(akt, kanal, veri) {
	if (akt.kanal !== kanal || akt.bitti) return;
	if (typeof veri === 'string') {
		let m;
		try {
			m = JSON.parse(veri);
		} catch {
			return;
		}
		if (m.hata) {
			const neden = m.hata === 'yok' ? `${akt.kisi} artık bu dosyayı sunmuyor.` : m.hata === 'iptal' ? `${akt.kisi} gönderimi durdurdu.` : 'Paylaşan dosyayı okuyamadı.';
			return indirmeBitti(akt, neden);
		}
		if (m.tamam) {
			if (Number(m.boyut) !== akt.boyut) return indirmeBitti(akt, 'Dosya değişmiş (boyutu farklı).');
			akt.durum = 'aliniyor';
			ilerlemeGuncelle(akt, akt.alinan, true);
		} else if (m.bitti) {
			akt.sonGeldi = true;
			akt.yazma.then(() => indirmeyiTamamla(akt));
		}
		return;
	}
	const parca = veri;
	if (!parca || typeof parca.byteLength !== 'number') return;
	if (akt.alinan + parca.byteLength > akt.boyut) return indirmeBitti(akt, 'Beklenenden fazla veri geldi.');
	akt.alinan += parca.byteLength;
	akt.yazma = akt.yazma
		.then(async () => {
			if (akt.bitti) return;
			await akt.yazici.yaz(parca);
			akt.yazilan += parca.byteLength;
			if (akt.yazilan - akt.onaylanan >= ONAY_ARALIGI || akt.yazilan === akt.boyut) {
				akt.onaylanan = akt.yazilan;
				if (akt.kanal) kanalaYaz(akt.kanal, { onay: akt.yazilan });
			}
		})
		.catch((h) => indirmeBitti(akt, 'Diske yazılamadı: ' + ((h && h.message) || h)));
	ilerlemeGuncelle(akt, akt.alinan);
}

// Kanal ya da bağlantı koptu: paylaşan hâlâ sunuyorsa kaldığı yerden yeniden iste.
function aktarimKoptu(akt, neden) {
	if (akt.bitti) return;
	clearTimeout(akt.acilisZamani);
	const kanal = akt.kanal;
	akt.kanal = null;
	if (kanal) {
		try {
			kanal.close();
		} catch {}
	}
	if (akt.bag) akt.bag.aktarimlar.delete(akt);
	akt.bag = null;
	if (akt.sonGeldi) return; // son parça geldi, yazılıp kapanıyor
	if (akt.onizleme || ++akt.deneme > 6) return indirmeBitti(akt, neden);
	akt.durum = 'bekliyor';
	akt.sonHata = neden;
	ilerlemeGuncelle(akt, akt.alinan, true);
	clearTimeout(akt.yenidenZaman);
	akt.yenidenZaman = setTimeout(() => yenidenIste(akt), Math.min(10000, 1000 * akt.deneme));
}

function yenidenIste(akt) {
	if (akt.bitti) return;
	if (!bagliyim || !sunulanlar.has(akt.id)) {
		// Paylaşan (ya da biz) sunucuya dönene kadar bekle (en fazla ~2 dakika).
		if (++akt.bekleme > 40) return indirmeBitti(akt, `${akt.kisi} geri gelmedi; aktarım durdu.`);
		akt.yenidenZaman = setTimeout(() => yenidenIste(akt), 3000);
		return;
	}
	indirmeKanaliAc(akt);
}

async function indirmeyiTamamla(akt) {
	if (akt.bitti) return;
	if (akt.yazilan !== akt.boyut) return indirmeBitti(akt, 'Dosya eksik geldi.');
	let dosya = null;
	try {
		dosya = await akt.yazici.bitir();
	} catch (h) {
		return indirmeBitti(akt, 'Dosya kaydedilemedi.');
	}
	akt.bitti = true;
	clearTimeout(akt.acilisZamani);
	clearTimeout(akt.yenidenZaman);
	if (akt.kanal) {
		const k = akt.kanal;
		akt.kanal = null;
		setTimeout(() => k.close(), 200); // son onay gitsin
	}
	if (akt.bag) akt.bag.aktarimlar.delete(akt);
	indirmeler.delete(akt.id);
	// Önizleme/kaydetme için türü doğru bir Blob (veriyi kopyalamaz, aynı dosyayı gösterir).
	const blob = dosya ? (dosya.type === (akt.bilgi.tur || '') ? dosya : new Blob([dosya], { type: akt.bilgi.tur || '' })) : null;
	alinanlar.set(akt.id, { dosya: blob, url: blob ? URL.createObjectURL(blob) : '', disk: akt.yazici.tur === 'disk', onizleme: akt.onizleme });
	if (!akt.onizleme) {
		if (akt.yazici.tur !== 'disk') dosyayiKaydet(akt.id);
		durum(`${akt.ad} indirildi${akt.yazici.tur === 'disk' ? ' ve kaydedildi' : ''}.`);
	}
	dosyaKartlariniGuncelle(akt.id);
	aktarimlariCiz();
	kapanisUyarisi();
}

function indirmeBitti(akt, hata) {
	if (akt.bitti) return;
	akt.bitti = true;
	clearTimeout(akt.acilisZamani);
	clearTimeout(akt.yenidenZaman);
	if (akt.kanal) {
		try {
			akt.kanal.close();
		} catch {}
	}
	akt.kanal = null;
	if (akt.bag) akt.bag.aktarimlar.delete(akt);
	if (akt.yazici) akt.yazici.iptal().catch(() => {});
	indirmeler.delete(akt.id);
	if (akt.onizleme) onizlemeHatalari.add(akt.id);
	else if (hata) durum(`${akt.ad}: ${hata}`, true);
	dosyaKartlariniGuncelle(akt.id);
	aktarimlariCiz();
	kapanisUyarisi();
}

function dosyayiKaydet(id) {
	const a = alinanlar.get(id);
	const bilgi = dosyaBilgileri.get(id);
	if (!a || !a.url || !bilgi) return;
	const bag = el('a');
	bag.href = a.url;
	bag.download = bilgi.ad;
	bag.rel = 'noopener';
	document.body.append(bag);
	bag.click();
	bag.remove();
}

// Küçük resimler kendiliğinden (en fazla ikisi aynı anda) alınıp sohbette gösterilir.
const onizlemeKuyrugu = [];
let onizlemeSuruyor = 0;
function onizlemeIste(id) {
	if (onizlemeKuyrugu.includes(id) || indirmeler.has(id) || alinanlar.has(id)) return;
	onizlemeKuyrugu.push(id);
	setTimeout(onizlemeSirasi, 0);
}
function onizlemeSirasi() {
	while (onizlemeSuruyor < 2 && onizlemeKuyrugu.length) {
		const id = onizlemeKuyrugu.shift();
		if (indirmeler.has(id) || alinanlar.has(id) || !sunulanlar.has(id)) continue;
		onizlemeSuruyor++;
		dosyaIndir(id, { onizleme: true }).finally(() => {
			const bekle = () => {
				if (indirmeler.has(id)) return setTimeout(bekle, 300);
				onizlemeSuruyor--;
				onizlemeSirasi();
			};
			bekle();
		});
	}
}

// --- ilerleme, hız, aktarım paneli

function hizBaslat(akt, bayt) {
	akt.hizOlcum = { zaman: Date.now(), bayt };
	akt.hiz = 0;
	akt.ilerleme = bayt;
}

function ilerlemeGuncelle(akt, bayt, hemen = false) {
	akt.ilerleme = bayt;
	const simdi = Date.now();
	const o = akt.hizOlcum;
	if (o && simdi - o.zaman >= 1000) {
		const anlik = ((bayt - o.bayt) * 1000) / (simdi - o.zaman);
		akt.hiz = akt.hiz ? akt.hiz * 0.6 + anlik * 0.4 : anlik;
		akt.hizOlcum = { zaman: simdi, bayt };
	}
	if (!hemen && simdi - (akt.cizimZamani || 0) < 250) return;
	akt.cizimZamani = simdi;
	if (akt.yon === 'gelen') kartIlerlemesi(akt);
	aktarimSatiriGuncelle(akt);
}

function aktarimMetni(akt) {
	const yuzde = akt.boyut ? Math.floor((akt.ilerleme / akt.boyut) * 100) : 0;
	if (akt.durum === 'baglaniyor' && akt.yon === 'gelen') return akt.alinan ? `%${yuzde} · yeniden bağlanıyor…` : 'bağlanıyor…';
	if (akt.durum === 'bekliyor') return `%${yuzde} · ${akt.sonHata || 'koptu'}; bekleniyor…`;
	const parcalar = [`%${yuzde}`, `${boyutYaz(akt.ilerleme)} / ${boyutYaz(akt.boyut)}`];
	if (akt.hiz > 0) {
		parcalar.push(boyutYaz(akt.hiz) + '/sn');
		const kalan = (akt.boyut - akt.ilerleme) / akt.hiz;
		if (kalan > 5) parcalar.push(`~${sureYaz(kalan)} kaldı`);
	}
	const bag = akt.bag;
	if (bag && bag.turn) parcalar.push('TURN');
	return parcalar.join(' · ');
}

const aktarimSatirlari = new Map(); // aktarım -> satır öğeleri
function aktarimlariCiz() {
	const kap = $('aktarimlar');
	if (!kap) return;
	const liste = [...indirmeler.values()].filter((a) => !a.onizleme).concat([...gonderimler]);
	for (const [akt, s] of aktarimSatirlari) {
		if (!liste.includes(akt)) {
			s.kok.remove();
			aktarimSatirlari.delete(akt);
		}
	}
	for (const akt of liste) {
		if (aktarimSatirlari.has(akt)) continue;
		const kok = el('div', 'aktarim ' + akt.yon);
		const isaret = el('span', 'aktarim-isaret');
		isaret.append(ikon(akt.yon === 'gelen' ? 'indir' : 'yukari'));
		const bilgi = el('div', 'aktarim-bilgi');
		const ust = el('div', 'aktarim-ust');
		ust.append(el('b', null, akt.ad), el('span', 'aktarim-kisi', akt.yon === 'gelen' ? `← ${akt.kisi}` : `→ ${akt.kisi}`));
		const metin = el('small', 'aktarim-metin');
		const cubuk = el('div', 'ilerleme');
		const dolgu = el('div');
		cubuk.append(dolgu);
		bilgi.append(ust, cubuk, metin);
		const iptal = el('button', 'aktarim-iptal');
		iptal.type = 'button';
		iptal.title = 'Aktarımı durdur';
		iptal.setAttribute('aria-label', akt.ad + ' aktarımını durdur');
		iptal.append(ikon('x'));
		iptal.onclick = () => (akt.yon === 'gelen' ? indirmeBitti(akt, '') : gonderimiIptalEt(akt));
		kok.append(isaret, bilgi, iptal);
		kap.append(kok);
		aktarimSatirlari.set(akt, { kok, metin, dolgu });
	}
	kap.hidden = !liste.length;
	for (const akt of liste) aktarimSatiriGuncelle(akt);
}
function aktarimSatiriGuncelle(akt) {
	const s = aktarimSatirlari.get(akt);
	if (!s) return;
	s.metin.textContent = aktarimMetni(akt);
	s.dolgu.style.width = (akt.boyut ? Math.min(100, (akt.ilerleme / akt.boyut) * 100) : 0).toFixed(1) + '%';
}

// Gönderim ya da indirme sürerken sayfa kapatılmak istenirse uyar.
let kapanisDinleyici = null;
function kapanisUyarisi() {
	const suruyor = gonderimler.size > 0 || [...indirmeler.values()].some((a) => !a.onizleme);
	if (suruyor && !kapanisDinleyici) {
		kapanisDinleyici = (e) => {
			e.preventDefault();
			e.returnValue = '';
		};
		window.addEventListener('beforeunload', kapanisDinleyici);
	} else if (!suruyor && kapanisDinleyici) {
		window.removeEventListener('beforeunload', kapanisDinleyici);
		kapanisDinleyici = null;
	}
}

// --- sohbetteki P2P dosya kartı

function p2pDosyaElemani(dosya, sahip) {
	dosyaBilgileri.set(dosya.id, { id: dosya.id, ad: dosya.ad || 'dosya', boyut: Number(dosya.boyut) || 0, tur: dosya.tur || '', sahip });
	const kap = el('div', 'p2p-dosya');
	kap.dataset.dosya = dosya.id;
	p2pDosyaCiz(kap);
	return kap;
}

// id verilirse yalnızca o dosyanın kartları, verilmezse tüm P2P kartlar yeniden çizilir (durumu
// değişmeyen kart dokunulmadan kalır: önizleme titremesin).
function dosyaKartlariniGuncelle(id) {
	const kok = $('mesajlar');
	if (!kok) return;
	const secici = id ? `.p2p-dosya[data-dosya="${id}"]` : '.p2p-dosya';
	for (const kap of kok.querySelectorAll(secici)) p2pDosyaCiz(kap);
}

function p2pDosyaCiz(kap) {
	const id = kap.dataset.dosya;
	const b = dosyaBilgileri.get(id);
	if (!b) return;
	const benim = b.sahip === benimAdim;
	const yerel = benim ? paylasimlarim.get(id) : null;
	const alinan = alinanlar.get(id);
	const akt = indirmeler.get(id);
	const sunuluyor = sunulanlar.has(id);
	const uz = dosyaUzanti(b.ad);
	const resim = ONIZLEME.includes(uz);
	const medya = resim || SES_TURLERI.includes(uz) || VIDEO_TURLERI.includes(uz);
	let url = alinan && alinan.url ? alinan.url : '';
	if (!url && yerel && medya) url = yerelUrl(id, yerel);
	if (!url && resim && !benim && sunuluyor && !akt && b.boyut <= ONIZLEME_SINIRI && !onizlemeHatalari.has(id)) onizlemeIste(id);
	const gorunenAkt = akt && !akt.onizleme ? akt : null;
	const anahtar = [benim ? 1 : 0, yerel ? 1 : 0, url ? 1 : 0, alinan ? 1 : 0, gorunenAkt ? 1 : 0, akt && akt.onizleme ? 1 : 0, sunuluyor ? 1 : 0].join('');
	if (kap.dataset.anahtar === anahtar) return;
	kap.dataset.anahtar = anahtar;
	kap.replaceChildren();

	if (url) {
		if (resim) {
			const a = el('a');
			a.href = url;
			a.target = '_blank';
			a.rel = 'noopener';
			const img = el('img', 'onizleme');
			img.src = url;
			img.alt = b.ad;
			img.addEventListener('load', () => {
				if (dibeYapisik) dibeKaydir();
			});
			a.addEventListener('click', (e) => {
				if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
				e.preventDefault();
				buyutecAc(url, b.ad);
			});
			a.append(img);
			kap.append(a);
		} else if (SES_TURLERI.includes(uz)) {
			const a = el('audio', 'onizleme');
			a.controls = true;
			a.preload = 'metadata';
			a.src = url;
			kap.append(a);
		} else if (VIDEO_TURLERI.includes(uz)) {
			const v = el('video', 'onizleme');
			v.controls = true;
			v.preload = 'metadata';
			v.playsInline = true;
			v.src = url;
			kap.append(v);
		}
	} else if (resim && akt && akt.onizleme) {
		kap.append(el('div', 'onizleme-bekle', 'Önizleme alınıyor…'));
	}

	const kart = el('div', 'dosya-kart p2p');
	const sol = el('span', 'dosya-ikon');
	sol.append(ikon('dosya'));
	const bilgi = el('span', 'dosya-bilgi');
	bilgi.append(el('b', null, b.ad));
	const alt = el('small', 'dosya-durum');
	const dugmeler = el('span', 'dosya-dugmeler');
	const dugme = (metin, fn, sinif = '') => {
		const d = el('button', 'dosya-dugme' + (sinif ? ' ' + sinif : ''), metin);
		d.type = 'button';
		d.onclick = fn;
		dugmeler.append(d);
		return d;
	};
	const nokta = (acik) => el('span', 'dosya-nokta' + (acik ? ' acik' : ''));
	if (gorunenAkt) {
		alt.append(document.createTextNode(boyutYaz(b.boyut) + ' · '), el('span', 'dosya-ilerleme-metin', aktarimMetni(gorunenAkt)));
		const cubuk = el('div', 'ilerleme');
		cubuk.append(el('div'));
		bilgi.append(alt, cubuk);
		dugme('İptal', () => indirmeBitti(gorunenAkt, ''), 'ikincil');
	} else if (benim) {
		alt.append(nokta(!!yerel), document.createTextNode(boyutYaz(b.boyut) + (yerel ? ' · senin paylaşımın; sayfan açıkken indirilebilir' : ' · bu sekmede artık sunulmuyor')));
		bilgi.append(alt);
		if (yerel) dugme('Paylaşımı durdur', () => paylasimiBirak(id), 'ikincil');
		else dugme('Yeniden paylaş', () => yenidenPaylas(id));
	} else if (alinan) {
		alt.append(document.createTextNode(boyutYaz(b.boyut) + (alinan.disk ? ' · indirildi, kaydedildi' : alinan.onizleme ? ' · paylaşandan doğrudan alındı' : ' · indirildi')));
		bilgi.append(alt);
		if (alinan.url && !alinan.disk) dugme('Kaydet', () => dosyayiKaydet(id));
	} else {
		alt.append(nokta(sunuluyor), document.createTextNode(boyutYaz(b.boyut) + (sunuluyor ? ` · ${b.sahip} çevrimiçi, doğrudan alınır` : ` · ${b.sahip} şu an sunmuyor`)));
		bilgi.append(alt);
		const d = dugme('İndir', () => dosyaIndir(id));
		d.disabled = !sunuluyor || !bagliyim;
		if (!sunuluyor) d.title = 'Paylaşan sayfasını açınca indirilebilir';
	}
	kart.append(sol, bilgi, dugmeler);
	kap.append(kart);
	if (gorunenAkt) kartIlerlemesi(gorunenAkt);
}

function kartIlerlemesi(akt) {
	const kok = $('mesajlar');
	if (!kok || akt.onizleme) return;
	for (const kap of kok.querySelectorAll(`.p2p-dosya[data-dosya="${akt.id}"]`)) {
		const metin = kap.querySelector('.dosya-ilerleme-metin');
		if (metin) metin.textContent = aktarimMetni(akt);
		const dolgu = kap.querySelector('.ilerleme > div');
		if (dolgu) dolgu.style.width = (akt.boyut ? Math.min(100, (akt.ilerleme / akt.boyut) * 100) : 0).toFixed(1) + '%';
	}
}

// --- resim büyüteci
// Resim ekrana sığdırılarak açılır. Ekrandan büyükse resme dokunmak/tıklamak (ya da büyüteç
// düğmesi) tam genişliğe geçirir; uzun resim aşağı kaydırılarak gezilir. Sığdırılınca incecik bir
// şerit kalacak uzun resimler (uzun ekran görüntüsü, dikey panorama) doğrudan tam genişlikte
// açılır. Boşluğa dokunmak, ✕, Esc ya da telefonda geri tuşu kapatır.
let buyutecTam = null; // null: karar resim yüklenince verilir
// Geçmişe bu sayfada eklenen büyüteç girdisi (yalnızca kendi eklediğimiz geri alınır: büyüteç açıkken
// sayfa yenilenmişse eski girdiye "geri" gitmek sayfayı baştan yüklerdi).
let buyutecGecmisi = false;
try {
	if (history.state && history.state.buyutec) history.replaceState(null, '');
} catch {}

function buyutecDuzenle(ilk) {
	const r = $('buyutec-resim');
	const kap = $('buyutec-kaydir');
	if (!r.naturalWidth || !r.naturalHeight) return;
	const stil = getComputedStyle(kap);
	const dolgu = (a, b) => (parseFloat(stil[a]) || 0) + (parseFloat(stil[b]) || 0);
	const genis = Math.max(1, kap.clientWidth - dolgu('paddingLeft', 'paddingRight'));
	const yuksek = Math.max(1, kap.clientHeight - dolgu('paddingTop', 'paddingBottom'));
	const sigdir = Math.min(1, genis / r.naturalWidth, yuksek / r.naturalHeight);
	const tam = Math.min(1, genis / r.naturalWidth);
	const buyuyebilir = tam > sigdir * 1.15;
	// Sığdırınca 280 px'ten ve tam genişliğin yarısından dar kalan uzun resim: tam genişlikte aç.
	if (ilk) buyutecTam = buyuyebilir && r.naturalWidth * sigdir < Math.min(280, r.naturalWidth * tam * 0.5);
	if (!buyuyebilir) buyutecTam = false;
	$('buyutec').classList.toggle('buyuyebilir', buyuyebilir);
	$('buyutec').classList.toggle('tam', !!buyutecTam);
	$('buyutec-boy').hidden = !buyuyebilir;
	ikonKoy($('buyutec-boy'), buyutecTam ? 'kucult' : 'buyut');
	$('buyutec-boy').setAttribute('aria-label', buyutecTam ? 'Ekrana sığdır' : 'Tam boy göster');
}

function buyutecAc(url, ad) {
	const r = $('buyutec-resim');
	buyutecTam = null;
	$('buyutec').classList.remove('tam', 'buyuyebilir');
	$('buyutec-boy').hidden = true;
	r.alt = ad || '';
	r.src = url;
	$('buyutec-ac').href = url;
	$('buyutec').hidden = false;
	$('buyutec-kaydir').scrollTop = 0;
	if (r.complete && r.naturalWidth) buyutecDuzenle(true);
	try {
		$('buyutec-kapat').focus({ preventScroll: true });
	} catch {}
	// Telefonda geri tuşu siteden çıkmasın, büyüteci kapatsın.
	try {
		if (!buyutecGecmisi) {
			history.pushState({ buyutec: true }, '');
			buyutecGecmisi = true;
		}
	} catch {}
}
$('buyutec-resim').addEventListener('load', () => {
	if (!$('buyutec').hidden && buyutecTam === null) buyutecDuzenle(true);
});

function buyutecKapat(gecmistenGeldi = false) {
	if ($('buyutec').hidden) return;
	$('buyutec').hidden = true;
	$('buyutec-resim').removeAttribute('src');
	$('buyutec-ac').removeAttribute('href');
	buyutecTam = null;
	if ($('buyutec').contains(document.activeElement)) document.activeElement.blur();
	if (gecmistenGeldi || !buyutecGecmisi) return;
	buyutecGecmisi = false;
	try {
		history.back();
	} catch {}
}
window.addEventListener('popstate', () => {
	buyutecGecmisi = false;
	buyutecKapat(true);
});

// Sığdır ↔ tam genişlik. Tıklanan nokta tam genişlikte de parmağın/imlecin altında kalır.
function buyutecBoyDegistir(olay) {
	if (!$('buyutec').classList.contains('buyuyebilir')) return false;
	const r = $('buyutec-resim');
	const kap = $('buyutec-kaydir');
	const once = r.getBoundingClientRect();
	const oran = olay && once.height ? Math.min(1, Math.max(0, (olay.clientY - once.top) / once.height)) : 0;
	buyutecTam = !buyutecTam;
	buyutecDuzenle(false);
	if (!buyutecTam || !olay) {
		kap.scrollTop = 0;
		return true;
	}
	const sonra = r.getBoundingClientRect();
	const kapUst = kap.getBoundingClientRect().top;
	kap.scrollTop = Math.max(0, kap.scrollTop + sonra.top - kapUst + oran * sonra.height - (olay.clientY - kapUst));
	return true;
}
$('buyutec-kaydir').addEventListener('click', (e) => {
	const kap = $('buyutec-kaydir');
	// Kaydırma çubuğuna tıklamak kapatmasın.
	if (e.target === kap && (e.offsetX >= kap.clientWidth || e.offsetY >= kap.clientHeight)) return;
	if (e.target === $('buyutec-resim') && buyutecBoyDegistir(e)) return;
	buyutecKapat();
});
$('buyutec-boy').addEventListener('click', () => buyutecBoyDegistir(null));
$('buyutec-kapat').addEventListener('click', () => buyutecKapat());
window.addEventListener('resize', () => {
	if (!$('buyutec').hidden) buyutecDuzenle(false);
});

// ---------------------------------------------------------------- sesli kanal: mikrofon

const mikSessizMi = () => ayar.mikKapali || ayar.sagir || !gidenIz;

function mikKisitlari() {
	const k = {
		echoCancellation: ayar.yanki,
		noiseSuppression: ayar.gurultu,
		autoGainControl: ayar.kazanc,
		channelCount: { ideal: 1 },
		sampleRate: { ideal: 48000 },
	};
	if (ayar.mikId) k.deviceId = { exact: ayar.mikId };
	return k;
}

function mikHataMetni(h) {
	const ad = h && h.name;
	if (ad === 'NotFoundError' || ad === 'OverconstrainedError') return 'Mikrofon bulunamadı';
	if (ad === 'NotReadableError') return 'Mikrofon başka bir uygulamada kullanılıyor';
	if (ad === 'NotAllowedError' || ad === 'SecurityError') return 'Mikrofon izni verilmedi';
	return 'Mikrofon açılamadı';
}

async function mikrofonAc() {
	if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('desteklenmiyor'), { name: 'NotSupportedError' });
	try {
		return await navigator.mediaDevices.getUserMedia({ audio: mikKisitlari() });
	} catch (h) {
		// Seçili mikrofon çıkarılmış: varsayılanla dene.
		if (h && (h.name === 'OverconstrainedError' || h.name === 'NotFoundError') && ayar.mikId) {
			ayar.mikId = '';
			ayarKaydet();
			return navigator.mediaDevices.getUserMedia({ audio: mikKisitlari() });
		}
		throw h;
	}
}

// Mikrofonu hazırla (yoksa al). Alınamazsa kanala yalnızca dinleyici olarak girilir.
async function mikrofonHazirla() {
	if (mikrofon && mikrofon.getAudioTracks().some((t) => t.readyState === 'live')) return true;
	mikrofonuBirak();
	try {
		const akis = await mikrofonAc();
		mikrofonuKullan(akis);
		return true;
	} catch (h) {
		mikHatasi = mikHataMetni(h);
		gidenIzKur();
		return false;
	}
}

function mikrofonuKullan(akis) {
	const eski = mikrofon;
	mikrofon = akis;
	mikHatasi = '';
	const iz = akis.getAudioTracks()[0];
	if (iz) {
		try {
			iz.contentHint = 'speech';
		} catch {}
		iz.addEventListener('ended', () => {
			if (mikrofon === akis) mikrofonBitti();
		});
	}
	gidenIzKur();
	if (eski && eski !== akis) eski.getTracks().forEach((t) => t.stop());
}

function mikrofonuBirak() {
	islemiKapat();
	if (mikrofon) mikrofon.getTracks().forEach((t) => t.stop());
	mikrofon = null;
	gidenIz = null;
	if (kendiOlcer) kendiOlcer.dur();
	kendiOlcer = null;
}

// Mikrofon izi kendiliğinden bittiyse (aygıt çıkarıldı, telefon araması, izin geri alındı):
// yeniden almayı dene; eşlere yeni iz bağlanır, yeniden anlaşma gerekmez.
let mikKurtariliyor = false;
function mikrofonBitti() {
	if (mikKurtariliyor || (!sesKanal && !sesGiriliyor)) return;
	if (sesKanal && mikBirakilsin()) {
		// Susturulmuşken zaten bırakılacaktı: yeniden alma, açınca alınır.
		mikrofonuBirak();
		mikBirakildi = true;
		gidenIzKur();
		return;
	}
	mikKurtariliyor = true;
	durum('Mikrofon bağlantısı kesildi; yeniden alınıyor…', true);
	setTimeout(async () => {
		try {
			if (!sesKanal) return;
			const akis = await mikrofonAc();
			if (!sesKanal) {
				akis.getTracks().forEach((t) => t.stop());
				return;
			}
			mikrofonuKullan(akis);
			durum('Mikrofon yeniden bağlandı.');
		} catch (h) {
			mikrofonuBirak();
			mikHatasi = mikHataMetni(h);
			gidenIzKur();
			durum(mikHatasi + '; yalnızca dinliyorsun.', true);
		} finally {
			mikKurtariliyor = false;
			sesUyarisiCiz();
			gonder({ type: 'sessiz', sessiz: mikSessizMi(), sagir: ayar.sagir });
		}
	}, 500);
}

function islemiKapat() {
	if (!mikIslem) return;
	try {
		mikIslem.kaynak.disconnect();
		mikIslem.kazanc.disconnect();
	} catch {}
	mikIslem = null;
}

// Eşlere gidecek izi hazırla: mikrofon seviyesi %100 ise mikrofon izinin kendisi (en sağlam yol),
// değilse WebAudio kazancından geçen iz. Yankı/gürültü giderme mikrofonda (yakalamada) uygulanır,
// WebAudio'dan sonra kapanmaz.
function gidenIzKur() {
	const mikIz = mikrofon && mikrofon.getAudioTracks()[0];
	let iz = mikIz || null;
	// Ses bağlamı çalışmıyorsa (kullanıcı etkileşimi olmadan açıldı, iOS arka plana aldı) kazanç
	// zinciri SESSİZLİK üretir: o durumda ham mikrofon izi gönderilir, bağlam açılınca zincir kurulur.
	const ac = mikIz && ayar.mikSeviye !== 100 ? sesBaglami() : null;
	if (mikIz && ayar.mikSeviye !== 100 && ac && ac.state === 'running') {
		if (mikIslem && mikIslem.akis === mikrofon) {
			mikIslem.kazanc.gain.value = ayar.mikSeviye / 100;
			iz = mikIslem.iz;
		} else if (ac.createMediaStreamDestination) {
			islemiKapat();
			try {
				const kaynak = ac.createMediaStreamSource(mikrofon);
				const kazanc = ac.createGain();
				kazanc.gain.value = ayar.mikSeviye / 100;
				const hedef = ac.createMediaStreamDestination();
				kaynak.connect(kazanc);
				kazanc.connect(hedef);
				mikIslem = { kaynak, kazanc, hedef, akis: mikrofon, iz: hedef.stream.getAudioTracks()[0] };
				iz = mikIslem.iz;
			} catch {
				mikIslem = null;
			}
		}
	} else islemiKapat();
	gidenIz = iz;
	mikDurumuUygula();
	for (const es of esler.values()) esIzBagla(es);
	if (kendiOlcer) kendiOlcer.dur();
	kendiOlcer = sesKanal && mikrofon ? seviyeOlcer(mikIslem ? mikIslem.hedef.stream : mikrofon, kendiSeviye) : null;
	benSatiriCiz();
	sesUyarisiCiz();
}

function mikDurumuUygula() {
	const acik = !(ayar.mikKapali || ayar.sagir);
	if (gidenIz) gidenIz.enabled = acik;
	// Kazanç yolundayken ham iz de kapansın (tarayıcının "mikrofon kullanılıyor" ışığı doğru kalsın).
	if (mikrofon) for (const t of mikrofon.getAudioTracks()) t.enabled = acik;
}

// Susturulmuşken mikrofon bırakılsın mı (ayar.mikBirak; telefonda varsayılan). Telefon mikrofon açık
// oldukça görüşme kipindedir: Bluetooth kulaklık tek kanallı, 16 kHz görüşme profiline (HFP) geçer,
// çalan ses telefonun görüşme işlemlerinden (yankı bastırma vb.) geçer. Susturulmuş dinleyen bunlara
// katlanmasın: mikrofon tamamen kapanır, paylaşılan müzik tam kalitede çalar.
const mikBirakilsin = () => ayar.mikBirak && (ayar.mikKapali || ayar.sagir);

// Susturma/sağırlaştırma değişti: gerekiyorsa mikrofonu bırak ya da yeniden al. Yeniden alırken
// (izin çoktan verildi, birkaç yüz ms) yeniden susturulursa sonunda yine bırakılır.
function mikBirakmayiUygula() {
	if (!sesKanal) return;
	if (mikBirakilsin()) {
		if (!mikrofon) return;
		mikrofonuBirak();
		mikBirakildi = true;
		gidenIzKur();
		mikDugmeleriCiz();
		return;
	}
	if (!mikBirakildi || mikAliniyor) return;
	mikAliniyor = mikYenidenAl();
	mikDugmeleriCiz();
}
async function mikYenidenAl() {
	const tamam = await mikrofonHazirla();
	mikAliniyor = null;
	if (!sesKanal) {
		mikrofonuBirak();
		return;
	}
	if (mikBirakilsin()) {
		// Alınırken yeniden susturuldu.
		if (mikrofon) {
			mikrofonuBirak();
			gidenIzKur();
		}
		mikDugmeleriCiz();
		return;
	}
	mikBirakildi = false;
	if (!tamam) durum(mikHatasi + '; yalnızca dinliyorsun.', true);
	mikDurumuUygula();
	mikDugmeleriCiz();
	benSatiriCiz();
	sesUyarisiCiz();
	gonder({ type: 'sessiz', sessiz: mikSessizMi(), sagir: ayar.sagir });
}

function esIzBagla(es) {
	const tr = es.tr;
	if (!tr || !tr.sender || !es.pc || es.pc.signalingState === 'closed') return Promise.resolve();
	if (tr.sender.track === gidenIz) return Promise.resolve();
	return tr.sender
		.replaceTrack(gidenIz || null)
		.then(() => bitHiziAyarla(es))
		.catch((h) => console.warn('iz bağlanamadı', es.ad, h));
}

// ---------------------------------------------------------------- sesli kanal: giriş / çıkış

async function sesAc(kanal) {
	cekmeceleriKapat();
	if (sesKanal === kanal) {
		sesKartiAc();
		return;
	}
	if (sesGiriliyor) return; // çift tıklama: ikinci mikrofon akışı açılıp sızmasın
	if (!bagliyim) return durum('Sunucuya bağlanmadan sesli kanala girilmez.', true);
	sesGiriliyor = true;
	sesHedef = kanal;
	sesKilidiAc(); // ses bağlamını bu tıklamayla başlat (tarayıcı otomatik oynatma kuralı)
	if (mikBirakilsin()) {
		// Susturulmuş giriliyor ve susturulunca mikrofon bırakılıyor: mikrofon (telefonda görüşme kipi)
		// ancak açınca alınır.
		mikrofonuBirak();
		mikBirakildi = true;
	} else {
		mikBirakildi = false;
		const mikVar = await mikrofonHazirla();
		if (!mikVar) durum(mikHatasi + '; kanala yalnızca dinleyici olarak giriliyor.', true);
	}
	if (!bagliyim || sesHedef !== kanal) {
		sesGiriliyor = false;
		if (!sesKanal) mikrofonuBirak();
		return;
	}
	iceTazeMi();
	gonder({ type: 'ses-gir', kanal, sessiz: mikSessizMi(), sagir: ayar.sagir, yayin: yayinBilgisi() });
	// Yanıt gelmezse (bağlantı koptu) kilit açılsın.
	setTimeout(() => {
		if (sesGiriliyor && sesHedef === kanal) {
			sesGiriliyor = false;
			sesHedef = '';
			if (!sesKanal) mikrofonuBirak();
		}
	}, 10000);
}

function sesGirisiBasarisiz() {
	if (!sesGiriliyor && sesKanal) return;
	sesGiriliyor = false;
	sesHedef = '';
	if (!sesKanal) {
		// Yeniden bağlanırken kanal dolmuş ya da silinmiş olabilir: sesi tamamen kapat.
		sesKapat(false);
		mikrofonuBirak();
		mikDugmeleriCiz();
	}
}

function sesKatil(m) {
	const kanal = m.kanal;
	const devam = !!m.devam && sesKanal === kanal;
	if (m.ice) iceAyarla(m.ice);
	const yeniGiris = !devam && sesKanal !== kanal;
	sesGiriliyor = false;
	sesHedef = '';
	if (!devam) {
		// Yeni kanal ya da taze giriş: eski bağlantıların hepsi kapanır.
		for (const ad of [...esler.keys()]) esKapat(ad);
		konusanlar.clear();
	}
	sesKanal = kanal;
	const liste = new Set((m.kisiler || []).filter((a) => a && a !== benimAdim));
	if (devam) {
		// Listede olmayanlar belki birazdan geri dönecek (sunucu yeniden başladı): hemen kapatma.
		for (const es of esler.values()) if (!liste.has(es.ad) && !es.bekleniyor) es.bekleniyor = Date.now();
	}
	for (const ad of liste) esGirdi(ad, devam, false);
	sesArayuzuAc();
	if (!kendiOlcer && mikrofon) gidenIzKur();
	sesGozcuBaslat();
	taniBaslat();
	istatistikBaslat();
	kurtarmaBaslat();
	bitHizlariniAyarla();
	yayinlarCiz();
	if (yeniGiris) {
		durum(`${kanalAdi(kanal)} kanalına girdin.` + (mikHatasi ? ` (${mikHatasi}; yalnızca dinliyorsun)` : ''));
		sesCal('giris');
	}
}

function sesKapat(bildir = true) {
	if (bildir && bagliyim && (sesKanal || sesHedef)) gonder({ type: 'ses-cik' });
	const vardi = !!sesKanal;
	sesKanal = '';
	sesHedef = '';
	sesGiriliyor = false;
	for (const ad of [...esler.keys()]) esKapat(ad);
	konusanlar.clear();
	if (vardi) sesCal('cikis');
	mikrofonuBirak();
	mikBirakildi = false;
	yayinDurdur(false); // ekran paylaşımı (ekransız da) kanaldan çıkınca biter
	sesKaynagiKapat();
	sesArayuzuKapat();
	sesGozcuDurdur();
	taniDurdur();
	istatistikDurdur();
	kurtarmaDurdur();
	sesDevamKaydet();
	if (vardi && bildir) durum('Sesli kanaldan ayrıldın.');
}

$('ben-kapat').addEventListener('click', () => sesKapat());

function mikDegistir() {
	if (ayar.sagir) {
		// Sağırken mikrofonu açmak sağırlığı da kaldırır (Discord gibi).
		ayar.sagir = false;
		ayar.mikKapali = false;
	} else ayar.mikKapali = !ayar.mikKapali;
	ayarKaydet();
	sesDurumunuUygula();
	sesCal(ayar.mikKapali ? 'sessiz' : 'acik');
}
function sagirDegistir() {
	ayar.sagir = !ayar.sagir;
	ayarKaydet();
	sesDurumunuUygula();
	sesCal(ayar.sagir ? 'sessiz' : 'acik');
}
function sesDurumunuUygula() {
	mikDurumuUygula();
	mikBirakmayiUygula();
	for (const es of esler.values()) esSesUygula(es);
	mikDugmeleriCiz();
	benSatiriCiz();
	if (sesKanal) gonder({ type: 'sessiz', sessiz: mikSessizMi(), sagir: ayar.sagir });
}
$('ben-mikrofon').addEventListener('click', mikDegistir);
$('ben-sagir').addEventListener('click', sagirDegistir);
// Ses kartındaki kopyaları (telefonda kullanıcı kartı çekmecede kalıyor).
$('kart-mikrofon').addEventListener('click', mikDegistir);
$('kart-sagir').addEventListener('click', sagirDegistir);
$('kart-ayril').addEventListener('click', () => sesKapat());

function mikDugmeleriCiz() {
	const mikKapali = ayar.mikKapali || ayar.sagir;
	for (const d of [$('ben-mikrofon'), $('kart-mikrofon')]) {
		ikonKoy(d, mikKapali ? 'mik-kapali' : 'mik');
		d.classList.toggle('kapali', mikKapali);
		d.setAttribute('aria-pressed', String(mikKapali));
		d.title = mikKapali ? 'Mikrofonu aç (Ctrl+Shift+M)' : 'Mikrofonu kapat (Ctrl+Shift+M)';
		d.setAttribute('aria-label', mikKapali ? 'Mikrofonu aç' : 'Mikrofonu kapat');
	}
	for (const s of [$('ben-sagir'), $('kart-sagir')]) {
		ikonKoy(s, ayar.sagir ? 'kulaklik-kapali' : 'kulaklik');
		s.classList.toggle('kapali', ayar.sagir);
		s.setAttribute('aria-pressed', String(ayar.sagir));
		s.title = ayar.sagir ? 'Sesleri aç (Ctrl+Shift+D)' : 'Sağırlaştır: gelen sesleri kapat (Ctrl+Shift+D)';
		s.setAttribute('aria-label', ayar.sagir ? 'Sesleri aç' : 'Sağırlaştır');
	}
	let alt = 'çevrimiçi';
	if (sesKanal) {
		if (ayar.sagir) alt = 'sağırlaştırıldın';
		else if (mikAliniyor) alt = 'mikrofon açılıyor…';
		else if (ayar.mikKapali && (gidenIz || mikBirakildi)) alt = 'mikrofon kapalı';
		else alt = !gidenIz ? 'yalnızca dinliyorsun' : ayar.mikKapali ? 'mikrofon kapalı' : kanalAdi(sesKanal);
	} else if (sesGiriliyor) alt = 'bağlanıyor…';
	$('ben-alt').textContent = alt;
}

// ---------------------------------------------------------------- sesli kanal: eşler

const esSayisi = () => [...esler.values()].filter((e) => !e.bekleniyor).length;

function esYap(ad) {
	const es = {
		ad,
		teklifci: benimAdim > ad, // her çiftte teklifi adı büyük olan verir (çakışma olmaz)
		pc: null,
		oturum: '',
		tr: null,
		adaylar: [], // [{ oturum, aday }] — uzak açıklama gelmeden gelen ICE adayları
		kuyruk: Promise.resolve(),
		olusturma: Date.now(),
		sorunBasi: 0,
		kurtarma: 0,
		sonKurtarma: 0,
		sonYenile: 0,
		bekleniyor: 0, // listede yok ama geri dönmesi bekleniyor (zaman)
		seviye: 100,
		susturuldu: false,
		konusuyor: false,
		ses: null,
		olcer: null,
		// Yayın: tr = mikrofon kanalı, trSes = ekran paylaşımının sesi, trGoruntu = ekran görüntüsü.
		trSes: null,
		trGoruntu: null,
		izliyor: true, // o, benim ekranımı izliyor (görüntüyü kapatırsa ona gönderilmez; ses gider)
		izliyorum: true, // ben onun ekranını izliyorum
		yayinSeviye: 100, // paylaştığı sesin seviyesi, yalnızca bende
		yayinSusturuldu: false, // paylaştığı sesi kendim için susturdum
		yayinSesOgesi: null,
		yayinAkis: null, // paylaştığı sesin akışı (seviye ölçeri için)
		yayinOlcer: null,
		goruntuOgesi: null,
		uzakGoruntu: null,
	};
	const kayitliSeviye = Number(depoOku('ses-seviye-' + ad, '100'));
	if (Number.isFinite(kayitliSeviye) && kayitliSeviye >= 0 && kayitliSeviye <= 100) es.seviye = kayitliSeviye;
	const yayinSeviye = Number(depoOku('yayin-seviye-' + ad, '100'));
	if (Number.isFinite(yayinSeviye) && yayinSeviye >= 0 && yayinSeviye <= 100) es.yayinSeviye = yayinSeviye;
	es.susturuldu = depoOku('ses-sustur-' + ad, '') === '1';
	es.yayinSusturuldu = depoOku('yayin-sustur-' + ad, '') === '1';
	// Gelen sesin <audio>'su: görünmez ama çizilir (iOS display:none'u çalmıyor).
	const ses = el('audio', 'ses-akis');
	ses.autoplay = true;
	ses.setAttribute('playsinline', '');
	ses.setAttribute('webkit-playsinline', '');
	ses.controls = false;
	$('ses-akislari').append(ses);
	es.ses = ses;
	esSesUygula(es);
	return es;
}

// Eş kanala girdi (devam: bağlantılar sürüyor olabilir, yeniden kurma).
function esGirdi(ad, devam, bildir) {
	if (!ad || ad === benimAdim || !sesKanal) return;
	let es = esler.get(ad);
	if (es) es.bekleniyor = 0;
	if (es && devam && es.pc) {
		if (esSaglikli(es) || es.turnYenile) return esGeriDondu(es); // bağlantı sürüyor
		// Bağlantı var ama bozuk: teklif eden önce ICE'yi yeniler (DTLS korunur), olmazsa baştan
		// kurar; yanıtlayan teklif edenden ister.
		if (!es.teklifci) yenileIste(es, true);
		else if (es.pc.remoteDescription && es.pc.signalingState === 'stable') iceYenile(es);
		else esYenidenKur(es);
		return;
	}
	if (es && !devam) esKapat(ad);
	es = esler.get(ad) || esOlustur(ad);
	// Teklif eden bağlantıyı kurar; yanıtlayanın bağlantısı teklif gelince (onun oturumuyla) kurulur.
	if (!es.pc && es.teklifci) pcKur(es, '');
	// Yanıtlayan taraf: karşıda eski bir bağlantı kalmış olabilir; teklif istemeyi garantiye al.
	if (!es.teklifci && devam) yenileIste(es, true);
	if (bildir && !devam) sesCal('kisi-girdi');
	sesKartiOzetCiz();
	bitHizlariniAyarla();
}

function esOlustur(ad) {
	const es = esYap(ad);
	esler.set(ad, es);
	esKutusuOlustur(es);
	return es;
}

function esCikti(ad) {
	if (!esler.has(ad)) return;
	esKapat(ad);
	sesCal('kisi-cikti');
	sesKartiOzetCiz();
	bitHizlariniAyarla();
}

function pcKapat(es) {
	if (es.pc) {
		const pc = es.pc;
		es.pc = null;
		pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = pc.onnegotiationneeded = pc.onicecandidateerror = null;
		try {
			pc.close();
		} catch {}
	}
	es.tr = es.trSes = es.trGoruntu = null;
	if (es.olcer) es.olcer.dur();
	es.olcer = null;
	if (es.yayinOlcer) es.yayinOlcer.dur();
	es.yayinOlcer = null;
	es.yayinAkis = null;
	if (es.ses) es.ses.srcObject = null;
	if (es.yayinSesOgesi) es.yayinSesOgesi.srcObject = null;
	if (es.goruntuOgesi) es.goruntuOgesi.srcObject = null;
	es.uzakGoruntu = null;
	es.olcum = es.gidenOlcum = es.yayinOlcum = null;
	es.pencere = [];
	es.yayinPencere = [];
	es.cozulemeyen = {};
	yankiReferansGuncelle();
}

function esKapat(ad) {
	const es = esler.get(ad);
	if (!es) return;
	pcKapat(es);
	if (es.ses) es.ses.remove();
	if (es.yayinSesOgesi) es.yayinSesOgesi.remove();
	if (es.goruntuOgesi) es.goruntuOgesi.remove();
	if (es.kutu) es.kutu.remove();
	esler.delete(ad);
	konusmaGuncelle(ad, false);
	sesAcDugmesiGuncelle();
	yayinlarCiz();
	yankiReferansGuncelle();
}

// Eşe yeni bir RTCPeerConnection kur. Teklif eden yeni bir oturum kimliği üretir ve kanalları açar:
// sırasıyla mikrofon (izi varsa onunla), ekran paylaşımının sesi ve görüntüsü (paylaşım yokken boş
// durur, başlayınca yalnızca iz takılır, yeniden anlaşma gerekmez). Yanıtlayan,
// teklifteki oturum kimliğini alır ve kanalları teklifin kendisi oluşturur (önceden açılan kanal
// teklifin m-line'ıyla eşleşmiyor → tek yönlü ses).
function pcKur(es, oturum) {
	pcKapat(es);
	let pc;
	try {
		pc = new RTCPeerConnection(pcAyari());
	} catch (h) {
		console.warn('RTCPeerConnection kurulamadı', h);
		return;
	}
	es.pc = pc;
	es.sonTeklif = '';
	es.oturum = oturum || (es.teklifci ? rastgeleKimlik(12) : '');
	es.olusturma = Date.now();
	es.sorunBasi = Date.now();
	es.uzakAkis = null;
	es.pencere = [];
	pc.onicecandidate = (e) => {
		if (es.pc === pc && e.candidate) gonder({ type: 'ice', to: es.ad, ice: e.candidate, oturum: es.oturum });
	};
	pc.ontrack = (e) => {
		if (es.pc !== pc) return;
		const tur = izTuru(pc, e.transceiver, e.track);
		if (tur === 'goruntu') uzakGoruntuBagla(es, e.track);
		else if (tur === 'yayinSes') uzakYayinSesiBagla(es, e.track);
		else uzakSesBagla(es, e.track);
	};
	pc.onconnectionstatechange = () => {
		if (es.pc === pc) esDurumDegisti(es);
	};
	// ICE toplama hataları (STUN/TURN'e ulaşılamıyor, 701 vb.) teşhise yazılır.
	pc.onicecandidateerror = (e) => {
		if (es.pc === pc) taniGonder({ olay: 'ice-hata', es: es.ad, kod: e.errorCode, metin: e.errorText, url: e.url });
	};
	if (es.teklifci) {
		pc.onnegotiationneeded = () => {
			if (es.pc === pc) teklifVer(es);
		};
		try {
			es.tr = pc.addTransceiver(gidenIz || 'audio', { direction: 'sendrecv' });
			es.trSes = pc.addTransceiver(yayin.ses || 'audio', { direction: 'sendrecv' });
			es.trGoruntu = pc.addTransceiver(gidenGoruntu(es) || 'video', { direction: 'sendrecv' });
			kodekSirasiAyarla(es);
		} catch (h) {
			console.warn('ses kanalı açılamadı', h);
		}
	}
	esIstatistikYaz(es, 'bağlanıyor…', '');
}

// Eş bağlantısındaki kanallar sırasıyla: 1. ses = mikrofon, 2. ses = yayın sesi, görüntü = ekran.
// (Teklif edende ekleme sırası, yanıtlayanda teklifteki m-line sırası; ikisi aynıdır.)
function kanallariBul(pc) {
	const trler = pc.getTransceivers().filter((t) => t.receiver && t.receiver.track);
	const sesler = trler.filter((t) => t.receiver.track.kind === 'audio');
	return { mik: sesler[0] || null, ses: sesler[1] || null, goruntu: trler.find((t) => t.receiver.track.kind === 'video') || null };
}
function izTuru(pc, tr, iz) {
	if (iz && iz.kind === 'video') return 'goruntu';
	if (!tr) return 'mik';
	return kanallariBul(pc).ses === tr ? 'yayinSes' : 'mik';
}

function pcAyari() {
	const ayari = { iceServers: ice.iceServers || [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };
	// Teşhis: localStorage 'zorla-turn'=1 → yalnızca TURN (relay) adayları (NAT/TURN denemek için).
	if (depoOku('zorla-turn', '') === '1') ayari.iceTransportPolicy = 'relay';
	return ayari;
}

const esKapandi = (es) => !es.pc || es.pc.signalingState === 'closed';
function esSaglikli(es) {
	if (esKapandi(es)) return false;
	const d = es.pc.connectionState;
	if (d === 'connected') return true;
	return (d === 'new' || d === 'connecting') && Date.now() - es.olusturma < 15000;
}

async function teklifVer(es, iceYenidenBaslat = false) {
	const pc = es.pc;
	if (!pc || pc.signalingState !== 'stable' || !bagliyim) return;
	try {
		const teklif = await pc.createOffer(iceYenidenBaslat ? { iceRestart: true } : undefined);
		if (es.pc !== pc || pc.signalingState !== 'stable') return;
		await pc.setLocalDescription(teklif);
		es.teklifZamani = Date.now();
		gonder({ type: 'sdp', to: es.ad, sdp: pc.localDescription, oturum: es.oturum });
	} catch (h) {
		console.warn('teklif', es.ad, h);
		taniGonder({ olay: 'teklif-hata', es: es.ad, metin: String((h && h.message) || h).slice(0, 160) });
	}
}

function sdpGeldi(ad, sdp, oturum) {
	if (!sesKanal || !ad || !sdp || !sdp.type) return;
	const es = esler.get(ad) || esOlustur(ad);
	es.bekleniyor = 0;
	// Aynı kişiden art arda gelen açıklamalar sırayla işlensin.
	es.kuyruk = es.kuyruk
		.then(() => sdpIsle(es, sdp, String(oturum || '')))
		.catch((h) => {
			console.warn('sdp', ad, h);
			taniGonder({ olay: 'sdp-hata', es: ad, tur: sdp.type, metin: String((h && h.message) || h).slice(0, 200) });
		});
}

async function sdpIsle(es, sdp, oturum) {
	if (esler.get(es.ad) !== es) return;
	if (sdp.type === 'offer') {
		if (es.teklifci) return; // bu çiftte teklif veren biziz; karşıdan teklif beklenmez
		// Yeni oturum (karşı taraf bağlantıyı sıfırdan kurdu) → biz de sıfırdan kurarız.
		if (esKapandi(es) || es.oturum !== oturum) pcKur(es, oturum);
		const pc = es.pc;
		if (!pc) return;
		// Aynı teklif yeniden geldi (yanıtımız kayboldu ya da iki istek çakıştı): yeniden UYGULAMA,
		// yanıtı yinele. Aynı ICE yenileme teklifini ikinci kez uygulamak, yeni aday çifti seçildiği
		// halde sesin akmamasına yol açıyordu.
		if (es.sonTeklif === sdp.sdp && pc.signalingState === 'stable' && pc.localDescription && pc.localDescription.type === 'answer') {
			gonder({ type: 'sdp', to: es.ad, sdp: pc.localDescription, oturum: es.oturum });
			return;
		}
		if (pc.signalingState !== 'stable') {
			// Yarım kalmış bir anlaşma: geri al ve yeni teklifi uygula.
			try {
				await pc.setLocalDescription({ type: 'rollback' });
			} catch {
				pcKur(es, oturum);
			}
		}
		pcSunuculariniTazele(es.pc);
		await es.pc.setRemoteDescription({ type: 'offer', sdp: opusAyarla(sdp.sdp) });
		es.sonTeklif = sdp.sdp;
		await adaylariUygula(es);
		// Teklifin m-line'larına bağlanan kanallar: yönü sendrecv yap ve gönderilecek izleri bağla
		// (mikrofon; ekran paylaşımının sesi; ekran gösteriliyorsa ve o izliyorsa görüntü). ÖNEMLİ: izi
		// bağlamadan yanıt üretilirse Firefox "recvonly" yanıt verip sesi tek yöne düşürüyor.
		const k = kanallariBul(es.pc);
		if (!k.mik || !k.ses || !k.goruntu) throw new Error('teklifte mikrofon, yayın sesi ve görüntü kanalları yok');
		const bagla = async (t, iz) => {
			try {
				t.direction = 'sendrecv';
			} catch {}
			if (t.sender.track !== iz) await t.sender.replaceTrack(iz || null).catch(() => {});
		};
		es.tr = k.mik;
		es.trSes = k.ses;
		es.trGoruntu = k.goruntu;
		// Yanıttaki kodek sırası: karşı taraf bize bu sırayla gönderir (RED önde: kayıplara karşı yedek).
		kodekSirasiAyarla(es);
		await bagla(k.mik, gidenIz);
		await bagla(k.ses, yayin.ses);
		await bagla(k.goruntu, gidenGoruntu(es));
		const yanit = await es.pc.createAnswer();
		await es.pc.setLocalDescription(yanit);
		gonder({ type: 'sdp', to: es.ad, sdp: es.pc.localDescription, oturum: es.oturum });
		bitHiziAyarla(es);
		taniGonder({ olay: 'yanit', es: es.ad, yon: k.mik.direction, mid: k.mik.mid != null ? String(k.mik.mid) : null, iz: !!k.mik.sender.track });
	} else if (sdp.type === 'answer') {
		const pc = es.pc;
		// Başka bir (eski) bağlantının yanıtı ise yok say.
		if (!es.teklifci || !pc || es.oturum !== oturum || pc.signalingState !== 'have-local-offer') return;
		try {
			await pc.setRemoteDescription({ type: 'answer', sdp: opusAyarla(sdp.sdp) });
		} catch (h) {
			// Yanıt uygulanamadı (ör. karşı taraf bağlantıyı sıfırdan kurdu, DTLS parmak izi değişti):
			// bağlantıyı baştan kur.
			esYenidenKur(es);
			throw h;
		}
		await adaylariUygula(es);
		bitHiziAyarla(es);
		const tr = es.tr;
		if (tr && tr.currentDirection && tr.currentDirection !== 'sendrecv') {
			taniGonder({ olay: 'tek-yon-yanit', es: es.ad, anlasilan: tr.currentDirection });
		}
	}
}

async function adaylariUygula(es) {
	const pc = es.pc;
	if (!pc || !pc.remoteDescription) return;
	const bekleyen = es.adaylar.splice(0);
	for (const { oturum, aday } of bekleyen) {
		if (oturum !== es.oturum) continue; // başka bir (eski) bağlantının adayı
		await pc.addIceCandidate(aday).catch(() => {});
	}
}

function iceGeldi(ad, aday, oturum) {
	const es = esler.get(ad);
	if (!es || !aday) return;
	oturum = String(oturum || '');
	if (es.pc && es.oturum === oturum && es.pc.remoteDescription) {
		es.pc.addIceCandidate(aday).catch(() => {});
	} else if (es.adaylar.length < 200) {
		// Uzak açıklama ya da yeni oturumun bağlantısı henüz kurulmadı: sakla.
		es.adaylar.push({ oturum, aday });
	}
}

// Yanıtlayan taraf "bağlantımız bozuk / bende yok" diyor (yalnızca teklif eden alır).
function yenileGeldi(ad, oturum) {
	if (!sesKanal || !ad || ad === benimAdim) return;
	const es = esler.get(ad) || esOlustur(ad);
	es.bekleniyor = 0;
	if (!es.teklifci) return;
	oturum = String(oturum || '');
	const pc = es.pc;
	if (pc && !esKapandi(es) && pc.signalingState === 'have-local-offer' && pc.localDescription) {
		// Teklifimiz zaten yolda (iki taraf aynı anda davrandı ya da teklif kayboldu): aynısını yinele.
		// Burada baştan kurmak, süren ICE yenilemesini yarıda keserdi.
		gonder({ type: 'sdp', to: es.ad, sdp: pc.localDescription, oturum: es.oturum });
		return;
	}
	if (pc && !esKapandi(es) && oturum && oturum === es.oturum && pc.remoteDescription && pc.signalingState === 'stable' && es.kurtarma < 2) {
		// Aynı bağlantı, karşıda sorun var: ICE'yi yenile (DTLS ve ses bağlantısı korunur).
		es.kurtarma++;
		es.sonKurtarma = Date.now();
		iceYenile(es);
		return;
	}
	// Karşı tarafta bağlantı yok (sayfa yenilendi) ya da ICE yenilemesi tutmadı: baştan kur.
	esYenidenKur(es);
}

function yenileIste(es, zorla) {
	if (!bagliyim || es.teklifci) return;
	const simdi = Date.now();
	if (!zorla && simdi - es.sonYenile < 6000) return;
	es.sonYenile = simdi;
	gonder({ type: 'yenile', to: es.ad, oturum: es.oturum || '' });
}

// Teklif eden: bağlantıyı yeni oturumla baştan kur (yeni teklif negotiationneeded ile gider).
function esYenidenKur(es) {
	if (!es.teklifci || !sesKanal) return;
	taniGonder({ olay: 'yeniden-kur', es: es.ad, eski: es.oturum });
	pcKur(es, '');
	esIzBagla(es);
}

// Eş kanalda göründü (geri döndü): bekleyen işleri şimdi yap.
function esGeriDondu(es) {
	if (!es.pc) return;
	if (es.turnYenile) {
		// Yalnızca teklif eden davranır: iki taraf birden davranınca aynı ICE yenileme teklifi iki kez
		// uygulanıyor, yeni aday çifti seçildiği halde ses akmıyordu. Yanıtlayan, bağlantı gerçekten
		// bozulursa kurtarma döngüsüyle ister.
		es.turnYenile = false;
		if (es.teklifci) {
			taniGonder({ olay: 'turn-yenilendi', es: es.ad });
			iceYenile(es);
		}
		return;
	}
	// O yokken gönderdiğimiz teklif sunucuda düştü: yinele.
	if (es.teklifci && es.pc.signalingState === 'have-local-offer' && es.pc.localDescription) {
		es.teklifZamani = Date.now();
		gonder({ type: 'sdp', to: es.ad, sdp: es.pc.localDescription, oturum: es.oturum });
	}
}

function pcSunuculariniTazele(pc) {
	if (!pc || pc.signalingState === 'closed' || !(ice.iceServers || []).length) return;
	try {
		pc.setConfiguration({ ...pc.getConfiguration(), iceServers: ice.iceServers });
	} catch {}
}

// ICE takıldıysa yeni adaylarla (taze TURN şifresiyle) yeniden dene; DTLS/ses bağlantısı korunur.
function iceYenile(es) {
	const pc = es.pc;
	if (!pc || pc.signalingState !== 'stable' || !es.teklifci) return;
	pcSunuculariniTazele(pc);
	esIstatistikYaz(es, 'bağlantı yenileniyor…', 'orta');
	taniGonder({ olay: 'ice-yenile', es: es.ad, deneme: es.kurtarma });
	teklifVer(es, true);
}

function esDurumDegisti(es) {
	const d = es.pc.connectionState;
	taniGonder({ olay: 'durum', es: es.ad, durum: d, ice: es.pc.iceConnectionState });
	if (d === 'connected') {
		es.sorunBasi = 0;
		es.kurtarma = 0;
		es.baglandiZaman = Date.now();
		bitHiziAyarla(es);
		calmayiDene(es);
		// Yayınını kapattığım kişiye (bağlantı yeniden kurulduysa) bunu yinele.
		if (!es.izliyorum) gonder({ type: 'izle', to: es.ad, izle: false });
	} else if (!es.sorunBasi) es.sorunBasi = Date.now();
	if (d === 'failed') esIstatistikYaz(es, 'bağlantı koptu · yeniden deneniyor', 'kotu');
	if (d === 'disconnected') esIstatistikYaz(es, 'bağlantı kesiliyor…', 'orta');
	if (d === 'failed') kurtarmaTuru();
	sesPaneliCiz();
}

// Kurtarma döngüsü (saniyede bir): bozuk ya da hiç kurulamayan bağlantıları onarır. Teklif eden
// önce ICE'yi yeniler (2 kez), olmazsa bağlantıyı baştan kurar; yanıtlayan, teklif edenden ister.
// Bekleme her denemede artar (en fazla 30 sn). Sunucu bağlantısı yokken bir şey yapılmaz.
let kurtarmaZamanlayici = null;
function kurtarmaBaslat() {
	if (!kurtarmaZamanlayici) kurtarmaZamanlayici = setInterval(kurtarmaTuru, 1000);
}
function kurtarmaDurdur() {
	clearInterval(kurtarmaZamanlayici);
	kurtarmaZamanlayici = null;
}
// Sunucu yeniden başladıktan sonra listede olmayan eş ne kadar beklenir: giriş freni herkesi sırayla
// içeri alır (varsayılan 10 saniyede 1), son kişi (kişi sayısı × aralık) sonra dönebilir. Bağlantısı
// sağlam olan bu sürede kapatılmaz (P2P ses sürüyor); bağlantısı ölmüş olan 25 sn sonra kapatılır.
const donusBeklemesi = () => Math.max(25000, (girisAraligi / Math.max(1, girisKovasi)) * (esler.size + 1) + 15000);
function kurtarmaTuru() {
	if (!sesKanal) return;
	const simdi = Date.now();
	for (const es of [...esler.values()]) {
		if (es.bekleniyor) {
			const gecen = simdi - es.bekleniyor;
			const olu = !es.pc || es.pc.connectionState === 'failed' || es.pc.connectionState === 'closed';
			if (gecen > donusBeklemesi() || (olu && gecen > 25000)) {
				esKapat(es.ad);
				sesKartiOzetCiz();
			}
			continue;
		}
		if (!bagliyim) continue;
		if (!es.pc) {
			// Teklif eden: bağlantı yoksa kur. Yanıtlayan: teklif kendiliğinden gelir; 8 sn'de gelmezse iste.
			if (es.teklifci) esYenidenKur(es);
			else if (simdi - es.olusturma > 8000) yenileIste(es);
			continue;
		}
		// Teklif hiç gönderilemedi (o an sunucu bağlantısı yoktu): şimdi gönder.
		if (es.teklifci && es.pc.signalingState === 'stable' && !es.pc.localDescription && !es.pc.remoteDescription) {
			teklifVer(es);
			continue;
		}
		const d = es.pc.connectionState;
		if (d === 'connected') {
			es.sorunBasi = 0;
			es.kurtarma = 0;
			continue;
		}
		// Teklif yolda kayboldu (sunucu o sırada kapalıydı): yinele.
		if (es.teklifci && es.pc.signalingState === 'have-local-offer' && simdi - (es.teklifZamani || 0) > 8000 && es.pc.localDescription) {
			es.teklifZamani = simdi;
			gonder({ type: 'sdp', to: es.ad, sdp: es.pc.localDescription, oturum: es.oturum });
		}
		if (!es.sorunBasi) es.sorunBasi = simdi;
		const esik = d === 'failed' || d === 'closed' ? 0 : d === 'disconnected' ? 5000 : 12000;
		if (simdi - es.sorunBasi < esik) continue;
		const bekleme = Math.min(30000, 4000 * 2 ** Math.min(es.kurtarma, 3));
		if (simdi - es.sonKurtarma < bekleme) continue;
		es.sonKurtarma = simdi;
		es.kurtarma++;
		if (es.teklifci) {
			if (es.kurtarma <= 2 && es.pc.remoteDescription && es.pc.signalingState === 'stable') iceYenile(es);
			else esYenidenKur(es);
		} else yenileIste(es, true);
	}
}

// ---------------------------------------------------------------- ses kalitesi

// Gönderilen Opus bit hızı (kbps): ayardaki tavan; kalabalık kanalda (mesh: herkese ayrı akış)
// toplam ~640 kbps'yi geçmesin diye kişi başına düşürülür (en az 40). Bunlar Opus'un hızıdır: RED
// (aşağıda) her çerçeveyi bir kez daha taşıdığı için hatta giden ~iki katıdır.
function gonderimHizi() {
	const n = Math.max(1, esSayisi());
	return Math.round(Math.min(ayar.kalite, Math.max(40, 640 / n)));
}

// Yayın bit hızları (kbps), alan kişi sayısına göre (mesh: herkese ayrı akış). Paylaşılan ses
// (stereo) herkese gider: ~160 kbps (RED'le hatta ~320; altı kişiden kalabalıkta kişi başı düşer);
// ekran yalnızca izleyene, en fazla 2,5 Mbit/s, toplam ~6 Mbit/s.
const izleyiciSayisi = () => Math.max(1, [...esler.values()].filter((e) => !e.bekleniyor && e.izliyor).length);
const yayinSesHizi = () => Math.round(Math.min(160, Math.max(64, 960 / Math.max(1, esSayisi()))));
const goruntuHizi = () => Math.round(Math.min(2500, Math.max(400, 6000 / izleyiciSayisi())));

// --- kayıplara karşı yedek (RED, RFC 2198)
//
// Her ses paketi bir önceki Opus çerçevesinin kopyasını da taşır: tek tük düşen paket bir sonrakinden
// yerine konur, alıcı ses uydurmak zorunda kalmaz. Opus'un kendi yedeği (FEC) bunu ancak kodlayıcı
// kaybı öğrendikten sonra ve düşük kalitede yapar (müzikte çoğu zaman hiç). Ölçüm (gerçek Chromium,
// iki bağlantı arasında paketlerin bir kısmını düşüren UDP aracısı; test/kayip.js): %10 rastgele
// kayıpta uydurulan ses konuşmada %5,4 → %0,9, müzikte %5,7 → %0,7; %5'te ~%5 → ~%0,2; %20'de %12 → %5.
// Bedeli bit hızının ~iki katı. Art arda iki-üç paket düşerse (patlama) kopyası da gider: orada kazanç
// az (%10 kayıp, ortalama 2,5 paketlik patlamalar: %5,8 → %4,8). Alıcının tamponunu büyütmek
// (jitterBufferTarget 60-120 ms) ne düz Opus'ta ne RED'de uydurmayı azalttı: tampon gecikmeye
// karşıdır, kayba değil.
// SDP'mizde RED'i Opus'un önüne yazarız; karşı taraf bize o sırayla gönderir: RED gönderebilen
// tarayıcı (Chrome/Edge) RED, gönderemeyen düz Opus gönderir, RED'i hiç bilmeyenle anlaşma düz Opus'a
// iner (eski sürümler de böyle anlaşır). Bir eşten gelen ses RED'le çözülemiyorsa (istatistikTuru:
// paket geliyor, ses hep uyduruluyor) o eşte RED bırakılır.
function kodekSirasi(red) {
	try {
		if (typeof RTCRtpReceiver === 'undefined' || typeof RTCRtpReceiver.getCapabilities !== 'function') return null;
		const hepsi = (RTCRtpReceiver.getCapabilities('audio') || {}).codecs || [];
		const tur = (c, ad) => String(c.mimeType || '').toLowerCase() === ad;
		const redler = hepsi.filter((c) => tur(c, 'audio/red'));
		const opuslar = hepsi.filter((c) => tur(c, 'audio/opus'));
		if (!redler.length || !opuslar.length) return null; // RED yok: tarayıcının sırası kalır
		const digerleri = hepsi.filter((c) => !redler.includes(c) && !opuslar.includes(c));
		return red ? [...redler, ...opuslar, ...digerleri] : [...opuslar, ...digerleri];
	} catch {
		return null;
	}
}
function kodekSirasiAyarla(es) {
	const sira = kodekSirasi(!es.redKapali);
	if (!sira) return;
	for (const tr of [es.tr, es.trSes]) {
		if (!tr || typeof tr.setCodecPreferences !== 'function') continue;
		try {
			tr.setCodecPreferences(sira);
		} catch (h) {
			console.warn('kodek sırası', es.ad, h);
		}
	}
}
// Bu kanalda RED anlaşıldı mı: giden (bizim gönderdiğimiz) ve alınabilen kodeklerin başı.
function redAnlasildi(tr, yon) {
	try {
		const p = yon === 'giden' ? tr.sender.getParameters() : tr.receiver.getParameters();
		const k = (p && p.codecs) || [];
		return yon === 'giden' ? !!k[0] && /red/i.test(k[0].mimeType) : k.some((c) => /red/i.test(c.mimeType));
	} catch {
		return false;
	}
}
// RED'le gelen ses çözülemiyor (paket geliyor, ses hep uyduruluyor): o eşte RED'i bırak ve yeniden
// anlaş. Teklif eden yeni teklif verir; yanıtlayan teklif edenden yenisini ister (yanıtındaki sıra
// RED'siz olur).
function redBirak(es, neden) {
	if (es.redKapali) return;
	es.redKapali = true;
	taniGonder({ olay: 'red-birakildi', es: es.ad, neden });
	kodekSirasiAyarla(es);
	if (es.teklifci) teklifVer(es);
	else yenileIste(es, true);
}

// Uzak SDP'deki Opus parametreleri: karşı tarafın "şöyle gönder" dediği değerler bizim
// kodlayıcımızı ayarlar. maxaveragebitrate olmadan tarayıcılar ~32 kbps'de kalıyor (ölçüm: 28 kbps);
// setParameters(maxBitrate) yalnızca Chrome'da işe yarıyor, bu yol Firefox/Safari'de de geçerli.
// useinbandfec=1: kayıpta yedek veri; usedtx=0: sessizlikte kesip açma (cızırtı) yok.
// Her ses m-line'ı ayrı ayarlanır: birincisi mikrofon (mono, konuşma), ikincisi yayın sesi (stereo,
// müzik kalitesi). Eskiden SDP'nin tamamına tek ayar uygulanıyordu.
const mikOpusu = () => ({ minptime: '10', useinbandfec: '1', usedtx: '0', stereo: '0', maxplaybackrate: '48000', maxaveragebitrate: String(gonderimHizi() * 1000) });
const yayinOpusu = () => ({
	minptime: '10',
	useinbandfec: '1',
	usedtx: '0',
	stereo: '1',
	'sprop-stereo': '1',
	maxplaybackrate: '48000',
	maxaveragebitrate: String(yayinSesHizi() * 1000),
});
function opusAyarla(sdp) {
	if (typeof sdp !== 'string') return sdp;
	try {
		// Bölümler: oturum başı + her "m=" satırıyla başlayan medya bölümü.
		const bolumler = [[]];
		for (const s of sdp.split(/\r?\n/)) {
			if (s.startsWith('m=')) bolumler.push([]);
			bolumler[bolumler.length - 1].push(s);
		}
		let sesSirasi = 0;
		for (const b of bolumler) {
			if (!b.length || !b[0].startsWith('m=audio')) continue;
			opusBolumu(b, sesSirasi++ === 0 ? mikOpusu() : yayinOpusu());
		}
		return bolumler.flat().join('\r\n');
	} catch {
		return sdp;
	}
}
function opusBolumu(satirlar, ek) {
	const opus = [];
	for (const s of satirlar) {
		const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(s);
		if (m) opus.push(m[1]);
	}
	for (const pt of opus) {
		const bas = 'a=fmtp:' + pt + ' ';
		const i = satirlar.findIndex((s) => s.startsWith(bas));
		if (i >= 0) {
			const p = new Map();
			for (const parca of satirlar[i].slice(bas.length).split(';')) {
				const x = parca.trim();
				if (!x) continue;
				const j = x.indexOf('=');
				p.set(j < 0 ? x : x.slice(0, j), j < 0 ? '' : x.slice(j + 1));
			}
			for (const [k, v] of Object.entries(ek)) p.set(k, v);
			satirlar[i] = bas + [...p].map(([k, v]) => (v === '' ? k : k + '=' + v)).join(';');
		} else {
			const r = satirlar.findIndex((s) => s.toLowerCase().startsWith('a=rtpmap:' + pt + ' opus/'));
			satirlar.splice(r + 1, 0, bas + Object.entries(ek).map(([k, v]) => k + '=' + v).join(';'));
		}
	}
}

// Gönderim tavanları: mikrofon, yayın sesi ve ekran ayrı ayrı (Chrome'da anında geçerli).
async function bitHiziAyarla(es) {
	const pc = es.pc;
	if (!pc || pc.signalingState === 'closed') return;
	const ayarlar = [
		[es.tr, gonderimHizi() * 1000, 0],
		[es.trSes, yayinSesHizi() * 1000, 0],
		[es.trGoruntu, goruntuHizi() * 1000, 30],
	];
	for (const [tr, hiz, kare] of ayarlar) {
		const s = tr && tr.sender;
		if (!s || !s.track) continue;
		try {
			const p = s.getParameters();
			if (!p.encodings || !p.encodings.length) p.encodings = [{}];
			if (p.encodings[0].maxBitrate === hiz && (!kare || p.encodings[0].maxFramerate === kare)) continue;
			p.encodings[0].maxBitrate = hiz;
			if (kare) p.encodings[0].maxFramerate = kare;
			await s.setParameters(p);
		} catch {}
	}
}
function bitHizlariniAyarla() {
	for (const es of esler.values()) bitHiziAyarla(es);
}

// ---------------------------------------------------------------- gelen ses

function uzakSesBagla(es, iz) {
	if (!iz) return;
	let akis = null;
	try {
		akis = new MediaStream([iz]);
	} catch {
		return;
	}
	es.uzakAkis = akis;
	es.ses.srcObject = akis;
	esSesUygula(es);
	calmayiDene(es);
	if (es.olcer) es.olcer.dur();
	es.olcer = seviyeOlcer(akis, (konusuyor) => {
		es.konusuyor = konusuyor;
		konusmaGuncelle(es.ad, konusuyor && !es.susturuldu && !ayar.sagir);
	});
}

// Eşin ekran paylaşımının sesi (ekransız paylaşımda tek gelen budur): mikrofondan ayrı bir <audio>,
// ayrı seviye ve susturma (yayın kartında). Öğe bağlantı kurulurken çalmaya başlar (paylaşım yokken
// sessizdir): telefonda sonradan başlayan paylaşımın sesi için yeniden dokunmak gerekmez.
function uzakYayinSesiBagla(es, iz) {
	if (!iz) return;
	if (!es.yayinSesOgesi) {
		const a = el('audio', 'ses-akis yayin-akis');
		a.autoplay = true;
		a.setAttribute('playsinline', '');
		a.setAttribute('webkit-playsinline', '');
		$('ses-akislari').append(a);
		es.yayinSesOgesi = a;
	}
	let akis;
	try {
		akis = new MediaStream([iz]);
		es.yayinSesOgesi.srcObject = akis;
	} catch {
		return;
	}
	if (es.yayinOlcer) es.yayinOlcer.dur();
	es.yayinOlcer = null;
	es.yayinAkis = akis;
	esSesUygula(es);
	calmayiDene(es);
	yayinOlceriAyarla(es);
}

// Eşin ekran görüntüsü: yayın kutucuğundaki <video>'ya bağlanır (görüntü gelince "bekleniyor" kalkar).
function uzakGoruntuBagla(es, iz) {
	if (!iz) return;
	es.uzakGoruntu = iz;
	iz.onmute = iz.onunmute = () => yayinlarCiz();
	if (es.goruntuOgesi) {
		try {
			es.goruntuOgesi.srcObject = new MediaStream([iz]);
		} catch {}
	}
	yayinlarCiz();
}

const gelenSesler = (es) => [es.ses, es.yayinSesOgesi].filter((a) => a && a.srcObject);

function esSesUygula(es) {
	if (!es.ses) return;
	es.ses.muted = ayar.sagir || es.susturuldu;
	es.ses.volume = Math.max(0, Math.min(1, es.seviye / 100));
	if (es.yayinSesOgesi) {
		// Paylaşılan ses ayrı bir kişi gibi: sağırken ya da onu susturduysan susar; paylaşanın
		// mikrofonunu susturmak onu etkilemez.
		es.yayinSesOgesi.muted = ayar.sagir || es.yayinSusturuldu;
		es.yayinSesOgesi.volume = Math.max(0, Math.min(1, es.yayinSeviye / 100));
	}
	for (const a of [es.ses, es.yayinSesOgesi]) {
		if (a && ayar.cikisId && typeof a.setSinkId === 'function' && a.sinkId !== ayar.cikisId) a.setSinkId(ayar.cikisId).catch(() => {});
	}
	yankiReferansGuncelle();
	if (es.kutu) {
		es.kutu.classList.toggle('susturuldu', es.susturuldu);
		ikonKoy(es.susDugme, es.susturuldu ? 'hoparlor-kapali' : 'hoparlor');
		es.susDugme.classList.toggle('kapali', es.susturuldu);
		es.susDugme.title = es.susturuldu ? 'Bu kişinin sesini aç' : 'Bu kişiyi yalnızca kendin için sustur';
	}
}

// Tarayıcı sesi kendiliğinden başlatmazsa (Safari, telefon) görünen "Sesi başlat" düğmesi çıkar.
function calmayiDene(es) {
	const liste = gelenSesler(es);
	if (!liste.length) return;
	Promise.all(liste.map((a) => oynat(a).catch(() => {}))).then(sesAcDugmesiGuncelle);
}
function sesAcDugmesiGuncelle() {
	let bekleyen = 0;
	for (const es of esler.values()) for (const a of gelenSesler(es)) if (a.paused && !a.muted) bekleyen++;
	$('ses-ac').hidden = !sesKanal || !bekleyen;
}

// Telefon tarayıcıları sesi ancak bir kullanıcı etkileşiminden SONRA başlatır. Yalnızca sesli
// kanaldayken ve çalmayan ses varken dene (eskiden her tuşta sessiz bir ses çalınıyordu: CSP onu
// zaten engelliyordu ve iOS'ta arka plandaki müziği durdurabilirdi).
function sesleriAc() {
	if (!sesKanal) return;
	sesKilidiAc();
	for (const es of esler.values()) for (const a of gelenSesler(es)) if (a.paused && !a.muted) oynat(a).catch(() => {});
	for (const v of document.querySelectorAll('#yayinlar video')) if (v.paused && v.srcObject) oynat(v).catch(() => {});
	setTimeout(sesAcDugmesiGuncelle, 300);
}
$('ses-ac').addEventListener('click', sesleriAc);
document.addEventListener('pointerdown', () => sesKanal && sesleriAc(), { passive: true });

// Telefon arka plandan dönünce: ses bağlamını uyandır (iOS 'interrupted' yapar), durmuş gelen
// sesleri yeniden çal, arka planda biten (ya da başka uygulama/telefon araması yüzünden
// açılamayan) mikrofonu yeniden al, bozulan bağlantıları beklemeden onar.
function sesUyandir() {
	if (!sesKanal) return;
	sesBaglami();
	const iz = mikrofon && mikrofon.getAudioTracks()[0];
	const mikMesgul = !mikrofon && (mikHatasi === 'Mikrofon başka bir uygulamada kullanılıyor' || mikHatasi === 'Mikrofon açılamadı');
	if ((iz && iz.readyState === 'ended') || mikMesgul) mikrofonBitti();
	for (const es of esler.values()) for (const a of gelenSesler(es)) if (a.paused && !a.muted) oynat(a).catch(() => {});
	setTimeout(sesAcDugmesiGuncelle, 300);
	kurtarmaTuru();
}

// Ses bağlamı: seviye ölçümü, mikrofon kazancı ve bildirim sesleri için tek bir AudioContext
// (her katılımcıya ayrı bağlam açmak tarayıcının bağlam sınırına takılıyordu).
let baglam = null;
function sesBaglami() {
	try {
		const Yapici = window.AudioContext || window.webkitAudioContext;
		if (!Yapici) return null;
		if (!baglam || baglam.state === 'closed') {
			baglam = new Yapici();
			baglam.onstatechange = baglamDurumuDegisti;
		}
		if (baglam.state === 'suspended' || baglam.state === 'interrupted') baglam.resume().catch(() => {});
	} catch {
		baglam = null;
	}
	return baglam;
}
function sesKilidiAc() {
	sesBaglami();
}
// Bağlam durdu → kazanç zincirinden (ve paylaşımdaki çıkarıcıdan) vazgeç (ham iz); yeniden
// çalıştı → zinciri kur.
function baglamDurumuDegisti() {
	yankiBaglamDegisti();
	if (!mikrofon || ayar.mikSeviye === 100) return;
	const calisiyor = baglam && baglam.state === 'running';
	if (calisiyor !== !!mikIslem) gidenIzKur();
}

// Ses seviyesi ölçer: yalnızca ölçer, çalınan/gönderilen ses buradan geçmez. Konuşma eşiği
// -48 dBFS, susunca 350 ms sonra söner (kelime arasında yanıp sönmesin).
function seviyeOlcer(akis, geri) {
	const ac = sesBaglami();
	if (!ac || !akis) return { dur() {} };
	let kaynak;
	let analiz;
	try {
		kaynak = ac.createMediaStreamSource(akis);
		analiz = ac.createAnalyser();
		analiz.fftSize = 1024;
		kaynak.connect(analiz);
	} catch {
		return { dur() {} };
	}
	const veri = new Float32Array(analiz.fftSize || 1024);
	let konusuyor = false;
	let sonSes = 0;
	const zaman = setInterval(() => {
		let rms = 0;
		if (typeof analiz.getFloatTimeDomainData === 'function') {
			analiz.getFloatTimeDomainData(veri);
			let t = 0;
			for (let i = 0; i < veri.length; i++) t += veri[i] * veri[i];
			rms = Math.sqrt(t / veri.length);
		}
		const db = rms > 0 ? 20 * Math.log10(rms) : -100;
		const simdi = Date.now();
		if (db > -48) sonSes = simdi;
		const yeni = simdi - sonSes < 350;
		const seviye = Math.max(0, Math.min(1, (db + 60) / 50));
		if (yeni !== konusuyor) konusuyor = yeni;
		geri(konusuyor, seviye);
	}, 100);
	return {
		dur() {
			clearInterval(zaman);
			try {
				kaynak.disconnect();
			} catch {}
			geri(false, 0);
		},
	};
}

function kendiSeviye(konusuyor, seviye) {
	const acik = !mikSessizMi();
	konusmaGuncelle(benimAdim, konusuyor && acik);
	const dolgu = $('ben-ses-satir').querySelector('.seviye-cubuk > div');
	if (dolgu) dolgu.style.width = (acik ? Math.round(seviye * 100) : 0) + '%';
	const ayarDolgu = $('ayar-olcer-dolgu');
	if (ayarDolgu && !$('ayarlar').hidden && !denemeMik) ayarDolgu.style.width = Math.round(seviye * 100) + '%';
}

// Konuşma göstergesi: eş kutusu, kenar çubuğundaki kanal üyesi ve (bensem) kullanıcı kartı.
function konusmaGuncelle(ad, konusuyor) {
	if (!ad) return;
	if (konusuyor === konusanlar.has(ad)) return;
	if (konusuyor) konusanlar.add(ad);
	else konusanlar.delete(ad);
	const es = esler.get(ad);
	if (es && es.kutu) es.kutu.classList.toggle('konusuyor', konusuyor);
	if (ad === benimAdim) {
		$('ben-ses-satir').classList.toggle('konusuyor', konusuyor);
		$('ben-avatar').classList.toggle('konusuyor', konusuyor);
	}
	for (const e of $('ses-kanallari').querySelectorAll('.ses-uyesi')) if (e.dataset.ad === ad) e.classList.toggle('konusuyor', konusuyor);
}

// Sunucudan gelen sessiz/sağır durumu (eş kutusundaki simge).
function sesDurumuGeldi(ad, d) {
	const onceki = sesDurumlari.get(ad) || {};
	sesDurumlari.set(ad, { ...onceki, ...d });
	const es = esler.get(ad);
	if (es) esDurumIkonlariCiz(es);
}

// ---------------------------------------------------------------- sesli kanal arayüzü

function esKutusuOlustur(es) {
	const kutu = el('div', 'ses-kisi');
	kutu.dataset.ad = es.ad;
	const bilgi = el('div', 'ses-kisi-bilgi');
	const adSatir = el('div', 'ad-satir');
	const durumIkon = el('span', 'durum-ikon');
	adSatir.append(el('b', 'ad', es.ad), durumIkon);
	const istatistik = el('span', 'ses-istatistik', 'bağlanıyor…');
	bilgi.append(adSatir, istatistik);
	const sus = el('button', 'ikon-dugme sus');
	sus.type = 'button';
	sus.setAttribute('aria-label', es.ad + ' kişisini sustur veya aç');
	sus.onclick = () => {
		es.susturuldu = !es.susturuldu;
		depoYaz('ses-sustur-' + es.ad, es.susturuldu ? '1' : null);
		esSesUygula(es);
		konusmaGuncelle(es.ad, es.konusuyor && !es.susturuldu && !ayar.sagir);
	};
	const seviye = el('input', 'ses-seviye');
	Object.assign(seviye, { type: 'range', min: 0, max: 100, step: 1 });
	seviye.value = String(es.seviye);
	seviye.title = 'Ses seviyesi (yalnızca sende)';
	seviye.setAttribute('aria-label', es.ad + ' kişisinin ses seviyesi');
	seviye.oninput = () => {
		es.seviye = Number(seviye.value);
		esSesUygula(es);
		depoYaz('ses-seviye-' + es.ad, seviye.value);
	};
	kutu.append(avatarYap(es.ad, 'avatar orta-avatar'), bilgi, sus, seviye);
	$('ses-kisiler').append(kutu);
	Object.assign(es, { kutu, istatistik, susDugme: sus, seviyeGirdi: seviye, durumIkon });
	esSesUygula(es);
	esDurumIkonlariCiz(es);
}

function esDurumIkonlariCiz(es) {
	if (!es.durumIkon) return;
	const d = sesDurumlari.get(es.ad) || {};
	es.durumIkon.replaceChildren();
	if (d.sagir) es.durumIkon.append(ikon('kulaklik-kapali'));
	else if (d.sessiz) es.durumIkon.append(ikon('mik-kapali'));
	es.durumIkon.title = d.sagir ? 'sağırlaştırılmış' : d.sessiz ? 'mikrofonu kapalı' : '';
	es.kutu.classList.toggle('sessiz', !!(d.sessiz || d.sagir));
	es.kutu.classList.toggle('askida', !!d.askida);
	if (es.yayinRozeti) es.yayinRozeti.remove();
	es.yayinRozeti = yayinRozeti(d);
	if (es.yayinRozeti) es.durumIkon.after(es.yayinRozeti);
}

// Ekranını paylaşana (ekransız da) "CANLI".
function yayinRozeti(d) {
	if (!d.yayin) return null;
	const r = el('span', 'canli', 'CANLI');
	r.title = d.yayin.goruntu ? 'Ekranını paylaşıyor' : 'Ekransız paylaşıyor (yalnızca ses)';
	return r;
}

function esIstatistikYaz(es, metin, sinif) {
	if (!es.istatistik) return;
	es.istatistik.textContent = metin;
	es.istatistik.className = 'ses-istatistik' + (sinif ? ' ' + sinif : '');
}

function benSatiriCiz() {
	const s = $('ben-ses-satir');
	if (!sesKanal) {
		s.replaceChildren();
		return;
	}
	const bilgi = el('div', 'ses-kisi-bilgi');
	const adSatir = el('div', 'ad-satir');
	adSatir.append(el('b', 'ad', benimAdim + ' (sen)'), durumIkonlari(ayar.mikKapali || !gidenIz, ayar.sagir));
	const alt = ayar.sagir ? 'sağırlaştırıldın' : !gidenIz ? mikHatasi || 'mikrofon yok' : ayar.mikKapali ? 'mikrofon kapalı' : 'mikrofon açık';
	bilgi.append(adSatir, el('span', 'ses-istatistik' + (!gidenIz ? ' kotu' : ''), alt));
	const cubuk = el('div', 'seviye-cubuk');
	cubuk.append(el('div'));
	cubuk.title = 'Mikrofon seviyen';
	s.replaceChildren(avatarYap(benimAdim, 'avatar orta-avatar'), bilgi, cubuk);
	s.classList.toggle('konusuyor', konusanlar.has(benimAdim));
}

function sesUyarisiCiz() {
	const u = $('ses-uyari');
	// Susturulduğu için bırakılan mikrofon bir sorun değildir (açınca yeniden alınır).
	if (!sesKanal || gidenIz || mikBirakildi || mikAliniyor) {
		u.hidden = true;
		return;
	}
	u.replaceChildren(document.createTextNode((mikHatasi || 'Mikrofon yok') + '; yalnızca dinliyorsun, seni kimse duymuyor.'));
	const dugme = el('button', null, 'Tekrar dene');
	dugme.type = 'button';
	dugme.onclick = async () => {
		const tamam = await mikrofonHazirla();
		if (tamam) {
			durum('Mikrofon açıldı.');
			gonder({ type: 'sessiz', sessiz: mikSessizMi(), sagir: ayar.sagir });
		} else durum(mikHatasi, true);
		mikDugmeleriCiz();
	};
	u.append(dugme);
	u.hidden = false;
}

function sesArayuzuAc() {
	$('ses-karti').hidden = false;
	$('ses-kart-kanal').textContent = kanalAdi(sesKanal);
	$('ses-baglanti').hidden = false;
	$('ses-baglanti-kanal').textContent = kanalAdi(sesKanal);
	benSatiriCiz();
	sesUyarisiCiz();
	mikDugmeleriCiz();
	kanalListesiCiz();
	sesKartiOzetCiz();
	sesPaneliCiz();
}
function sesArayuzuKapat() {
	$('ses-karti').hidden = true;
	$('ses-baglanti').hidden = true;
	$('ses-ac').hidden = true;
	$('ses-uyari').hidden = true;
	$('ben-ses-satir').replaceChildren();
	$('ben-ses-satir').classList.remove('konusuyor');
	$('ben-avatar').classList.remove('konusuyor');
	mikDugmeleriCiz();
	kanalListesiCiz();
}
function sesKartiAc() {
	$('ses-karti').classList.remove('kucuk');
	$('ses-kucult').setAttribute('aria-expanded', 'true');
}
$('ses-kucult').addEventListener('click', () => {
	const kucuk = $('ses-karti').classList.toggle('kucuk');
	$('ses-kucult').setAttribute('aria-expanded', String(!kucuk));
});

function sesKartiOzetCiz() {
	if (!sesKanal) return;
	const n = esler.size + 1;
	$('ses-kart-ozet').textContent = n === 1 ? '· kanalda yalnızsın' : `· ${n} kişi`;
}

// Sol alttaki ses bağlantısı paneli: genel durum (bağlanıyor / bağlı / zayıf / sunucu koptu).
// "Bağlantı zayıf" (kırmızı) yalnızca HERKESTEN gelen ses gerçekten bozulduğunda (sorun büyük
// olasılıkla bizim bağlantımızda) ya da mikrofonumuz gitmiyorsa çıkar. Tek bir kişinin bağlantısı
// kötüyse panel yeşil kalır, alt satırda ve o kişinin kutusunda belirtilir.
let sonOzet = null;
function sesPaneliCiz(ozet) {
	if (!sesKanal) return;
	if (ozet) sonOzet = ozet;
	else ozet = sonOzet;
	const panel = $('ses-baglanti');
	const sinyal = $('ses-sinyal');
	let durumMetni = 'Ses bağlı';
	let sinif = '';
	let ek = ozet && ozet.metin ? ozet.metin : '';
	const durumlar = [...esler.values()].filter((e) => e.pc).map((e) => e.pc.connectionState);
	const kotuler = ozet ? ozet.kotu.filter((ad) => esler.has(ad)) : [];
	const ortalar = ozet ? ozet.orta.filter((ad) => esler.has(ad)) : [];
	if (!bagliyim) {
		durumMetni = 'Sunucuya yeniden bağlanılıyor';
		sinif = 'orta';
	} else if (durumlar.some((d) => d !== 'connected')) {
		durumMetni = durumlar.some((d) => d === 'connected') ? 'Bazı bağlantılar kuruluyor' : 'Ses bağlanıyor…';
		sinif = 'bekliyor';
	} else if (ozet && ozet.mikSorun) {
		durumMetni = 'Mikrofonun gitmiyor';
		sinif = 'kotu';
	} else if (ozet && ozet.olculen && kotuler.length >= ozet.olculen) {
		durumMetni = 'Bağlantı zayıf';
		sinif = 'kotu';
	} else if (ozet && ozet.olculen && kotuler.length + ortalar.length >= ozet.olculen) {
		durumMetni = 'Ses bağlı · dalgalı';
		sinif = 'orta';
	} else if (kotuler.length) {
		ek = `${kotuler.join(', ')}: bağlantısı zayıf`;
	}
	$('ses-baglanti-durum').textContent = durumMetni;
	panel.classList.toggle('orta', sinif === 'orta' || sinif === 'bekliyor');
	panel.classList.toggle('kotu', sinif === 'kotu');
	sinyal.className = 'sinyal' + (sinif ? ' ' + sinif : '');
	$('ses-baglanti-kanal').textContent = kanalAdi(sesKanal) + (ek ? ' · ' + ek : '');
}

// ---------------------------------------------------------------- yayın: ekran paylaşımı (ekranlı ya da ekransız)
//
// Paylaşım tarayıcının ekran paylaşımıyla yapılır (ekran, pencere ya da sekme; istenirse sesiyle).
// Sekmenin ya da bilgisayarın sesini paylaşmak da böyle olur: "ekransız paylaşım" bir ekran
// paylaşımıdır; yakalama sürer ama görüntü kimseye gönderilmez, yalnızca sesi gider. Görüntü izi bu
// yüzden durdurulmaz (saniyede bir kareye indirilir): tarayıcıda ses yakalaması ve "paylaşılıyor"
// göstergesi görüntüye bağlıdır, görüntüyü durdurmak sesi de kesebilir. Paylaşan ekranı tek dokunuşla
// (yeniden seçmeden) gösterip gizler.
//
// Ekran paylaşımında sesi yalnızca Chrome/Edge verir (sekmenin sesi; Windows'ta "Tüm ekran" ile tüm
// bilgisayarın sesi). Firefox ve Safari, ne seçilirse seçilsin, ses vermez: bu tarayıcılarda paylaşılan
// ses bir SES AYGITINDAN alınır (getUserMedia). Linux'ta bilgisayarın sesi PulseAudio/PipeWire'ın
// "Monitor of …" aygıtıdır (Windows'ta "Stereo Karışımı", Mac'te BlackHole gibi sanal bir aygıt).
// Ekransız paylaşım orada seçim penceresi açmaz, aygıt sorar; ekranlı paylaşıma ses sonradan eklenir,
// ses aygıtından ekransız paylaşıma ekran sonradan eklenir. Bu aygıt bilgisayarda çalan her şeyi,
// kanaldakilerin konuşması dahil, duyar: bu sayfanın çaldığı yakalanan sesten çıkarılır (yanki.js;
// kimse kendi sesini geri duymaz), başka sekmelerin ve uygulamaların sesi olduğu gibi kalır.
//
// Sesli kanaldaki her eş bağlantısında mikrofonun yanında iki kanal önceden açıktır: paylaşımın sesi
// (stereo, müzik kalitesinde) ve görüntüsü. Paylaşım başlayınca/bitince ya da ekran gösterilip
// gizlenince bu kanallara yalnızca iz takılır (yeniden anlaşma yok, konuşma kesilmez). Ses herkese
// gider (herkes yayın kartından kendi için kısar ya da susturur); görüntü yalnızca izleyene: görüntüyü
// kapatana (ör. telefonda yalnızca dinlemek isteyene) gönderilmez.
// Telefon tarayıcılarının çoğu hiç yakalayamaz: paylaş düğmesi yalnızca tarayıcı ekran paylaşımı
// sunuyorsa görünür. Paylaşılanı her cihaz izler ve dinler.

const GORUNTU_KISITI = { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } };
const EKRANSIZ_KISITI = { ...GORUNTU_KISITI, frameRate: { max: 1 } };

// goruntu/ses: paylaşılan (gönderilen) izler (biri yoksa null). aygit: ses bir ses aygıtından
// alınıyorsa onun kimliği ('' = ekran yakalamasının kendi sesi), aygitAdi: o aygıtın adı. ekransiz:
// görüntü gönderilmiyor (gizlendi ya da ses aygıtından paylaşımda hiç seçilmedi). hamSes: yakalanan
// iz; ses aygıtından alınan sesten kanaldakilerin sesi çıkarılıyorsa (yanki: çıkarıcı) gönderilen
// iz (ses) çıkarıcının çıkışıdır, değilse ikisi aynıdır.
const yayin = { goruntu: null, ses: null, hamSes: null, yanki: null, ekransiz: false, olcer: null, aygit: '', aygitAdi: '' };
const yayinVar = () => !!(yayin.goruntu || yayin.ses);
// Tarayıcı seçim penceresini açmadan reddetti (ör. "masaüstü sitesi" kipindeki telefon): düğme gizlenir.
let yayinDesteklenmiyor = false;
const ekranPaylasilabilir = () => !yayinDesteklenmiyor && !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');
// Ekran paylaşımı ses de verebilir mi? Verebilen tarayıcılar (Chrome/Edge) ekran yakalamasının ses
// kısıtlarını tanır; Firefox ve Safari tanımaz (onlarda ses ancak bir ses aygıtından gelir).
function ekranSesiVar() {
	try {
		const d = navigator.mediaDevices.getSupportedConstraints();
		return !!(d && (d.suppressLocalAudioPlayback || d.restrictOwnAudio));
	} catch {
		return false;
	}
}

// Duyurulan durum: null (paylaşım yok) ya da { goruntu, ses } (goruntu: false = ekransız).
const yayinBilgisi = () => (yayinVar() ? { goruntu: !!yayin.goruntu && !yayin.ekransiz, ses: !!yayin.ses } : null);
// Eşe giden görüntü: ekran gösteriliyorsa ve o izliyorsa. (Ses herkese gider: yayin.ses.)
const gidenGoruntu = (es) => (yayin.goruntu && !yayin.ekransiz && es.izliyor ? yayin.goruntu : null);

function yayinBildir() {
	if (sesKanal) gonder({ type: 'yayin', yayin: yayinBilgisi() });
}

// Yayın izlerini eşin kanallarına tak (yeniden anlaşma gerekmez).
function yayinIzleriniBagla(es) {
	if (!es.pc || es.pc.signalingState === 'closed') return;
	const ses = yayin.ses;
	const goruntu = gidenGoruntu(es);
	const isler = [];
	if (es.trSes && es.trSes.sender.track !== ses) isler.push(es.trSes.sender.replaceTrack(ses).catch((h) => console.warn('yayın sesi bağlanamadı', es.ad, h)));
	if (es.trGoruntu && es.trGoruntu.sender.track !== goruntu) isler.push(es.trGoruntu.sender.replaceTrack(goruntu).catch((h) => console.warn('görüntü bağlanamadı', es.ad, h)));
	if (isler.length) Promise.all(isler).then(() => bitHiziAyarla(es));
}
function yayinDegisti() {
	for (const es of esler.values()) yayinIzleriniBagla(es);
	bitHizlariniAyarla();
	yayinBildir();
	yayinlarCiz();
	yayinMenusuCiz();
}

// Yakalama kısıtı (desteklemeyen tarayıcıda ya da reddedilirse yakalama olduğu gibi sürer).
function kisitUygula(iz, kisit) {
	try {
		if (iz && typeof iz.applyConstraints === 'function') iz.applyConstraints(kisit).catch(() => {});
	} catch {}
}

// Tarayıcının seçim penceresi. sesli: ekranın sesi de istenir (verebilen tarayıcıda); sekme: seçim
// sekmelerle açılsın. Vazgeçilir ya da reddedilirse null.
async function ekranIste(sesli, sekme) {
	const secenek = {
		video: sekme ? { ...GORUNTU_KISITI, displaySurface: 'browser' } : { ...GORUNTU_KISITI },
		audio: false,
		selfBrowserSurface: 'exclude', // Diszort sekmesinin kendisi seçenek olmasın
		surfaceSwitching: 'include',
	};
	if (sesli) {
		const destek = (navigator.mediaDevices.getSupportedConstraints && navigator.mediaDevices.getSupportedConstraints()) || {};
		// Ses işlenmeden gitsin (yankı/gürültü giderme müziği bozar). restrictOwnAudio: bu sekmenin kendi
		// sesi (kanaldakilerin konuşması) yakalanan bilgisayar sesine karışmasın (yankı olmasın).
		const sesKisiti = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
		if (destek.suppressLocalAudioPlayback) sesKisiti.suppressLocalAudioPlayback = false;
		if (destek.restrictOwnAudio) sesKisiti.restrictOwnAudio = true;
		secenek.audio = sesKisiti;
		secenek.systemAudio = 'include'; // Chrome: "tüm ekran" seçilince sistem sesini paylaşma seçeneği
	}
	const istekZamani = Date.now();
	try {
		return await navigator.mediaDevices.getDisplayMedia(secenek);
	} catch (h) {
		if (h && (h.name === 'NotAllowedError' || h.name === 'AbortError')) {
			// Seçim penceresi açılmadan hemen reddedildiyse tarayıcı/cihaz izin vermiyor (düğme gizlenir);
			// yoksa kullanıcı vazgeçti.
			if (Date.now() - istekZamani < 400) {
				yayinDesteklenmiyor = true;
				yayinMenusuCiz();
				durum('Bu tarayıcı ya da cihaz ekran paylaşımına izin vermiyor; paylaşılanları izleyip dinleyebilirsin.', true);
			}
			return null;
		}
		durum('Paylaşım başlatılamadı: ' + ((h && h.message) || h), true);
		return null;
	}
}

// Paylaşımı başlat. ekransiz: yalnızca ses gider (seçim penceresi sekmelerle açılır; sesi olmayan
// seçim kabul edilmez). Ekran paylaşımı ses vermeyen tarayıcıda (Firefox, Safari) ekransız
// paylaşım seçim penceresi açmaz: ses aygıtı sorulur.
async function yayinBaslat(ekransiz) {
	yayinMenuKapat();
	if (!sesKanal) return durum('Önce bir sesli kanala gir.', true);
	if (!ekranPaylasilabilir()) return durum('Bu tarayıcı ekranı ve sesi paylaşamıyor; paylaşılanları izleyip dinleyebilirsin.', true);
	if (ekransiz && !ekranSesiVar()) return sesKaynagiAc();
	const akis = await ekranIste(true, ekransiz);
	if (!akis) return;
	const goruntu = akis.getVideoTracks()[0] || null;
	const ses = akis.getAudioTracks()[0] || null;
	const birak = () => akis.getTracks().forEach((t) => t.stop());
	if (!sesKanal) return birak();
	if (!goruntu) {
		birak();
		return durum('Paylaşım başlatılamadı: tarayıcı görüntü vermedi.', true);
	}
	if (ekransiz && !ses) {
		birak();
		return durum('Ses gelmedi: seçim penceresinde sesi paylaşma seçeneğini aç (sekmenin sesi her bilgisayarda; tüm bilgisayarın sesi Windows\'ta "Tüm ekran" ile).', true);
	}
	if (yayinVar()) yayinDurdur(false);
	yayin.ekransiz = !!ekransiz;
	yayinGoruntusuTak(goruntu);
	if (ekransiz) kisitUygula(goruntu, EKRANSIZ_KISITI);
	if (ses) yayinSesiTak(ses);
	yayinDegisti();
	if (ekransiz) durum('Ekransız paylaşıyorsun: yalnızca ses gidiyor. Hoparlörden dinliyorsan mikrofonun da bu sesi alır; kulaklık kullan.');
	else if (ses) durum('Ekranın ve sesi paylaşılıyor.');
	else if (ekranSesiVar()) durum('Ekranın paylaşılıyor (ses yok: seçerken sesi de paylaşabilirsin).');
	else durum('Ekranın paylaşılıyor (sessiz). Bilgisayarın sesini de paylaşmak için: "Ses ekle".');
}

// Paylaşılan görüntü izi. Tarayıcının "Paylaşımı durdur" çubuğu ya da paylaşılan pencerenin kapanması
// onu bitirir: ekran yakalamasının kendi sesi de onunla gider (paylaşım biter); ses bir ses aygıtından
// geliyorsa paylaşım ekransız sürer.
function yayinGoruntusuTak(goruntu) {
	yayin.goruntu = goruntu;
	try {
		goruntu.contentHint = 'motion'; // oyun/video: akıcılık öncelikli
	} catch {}
	goruntu.addEventListener('ended', () => {
		if (yayin.goruntu !== goruntu) return;
		if (!yayin.ses || !yayin.aygit) return yayinDurdur();
		yayin.goruntu = null;
		yayin.ekransiz = true;
		yayinDegisti();
		durum('Ekran paylaşımı bitti; ses paylaşımı sürüyor.');
	});
}

// Paylaşılan ses izi: ekran yakalamasının sesi ya da (aygit verilirse) bir ses aygıtının sesi.
// isleyici: aygıtın sesinden kanaldakilerin sesini çıkaran düzenek (yankiCikariciKur); verilirse
// gönderilen iz onun çıkışıdır, aygıtın kendi izi isleyici.ham'dır.
function yayinSesiTak(ses, aygit = '', aygitAdi = '', isleyici = null) {
	if (yayin.ses && yayin.ses !== ses) yayinSesiniBirak();
	const ham = isleyici ? isleyici.ham : ses;
	yayin.ses = ses;
	yayin.hamSes = ham;
	yayin.yanki = isleyici;
	yayin.aygit = aygit;
	yayin.aygitAdi = aygitAdi;
	try {
		ses.contentHint = 'music';
	} catch {}
	// Biten, yakalanan izdir (aygıt çıkarıldı, paylaşım durduruldu); çıkarıcının çıkışı kendiliğinden bitmez.
	ham.addEventListener('ended', () => {
		if (yayin.hamSes !== ham) return;
		// Ekransızken paylaşılacak bir şey kalmadı; ekran gösteriliyorsa görüntü sürer.
		if (yayin.ekransiz || !yayin.goruntu) {
			yayinDurdur();
			if (aygit) durum('Ses aygıtı kapandı; paylaşım bitti.', true);
			return;
		}
		yayinSesiniBirak();
		yayinDegisti();
		if (aygit) durum('Ses aygıtı kapandı; yalnızca ekranın gidiyor.', true);
	});
	// Paylaştığım sesin seviyesi kendi kartımda (diğerlerinde de öyle görünür).
	try {
		yayin.olcer = seviyeOlcer(new MediaStream([ses]), (caliyor, seviye) => kartSesi('ben', caliyor, seviye));
	} catch {}
}

function yayinSesiniBirak() {
	if (yayin.olcer) yayin.olcer.dur();
	yayin.olcer = null;
	if (yayin.yanki) yankiCikariciKapat(yayin.yanki);
	if (yayin.hamSes) yayin.hamSes.stop();
	if (yayin.ses) yayin.ses.stop();
	yayin.ses = null;
	yayin.hamSes = null;
	yayin.yanki = null;
	yayin.aygit = '';
	yayin.aygitAdi = '';
}

// Ekranı göster / gizle: aynı yakalama sürer, yalnızca görüntünün gidip gitmediği değişir. Ses
// aygıtından ekransız paylaşımda ekran henüz seçilmediyse önce seçilir.
function ekransizAyarla(ekransiz) {
	if (!ekransiz && yayin.ses && !yayin.goruntu) return ekranEkle();
	if (!yayin.goruntu || yayin.ekransiz === ekransiz || (ekransiz && !yayin.ses)) return;
	yayin.ekransiz = ekransiz;
	kisitUygula(yayin.goruntu, ekransiz ? EKRANSIZ_KISITI : GORUNTU_KISITI);
	yayinDegisti();
	durum(ekransiz ? 'Ekranın gizlendi; yalnızca ses gidiyor.' : 'Ekranın yeniden görünüyor.');
}

// Ses aygıtından süren ekransız paylaşıma ekran ekle: seçim penceresi bir kez açılır (sonra gösterip
// gizlemek yeniden seçim istemez).
async function ekranEkle() {
	const akis = await ekranIste(false, false);
	if (!akis) return;
	const goruntu = akis.getVideoTracks()[0] || null;
	for (const t of akis.getTracks()) if (t !== goruntu) t.stop();
	if (!goruntu) return durum('Paylaşım başlatılamadı: tarayıcı görüntü vermedi.', true);
	// Seçerken paylaşım bitti (ya da ekran başka yoldan eklendi).
	if (!sesKanal || !yayin.ses || yayin.goruntu) return goruntu.stop();
	yayinGoruntusuTak(goruntu);
	yayin.ekransiz = false;
	yayinDegisti();
	durum('Ekranın da paylaşılıyor.');
}

// Paylaşımı bitir. bildir=false: sesli kanaldan çıkılırken (eşler zaten kapandı).
function yayinDurdur(bildir = true) {
	const goruntu = yayin.goruntu;
	yayinSesiniBirak();
	yayin.goruntu = null;
	yayin.ekransiz = false;
	if (goruntu) goruntu.stop();
	// Bir sonraki paylaşım herkese yine kendiliğinden gitsin.
	for (const es of esler.values()) es.izliyor = true;
	if (bildir) yayinDegisti();
	else {
		yayinlarCiz();
		yayinMenusuCiz();
	}
}

// --- ses kaynağı: paylaşılan sesin alındığı ses aygıtı (ekran paylaşımı ses vermeyen tarayıcılarda)
//
// Bilgisayarın sesi gibi görünen aygıtlar ("Monitor of …", Stereo Mix, BlackHole…) başta gelir ve ilki
// seçili gelir (en son seçilen hâlâ takılıysa o); mikrofonun işaretlenir. Ses stereo ve tarayıcının
// hiçbir işlemi olmadan alınır: gürültü bastırma ve otomatik kazanç müziği bozar; tarayıcının yankı
// engelleyicisi de kalan yankıyı bastırırken müziği eşik varmış gibi kesik kesik gönderiyordu.
// Kanaldakilerin sesi yakalanandan bunun yerine yanki.js'le çıkarılır (aşağıda).

const BILGISAYAR_SESI = /monit|izleyici|stereo ?mix|stereo karı|what ?u ?hear|loopback|blackhole|soundflower|vb-audio|cable output|voicemeeter/i;

async function sesAygitlari() {
	try {
		const liste = await navigator.mediaDevices.enumerateDevices();
		return liste.filter((a) => a.kind === 'audioinput' && a.deviceId && a.deviceId !== 'default' && a.deviceId !== 'communications');
	} catch {
		return [];
	}
}

let sesKaynagiOncekiOdak = null;
// Pencereyi aç ve aygıtları listele. Aygıt adları izin verilmeden gizlidir (mikrofonsuz, yalnızca
// dinlerken): o zaman bir kez izin istenir.
async function sesKaynagiAc() {
	yayinMenuKapat();
	if (!sesKanal) return durum('Önce bir sesli kanala gir.', true);
	if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') return durum('Bu tarayıcı ses aygıtından paylaşamıyor.', true);
	if ($('ses-kaynagi').hidden) sesKaynagiOncekiOdak = document.activeElement;
	const secim = $('ses-kaynagi-aygit');
	secim.replaceChildren(el('option', null, 'Ses aygıtları aranıyor…'));
	secim.disabled = true;
	$('ses-kaynagi-paylas').disabled = true;
	$('ses-kaynagi-ipucu').hidden = true;
	$('ses-kaynagi').hidden = false;
	$('ses-kaynagi-iptal').focus();
	let aygitlar = await sesAygitlari();
	if (!aygitlar.some((a) => a.label)) {
		try {
			const izin = await navigator.mediaDevices.getUserMedia({ audio: true });
			izin.getTracks().forEach((t) => t.stop());
			aygitlar = await sesAygitlari();
		} catch {}
	}
	if (!$('ses-kaynagi').hidden) sesKaynaklariniCiz(aygitlar);
}

function sesKaynaklariniCiz(aygitlar) {
	const secim = $('ses-kaynagi-aygit');
	let mikId = '';
	try {
		const iz = mikrofon && mikrofon.getAudioTracks()[0];
		mikId = (iz && iz.getSettings && iz.getSettings().deviceId) || '';
	} catch {}
	const bilgisayar = aygitlar.filter((a) => BILGISAYAR_SESI.test(a.label));
	const diger = aygitlar.filter((a) => !BILGISAYAR_SESI.test(a.label));
	secim.replaceChildren();
	let sira = 0;
	for (const a of [...bilgisayar, ...diger]) {
		const ad = a.label || `Ses aygıtı ${++sira}`;
		const o = el('option', null, BILGISAYAR_SESI.test(a.label) ? `Bilgisayarın sesi · ${ad}` : a.deviceId === mikId ? `${ad} · mikrofonun` : ad);
		o.value = a.deviceId;
		o.dataset.ad = ad;
		secim.append(o);
	}
	if (!aygitlar.length) secim.append(el('option', null, 'Ses aygıtı bulunamadı'));
	const takili = (id) => !!id && aygitlar.some((a) => a.deviceId === id);
	const ilk = bilgisayar[0] || diger.find((a) => a.deviceId !== mikId) || diger[0];
	if (takili(ayar.yayinAygitId)) secim.value = ayar.yayinAygitId;
	else if (ilk) secim.value = ilk.deviceId;
	secim.disabled = !aygitlar.length;
	$('ses-kaynagi-paylas').disabled = !aygitlar.length;
	$('ses-kaynagi-ipucu').hidden = bilgisayar.length > 0;
	if (aygitlar.length) secim.focus();
}

function sesKaynagiKapat() {
	if ($('ses-kaynagi').hidden) return;
	$('ses-kaynagi').hidden = true;
	const odak = sesKaynagiOncekiOdak;
	sesKaynagiOncekiOdak = null;
	// Menüden açıldıysa menü öğesi artık yok: paylaş düğmesine dön.
	if (odak && odak.focus && document.contains(odak) && !odak.closest('[hidden]')) odak.focus();
	else if (!$('yayin-ac').hidden && !$('ses-karti').hidden) $('yayin-ac').focus();
}

function aygitHataMetni(h) {
	const ad = h && h.name;
	if (ad === 'NotAllowedError' || ad === 'SecurityError') return 'Ses aygıtına izin verilmedi.';
	if (ad === 'NotFoundError' || ad === 'OverconstrainedError') return 'Ses aygıtı bulunamadı; yeniden seç.';
	const neden = String((h && h.message) || h || '').slice(0, 120);
	if (ad === 'NotReadableError' || ad === 'AbortError') return 'Ses aygıtı açılamadı' + (neden ? ': ' + neden : ' (başka bir uygulama kullanıyor olabilir).');
	return 'Ses aygıtı açılamadı: ' + neden;
}

// Seçilen aygıtın sesini paylaş: ekranlı bir paylaşım sürüyorsa ona eklenir, yoksa ekransız paylaşım
// başlar. Kanaldakilerin sesi bu sesten çıkarılır (kurulamazsa ham ses gider).
async function sesKaynagiPaylas() {
	const secim = $('ses-kaynagi-aygit');
	if (secim.disabled) return;
	const id = secim.value;
	const secili = secim.selectedOptions && secim.selectedOptions[0];
	const ad = (secili && secili.dataset.ad) || '';
	sesKaynagiKapat();
	if (!sesKanal) return durum('Önce bir sesli kanala gir.', true);
	ayar.yayinAygitId = id;
	ayarKaydet();
	const kisit = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } };
	if (id) kisit.deviceId = { exact: id };
	let ses;
	try {
		const akis = await navigator.mediaDevices.getUserMedia({ audio: kisit });
		ses = akis.getAudioTracks()[0] || null;
		for (const t of akis.getTracks()) if (t !== ses) t.stop();
		if (!ses) throw Object.assign(new Error('ses izi yok'), { name: 'NotFoundError' });
	} catch (h) {
		if (h && (h.name === 'OverconstrainedError' || h.name === 'NotFoundError')) {
			ayar.yayinAygitId = '';
			ayarKaydet();
		}
		taniGonder({ olay: 'yayin-aygit-hata', ad: (h && h.name) || null, metin: String((h && h.message) || h).slice(0, 160) });
		return durum(aygitHataMetni(h), true);
	}
	if (!sesKanal) return ses.stop();
	const isleyici = await yankiCikariciKur(ses);
	if (!sesKanal || ses.readyState === 'ended') {
		if (isleyici) yankiCikariciKapat(isleyici);
		return ses.stop();
	}
	// Teşhis: tarayıcının gerçekte uyguladığı (kanal sayısı, işlemler) ve çıkarıcının kurulup kurulmadığı.
	try {
		const s = ses.getSettings ? ses.getSettings() : {};
		taniGonder({ olay: 'yayin-aygit', kanal: s.channelCount ?? null, aec: s.echoCancellation ?? null, ns: s.noiseSuppression ?? null, agc: s.autoGainControl ?? null, ornekHizi: s.sampleRate ?? null, cikarici: !!isleyici, baglamHizi: isleyici ? isleyici.ac.sampleRate : null });
	} catch {}
	const ekle = yayinVar();
	if (!ekle) yayin.ekransiz = true;
	yayinSesiTak(isleyici ? isleyici.iz : ses, id || 'varsayilan', ad, isleyici);
	yayinDegisti();
	const kaynak = ad ? ` (${ad})` : '';
	const not = isleyici ? '' : ' Bu tarayıcıda kanaldakilerin sesi paylaşımdan çıkarılamıyor: kendi seslerini geri duyabilirler.';
	durum((ekle ? `Ses de paylaşılıyor${kaynak}.` : `Ekransız paylaşıyorsun: yalnızca ses gidiyor${kaynak}.`) + not, !isleyici);
}

// --- ses aygıtından paylaşımda kanaldakilerin sesini çıkarma (bkz. yanki.js)
//
// Sayfa ne çaldığını bilir: çalınan her akış (kanaldakilerin mikrofonu ve paylaşımları, <audio>'nun
// seviyesi ve susturmasıyla) AudioWorklet'in ayrı bir girişine (yuva) bağlanır; her birinin gecikmesi
// ayrı bulunur ve yakalanan sesten çıkarılır. Gecikme ve süzgeçler bir Web Worker'da bulunur (sayfa
// yorulmasın), sayfa ikisi arasında iletir. Ses bağlamı çalışmıyorsa (ya da tarayıcı
// AudioWorklet/Worker sunmuyorsa) ham ses gider.

const YANKI_YUVA = 20; // yanki.js ile aynı: worklet'in referans girişi sayısı
let yankiModulu = null; // { ac, soz }: worklet bağlam başına bir kez yüklenir

async function yankiCikariciKur(ham) {
	const ac = sesBaglami();
	if (!ac || !ac.audioWorklet || typeof AudioWorkletNode !== 'function' || typeof Worker !== 'function' || typeof ac.createMediaStreamDestination !== 'function') return null;
	if (ac.state !== 'running') {
		try {
			await Promise.race([ac.resume(), new Promise((r) => setTimeout(r, 1500))]);
		} catch {}
		if (ac.state !== 'running') return null;
	}
	try {
		if (!yankiModulu || yankiModulu.ac !== ac) yankiModulu = { ac, soz: ac.audioWorklet.addModule('yanki.js') };
		await yankiModulu.soz;
	} catch (h) {
		yankiModulu = null;
		console.warn('yankı çıkarıcı yüklenemedi', h);
		return null;
	}
	const y = { ac, ham, referans: new Map(), ozet: null, ozetBekleyen: [], suzgec: null, suzgecler: new Map(), denemeler: [], kapandi: false, t0: Date.now() };
	try {
		y.dugum = new AudioWorkletNode(ac, 'yanki-cikarici', { numberOfInputs: 1 + YANKI_YUVA, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
		y.kaynak = ac.createMediaStreamSource(new MediaStream([ham]));
		y.hedef = ac.createMediaStreamDestination();
		y.kaynak.connect(y.dugum, 0, 0);
		y.dugum.connect(y.hedef);
		y.iz = y.hedef.stream.getAudioTracks()[0];
		y.isci = new Worker('yanki.js');
		y.isci.postMessage({ tur: 'kur', hiz: ac.sampleRate });
		y.dugum.port.onmessage = (e) => {
			const v = e.data || {};
			if (y.kapandi) return;
			if (v.tur === 'ornek') y.isci.postMessage(v, [v.m.buffer, ...Object.values(v.r || {}).map((d) => d.buffer)]);
			else if (v.tur === 'ozet') {
				y.ozet = v.ozet;
				for (const f of y.ozetBekleyen.splice(0)) f(v.ozet);
			}
		};
		y.isci.onmessage = (e) => {
			const v = e.data || {};
			if (y.kapandi) return;
			if (v.tur === 'deneme') {
				// Son tahmin denemeleri (teşhis): ne zaman, hangi yuva, hangi gecikme, ne kadar belirgin, kabul mü.
				if (v.etkin === false) return;
				y.denemeler.push({ sn: Math.round((Date.now() - y.t0) / 100) / 10, yuva: v.yuva, D: v.D, guven: v.guven, anlamli: v.anlamli, kabul: v.kabul });
				if (y.denemeler.length > 12) y.denemeler.shift();
				return;
			}
			if (v.tur !== 'suzgec') return;
			y.dugum.port.postMessage(v);
			const ilk = !y.suzgec && v.w;
			const bilgi = v.w ? { yuva: v.yuva, gecikmeMs: Math.round(((v.D0 + v.w.length / 2) / ac.sampleRate) * 10000) / 10, azalmaDb: Math.round(v.azalmaDb * 10) / 10, guven: Math.round(v.guven) } : null;
			if (bilgi) {
				y.suzgecler.set(v.yuva, bilgi);
				y.suzgec = bilgi; // en son kurulan (teşhis ve denemeler için)
			} else y.suzgecler.delete(v.yuva);
			if (ilk) taniGonder({ olay: 'yayin-yanki', ...bilgi });
		};
		y.isci.onerror = (h) => console.warn('yankı tahmini durdu', h && h.message);
	} catch (h) {
		console.warn('yankı çıkarıcı kurulamadı', h);
		yankiCikariciKapat(y);
		return null;
	}
	yankiReferansGuncelle(y);
	return y;
}

function yankiCikariciKapat(y) {
	if (!y || y.kapandi) return;
	y.kapandi = true;
	for (const f of y.ozetBekleyen.splice(0)) f(null);
	try {
		if (y.dugum) {
			y.dugum.port.postMessage({ tur: 'bitir' });
			y.dugum.port.onmessage = null;
		}
	} catch {}
	for (const r of y.referans.values()) {
		try {
			r.kaynak.disconnect();
			r.kazanc.disconnect();
		} catch {}
	}
	y.referans.clear();
	for (const d of [y.kaynak, y.dugum]) {
		try {
			if (d) d.disconnect();
		} catch {}
	}
	try {
		if (y.iz) y.iz.stop();
	} catch {}
	try {
		if (y.isci) y.isci.terminate();
	} catch {}
}

// Yuvaları çalınanlara uydur: her eşin mikrofonu ve paylaşımı kendi yuvasında, <audio>'su ne
// çalıyorsa o seviyede (susturulmuş, sağırlaştırılmış ya da henüz çalmayan: 0). Seviye/susturma
// değişince, eş gelip gidince ve gözcüde (saniyede bir) çağrılır.
function yankiReferansGuncelle(y = yayin.yanki) {
	if (!y || y.kapandi) return;
	const gorulen = new Set();
	for (const es of esler.values()) {
		for (const a of [es.ses, es.yayinSesOgesi]) {
			// Öğe çalmaya başlayınca / durunca / seviyesi değişince referans hemen uysun.
			if (a && !a.yankiDinleniyor) {
				a.yankiDinleniyor = true;
				for (const olay of ['playing', 'pause', 'volumechange', 'emptied']) a.addEventListener(olay, () => yankiReferansGuncelle());
			}
			const akis = a && a.srcObject;
			if (!akis || typeof akis.getAudioTracks !== 'function' || !akis.getAudioTracks().length) continue;
			gorulen.add(akis);
			let r = y.referans.get(akis);
			if (!r) {
				const dolu = new Set([...y.referans.values()].map((x) => x.yuva));
				let yuva = 0;
				while (dolu.has(yuva)) yuva++;
				if (yuva >= YANKI_YUVA) continue;
				try {
					const kaynak = y.ac.createMediaStreamSource(akis);
					// Stereo (tek kanallı mikrofon iki yana eşit gider), <audio>'nun seviyesiyle.
					const kazanc = y.ac.createGain();
					kazanc.channelCount = 2;
					kazanc.channelCountMode = 'explicit';
					kazanc.channelInterpretation = 'speakers';
					kaynak.connect(kazanc);
					kazanc.connect(y.dugum, 0, 1 + yuva);
					r = { kaynak, kazanc, yuva };
					y.referans.set(akis, r);
				} catch {
					continue;
				}
			}
			const g = a.muted || a.paused ? 0 : a.volume;
			if (r.kazanc.gain.value !== g) r.kazanc.gain.value = g;
		}
	}
	for (const [akis, r] of y.referans) {
		if (gorulen.has(akis)) continue;
		try {
			r.kaynak.disconnect();
			r.kazanc.disconnect();
		} catch {}
		y.referans.delete(akis);
		// Yuva boşaldı: worklet de tahmin de o yuvanın geçmişini unutsun (yeni akış temiz başlar).
		y.suzgecler.delete(r.yuva);
		try {
			y.dugum.port.postMessage({ tur: 'yuva-bos', yuva: r.yuva });
			y.isci.postMessage({ tur: 'yuva-bos', yuva: r.yuva });
		} catch {}
	}
}

// Ses bağlamı durdu (ör. sistem askıya aldı): çıkarıcının çıkışı sessizleşir, paylaşımın ham sesi
// gider; bağlam yeniden çalışınca çıkarıcıya dönülür.
function yankiBaglamDegisti() {
	const y = yayin.yanki;
	if (!y || y.kapandi) return;
	const iz = baglam === y.ac && baglam.state === 'running' ? y.iz : y.ham;
	if (yayin.ses === iz) return;
	yayin.ses = iz;
	yayinDegisti();
}

// Çıkarıcının durumu (worklet'ten): gecikme, ölçek, yakalananla çıkanın oranı, yakalamadaki kopukluklar.
function yankiOzeti(y = yayin.yanki) {
	if (!y || y.kapandi) return Promise.resolve(null);
	return new Promise((tamam) => {
		y.ozetBekleyen.push(tamam);
		try {
			y.dugum.port.postMessage({ tur: 'ozet' });
		} catch {
			tamam(null);
		}
		setTimeout(() => tamam(null), 2000);
	});
}

$('ses-kaynagi-paylas').addEventListener('click', sesKaynagiPaylas);
$('ses-kaynagi-iptal').addEventListener('click', sesKaynagiKapat);
$('ses-kaynagi-kapat').addEventListener('click', sesKaynagiKapat);
$('ses-kaynagi').addEventListener('click', (e) => {
	if (e.target === $('ses-kaynagi')) sesKaynagiKapat();
});

// --- izleme: başkasının ekranını kapat / yeniden aç (yalnızca görüntü; ses sürer)

function izlemeAyarla(es, izle) {
	es.izliyorum = !!izle;
	gonder({ type: 'izle', to: es.ad, izle: es.izliyorum });
	yayinlarCiz();
}
function izleGeldi(ad, izle) {
	const es = esler.get(ad);
	if (!es) return;
	es.izliyor = izle;
	yayinIzleriniBagla(es);
	bitHizlariniAyarla();
	yayinlarCiz(); // izleyen sayısı
}
// Kanaldakilerin paylaşımı değişti (sunucudan): haber ver; biten paylaşımdan sonra bir sonraki yine
// kendiliğinden izlenir.
function yayinDurumlariDegisti(onceki) {
	if (!sesKanal) return;
	for (const es of esler.values()) {
		const o = (onceki.get(es.ad) || {}).yayin || null;
		const s = (sesDurumlari.get(es.ad) || {}).yayin || null;
		if (o && !s) {
			es.izliyorum = true;
			sesCal('kisi-cikti');
		} else if (!o && s) {
			if (!es.izliyorum) gonder({ type: 'izle', to: es.ad, izle: false });
			durum(s.goruntu ? `${es.ad} ekranını paylaşıyor.` : `${es.ad} ekransız paylaşıyor (yalnızca ses).`);
			sesCal('kisi-girdi');
		} else if (o && s && o.goruntu !== s.goruntu) {
			durum(s.goruntu ? `${es.ad} ekranını gösteriyor.` : `${es.ad} ekranını gizledi; yalnızca sesi geliyor.`);
		}
	}
}

// Eşin paylaşımının sesi yalnızca o kişi sesli bir paylaşım yaparken ölçülür (kartın ışığı ve çubuğu).
function yayinOlceriAyarla(es) {
	const y = (sesDurumlari.get(es.ad) || {}).yayin;
	const gerekli = !!(sesKanal && y && y.ses && es.yayinAkis);
	if (gerekli === !!es.yayinOlcer) return;
	if (es.yayinOlcer) {
		es.yayinOlcer.dur();
		es.yayinOlcer = null;
		return;
	}
	es.yayinOlcer = seviyeOlcer(es.yayinAkis, (caliyor, seviye) => kartSesi('es:' + es.ad, caliyor && !es.yayinSusturuldu && !ayar.sagir, seviye));
}

// Yayın kartının ses göstergesi: ses duyuldukça kart ışır, çubuk gelen sesin seviyesini gösterir.
function kartSesi(anahtar, caliyor, seviye) {
	const k = yayinKartlari.get(anahtar);
	if (!k) return;
	if (k.kok.classList.contains('ses-var') !== caliyor) k.kok.classList.toggle('ses-var', caliyor);
	k.dolgu.style.width = Math.round((seviye || 0) * 100) + '%';
}

// --- yayın kartları (ses kartında, kişilerin üstünde): kendi paylaşımım + kanaldakilerinki.
// Kartlar anahtarla tutulur, her çizimde yeniden yaratılmaz (oynayan görüntü bozulmasın).

const yayinKartlari = new Map(); // 'ben' ya da 'es:<ad>' -> { kok, guncelle, es, dolgu }
function yayinlarCiz() {
	const kap = $('yayinlar');
	if (!kap) return;
	const istenen = [];
	if (sesKanal) {
		if (yayinVar()) istenen.push(['ben', null]);
		for (const es of esler.values()) if ((sesDurumlari.get(es.ad) || {}).yayin) istenen.push(['es:' + es.ad, es]);
	}
	const anahtarlar = new Set(istenen.map(([a]) => a));
	for (const [a, k] of yayinKartlari) {
		if (anahtarlar.has(a)) continue;
		k.kok.remove();
		yayinKartlari.delete(a);
	}
	istenen.forEach(([a, es], i) => {
		let k = yayinKartlari.get(a);
		if (!k || k.es !== es) {
			if (k) k.kok.remove();
			k = es ? yayinKarti(es) : benimYayinKartim();
			yayinKartlari.set(a, k);
		}
		if (kap.children[i] !== k.kok) kap.insertBefore(k.kok, kap.children[i] || null);
		k.guncelle();
	});
	kap.hidden = !istenen.length;
	for (const es of esler.values()) yayinOlceriAyarla(es);
}

function videoYap(sinif) {
	const v = el('video', 'yayin-video' + (sinif ? ' ' + sinif : ''));
	v.autoplay = true;
	v.muted = true; // yayının sesi ayrı kanaldan gelir
	v.playsInline = true;
	v.setAttribute('playsinline', '');
	return v;
}
function videoyaBagla(v, iz) {
	const mevcut = v.srcObject && typeof v.srcObject.getVideoTracks === 'function' ? v.srcObject.getVideoTracks()[0] : null;
	if (!iz) {
		if (v.srcObject) v.srcObject = null;
		return;
	}
	if (mevcut !== iz) {
		try {
			v.srcObject = new MediaStream([iz]);
		} catch {}
	}
	if (v.paused) oynat(v).catch(() => {});
}
function tamEkran(kap, v) {
	if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
	if (kap.requestFullscreen) kap.requestFullscreen().catch(() => v && v.webkitEnterFullscreen && v.webkitEnterFullscreen());
	else if (v && v.webkitEnterFullscreen) v.webkitEnterFullscreen(); // iPhone
}
function ikonDugmesi(ad, baslik, fn, sinif = '') {
	const d = el('button', 'ikon-dugme' + (sinif ? ' ' + sinif : ''));
	d.type = 'button';
	d.title = baslik;
	d.setAttribute('aria-label', baslik);
	d.append(ikon(ad));
	d.onclick = fn;
	return d;
}
function seviyeCubugu(baslik) {
	const cubuk = el('div', 'seviye-cubuk');
	const dolgu = el('div');
	cubuk.append(dolgu);
	cubuk.title = baslik;
	return { cubuk, dolgu };
}

// Kanaldaki birinin paylaşımı: ekranlıysa görüntü (izle / kapat, tam ekran), sesliyse ses satırı
// (susturma ve seviye yalnızca sende; çubuk ses geldikçe dolar).
function yayinKarti(es) {
	const kok = el('div', 'yayin-kart');
	kok.dataset.ad = es.ad;
	const ust = el('div', 'yayin-ust');
	const aciklama = el('span', 'yayin-aciklama');
	const sahne = el('div', 'yayin-sahne');
	const video = es.goruntuOgesi || (es.goruntuOgesi = videoYap());
	const bekle = el('div', 'yayin-bekle', 'Görüntü bekleniyor…');
	sahne.append(video, bekle);
	sahne.addEventListener('dblclick', () => tamEkran(sahne, video));
	const tam = ikonDugmesi('tam-ekran', 'Tam ekran', () => tamEkran(sahne, video));
	const izle = el('button', 'yayin-dugme');
	izle.type = 'button';
	izle.onclick = () => izlemeAyarla(es, !es.izliyorum);
	ust.append(el('span', 'canli', 'CANLI'), el('b', null, es.ad), aciklama, el('span', 'bosluk'), tam, izle);
	const sesSatir = el('div', 'yayin-ses');
	const sus = ikonDugmesi(
		'hoparlor',
		'',
		() => {
			es.yayinSusturuldu = !es.yayinSusturuldu;
			depoYaz('yayin-sustur-' + es.ad, es.yayinSusturuldu ? '1' : null);
			esSesUygula(es);
			guncelle();
		},
		'sus',
	);
	const { cubuk, dolgu } = seviyeCubugu('Paylaşılan sesin seviyesi');
	const seviye = el('input', 'ses-seviye');
	Object.assign(seviye, { type: 'range', min: 0, max: 100, step: 1 });
	seviye.value = String(es.yayinSeviye);
	seviye.title = 'Ses seviyesi (yalnızca sende)';
	seviye.setAttribute('aria-label', es.ad + ' paylaşımının ses seviyesi');
	seviye.oninput = () => {
		es.yayinSeviye = Number(seviye.value);
		depoYaz('yayin-seviye-' + es.ad, seviye.value);
		esSesUygula(es);
	};
	sesSatir.append(sus, cubuk, seviye);
	kok.append(ust, sahne, sesSatir);
	const guncelle = () => {
		const y = (sesDurumlari.get(es.ad) || {}).yayin || {};
		const ekranli = !!y.goruntu;
		const izliyorum = es.izliyorum;
		kok.classList.toggle('ekransiz', !ekranli);
		aciklama.textContent = ekranli ? ' ekranını paylaşıyor' : ' ekransız paylaşıyor · yalnızca ses';
		sahne.hidden = !ekranli || !izliyorum;
		tam.hidden = sahne.hidden;
		izle.hidden = !ekranli;
		izle.textContent = izliyorum ? 'Görüntüyü kapat' : 'Görüntüyü aç';
		izle.title = izliyorum ? 'Görüntü sana gönderilmesin (ses sürer, bant genişliği harcanmaz)' : 'Ekranı izle';
		videoyaBagla(video, ekranli && izliyorum ? es.uzakGoruntu : null);
		bekle.hidden = !!(es.uzakGoruntu && !es.uzakGoruntu.muted && es.uzakGoruntu.readyState === 'live');
		sesSatir.hidden = !y.ses;
		const susuk = es.yayinSusturuldu;
		ikonKoy(sus, susuk ? 'hoparlor-kapali' : 'hoparlor');
		sus.classList.toggle('kapali', susuk);
		sus.title = susuk ? 'Paylaşımın sesini aç' : 'Paylaşımın sesini yalnızca kendin için sustur';
		sus.setAttribute('aria-label', `${es.ad} paylaşımının sesini ${susuk ? 'aç' : 'sustur'}`);
		kok.classList.toggle('susturuldu', susuk);
	};
	return { kok, guncelle, es, dolgu };
}

// Kendi paylaşımım: ekranı göster / gizle (sesi varsa), ses ekle (ekran paylaşımı ses vermeyen
// tarayıcıda, sessiz ekran paylaşımına), durdur; ekranlıysa küçük önizleme.
function benimYayinKartim() {
	const kok = el('div', 'yayin-kart ben');
	const ust = el('div', 'yayin-ust');
	const metin = el('span', 'yayin-metin');
	const sesEkle = el('button', 'yayin-dugme', 'Ses ekle');
	sesEkle.type = 'button';
	sesEkle.title = 'Bilgisayarın sesini de paylaş (ses aygıtından)';
	sesEkle.onclick = () => sesKaynagiAc();
	const gizle = el('button', 'yayin-dugme');
	gizle.type = 'button';
	gizle.onclick = () => ekransizAyarla(!yayin.ekransiz);
	const durdur = el('button', 'yayin-dugme tehlike', 'Durdur');
	durdur.type = 'button';
	durdur.title = 'Paylaşımı durdur';
	durdur.onclick = () => yayinDurdur();
	ust.append(el('span', 'canli', 'CANLI'), metin, el('span', 'bosluk'), sesEkle, gizle, durdur);
	const onizleme = videoYap('kucuk-onizleme');
	const sesSatir = el('div', 'yayin-ses');
	const sesIkon = el('span', 'yayin-ses-ikon');
	sesIkon.append(ikon('hoparlor'));
	const { cubuk, dolgu } = seviyeCubugu('Paylaştığın sesin seviyesi');
	sesSatir.append(sesIkon, cubuk);
	kok.append(ust, onizleme, sesSatir);
	const guncelle = () => {
		const kisi = esSayisi();
		const izleyen = [...esler.values()].filter((e) => !e.bekleniyor && e.izliyor).length;
		kok.classList.toggle('ekransiz', yayin.ekransiz);
		if (yayin.ekransiz) metin.textContent = 'Ekransız paylaşıyorsun · yalnızca ses gidiyor' + (kisi ? '' : ' · kanalda yalnızsın');
		else metin.textContent = 'Ekranını paylaşıyorsun' + (kisi ? ` · ${izleyen}/${kisi} kişi izliyor` : ' · kanalda yalnızsın');
		metin.title = yayin.aygitAdi ? 'Ses: ' + yayin.aygitAdi : '';
		sesEkle.hidden = !!yayin.ses || ekranSesiVar();
		gizle.hidden = !yayin.ses;
		gizle.textContent = yayin.ekransiz ? 'Ekranı göster' : 'Ekranı gizle';
		if (!yayin.ekransiz) gizle.title = 'Ekran gönderilmesin, yalnızca ses gitsin';
		else gizle.title = yayin.goruntu ? 'Ekran da gönderilsin (yeniden seçmeden)' : 'Ekranı da paylaş (seçim penceresi açılır)';
		onizleme.hidden = yayin.ekransiz;
		videoyaBagla(onizleme, yayin.ekransiz ? null : yayin.goruntu);
		sesSatir.hidden = !yayin.ses;
	};
	return { kok, guncelle, es: null, dolgu };
}

// --- paylaşım menüsü (ses kartındaki yayın düğmesi; tarayıcı ekran paylaşımı sunmuyorsa gizli)

function yayinMenusuCiz() {
	const m = $('yayin-menu');
	const d = $('yayin-ac');
	d.hidden = !yayinVar() && !ekranPaylasilabilir();
	d.classList.toggle('secili', yayinVar());
	if (m.hidden) return;
	m.replaceChildren();
	const ekle = (ikonAd, baslik, aciklama, fn) => {
		const o = el('button', 'yayin-menu-oge');
		o.type = 'button';
		o.setAttribute('role', 'menuitem');
		const yazi = el('span', 'yayin-menu-yazi');
		yazi.append(el('b', null, baslik));
		if (aciklama) yazi.append(el('small', null, aciklama));
		o.append(ikon(ikonAd), yazi);
		o.onclick = () => {
			yayinMenuKapat();
			fn();
		};
		m.append(o);
	};
	// Ekran paylaşımı ses vermeyen tarayıcıda (Firefox, Safari) ses bir ses aygıtından gelir.
	const ekranSesli = ekranSesiVar();
	if (!yayinVar()) {
		ekle('ekran', 'Ekranını paylaş', ekranSesli ? 'Ekran, pencere ya da sekme; istersen sesiyle' : 'Ekran ya da pencere; sesi sonra eklersin', () => yayinBaslat(false));
		ekle('hoparlor', 'Ekransız paylaş', ekranSesli ? 'Yalnızca ses: sekmenin ya da bilgisayarın sesi' : 'Yalnızca ses: bilgisayarın sesi (ses aygıtından)', () => yayinBaslat(true));
	} else {
		if (!yayin.ses && !ekranSesli) ekle('hoparlor', 'Ses ekle', 'Bilgisayarın sesi (ses aygıtından)', () => sesKaynagiAc());
		if (yayin.ses && yayin.ekransiz) ekle('ekran', 'Ekranı göster', yayin.goruntu ? 'Aynı paylaşım, yeniden seçmeden' : 'Ekranı da paylaş (seçim penceresi açılır)', () => ekransizAyarla(false));
		else if (yayin.ses) ekle('ekran-kapali', 'Ekranı gizle', 'Yalnızca ses gitsin', () => ekransizAyarla(true));
		ekle('dur', 'Paylaşımı durdur', '', () => yayinDurdur());
	}
	m.append(
		el(
			'p',
			'yayin-menu-not',
			ekranSesli
				? 'Ses için seçim penceresinde sesi paylaşma seçeneğini aç: sekmenin sesi her bilgisayarda gider, tüm bilgisayarın sesi Windows\'ta "Tüm ekran" seçilince. Hoparlörden dinliyorsan kulaklık kullan (mikrofonun sesi geri alır).'
				: 'Bu tarayıcı ekranla birlikte ses paylaşamaz; ses bir ses aygıtından alınır (Linux\'ta bilgisayarın sesi "Monitor of …" aygıtıdır). Hoparlörden dinliyorsan kulaklık kullan (mikrofonun sesi geri alır).',
		),
	);
}
function yayinMenuKapat() {
	$('yayin-menu').hidden = true;
	$('yayin-ac').setAttribute('aria-expanded', 'false');
}
// Menü ses kartının dışına taşabilir (kart overflow:hidden): ekrana göre konumlanır.
$('yayin-ac').addEventListener('click', (e) => {
	e.stopPropagation();
	const m = $('yayin-menu');
	if (!m.hidden) return yayinMenuKapat();
	m.hidden = false;
	$('yayin-ac').setAttribute('aria-expanded', 'true');
	yayinMenusuCiz();
	const r = $('yayin-ac').getBoundingClientRect();
	const genislik = Math.min(300, window.innerWidth - 16);
	m.style.width = genislik + 'px';
	m.style.left = Math.max(8, Math.min(window.innerWidth - genislik - 8, r.right - genislik)) + 'px';
	const yukseklik = m.offsetHeight || 220;
	const asagi = r.bottom + 6 + yukseklik <= window.innerHeight - 8;
	m.style.top = (asagi ? r.bottom + 6 : Math.max(8, r.top - 6 - yukseklik)) + 'px';
});
document.addEventListener('click', (e) => {
	if (!$('yayin-menu').hidden && !(e.target && e.target.closest && e.target.closest('.yayin-menu-kap'))) yayinMenuKapat();
});

// ---------------------------------------------------------------- bildirim sesleri

const SESLER = {
	giris: [[523.25, 0], [783.99, 0.09]],
	cikis: [[783.99, 0], [523.25, 0.09]],
	'kisi-girdi': [[659.25, 0], [880, 0.08]],
	'kisi-cikti': [[880, 0], [659.25, 0.08]],
	sessiz: [[392, 0]],
	acik: [[587.33, 0]],
	kapi: [[740, 0], [740, 0.16]],
};
function sesCal(tur) {
	// Yalnızca zaten çalışan bir ses bağlamıyla (kullanıcı sesli kanala girdiyse): sayfa açılır
	// açılmaz ses çalmaya kalkışmayalım.
	if (!ayar.sesler || !baglam || baglam.state !== 'running') return;
	const notalar = SESLER[tur];
	if (!notalar) return;
	try {
		const t0 = baglam.currentTime + 0.02;
		for (const [frekans, gecikme] of notalar) {
			const osc = baglam.createOscillator();
			const g = baglam.createGain();
			osc.type = 'sine';
			osc.frequency.value = frekans;
			g.gain.setValueAtTime(0, t0 + gecikme);
			g.gain.linearRampToValueAtTime(0.06, t0 + gecikme + 0.015);
			g.gain.exponentialRampToValueAtTime(0.0001, t0 + gecikme + 0.17);
			osc.connect(g);
			g.connect(baglam.destination);
			osc.start(t0 + gecikme);
			osc.stop(t0 + gecikme + 0.2);
		}
	} catch {}
}

// ---------------------------------------------------------------- gözcü, istatistik, teşhis

// Ses gözcüsü: çalmayan eş varsa her saniye yeniden dener ve görünen düğmeyi açar (bazı mobil
// tarayıcılarda play() sözü hiç sonuçlanmıyor, hata yolundaki düğme hiç çıkmıyordu).
let sesGozcu = null;
function sesGozcuBaslat() {
	if (sesGozcu) return;
	sesGozcu = setInterval(() => {
		if (!sesKanal) return;
		yankiReferansGuncelle(); // çalmaya başlayan / duran <audio>'lar
		let bekleyen = 0;
		for (const es of esler.values()) {
			const bekleyenler = gelenSesler(es).filter((a) => !a.muted && a.paused);
			if (!bekleyenler.length) {
				es.calmaDenemesi = 0;
				continue;
			}
			es.calmaDenemesi = (es.calmaDenemesi || 0) + 1;
			if (es.calmaDenemesi >= 2) bekleyen++;
			if (es.calmaDenemesi % 3 === 0) for (const a of bekleyenler) oynat(a).catch(() => {});
		}
		$('ses-ac').hidden = !bekleyen;
	}, 1000);
}
function sesGozcuDurdur() {
	clearInterval(sesGozcu);
	sesGozcu = null;
}

// Her eş için: bağlantı türü (P2P / TURN), gecikme, ses kalitesi ve bit hızı (iki ölçüm arasındaki
// farktan; kümülatif oran eski kayıpları sonsuza dek taşıdığı için yanıltıcı).
//
// Ses kalitesi: eskiden tek bir 2 saniyelik ölçümde %5 paket kaybı görülünce "Bağlantı zayıf"
// (kırmızı) deniyordu. Opus'un yedek verisi (FEC) ve kayıp gizleme bu kadar kısa kayıpları duyulmaz
// kılar: ses iyiyken uyarı çıkıyordu. Şimdi DUYULAN bozulma ölçülür: alıcının kayıp yüzünden
// uydurmak zorunda kaldığı ses (concealedSamples; sessiz olanlar hariç) son ~10 saniyede toplam sesin
// ne kadarı? (Bu ölçü yoksa — eski tarayıcı — 10 sn'lik kayıp oranı.) Bağlantı yeni kurulduysa ya da
// karşı taraf ses göndermiyorsa karar verilmez. Yalnızca mikrofon kanalının istatistikleri kullanılır
// (yayın sesi ve görüntü ayrı kanallardadır; eskiden "son ses kaydı" hangisiyse o okunuyordu).
const KALITE_PENCERESI = 5; // ölçüm (2 sn'de bir) → ~10 sn
const GIZLEME_ORTA = 0.03;
const GIZLEME_KOTU = 0.1;
const KAYIP_ORTA = 0.04;
const KAYIP_KOTU = 0.12;

let istatistikZamanlayici = null;
function istatistikBaslat() {
	if (!istatistikZamanlayici) istatistikZamanlayici = setInterval(istatistikTuru, 2000);
}
function istatistikDurdur() {
	clearInterval(istatistikZamanlayici);
	istatistikZamanlayici = null;
}

// RTCRtpReceiver/Sender.getStats yalnızca o kanalın raporunu verir (yoksa bağlantınınki).
async function kanalRaporu(nesne, pc) {
	try {
		if (nesne && typeof nesne.getStats === 'function') return await nesne.getStats();
	} catch {}
	return pc.getStats();
}
// Rapordaki ses kaydı: birden çok varsa izin kimliği tutan, yoksa ilki.
function sesKaydi(rapor, tur, iz) {
	let ilk = null;
	let eslesen = null;
	rapor.forEach((r) => {
		if (r.type !== tur || (r.kind && r.kind !== 'audio') || (r.mediaType && r.mediaType !== 'audio')) return;
		if (!ilk) ilk = r;
		if (iz && r.trackIdentifier === iz.id) eslesen = r;
	});
	return eslesen || ilk;
}
function seciliCift(rapor) {
	let cift = null;
	rapor.forEach((r) => {
		if (r.type === 'transport' && r.selectedCandidatePairId) cift = rapor.get(r.selectedCandidatePairId) || cift;
	});
	if (!cift) {
		rapor.forEach((r) => {
			if (!cift && r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) cift = r;
		});
	}
	return cift ? { cift, rapor } : null;
}

// Son ~10 saniyenin ölçümlerinden kalite sınıfı: '' (iyi), 'orta', 'kotu'.
function kaliteHesapla(pencere) {
	const ornekler = pencere.filter((d) => d.alinan > 0 && !d.erken);
	let alinan = 0;
	let kayip = 0;
	for (const d of pencere) {
		alinan += Math.max(0, d.alinan);
		kayip += d.kayip;
	}
	const kayipOrani = alinan + kayip > 0 ? kayip / (alinan + kayip) : null;
	if (ornekler.length < 2) return { sinif: '', kayip: kayipOrani, gizleme: null, olculdu: false };
	let ornek = 0;
	let gizli = 0;
	let gizlemeVar = true;
	for (const d of ornekler) {
		if (d.ornek == null || d.ornek <= 0) gizlemeVar = false;
		else {
			ornek += d.ornek;
			gizli += d.gizli;
		}
	}
	if (gizlemeVar && ornek > 0) {
		const g = gizli / ornek;
		return { sinif: g >= GIZLEME_KOTU ? 'kotu' : g >= GIZLEME_ORTA ? 'orta' : '', kayip: kayipOrani, gizleme: g, olculdu: true };
	}
	const k = kayipOrani || 0;
	return { sinif: k >= KAYIP_KOTU ? 'kotu' : k >= KAYIP_ORTA ? 'orta' : '', kayip: kayipOrani, gizleme: null, olculdu: true };
}
const yuzdeYaz = (x) => '%' + (Math.round(x * 1000) / 10).toLocaleString('tr-TR');

// Gelen bir ses kanalının (inbound-rtp kaydı) önceki ölçümden farkı; ölçüm es[olcumAd]'da tutulur.
// İlk ölçümde (ya da çok yakın iki ölçümde) null. gizli: sessiz olmayan uydurulan örnekler (duyulan
// bozulma), gizliTum: hepsi (çözülemeyen akışta uydurulan ses kısa sürede sessizleşir).
function gelenFark(es, olcumAd, gelen, simdi) {
	const onceki = es[olcumAd];
	const o = {
		zaman: simdi,
		alinan: gelen.packetsReceived || 0,
		kayip: gelen.packetsLost || 0,
		bayt: gelen.bytesReceived || 0,
		ornek: gelen.totalSamplesReceived,
		gizli: gelen.concealedSamples != null ? gelen.concealedSamples - (gelen.silentConcealedSamples || 0) : null,
		gizliTum: gelen.concealedSamples,
	};
	es[olcumAd] = o;
	if (!onceki || simdi - onceki.zaman <= 400) return null;
	const fark = (a) => (o[a] != null && onceki[a] != null ? Math.max(0, o[a] - onceki[a]) : null);
	return {
		alinan: o.alinan - onceki.alinan,
		kayip: Math.max(0, o.kayip - onceki.kayip),
		ornek: o.ornek != null && onceki.ornek != null ? o.ornek - onceki.ornek : null,
		gizli: fark('gizli'),
		gizliTum: fark('gizliTum'),
		kbps: Math.max(0, Math.round(((o.bayt - onceki.bayt) * 8) / (simdi - onceki.zaman))),
		// Bağlantı yeni kurulduysa (alıcı tamponu dolarken biraz ses uydurulur) sayılmaz.
		erken: simdi - (es.baglandiZaman || 0) < 6000,
	};
}

// Paket geliyor ama ses hep uyduruluyor (alıcı çözemiyor): üç ölçüm (~6 sn) üst üste sürerse teşhise
// yazılır; o kanalda RED anlaşılmışsa o eşte RED bırakılır (düz Opus'la yeniden anlaşılır).
function cozumGozcusu(es, kanal, tr, d) {
	if (!es.cozulemeyen) es.cozulemeyen = {};
	const bozuk = !d.erken && d.kbps >= 8 && d.ornek > 0 && d.gizliTum != null && d.gizliTum / d.ornek > 0.9;
	es.cozulemeyen[kanal] = bozuk ? (es.cozulemeyen[kanal] || 0) + 1 : 0;
	if (es.cozulemeyen[kanal] !== 3) return;
	const red = !!tr && redAnlasildi(tr, 'gelen');
	taniGonder({ olay: 'cozulemiyor', es: es.ad, kanal, kbps: d.kbps, red });
	if (red) redBirak(es, kanal);
}

async function istatistikTuru() {
	const ozet = { olculen: 0, kotu: [], orta: [], mikSorun: false, metin: '' };
	let enIyiRtt = null;
	let turnVar = false;
	for (const es of [...esler.values()]) {
		const pc = es.pc;
		if (!pc || pc.connectionState !== 'connected') continue;
		let gelenRapor;
		let gidenRapor;
		let yayinRapor = null;
		// Paylaşımın sesi yalnızca o kişi sesli bir paylaşım yaparken ölçülür (kanal ayrı).
		const yayinSesVar = !!((sesDurumlari.get(es.ad) || {}).yayin || {}).ses && !!es.trSes;
		try {
			[gelenRapor, gidenRapor, yayinRapor] = await Promise.all([
				kanalRaporu(es.tr && es.tr.receiver, pc),
				kanalRaporu(es.tr && es.tr.sender, pc),
				yayinSesVar ? kanalRaporu(es.trSes.receiver, pc) : null,
			]);
		} catch {
			continue;
		}
		if (es.pc !== pc) continue;
		const simdi = Date.now();
		const gelen = sesKaydi(gelenRapor, 'inbound-rtp', es.tr && es.tr.receiver && es.tr.receiver.track);
		const giden = sesKaydi(gidenRapor, 'outbound-rtp', es.tr && es.tr.sender && es.tr.sender.track);
		// Paylaşımın sesi: kendi penceresinde kayıp ve uydurulan ses (teşhis ve ipucu için).
		const yayinGelen = yayinRapor ? sesKaydi(yayinRapor, 'inbound-rtp', es.trSes.receiver.track) : null;
		if (yayinGelen) {
			const d = gelenFark(es, 'yayinOlcum', yayinGelen, simdi);
			if (d) {
				es.yayinPencere = (es.yayinPencere || []).concat([d]).slice(-KALITE_PENCERESI);
				const k = kaliteHesapla(es.yayinPencere);
				es.yayinSonKbps = d.kbps;
				es.yayinSonKayip = k.kayip != null ? Math.round(k.kayip * 1000) / 10 : null;
				es.yayinSonGizleme = k.gizleme != null ? Math.round(k.gizleme * 1000) / 10 : null;
				cozumGozcusu(es, 'yayin', es.trSes, d);
			}
		} else {
			es.yayinOlcum = null;
			es.yayinPencere = [];
			es.yayinSonKbps = es.yayinSonKayip = es.yayinSonGizleme = null;
		}
		const secili = seciliCift(gelenRapor) || seciliCift(gidenRapor);
		const parcalar = []; // görünen kısa özet: tür · gecikme (· kayıp · sorun)
		const ayrinti = []; // ipucu: bit hızları, titreşim, kayıp, gizleme
		let sinif = '';
		if (secili) {
			const { cift, rapor } = secili;
			const yerel = rapor.get(cift.localCandidateId);
			const uzak = rapor.get(cift.remoteCandidateId);
			const aktarim = (yerel && yerel.candidateType === 'relay') || (uzak && uzak.candidateType === 'relay');
			es.sonTip = aktarim ? 'TURN' : 'P2P';
			if (aktarim) turnVar = true;
			parcalar.push(es.sonTip);
			if (cift.currentRoundTripTime != null) {
				const ms = Math.round(cift.currentRoundTripTime * 1000);
				es.sonRtt = ms;
				parcalar.push(ms + ' ms');
				if (ms > 400) sinif = 'orta';
				if (enIyiRtt === null || ms < enIyiRtt) enIyiRtt = ms;
			}
		}
		if (gelen) {
			if (gelen.jitter != null) es.jitter = Math.round(gelen.jitter * 1000);
			const d = gelenFark(es, 'olcum', gelen, simdi);
			if (d) {
				if (d.kbps > 0) {
					es.sonKbps = d.kbps;
					ayrinti.push('gelen ' + es.sonKbps + ' kbps');
				}
				cozumGozcusu(es, 'mik', es.tr, d);
				es.pencere = (es.pencere || []).concat([d]).slice(-KALITE_PENCERESI);
				const k = kaliteHesapla(es.pencere);
				es.sonKayip = k.kayip != null ? Math.round(k.kayip * 1000) / 10 : null;
				es.sonGizleme = k.gizleme != null ? Math.round(k.gizleme * 1000) / 10 : null;
				if (k.kayip != null) ayrinti.push(yuzdeYaz(k.kayip) + ' kayıp');
				if (k.gizleme != null) ayrinti.push(yuzdeYaz(k.gizleme) + ' ses uyduruldu');
				if (k.olculdu) {
					ozet.olculen++;
					if (k.sinif === 'kotu') ozet.kotu.push(es.ad);
					else if (k.sinif === 'orta') ozet.orta.push(es.ad);
				}
				if (k.sinif) {
					parcalar.push(k.kayip >= 0.01 ? yuzdeYaz(k.kayip) + ' kayıp' : 'ses takılıyor');
					if (k.sinif === 'kotu') sinif = 'kotu';
					else if (sinif !== 'kotu') sinif = 'orta';
				}
			}
		}
		if (es.yayinSonKbps != null) {
			ayrinti.push(
				'paylaşım ' + es.yayinSonKbps + ' kbps' + (es.yayinSonKayip != null ? ', ' + yuzdeYaz(es.yayinSonKayip / 100) + ' kayıp' : '') + (es.yayinSonGizleme != null ? ', ' + yuzdeYaz(es.yayinSonGizleme / 100) + ' ses uyduruldu' : ''),
			);
		}
		if (es.tr && redAnlasildi(es.tr, 'giden')) ayrinti.push('kayıplara karşı yedekli (RED)');
		// Giden ses: mikrofon gerçekten karşıya gidiyor mu? (Tek yönlü ses şüphesinde kanıt.)
		if (giden) {
			const onceki = es.gidenOlcum;
			const bayt = giden.bytesSent || 0;
			if (onceki && simdi - onceki.zaman > 400) {
				const kbps = Math.round(((bayt - onceki.bayt) * 8) / (simdi - onceki.zaman));
				es.sonGiden = kbps;
				ayrinti.push('giden ' + kbps + ' kbps');
				if (kbps === 0 && gidenIz && !mikSessizMi() && simdi - (es.baglandiZaman || 0) > 6000) {
					es.sifirGiden = (es.sifirGiden || 0) + 1;
					// Tek tük sıfır olabilir; art arda üç ölçüm (~6 sn) gerçek sorundur.
					if (es.sifirGiden >= 3) {
						parcalar.push('mikrofon gitmiyor');
						sinif = 'kotu';
						ozet.mikSorun = true;
						if (es.sifirGiden === 3) taniGonder({ olay: 'mik-gitmiyor', es: es.ad, iz: !!(es.tr && es.tr.sender && es.tr.sender.track), yon: es.tr ? es.tr.currentDirection || null : null });
					}
				} else es.sifirGiden = 0;
			}
			es.gidenOlcum = { zaman: simdi, bayt };
		}
		// "Ses geliyor ama çalmıyor" ile "ses hiç gelmiyor"u ayır.
		if (es.ses && es.ses.srcObject && es.ses.paused && !es.ses.muted) {
			parcalar.push('⚠ çalmıyor');
			if (sinif !== 'kotu') sinif = 'orta';
		}
		if (!parcalar.length) continue;
		// Renk: TURN (relay) üzerinden bağlananlar turuncu; ciddi sorun (kırmızı) her zaman öne geçer.
		esIstatistikYaz(es, parcalar.join(' · '), sinif !== 'kotu' && es.sonTip === 'TURN' ? 'turn' : sinif);
		ayrinti.push('titreşim ' + (es.jitter != null ? es.jitter + ' ms' : '?'), 'gönderim tavanı ' + gonderimHizi() + ' kbps');
		es.istatistik.title = parcalar.concat(ayrinti.filter((x) => !parcalar.includes(x))).join(' · ') + ' (Opus VBR: ağ izin verdiği kadarını kullanır)';
	}
	if (enIyiRtt !== null) ozet.metin = (turnVar ? 'TURN' : 'P2P') + ' · ' + enIyiRtt + ' ms';
	sesPaneliCiz(ozet);
}

// Teşhis: 10 saniyede bir kendi ses durumunu sunucuya bildirir (sunucu YALNIZCA günlüğe yazar;
// "ses gelmiyor" şikayetinde cihazın ne gördüğünü uzaktan okumak için).
let taniZamanlayici = null;
function taniGonder(veri) {
	if (bagliyim) gonder({ type: 'tani', veri });
}

async function adayOzeti(pc) {
	const yerel = {};
	const uzak = {};
	try {
		const rapor = await pc.getStats();
		rapor.forEach((r) => {
			const anahtarAd = (r.candidateType || '?') + (r.protocol ? '/' + r.protocol : '');
			if (r.type === 'local-candidate') yerel[anahtarAd] = (yerel[anahtarAd] || 0) + 1;
			if (r.type === 'remote-candidate') uzak[anahtarAd] = (uzak[anahtarAd] || 0) + 1;
		});
	} catch {
		return null;
	}
	return { yerel, uzak };
}

async function taniVeri() {
	const liste = [];
	for (const [ad, es] of esler) {
		const pc = es.pc;
		const tr = es.tr;
		liste.push({
			ad,
			oturum: es.oturum,
			durum: pc ? pc.connectionState : null,
			ice: pc ? pc.iceConnectionState : null,
			sinyal: pc ? pc.signalingState : null,
			teklifEden: es.teklifci,
			yon: tr ? tr.direction : null,
			anlasilanYon: tr ? tr.currentDirection || null : null,
			gonderenIz: !!(tr && tr.sender && tr.sender.track),
			caliyor: es.ses ? !es.ses.paused : null,
			kbps: es.sonKbps ?? null,
			giden: es.sonGiden ?? null,
			kayip: es.sonKayip ?? null,
			gizleme: es.sonGizleme ?? null,
			tip: es.sonTip || null,
			rtt: es.sonRtt ?? null,
			kurtarma: es.kurtarma,
			// Kayıplara karşı yedek: bizim gönderdiğimiz mikrofon/paylaşım RED'li mi; bu eşte bırakıldı mı.
			red: { mik: !!es.tr && redAnlasildi(es.tr, 'giden'), yayin: !!es.trSes && redAnlasildi(es.trSes, 'giden'), birakildi: !!es.redKapali },
			// Onun paylaşımının sesi (paylaşıyorsa): gelen bit hızı, kayıp, uydurulan ses.
			yayinGelen: es.yayinSonKbps != null ? { kbps: es.yayinSonKbps, kayip: es.yayinSonKayip ?? null, gizleme: es.yayinSonGizleme ?? null } : null,
			yayinKanali: !!(es.trSes && es.trGoruntu),
			izliyor: es.izliyor,
			izliyorum: es.izliyorum,
			adaylar: pc ? await adayOzeti(pc) : null,
		});
	}
	const iz = mikrofon && mikrofon.getAudioTracks()[0];
	let micAyarlar = null;
	try {
		const s = iz && iz.getSettings ? iz.getSettings() : null;
		if (s) micAyarlar = { aec: s.echoCancellation ?? null, ns: s.noiseSuppression ?? null, agc: s.autoGainControl ?? null, kanal: s.channelCount ?? null, ornekHizi: s.sampleRate ?? null };
	} catch {}
	return {
		ua: navigator.userAgent.slice(0, 110),
		kanal: sesKanal,
		mikrofon: !!mikrofon,
		mikBirakildi,
		mikAcik: !mikSessizMi(),
		mikDurum: iz ? iz.readyState : null,
		micAyarlar,
		kazanc: ayar.mikSeviye,
		kalite: gonderimHizi(),
		sesBaglami: baglam ? baglam.state : null,
		iceSunucu: (ice.iceServers || []).map((s) => [].concat(s.urls || []).join('+')).join(',').slice(0, 200),
		yayin: yayinBilgisi(),
		yayinSes: await yayinSesiOzeti(),
		esler: liste,
	};
}

// Paylaşılan ses: kaynağı (ses aygıtı ya da ekran yakalaması), tarayıcının gerçekte uyguladığı ve
// (ses aygıtından paylaşımda) kanaldakilerin sesini çıkaranın durumu.
async function yayinSesiOzeti() {
	const iz = yayin.hamSes || yayin.ses;
	if (!iz) return null;
	let s = {};
	try {
		s = iz.getSettings ? iz.getSettings() : {};
	} catch {}
	const o = { kaynak: yayin.aygit ? 'aygit' : 'ekran', durum: iz.readyState, kanal: s.channelCount ?? null, aec: s.echoCancellation ?? null };
	if (yayin.aygit) {
		const y = yayin.yanki;
		o.cikarici = y ? { gidiyor: yayin.ses === y.iz, yuva: y.referans.size, suzgecler: [...y.suzgecler.values()], ...((await yankiOzeti(y)) || {}), denemeler: y.denemeler.slice(-4) } : null;
	}
	return o;
}

function taniBaslat() {
	if (taniZamanlayici) return;
	taniZamanlayici = setInterval(() => {
		if (sesKanal && bagliyim) taniVeri().then(taniGonder).catch(() => {});
	}, 10000);
}
function taniDurdur() {
	clearInterval(taniZamanlayici);
	taniZamanlayici = null;
}

// ---------------------------------------------------------------- ses ayarları penceresi

let denemeMik = null; // ayarlarda "Mikrofonu dene" için geçici akış (sesli kanalda değilken)
let denemeOlcer = null;

async function aygitlariDoldur() {
	if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') return;
	let aygitlar = [];
	try {
		aygitlar = await navigator.mediaDevices.enumerateDevices();
	} catch {
		return;
	}
	const doldur = (secim, tur, secili, varsayilanAd) => {
		secim.replaceChildren();
		const v = el('option', null, varsayilanAd);
		v.value = '';
		secim.append(v);
		let i = 0;
		for (const a of aygitlar.filter((x) => x.kind === tur && x.deviceId && x.deviceId !== 'default' && x.deviceId !== 'communications')) {
			const o = el('option', null, a.label || `${tur === 'audioinput' ? 'Mikrofon' : 'Hoparlör'} ${++i}`);
			o.value = a.deviceId;
			secim.append(o);
		}
		secim.value = [...secim.options].some((o) => o.value === secili) ? secili : '';
	};
	doldur($('ayar-mik'), 'audioinput', ayar.mikId, 'Varsayılan mikrofon');
	const cikisDesteklenir = typeof HTMLMediaElement !== 'undefined' && typeof HTMLMediaElement.prototype.setSinkId === 'function';
	doldur($('ayar-cikis'), 'audiooutput', ayar.cikisId, cikisDesteklenir ? 'Varsayılan hoparlör' : 'Sistemin varsayılanı (bu tarayıcıda seçilemiyor)');
	$('ayar-cikis').disabled = !cikisDesteklenir;
}

function ayarlarAc() {
	$('ayar-gurultu').checked = ayar.gurultu;
	$('ayar-yanki').checked = ayar.yanki;
	$('ayar-kazanc').checked = ayar.kazanc;
	$('ayar-mik-birak').checked = ayar.mikBirak;
	$('ayar-mik-seviye').value = String(ayar.mikSeviye);
	$('ayar-mik-seviye-deger').textContent = '%' + ayar.mikSeviye;
	$('ayar-kalite').value = String(ayar.kalite);
	$('ayar-sesler').checked = ayar.sesler;
	$('ayar-mik-dene').hidden = !!sesKanal;
	$('ayar-olcer-dolgu').style.width = '0%';
	$('ayarlar').hidden = false;
	aygitlariDoldur();
	$('ayarlar-kapat').focus();
}
function ayarlarKapat() {
	if ($('ayarlar').hidden) return;
	$('ayarlar').hidden = true;
	denemeyiBitir();
}
function denemeyiBitir() {
	if (denemeOlcer) denemeOlcer.dur();
	denemeOlcer = null;
	if (denemeMik) denemeMik.getTracks().forEach((t) => t.stop());
	denemeMik = null;
	$('ayar-mik-dene').textContent = 'Mikrofonu dene';
}
$('ben-ayarlar').addEventListener('click', ayarlarAc);
$('ayarlar-kapat').addEventListener('click', ayarlarKapat);
$('ayarlar').addEventListener('click', (e) => {
	if (e.target === $('ayarlar')) ayarlarKapat();
});
$('ayar-mik-dene').addEventListener('click', async () => {
	if (denemeMik) return denemeyiBitir();
	sesKilidiAc();
	try {
		denemeMik = await mikrofonAc();
	} catch (h) {
		durum(mikHataMetni(h), true);
		return;
	}
	aygitlariDoldur(); // izin verilince aygıt adları görünür
	$('ayar-mik-dene').textContent = 'Denemeyi bitir';
	denemeOlcer = seviyeOlcer(denemeMik, (k, seviye) => {
		$('ayar-olcer-dolgu').style.width = Math.round(Math.min(1, seviye * (ayar.mikSeviye / 100)) * 100) + '%';
	});
});

// Mikrofon ayarı değişti: sesli kanaldaysak yeni akışı al, eşlere bağla, eskisini kapat
// (yeniden anlaşma gerekmez; konuşma kesilmez).
async function mikrofonuYenile() {
	if (denemeMik) {
		denemeyiBitir();
		$('ayar-mik-dene').click();
	}
	// Susturulduğu için bırakılmışsa yeni ayar açınca alınan mikrofona uygulanır.
	if (!sesKanal || mikBirakildi || mikAliniyor) return;
	try {
		const akis = await mikrofonAc();
		if (!sesKanal) return akis.getTracks().forEach((t) => t.stop());
		mikrofonuKullan(akis);
	} catch (h) {
		durum(mikHataMetni(h), true);
	}
	gonder({ type: 'sessiz', sessiz: mikSessizMi(), sagir: ayar.sagir });
}

$('ayar-mik').addEventListener('change', () => {
	ayar.mikId = $('ayar-mik').value;
	ayarKaydet();
	mikrofonuYenile();
});
for (const [id, alan] of [
	['ayar-gurultu', 'gurultu'],
	['ayar-yanki', 'yanki'],
	['ayar-kazanc', 'kazanc'],
]) {
	$(id).addEventListener('change', () => {
		ayar[alan] = $(id).checked;
		ayarKaydet();
		mikrofonuYenile();
	});
}
// Susturunca mikrofonu bırak: susturulmuşsak hemen bırakılır ya da (kapatıldıysa) yeniden alınır.
$('ayar-mik-birak').addEventListener('change', () => {
	ayar.mikBirak = $('ayar-mik-birak').checked;
	ayarKaydet();
	if (sesKanal) sesDurumunuUygula();
});
$('ayar-mik-seviye').addEventListener('input', () => {
	ayar.mikSeviye = Number($('ayar-mik-seviye').value);
	$('ayar-mik-seviye-deger').textContent = '%' + ayar.mikSeviye;
	ayarKaydet();
	if (sesKanal && mikrofon) gidenIzKur();
});
$('ayar-cikis').addEventListener('change', () => {
	ayar.cikisId = $('ayar-cikis').value;
	ayarKaydet();
	for (const es of esler.values()) {
		for (const a of [es.ses, es.yayinSesOgesi]) {
			if (a && typeof a.setSinkId === 'function') a.setSinkId(ayar.cikisId).catch(() => durum('Bu çıkış aygıtı seçilemedi.', true));
		}
	}
});
$('ayar-kalite').addEventListener('change', () => {
	ayar.kalite = Number($('ayar-kalite').value) || 96;
	ayarKaydet();
	bitHizlariniAyarla();
	// Firefox/Safari için Opus hedefi yeniden anlaşmada uygulanır: teklif verdiğimiz bağlantıları yenile.
	for (const es of esler.values()) if (es.teklifci && es.pc && es.pc.signalingState === 'stable') teklifVer(es);
});
$('ayar-sesler').addEventListener('change', () => {
	ayar.sesler = $('ayar-sesler').checked;
	ayarKaydet();
});
if (navigator.mediaDevices && 'ondevicechange' in navigator.mediaDevices) {
	navigator.mediaDevices.addEventListener('devicechange', () => {
		if (!$('ayarlar').hidden) aygitlariDoldur();
	});
}

// ---------------------------------------------------------------- sunucu penceresi: veritabanı ve temizlik
//
// Veritabanının diskteki boyutu, mesaj ve dosya kaydı sayısı. "Sohbeti temizle" yalnızca yazılı
// mesajları (ve dosya kayıtlarını) siler: tüm kanallar ya da tek kanal, hepsi ya da belli bir
// günden eskiler. Beyaz liste, kanallar ve ayarlar değişmez. Sunucu ardından veritabanını küçültür.

let sunucuPencereOncekiOdak = null;
function sunucuPenceresiAc() {
	cekmeceleriKapat();
	sunucuPencereOncekiOdak = document.activeElement;
	const secim = $('temizle-kanal');
	const onceki = secim.value;
	secim.replaceChildren();
	const hepsi = el('option', null, 'Tüm yazılı kanallar');
	hepsi.value = '';
	secim.append(hepsi);
	for (const k of kanallar.filter((x) => x.tur === 'yazi')) {
		const o = el('option', null, '#' + k.ad);
		o.value = k.id;
		secim.append(o);
	}
	secim.value = [...secim.options].some((o) => o.value === onceki) ? onceki : '';
	for (const id of ['vt-boyut', 'vt-mesaj', 'vt-dosya', 'vt-bos', 'vt-surum']) $(id).textContent = '…';
	$('sunucu-pencere').hidden = false;
	$('sunucu-kapat').focus();
	gonder({ type: 'sunucu-bilgi' });
}
function sunucuPenceresiKapat() {
	if ($('sunucu-pencere').hidden) return;
	$('sunucu-pencere').hidden = true;
	if (sunucuPencereOncekiOdak && sunucuPencereOncekiOdak.focus) sunucuPencereOncekiOdak.focus();
}
function sunucuBilgisiGeldi(m) {
	const sayi = (n) => Number(n || 0).toLocaleString('tr-TR');
	$('vt-boyut').textContent = boyutYaz(m.veritabani);
	$('vt-mesaj').textContent = sayi(m.mesaj);
	$('vt-dosya').textContent = sayi(m.dosya);
	$('vt-bos').textContent = m.bosAlan == null ? 'bilinmiyor' : boyutYaz(m.bosAlan);
	$('vt-surum').textContent = m.surum || '—';
	$('temizle').disabled = false;
}
$('sunucu-ac').addEventListener('click', sunucuPenceresiAc);
$('sunucu-kapat').addEventListener('click', sunucuPenceresiKapat);
$('sunucu-pencere').addEventListener('click', (e) => {
	if (e.target === $('sunucu-pencere')) sunucuPenceresiKapat();
});
$('temizle').addEventListener('click', () => {
	const kanal = $('temizle-kanal').value;
	const gunSecimi = $('temizle-gun');
	const gun = Number(gunSecimi.value) || 0;
	const kapsam = kanal ? `#${kanalAdi(kanal)} kanalındaki` : 'Tüm yazılı kanallardaki';
	const ne = gun ? `${gunSecimi.options[gunSecimi.selectedIndex].textContent.toLocaleLowerCase('tr')} mesajlar` : 'bütün mesajlar';
	pencereAc({
		baslik: 'Sohbeti temizle',
		metin: `${kapsam} ${ne} ve paylaşılan dosyaların kayıtları kalıcı olarak silinecek. Beyaz liste, kanallar ve ayarlar değişmez. Bu geri alınamaz.`,
		girdi: false,
		tamam: 'Temizle',
		tehlike: true,
		onay: () => {
			gonder({ type: 'sohbet-temizle', kanal, gun });
			$('temizle').disabled = true;
			$('vt-boyut').textContent = 'temizleniyor…';
		},
	});
});
function sohbetTemizlendi(m) {
	$('temizle').disabled = false;
	const kapsam = m.kanal ? `#${kanalAdi(m.kanal)}` : 'tüm kanallar';
	durum(`${m.ad} sohbeti temizledi (${kapsam}${m.gun ? `, ${m.gun} günden eski` : ''}): ${Number(m.silinen || 0).toLocaleString('tr-TR')} mesaj silindi.`);
	// Etkilenen kanalların okunmamış sayıları ve açık kanalın geçmişi tazelenir.
	for (const id of [...okunmamis.keys()]) if (!m.kanal || m.kanal === id) okunmamis.delete(id);
	kanalListesiCiz();
	if (aktifKanal && (!m.kanal || m.kanal === aktifKanal)) {
		mesajVerisi = [];
		$('mesajlar').replaceChildren();
		gecmisBitti = true;
		gecmisIstegi = { kanal: '', zaman: 0 };
		gecmisYukle();
	}
	if (!$('sunucu-pencere').hidden) gonder({ type: 'sunucu-bilgi' });
}

// ---------------------------------------------------------------- çekmeceler (dar ekran)

function cekmeceleriKapat() {
	$('kanal-panosu').classList.remove('acik');
	$('uye-panosu').classList.remove('acik');
	$('ortu').hidden = true;
}
$('menu').addEventListener('click', () => {
	const acik = !$('kanal-panosu').classList.contains('acik');
	cekmeceleriKapat();
	if (acik) {
		$('kanal-panosu').classList.add('acik');
		$('ortu').hidden = false;
	}
});
$('kenar-kapat').addEventListener('click', cekmeceleriKapat);
$('uye-kapat').addEventListener('click', cekmeceleriKapat);
$('ortu').addEventListener('click', cekmeceleriKapat);
// Geniş ekranda üye panelini gizle/göster (kalıcı); dar ekranda çekmece olarak aç.
if (depoOku('uyeler-gizli', '') === '1') {
	$('uygulama').classList.add('uyeler-gizli');
	$('uye-ac').setAttribute('aria-pressed', 'false');
}
$('uye-ac').addEventListener('click', () => {
	if (medyaSorgu('(max-width: 1100px)')) {
		const acik = !$('uye-panosu').classList.contains('acik');
		cekmeceleriKapat();
		if (acik) {
			$('uye-panosu').classList.add('acik');
			$('ortu').hidden = false;
		}
		return;
	}
	const gizli = $('uygulama').classList.toggle('uyeler-gizli');
	$('uye-ac').setAttribute('aria-pressed', String(!gizli));
	depoYaz('uyeler-gizli', gizli ? '1' : null);
});

// ---------------------------------------------------------------- klavye

document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape') {
		if (!$('buyutec').hidden) buyutecKapat();
		else if (!$('yayin-menu').hidden) yayinMenuKapat();
		else if (!$('ses-kaynagi').hidden) sesKaynagiKapat();
		else if (!$('pencere').hidden) pencereKapat();
		else if (!$('ayarlar').hidden) ayarlarKapat();
		else if (!$('sunucu-pencere').hidden) sunucuPenceresiKapat();
		else cekmeceleriKapat();
		return;
	}
	if (e.ctrlKey && e.shiftKey && !e.altKey && $('giris-ekrani').hidden) {
		const tus = e.key.toLowerCase();
		if (tus === 'm') {
			e.preventDefault();
			mikDegistir();
		} else if (tus === 'd') {
			e.preventDefault();
			sagirDegistir();
		}
	}
	if (sesKanal) sesleriAc();
});

// ---------------------------------------------------------------- kapanış

// Sekme kapanırken sesli kanaldan açıkça çık (sunucu yeri askıda tutmasın).
window.addEventListener('pagehide', () => {
	if (sesKanal && bagliyim) gonder({ type: 'ses-cik' });
	durduruldu = true;
	sesKapat(false); // arka planda kapatılma notunu da siler: normal kapanışta sese geri dönülmez
	for (const bag of [...dosyaBaglari.values()]) bagKapat(bag, '');
	if (ws) soketBirak(ws);
});
window.addEventListener('pageshow', (e) => {
	// Geri/ileri önbelleğinden dönüldü: bağlantıyı yeniden kur.
	if (e.persisted && (oturumVardi || anahtar)) {
		durduruldu = false;
		baglan();
	}
});

// ---------------------------------------------------------------- açılış

simgeleriCiz(document);
mikDugmeleriCiz();
yayinMenusuCiz(); // paylaş düğmesi yalnızca tarayıcı ekran paylaşımı sunuyorsa görünür (çoğu telefonda yok)
eskiIndirmeleriSil();
$('ad').value = depoOku('ad', '');
anahtar = depoOku('anahtar', '');
// Kurulum bağlantısı: https://…/#anahtar=XXXX → anahtarı sakla, adresten temizle.
if (location.hash.length > 1) {
	const m = location.hash.slice(1).match(/(?:^|&)anahtar=([^&]+)/);
	if (m) {
		try {
			anahtar = decodeURIComponent(m[1]);
		} catch {
			anahtar = m[1];
		}
		depoYaz('anahtar', anahtar);
		history.replaceState(null, '', location.pathname);
	}
}
// Anahtarı olan kendiliğinden girer: ad sormadan bağlan (ad sunucudan gelir).
if (anahtar) {
	girisAdi = '';
	$('gir').disabled = true;
	girisDurum('Anahtar doğrulanıyor…', false, true);
	baglan();
} else {
	$('ad').focus();
}
