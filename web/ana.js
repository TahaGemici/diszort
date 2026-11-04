// Ses Kanalı — tarayıcı tarafı.
// Discord'umsu tek sunucu: solda yazılı/sesli kanallar, ortada sohbet, sağda üyeler.
// Yazılı mesajlar sunucudan geçer ve SQLite'ta saklanır; sesli kanallarda ses P2P akar
// (mesh WebRTC, doğrudan bağlanamayanlar TURN üzerinden).
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
let jeton = '';
let sunucu = { max: 10, dosyaMb: 25 };
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
	jeton = '';
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

function yenidenBaglanmayiPlanla(ms) {
	clearTimeout(yenidenZamanlayici);
	// Sunucu güncellemesi birkaç saniye sürer: ilk denemeler sık, sonra seyrekleşir (en fazla 15 sn).
	const TAKVIM = [500, 1000, 1000, 2000, 2000, 4000, 8000, 15000];
	const bekle = ms ?? TAKVIM[Math.min(yenidenDene++, TAKVIM.length - 1)] * (0.8 + Math.random() * 0.4);
	const sn = Math.max(1, Math.round(bekle / 1000));
	if (oturumVardi) baglantiRozeti(`bağlantı koptu · ${sn} sn sonra yeniden`);
	else girisDurum(ms ? `Sunucu yoğun; ${sn} sn sonra yeniden denenecek…` : `Sunucuya ulaşılamadı; ${sn} sn sonra yeniden denenecek…`, false, true);
	yenidenZamanlayici = setTimeout(baglan, bekle);
}

// Ağ geri geldiğinde ya da sekme öne alındığında beklemeden dene.
function hemenDene() {
	if (yenidenZamanlayici && !durduruldu) {
		yenidenDene = Math.max(0, yenidenDene - 1);
		baglan();
	}
}
window.addEventListener('online', hemenDene);
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'visible') hemenDene();
});

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
		case 'ice-sunuculari':
			iceAyarla(m.ice);
			break;
		case 'hata':
			durum(m.message, true);
			if (m.kod === 'ses-dolu' || m.kod === 'ses-kanal-yok') sesGirisiBasarisiz();
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
	jeton = m.jeton || '';
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
	sunucu = { max: m.max || 10, dosyaMb: m.dosyaMb || 25 };
	kimlerListesi = m.kimler || [];
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
	} else {
		durum('Yeniden bağlandın.');
		gecmisTazele();
		// Sesli kanaldaydık: eş bağlantıları ayakta, kanala devam et.
		if (sesKanal) {
			// TURN'den geçen bağlantılar işaretlenir; karşı taraf kanalda görünür görünmez yenilenir
			// (o daha dönmeden gönderilen teklif sunucuda düşerdi).
			if (turnYenilendi) for (const es of esler.values()) if (es.sonTip === 'TURN' && es.pc) es.turnYenile = true;
			gonder({ type: 'ses-gir', kanal: sesKanal, devam: true, sessiz: mikSessizMi(), sagir: ayar.sagir });
		}
	}
	sesPaneliCiz();
}

function girisReddi(m) {
	const metin = m.message || 'Giriş reddedildi.';
	// Eski sunucular kod göndermez: metinden çıkar.
	const kod = m.kod || (/saniye sonra/.test(metin) ? 'fren' : /anahtar/i.test(metin) ? 'anahtar' : '');
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
	sesDurumlari.clear();
	for (const k of kanallar) {
		if (k.tur !== 'ses') continue;
		for (const p of k.kisiler || []) sesDurumlari.set(p.ad, { sessiz: !!p.sessiz, sagir: !!p.sagir, askida: !!p.askida, kanal: k.id });
	}
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

function pencereAc({ baslik, metin, girdi, tamam, tehlike, onay }) {
	pencereOncekiOdak = document.activeElement;
	$('pencere-baslik').textContent = baslik;
	$('pencere-metin').textContent = metin || '';
	$('pencere-girdi').hidden = !girdi;
	$('pencere-girdi').value = '';
	$('pencere-tamam').textContent = tamam || 'Tamam';
	$('pencere-tamam').classList.toggle('tehlike', !!tehlike);
	pencereOnay = onay;
	$('pencere').hidden = false;
	if (girdi) $('pencere-girdi').focus();
	else $('pencere-tamam').focus();
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
	if (girdiVar && !girdi) {
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
	$('birak-kanal').textContent = `#${k.ad} kanalına yüklenir`;
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
		const yakin = dibeYakin();
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
	if (n < 1024) return n + ' B';
	if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
	return (n / 1024 / 1024).toFixed(1) + ' MB';
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

function dosyaElemani(dosya) {
	const url = '/dosya/' + dosya.id;
	const uz = dosyaUzanti(dosya.ad);
	if (ONIZLEME.includes(uz)) {
		const a = el('a');
		a.href = url;
		a.target = '_blank';
		a.rel = 'noopener';
		const img = el('img', 'onizleme');
		img.src = url;
		img.alt = dosya.ad;
		img.loading = 'lazy';
		// Resim yüklenince yükseklik değişir: dipteysek dipte kal.
		img.addEventListener('load', () => {
			if (dibeYapisik) dibeKaydir();
		});
		a.addEventListener('click', (e) => {
			if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
			e.preventDefault();
			buyutecAc(url, dosya.ad);
		});
		a.append(img);
		return a;
	}
	if (SES_TURLERI.includes(uz)) {
		const a = el('audio', 'onizleme');
		a.controls = true;
		a.preload = 'none';
		a.src = url;
		return a;
	}
	if (VIDEO_TURLERI.includes(uz)) {
		const v = el('video', 'onizleme');
		v.controls = true;
		v.preload = 'metadata';
		v.playsInline = true;
		v.src = url;
		return v;
	}
	const a = el('a', 'dosya-kart');
	a.href = url;
	a.target = '_blank';
	a.rel = 'noopener';
	a.download = dosya.ad;
	const sol = el('span', 'dosya-ikon');
	sol.append(ikon('dosya'));
	const bilgi = el('span', 'dosya-bilgi');
	bilgi.append(el('b', null, dosya.ad), el('small', null, boyutYaz(dosya.boyut || 0)));
	const sag = el('span', 'indir-ikon');
	sag.append(ikon('indir'));
	a.append(sol, bilgi, sag);
	return a;
}

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
	if (m.dosya) govde.append(dosyaElemani(m.dosya));
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

// Dipte miyiz? Yeni mesaj/resim gelince yalnızca dipteysek aşağı kayılır; yukarı bakan bölünmez.
let dibeYapisik = true;
function dibeYakin() {
	const alan = $('mesaj-alani');
	return alan.scrollHeight - alan.scrollTop - alan.clientHeight < 120;
}
function dibeKaydir() {
	const alan = $('mesaj-alani');
	alan.scrollTop = alan.scrollHeight;
	dibeYapisik = true;
	$('yeni-mesaj').hidden = true;
}
let yeniMesajSayisi = 0;
$('mesaj-alani').addEventListener(
	'scroll',
	() => {
		dibeYapisik = dibeYakin();
		if (dibeYapisik && !$('yeni-mesaj').hidden) $('yeni-mesaj').hidden = true;
		// En üste gelince eski mesajları kendiliğinden yükle.
		if ($('mesaj-alani').scrollTop < 40 && !gecmisBitti && mesajVerisi.length) gecmisYukle();
	},
	{ passive: true },
);
$('yeni-mesaj').addEventListener('click', dibeKaydir);

function mesajGeldi(kanal, m) {
	if (!m) return;
	if (kanal === aktifKanal) {
		if (mesajVerisi.some((x) => x.id === m.id)) return;
		const yakin = dibeYakin();
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
	const dosya = $('dosya').files && $('dosya').files[0];
	$('dosya').value = '';
	if (dosya) dosyaYukle(dosya);
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
	const dosya = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
	if (!dosya) return;
	e.preventDefault();
	dosyaYukle(dosya);
});
$('metin').addEventListener('paste', (e) => {
	const dosya = [...((e.clipboardData && e.clipboardData.files) || [])][0];
	if (!dosya) return;
	e.preventDefault();
	dosyaYukle(dosya);
});

function yuklemeGoster(ad) {
	$('yukleme').hidden = false;
	$('yukleme-yazi').textContent = ad + ' yükleniyor…';
	$('yukleme-dolgu').style.width = '0%';
}
function yuklemeGizle() {
	$('yukleme').hidden = true;
	$('yukleme-dolgu').style.width = '0%';
}

function dosyaYukle(dosya) {
	if (!dosya) return;
	if (!aktifKanal || !bagliyim || !jeton) return durum('Dosya için önce sunucuya bağlan.', true);
	const sinir = sunucu.dosyaMb * 1024 * 1024;
	if (dosya.size > sinir) return durum(`Dosya çok büyük (en fazla ${sunucu.dosyaMb} MB).`, true);

	const xhr = new XMLHttpRequest();
	xhr.open('POST', '/api/yukle?kanal=' + encodeURIComponent(aktifKanal));
	xhr.setRequestHeader('Authorization', 'Bearer ' + jeton);
	xhr.setRequestHeader('X-Dosya-Adi', encodeURIComponent(dosya.name || 'dosya'));
	xhr.setRequestHeader('Content-Type', dosya.type || 'application/octet-stream');
	xhr.upload.onprogress = (e) => {
		if (!e.lengthComputable) return;
		const yuzde = Math.round((e.loaded / e.total) * 100);
		$('yukleme-dolgu').style.width = yuzde + '%';
		$('yukleme-yazi').textContent = `${dosya.name} · %${yuzde}`;
	};
	xhr.onload = () => {
		yuklemeGizle();
		if (xhr.status === 200) return;
		let metin = 'Yükleme başarısız.';
		try {
			metin = JSON.parse(xhr.responseText).hata || metin;
		} catch {}
		durum(metin, true);
	};
	xhr.onerror = () => {
		yuklemeGizle();
		durum('Yükleme başarısız (ağ hatası).', true);
	};
	yuklemeGoster(dosya.name);
	xhr.send(dosya);
}

// --- resim büyüteci

function buyutecAc(url, ad) {
	$('buyutec-resim').src = url;
	$('buyutec-resim').alt = ad || '';
	$('buyutec').hidden = false;
}
$('buyutec').addEventListener('click', () => {
	$('buyutec').hidden = true;
	$('buyutec-resim').removeAttribute('src');
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
	const mikVar = await mikrofonHazirla();
	if (!mikVar) durum(mikHatasi + '; kanala yalnızca dinleyici olarak giriliyor.', true);
	if (!bagliyim || sesHedef !== kanal) {
		sesGiriliyor = false;
		if (!sesKanal) mikrofonuBirak();
		return;
	}
	iceTazeMi();
	gonder({ type: 'ses-gir', kanal, sessiz: mikSessizMi(), sagir: ayar.sagir });
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
	sesArayuzuKapat();
	sesGozcuDurdur();
	taniDurdur();
	istatistikDurdur();
	kurtarmaDurdur();
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
	if (sesKanal) alt = ayar.sagir ? 'sağırlaştırıldın' : !gidenIz ? 'yalnızca dinliyorsun' : ayar.mikKapali ? 'mikrofon kapalı' : kanalAdi(sesKanal);
	else if (sesGiriliyor) alt = 'bağlanıyor…';
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
	};
	const kayitliSeviye = Number(depoOku('ses-seviye-' + ad, '100'));
	if (Number.isFinite(kayitliSeviye) && kayitliSeviye >= 0 && kayitliSeviye <= 100) es.seviye = kayitliSeviye;
	es.susturuldu = depoOku('ses-sustur-' + ad, '') === '1';
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
	es.tr = null;
	if (es.olcer) es.olcer.dur();
	es.olcer = null;
	if (es.ses) es.ses.srcObject = null;
	es.olcum = es.gidenOlcum = null;
}

function esKapat(ad) {
	const es = esler.get(ad);
	if (!es) return;
	pcKapat(es);
	if (es.ses) es.ses.remove();
	if (es.kutu) es.kutu.remove();
	esler.delete(ad);
	konusmaGuncelle(ad, false);
	sesAcDugmesiGuncelle();
}

// Eşe yeni bir RTCPeerConnection kur. Teklif eden yeni bir oturum kimliği üretir ve ses kanalını
// açar (mikrofon izi varsa onunla); yanıtlayan, teklifteki oturum kimliğini alır ve kanalı teklifin
// kendisi oluşturur (önceden açılan kanal teklifin m-line'ıyla eşleşmiyor → tek yönlü ses).
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
	pc.onicecandidate = (e) => {
		if (es.pc === pc && e.candidate) gonder({ type: 'ice', to: es.ad, ice: e.candidate, oturum: es.oturum });
	};
	pc.ontrack = (e) => {
		if (es.pc === pc) uzakSesBagla(es, e.track);
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
		} catch (h) {
			console.warn('ses kanalı açılamadı', h);
		}
	}
	esIstatistikYaz(es, 'bağlanıyor…', '');
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
		// Teklifin ses m-line'ına bağlanan kanal: yönü sendrecv yap ve gönderilecek izi bağla.
		// ÖNEMLİ: izi bağlamadan yanıt üretilirse Firefox "recvonly" yanıt verip sesi tek yöne düşürüyor.
		const tr = es.pc.getTransceivers().find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === 'audio');
		if (tr) {
			es.tr = tr;
			try {
				tr.direction = 'sendrecv';
			} catch {}
			if (tr.sender.track !== gidenIz) await tr.sender.replaceTrack(gidenIz || null).catch(() => {});
		}
		const yanit = await es.pc.createAnswer();
		await es.pc.setLocalDescription(yanit);
		gonder({ type: 'sdp', to: es.ad, sdp: es.pc.localDescription, oturum: es.oturum });
		bitHiziAyarla(es);
		taniGonder({ olay: 'yanit', es: es.ad, yon: tr ? tr.direction : null, mid: tr && tr.mid != null ? String(tr.mid) : null, iz: !!(tr && tr.sender.track) });
	} else if (sdp.type === 'answer') {
		const pc = es.pc;
		// Eski bağlantının yanıtı ise yok say. (Oturum kimliği göndermeyen eski sürüm istemcinin
		// yanıtı geçerli sayılır: güncellemeden sonra açık kalan sekmelerle de konuşulabilsin.)
		if (!es.teklifci || !pc || (oturum && es.oturum !== oturum) || pc.signalingState !== 'have-local-offer') return;
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
		if (oturum && oturum !== es.oturum) continue; // eski bağlantının adayı
		await pc.addIceCandidate(aday).catch(() => {});
	}
}

function iceGeldi(ad, aday, oturum) {
	const es = esler.get(ad);
	if (!es || !aday) return;
	oturum = String(oturum || '');
	if (es.pc && (!oturum || es.oturum === oturum) && es.pc.remoteDescription) {
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
		bitHiziAyarla(es);
		calmayiDene(es);
	} else if (!es.sorunBasi) es.sorunBasi = Date.now();
	if (d === 'failed') esIstatistikYaz(es, 'bağlantı koptu · yeniden deneniyor', 'kotu');
	if (d === 'disconnected') esIstatistikYaz(es, 'bağlantı zayıf…', 'orta');
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
// toplam ~640 kbps'yi geçmesin diye kişi başına düşürülür (en az 40).
function gonderimHizi() {
	const n = Math.max(1, esSayisi());
	return Math.round(Math.min(ayar.kalite, Math.max(40, 640 / n)));
}

// Uzak SDP'deki Opus parametreleri: karşı tarafın "şöyle gönder" dediği değerler bizim
// kodlayıcımızı ayarlar. maxaveragebitrate olmadan tarayıcılar ~32 kbps'de kalıyor (ölçüm: 28 kbps);
// setParameters(maxBitrate) yalnızca Chrome'da işe yarıyor, bu yol Firefox/Safari'de de geçerli.
// useinbandfec=1: kayıpta yedek veri; usedtx=0: sessizlikte kesip açma (cızırtı) yok.
function opusAyarla(sdp) {
	if (typeof sdp !== 'string') return sdp;
	try {
		const satirlar = sdp.split(/\r?\n/);
		const opus = [];
		for (const s of satirlar) {
			const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(s);
			if (m) opus.push(m[1]);
		}
		if (!opus.length) return sdp;
		const ek = {
			minptime: '10',
			useinbandfec: '1',
			usedtx: '0',
			stereo: '0',
			maxplaybackrate: '48000',
			maxaveragebitrate: String(gonderimHizi() * 1000),
		};
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
		return satirlar.join('\r\n');
	} catch {
		return sdp;
	}
}

async function bitHiziAyarla(es) {
	const pc = es.pc;
	if (!pc || pc.signalingState === 'closed') return;
	const hiz = gonderimHizi() * 1000;
	for (const s of pc.getSenders()) {
		if (!s.track || s.track.kind !== 'audio') continue;
		try {
			const p = s.getParameters();
			if (!p.encodings || !p.encodings.length) p.encodings = [{}];
			if (p.encodings[0].maxBitrate === hiz) continue;
			p.encodings[0].maxBitrate = hiz;
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

function esSesUygula(es) {
	if (!es.ses) return;
	es.ses.muted = ayar.sagir || es.susturuldu;
	es.ses.volume = Math.max(0, Math.min(1, es.seviye / 100));
	if (ayar.cikisId && typeof es.ses.setSinkId === 'function' && es.ses.sinkId !== ayar.cikisId) {
		es.ses.setSinkId(ayar.cikisId).catch(() => {});
	}
	if (es.kutu) {
		es.kutu.classList.toggle('susturuldu', es.susturuldu);
		ikonKoy(es.susDugme, es.susturuldu ? 'hoparlor-kapali' : 'hoparlor');
		es.susDugme.classList.toggle('kapali', es.susturuldu);
		es.susDugme.title = es.susturuldu ? 'Bu kişinin sesini aç' : 'Bu kişiyi yalnızca kendin için sustur';
	}
}

// Tarayıcı sesi kendiliğinden başlatmazsa (Safari, telefon) görünen "Sesi başlat" düğmesi çıkar.
function calmayiDene(es) {
	if (!es.ses || !es.ses.srcObject) return;
	oynat(es.ses)
		.then(sesAcDugmesiGuncelle)
		.catch(sesAcDugmesiGuncelle);
}
function sesAcDugmesiGuncelle() {
	let bekleyen = 0;
	for (const es of esler.values()) if (es.ses && es.ses.srcObject && es.ses.paused && !es.ses.muted) bekleyen++;
	$('ses-ac').hidden = !sesKanal || !bekleyen;
}

// Telefon tarayıcıları sesi ancak bir kullanıcı etkileşiminden SONRA başlatır. Yalnızca sesli
// kanaldayken ve çalmayan ses varken dene (eskiden her tuşta sessiz bir ses çalınıyordu: CSP onu
// zaten engelliyordu ve iOS'ta arka plandaki müziği durdurabilirdi).
function sesleriAc() {
	if (!sesKanal) return;
	sesKilidiAc();
	for (const es of esler.values()) if (es.ses && es.ses.srcObject && es.ses.paused && !es.ses.muted) oynat(es.ses).catch(() => {});
	setTimeout(sesAcDugmesiGuncelle, 300);
}
$('ses-ac').addEventListener('click', sesleriAc);
document.addEventListener('pointerdown', () => sesKanal && sesleriAc(), { passive: true });

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
// Bağlam durdu → kazanç zincirinden vazgeç (ham iz); yeniden çalıştı → zinciri kur.
function baglamDurumuDegisti() {
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
	if (!sesKanal || gidenIz) {
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
function sesPaneliCiz(ozet) {
	if (!sesKanal) return;
	const panel = $('ses-baglanti');
	const sinyal = $('ses-sinyal');
	let durumMetni = 'Ses bağlı';
	let sinif = '';
	const durumlar = [...esler.values()].filter((e) => e.pc).map((e) => e.pc.connectionState);
	if (!bagliyim) {
		durumMetni = 'Sunucuya yeniden bağlanılıyor';
		sinif = 'orta';
	} else if (durumlar.some((d) => d !== 'connected')) {
		durumMetni = durumlar.some((d) => d === 'connected') ? 'Bazı bağlantılar kuruluyor' : 'Ses bağlanıyor…';
		sinif = 'bekliyor';
	} else if (ozet && ozet.kotu) {
		durumMetni = 'Bağlantı zayıf';
		sinif = 'kotu';
	} else if (ozet && ozet.orta) {
		durumMetni = 'Ses bağlı · dalgalı';
		sinif = 'orta';
	}
	$('ses-baglanti-durum').textContent = durumMetni;
	panel.classList.toggle('orta', sinif === 'orta' || sinif === 'bekliyor');
	panel.classList.toggle('kotu', sinif === 'kotu');
	sinyal.className = 'sinyal' + (sinif ? ' ' + sinif : '');
	$('ses-baglanti-kanal').textContent = kanalAdi(sesKanal) + (ozet && ozet.metin ? ' · ' + ozet.metin : '');
}

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
		let bekleyen = 0;
		for (const es of esler.values()) {
			const a = es.ses;
			if (!a || !a.srcObject || a.muted) {
				es.calmaDenemesi = 0;
				continue;
			}
			if (a.paused) {
				es.calmaDenemesi = (es.calmaDenemesi || 0) + 1;
				if (es.calmaDenemesi >= 2) bekleyen++;
				if (es.calmaDenemesi % 3 === 0) oynat(a).catch(() => {});
			} else es.calmaDenemesi = 0;
		}
		$('ses-ac').hidden = !bekleyen;
	}, 1000);
}
function sesGozcuDurdur() {
	clearInterval(sesGozcu);
	sesGozcu = null;
}

// Her eş için: bağlantı türü (P2P / TURN), gecikme, paket kaybı ve bit hızı (iki ölçüm arasındaki
// farktan; kümülatif oran eski kayıpları sonsuza dek taşıdığı için yanıltıcı).
let istatistikZamanlayici = null;
function istatistikBaslat() {
	if (!istatistikZamanlayici) istatistikZamanlayici = setInterval(istatistikTuru, 2000);
}
function istatistikDurdur() {
	clearInterval(istatistikZamanlayici);
	istatistikZamanlayici = null;
}
async function istatistikTuru() {
	const ozet = { orta: false, kotu: false, metin: '' };
	let enIyiRtt = null;
	let turnVar = false;
	for (const es of [...esler.values()]) {
		const pc = es.pc;
		if (!pc || pc.connectionState !== 'connected') continue;
		let rapor;
		try {
			rapor = await pc.getStats();
		} catch {
			continue;
		}
		if (es.pc !== pc) continue;
		const simdi = Date.now();
		let cift = null;
		let gelen = null;
		let giden = null;
		rapor.forEach((r) => {
			if (r.type === 'transport' && r.selectedCandidatePairId) cift = rapor.get(r.selectedCandidatePairId);
			if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio')) gelen = r;
			if (r.type === 'outbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio')) giden = r;
		});
		if (!cift) rapor.forEach((r) => {
			if (!cift && r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) cift = r;
		});
		const parcalar = []; // görünen kısa özet: tür · gecikme (· kayıp · sorun)
		const ayrinti = []; // ipucu: bit hızları, titreşim
		let sinif = '';
		if (cift) {
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
			const onceki = es.olcum;
			const alinan = gelen.packetsReceived || 0;
			const kayip = gelen.packetsLost || 0;
			const bayt = gelen.bytesReceived || 0;
			if (gelen.jitter != null) es.jitter = Math.round(gelen.jitter * 1000);
			if (onceki && simdi - onceki.zaman > 400) {
				const dt = simdi - onceki.zaman;
				const dAlinan = alinan - onceki.alinan;
				const dKayip = kayip - onceki.kayip;
				if (dAlinan + dKayip > 0) {
					const oran = Math.max(0, (dKayip / (dAlinan + dKayip)) * 100);
					const metin = (oran < 0.05 ? '0' : oran.toFixed(1)) + '% kayıp';
					if (oran >= 1) parcalar.push(metin);
					ayrinti.push(metin);
					es.sonKayip = Math.round(oran * 10) / 10;
					if (oran >= 5) sinif = 'kotu';
					else if (oran >= 1 && sinif !== 'kotu') sinif = 'orta';
				}
				const dBayt = bayt - onceki.bayt;
				if (dBayt > 0) {
					es.sonKbps = Math.round((dBayt * 8) / dt);
					ayrinti.push('gelen ' + es.sonKbps + ' kbps');
				}
			}
			es.olcum = { zaman: simdi, alinan, kayip, bayt };
		}
		// Giden ses: mikrofon gerçekten karşıya gidiyor mu? (Tek yönlü ses şüphesinde kanıt.)
		if (giden) {
			const onceki = es.gidenOlcum;
			const bayt = giden.bytesSent || 0;
			if (onceki && simdi - onceki.zaman > 400) {
				const kbps = Math.round(((bayt - onceki.bayt) * 8) / (simdi - onceki.zaman));
				es.sonGiden = kbps;
				ayrinti.push('giden ' + kbps + ' kbps');
				if (kbps === 0 && gidenIz && !mikSessizMi()) {
					es.sifirGiden = (es.sifirGiden || 0) + 1;
					// Tek ölçümde 0 olabilir; iki ardışık sıfır gerçek sorundur.
					if (es.sifirGiden >= 2) {
						parcalar.push('mikrofon gitmiyor');
						sinif = 'kotu';
						taniGonder({ olay: 'mik-gitmiyor', es: es.ad, iz: !!(es.tr && es.tr.sender && es.tr.sender.track), yon: es.tr ? es.tr.currentDirection || null : null });
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
		if (sinif === 'kotu') ozet.kotu = true;
		else if (sinif === 'orta') ozet.orta = true;
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
			tip: es.sonTip || null,
			rtt: es.sonRtt ?? null,
			kurtarma: es.kurtarma,
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
		mikAcik: !mikSessizMi(),
		mikDurum: iz ? iz.readyState : null,
		micAyarlar,
		kazanc: ayar.mikSeviye,
		kalite: gonderimHizi(),
		sesBaglami: baglam ? baglam.state : null,
		iceSunucu: (ice.iceServers || []).map((s) => [].concat(s.urls || []).join('+')).join(',').slice(0, 200),
		esler: liste,
	};
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
	if (!sesKanal) return;
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
		if (es.ses && typeof es.ses.setSinkId === 'function') es.ses.setSinkId(ayar.cikisId).catch(() => durum('Bu çıkış aygıtı seçilemedi.', true));
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
		if (!$('buyutec').hidden) $('buyutec').click();
		else if (!$('pencere').hidden) pencereKapat();
		else if (!$('ayarlar').hidden) ayarlarKapat();
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
	sesKapat(false);
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
