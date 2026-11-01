// Ses Kanalı — tarayıcı tarafı.
// Discord'umsu tek sunucu: solda yazılı/sesli kanallar, ortada sohbet, sağda çevrimiçi kişiler.
// Yazılı mesajlar sunucudan geçer ve SQLite'ta saklanır; sesli kanallarda ses P2P akar
// (mesh WebRTC, doğrudan bağlanamayanlar TURN üzerinden).
'use strict';

const $ = (id) => document.getElementById(id);
const el = (etiket, sinif, metin) => {
	const e = document.createElement(etiket);
	if (sinif) e.className = sinif;
	if (metin != null) e.textContent = metin;
	return e;
};

let tostZaman = null;
// hata=true: bildirim kırmızı gösterilir (kullanıcı hatayı normal bilgiden ayırsın).
function durum(metin, hata = false) {
	const e = $('durum');
	e.textContent = metin;
	e.classList.toggle('hata', hata);
	clearTimeout(tostZaman);
	if (metin) tostZaman = setTimeout(() => (e.textContent = ''), hata ? 6000 : 3500);
}
function girisDurum(metin, hata = false) {
	const e = $('giris-durum');
	if (!e) return;
	e.textContent = metin;
	e.classList.toggle('hata', hata);
}

// Aynı sekme yeniden bağlanınca sunucu eski bağlantıyı tanısın ("bu ad zaten var" demesin).
let SEKME = '';
try {
	SEKME = sessionStorage.getItem('sekme') || crypto.getRandomValues(new Uint32Array(4)).join('-');
	sessionStorage.setItem('sekme', SEKME);
} catch {
	SEKME = String(Date.now());
}

// ---------------------------------------------------------------- durum

let ws = null;
let benimAdim = '';
let jeton = '';
let bagliyim = false;
let durduruldu = false; // ad alınamadı gibi kalıcı hata: yeniden bağlanmayı durdur
let yenidenDene = 0;
let sunucu = { max: 10, dosyaMb: 25 };
let kanallar = [];
let kimlerListesi = [];
let aktifKanal = '';
let ice = { iceServers: [] };

let mesajVerisi = []; // aktif kanalın mesajları (eskiden yeniye)
let gecmisBitti = true;
const okunmamis = new Map(); // kanal id -> okunmamış mesaj sayısı

let sesKanal = '';
let mikrofon = null;
const kisiler = new Map(); // ad -> { pc, satir, ses, etiket, adaylar, kuyruk, olcer, sesDugmesi, seviye }
let istatistikZamanlayici = null;
let kendiOlcer = null;

const yaziyorlar = new Map(); // ad -> son "yazıyor" zamanı

// ---------------------------------------------------------------- giriş

try {
	$('ad').value = localStorage.getItem('ad') || '';
} catch {}
$('ad').focus();

$('giris').addEventListener('submit', async (e) => {
	e.preventDefault();
	if (bagliyim || ws) return;
	const ad = $('ad').value.trim().slice(0, 32);
	if (!ad) return;
	benimAdim = ad;
	try {
		localStorage.setItem('ad', ad);
	} catch {}
	$('gir').disabled = true;
	durduruldu = false;
	yenidenDene = 0;
	girisDurum('Bağlanılıyor…');
	await iceYukle();
	baglan();
});

async function iceYukle() {
	try {
		const yanit = await fetch('/api/ice', { cache: 'no-store' });
		if (yanit.ok) ice = await yanit.json();
	} catch {}
}

// ---------------------------------------------------------------- sunucu bağlantısı

function baglan() {
	baglantiRozeti('bağlanılıyor…');
	ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/rtc');
	ws.onopen = () => ws.send(JSON.stringify({ type: 'giris', ad: benimAdim, id: SEKME }));
	ws.onmessage = (olay) => {
		let m;
		try {
			m = JSON.parse(olay.data);
		} catch {
			return;
		}
		mesaj(m);
	};
	ws.onclose = () => {
		bagliyim = false;
		herkesiKapat();
		if (!benimAdim || durduruldu) return;
		// Sunucu yeniden başladı ya da ağ değişti: kısa bir beklemeyle yeniden bağlan.
		const bekle = Math.min(1000 * 2 ** yenidenDene++, 15000);
		baglantiRozeti(`koptu; ${Math.round(bekle / 1000)} sn sonra yeniden…`);
		durum('Sunucu bağlantısı koptu; yeniden bağlanılıyor…', true);
		setTimeout(baglan, bekle);
	};
	ws.onerror = () => {};
}

function gonder(nesne) {
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(nesne));
}

function baglantiRozeti(metin) {
	const e = $('baglanti-durumu');
	if (!metin) {
		e.hidden = true;
		return;
	}
	e.hidden = false;
	e.textContent = metin;
	e.className = 'etiket bag';
}

function mesaj(m) {
	switch (m.type) {
		case 'hazir': {
			const ilk = !bagliyim;
			bagliyim = true;
			yenidenDene = 0;
			jeton = m.jeton;
			sunucu = { max: m.max || 10, dosyaMb: m.dosyaMb || 25 };
			kanallar = m.kanallar || [];
			kimlerListesi = m.kimler || [];
			baglantiRozeti('');
			$('giris-ekrani').hidden = true;
			$('uygulama').hidden = false;
			$('ben-ad').textContent = m.ad;
			$('ben-avatar').textContent = basHarf(m.ad);
			$('ben-avatar').style.setProperty('--renk', renkBul(m.ad));
			kanalListesiCiz();
			uyeleriCiz();
			mikDugmeCiz();
			if (ilk) {
				kanalSec(ilkKanal());
			} else {
				// Yeniden bağlandık: kaçırdığımız mesajlar olabilir, geçmişi tazele.
				mesajVerisi = [];
				gecmisYukle();
				if (sesKanal) {
					const kanal = sesKanal;
					sesKanal = '';
					gonder({ type: 'ses-gir', kanal });
				}
			}
			break;
		}
		case 'kanallar':
			kanallar = m.kanallar || [];
			kanalListesiCiz();
			cevrimiciSayaci();
			break;
		case 'kimler':
			kimlerListesi = m.kimler || [];
			uyeleriCiz();
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
			sesKatil(m.kanal, m.kisiler || []);
			break;
		case 'ses-kisi-girdi':
			kisiEkle(m.ad);
			break;
		case 'ses-kisi-cikti':
			kisiCikar(m.ad);
			break;
		case 'sessiz':
			sessizGoster(m.ad, m.sessiz);
			uyeleriCiz();
			kanalListesiCiz();
			break;
		case 'sdp':
			sdpGeldi(m.from, m.sdp).catch((h) => console.warn('sdp', m.from, h));
			break;
		case 'ice':
			iceGeldi(m.from, m.ice);
			break;
		case 'hata':
			durum(m.message, true);
			// Sesli kanala giremedik (dolu, bilinmeyen kanal): mikrofonu bırak, ışık yanık kalmasın.
			if (!sesKanal && mikrofon && !kisiler.size) {
				mikrofon.getTracks().forEach((t) => t.stop());
				mikrofon = null;
				mikDugmeCiz();
			}
			if (!bagliyim) {
				// Giriş reddedildi (ad alınmış vb.): yeniden bağlanma döngüsüne girme.
				durduruldu = true;
				girisDurum(m.message, true);
				$('gir').disabled = false;
				$('uygulama').hidden = true;
				$('giris-ekrani').hidden = false;
				if (ws) ws.close();
				ws = null;
			}
			break;
	}
}

// ---------------------------------------------------------------- kanal listesi / üyeler

const kanalBilgi = (id) => kanallar.find((k) => k.id === id) || null;

function ilkKanal() {
	let istenen = '';
	try {
		istenen = decodeURIComponent(location.hash.slice(1));
	} catch {
		istenen = location.hash.slice(1);
	}
	const adaylar = [istenen, (() => { try { return localStorage.getItem('kanal'); } catch { return ''; } })()];
	for (const a of adaylar) {
		const k = kanalBilgi(a);
		if (k && k.tur === 'yazi') return a;
	}
	return (kanallar.find((k) => k.tur === 'yazi') || {}).id || '';
}

function cevrimiciSayaci() {
	$('cevrimici-sayac').textContent = String(kimlerListesi.length);
	$('uye-sayi').textContent = String(kimlerListesi.length);
}

function kanalListesiCiz() {
	const y = $('yazi-kanallari');
	const s = $('ses-kanallari');
	y.replaceChildren();
	s.replaceChildren();

	for (const k of kanallar.filter((x) => x.tur === 'yazi')) {
		const d = el('button', 'kanal' + (k.id === aktifKanal ? ' aktif' : ''));
		d.type = 'button';
		d.append(el('span', 'kanal-isaret', '#'), el('span', 'kanal-adi', k.ad));
		const n = okunmamis.get(k.id) || 0;
		if (n) d.append(el('span', 'rozet', n > 99 ? '99+' : String(n)));
		d.onclick = () => kanalSec(k.id);
		y.append(d);
	}

	for (const k of kanallar.filter((x) => x.tur === 'ses')) {
		const d = el('button', 'kanal' + (k.id === sesKanal ? ' aktif' : ''));
		d.type = 'button';
		d.append(el('span', 'kanal-isaret', '🔊'), el('span', 'kanal-adi', k.ad));
		const kisi = k.kisiler || [];
		if (kisi.length) d.append(el('span', 'rozet-yazi', String(kisi.length)));
		d.onclick = () => sesAc(k.id);
		s.append(d);
		for (const p of kisi) {
			const satir = el('div', 'ses-uyesi');
			satir.append(el('span', 'nokta' + (p.sessiz ? ' kapali' : '')), el('span', 'ad', p.ad + (p.ad === benimAdim ? ' (sen)' : '')));
			s.append(satir);
		}
	}
	cevrimiciSayaci();
	baslikGuncelle();
}

function uyeleriCiz() {
	const kap = $('uye-listesi');
	kap.replaceChildren();
	for (const k of kimlerListesi) {
		const d = el('div', 'uye');
		d.append(el('span', 'nokta' + (k.sessiz ? ' kapali' : '')), el('span', 'ad', k.ad + (k.ad === benimAdim ? ' (sen)' : '')));
		if (k.ses) d.append(el('span', 'etiket', kanalBilgi(k.ses)?.ad || 'ses'));
		kap.append(d);
	}
	cevrimiciSayaci();
}

function rozetleriGuncelle() {
	kanalListesiCiz();
}

function baslikGuncelle() {
	let toplam = 0;
	for (const n of okunmamis.values()) toplam += n;
	document.title = (toplam ? `(${toplam}) ` : '') + 'Ses Kanalı';
}

// ---------------------------------------------------------------- sohbet

function kanalSec(id) {
	const k = kanalBilgi(id);
	if (!k || k.tur !== 'yazi') return;
	aktifKanal = id;
	okunmamis.delete(id);
	rozetleriGuncelle();
	$('kanal-ad').textContent = '#' + k.ad;
	$('kanal-aciklama').textContent = k.aciklama || '';
	$('metin').placeholder = `#${k.ad} kanalına yaz…`;
	$('metin').disabled = false;
	mesajVerisi = [];
	$('mesajlar').replaceChildren();
	$('daha-eski').hidden = true;
	gecmisBitti = true;
	gecmisYukle();
	try {
		localStorage.setItem('kanal', id);
	} catch {}
	if (location.hash.slice(1) !== id) history.replaceState(null, '', '#' + id);
	kenarKapat();
	$('metin').focus();
}

function gecmisYukle() {
	if (!bagliyim || !aktifKanal) return;
	gonder({ type: 'gecmis', kanal: aktifKanal, once: mesajVerisi.length ? mesajVerisi[0].id : 0 });
}

function gecmisGeldi(m) {
	if (m.kanal !== aktifKanal) return;
	const gelen = m.mesajlar || [];
	gecmisBitti = !!m.bitti;
	$('daha-eski').hidden = gecmisBitti;
	if (!mesajVerisi.length) {
		mesajVerisi = gelen;
		mesajlariCiz(true);
	} else {
		const bilinen = new Set(mesajVerisi.map((x) => x.id));
		const eski = gelen.filter((x) => !bilinen.has(x.id));
		if (eski.length) {
			mesajVerisi = eski.concat(mesajVerisi);
			mesajlariCiz(false);
		}
	}
}

$('daha-eski').addEventListener('click', () => {
	if (gecmisBitti) return;
	gecmisYukle();
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

function renkBul(ad) {
	let h = 0;
	for (const ch of String(ad)) h = (h * 31 + ch.codePointAt(0)) % 360;
	return 25 + h * 0.85;
}
const basHarf = (ad) => [...String(ad).trim()][0]?.toLocaleUpperCase('tr') || '?';

function avatarYap(ad, sinif = 'avatar') {
	const e = el('span', sinif, basHarf(ad));
	e.style.setProperty('--renk', renkBul(ad));
	return e;
}

function boyutYaz(n) {
	if (n < 1024) return n + ' B';
	if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
	return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function metinCiz(hedef, metin) {
	if (!metin) return;
	const benimKucuk = benimAdim.toLocaleLowerCase('tr');
	for (const parca of String(metin).split(/(@[\p{L}\p{N}_.-]+)/u)) {
		if (!parca) continue;
		if (parca.startsWith('@') && parca.slice(1).toLocaleLowerCase('tr') === benimKucuk) {
			hedef.append(el('span', 'bahsetme', parca));
		} else {
			hedef.append(document.createTextNode(parca));
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
		v.src = url;
		return v;
	}
	const a = el('a', 'dosya-kart');
	a.href = url;
	a.target = '_blank';
	a.rel = 'noopener';
	a.download = dosya.ad;
	a.append(el('span', 'dosya-ikon', '📄'));
	const bilgi = el('span', 'dosya-bilgi');
	bilgi.append(el('b', null, dosya.ad), el('small', null, boyutYaz(dosya.boyut || 0)));
	a.append(bilgi, el('span', 'dosya-ikon', '⬇'));
	return a;
}

function mesajElemani(m, onceki) {
	const gruplu = !!(onceki && onceki.ad === m.ad && m.zaman - onceki.zaman < 5 * 60000);
	const d = el('div', 'mesaj' + (gruplu ? ' gruplu' : ''));
	d.dataset.id = m.id;
	if (!gruplu) d.append(avatarYap(m.ad));
	const govde = el('div', 'govde');
	if (!gruplu) {
		const ust = el('div', 'mesaj-ust');
		ust.append(el('b', 'ad', m.ad), el('span', 'saat', saatYaz(m.zaman)));
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

function mesajlariCiz(dibe) {
	const kap = $('mesajlar');
	const alan = $('mesaj-alani');
	const oncekiYukseklik = alan.scrollHeight;
	const oncekiKaydirma = alan.scrollTop;
	kap.replaceChildren();
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
	if (dibe) alan.scrollTop = alan.scrollHeight;
	else alan.scrollTop = oncekiKaydirma + (alan.scrollHeight - oncekiYukseklik);
}

function dibeYakin() {
	const alan = $('mesaj-alani');
	return alan.scrollHeight - alan.scrollTop - alan.clientHeight < 90;
}
const dibeKaydir = () => ($('mesaj-alani').scrollTop = $('mesaj-alani').scrollHeight);

function mesajGeldi(kanal, m) {
	if (!m) return;
	if (kanal === aktifKanal) {
		if (mesajVerisi.some((x) => x.id === m.id)) return;
		const yakin = dibeYakin();
		const onceki = mesajVerisi.length ? mesajVerisi[mesajVerisi.length - 1] : null;
		mesajVerisi.push(m);
		$('mesajlar').querySelectorAll('.bos-kanal').forEach((x) => x.remove());
		if (onceki && gunAnahtari(m.zaman) !== gunAnahtari(onceki.zaman)) {
			$('mesajlar').append(el('div', 'gun', gunEtiketi(m.zaman)));
		}
		const e = mesajElemani(m, onceki && gunAnahtari(m.zaman) === gunAnahtari(onceki.zaman) ? onceki : null);
		if (m.ad !== benimAdim) e.classList.add('yeni');
		$('mesajlar').append(e);
		if (yakin) dibeKaydir();
	} else if (m.ad !== benimAdim) {
		okunmamis.set(kanal, (okunmamis.get(kanal) || 0) + 1);
		kanalListesiCiz();
	}
}

// --- yazma

$('metin').addEventListener('input', () => {
	const t = $('metin');
	t.style.height = 'auto';
	t.style.height = Math.min(t.scrollHeight, 180) + 'px';
});

let yaziZaman = 0;
$('metin').addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && !e.shiftKey) {
		e.preventDefault();
		yaziyiGonder();
	}
});

let yaziyorZaman = 0;
$('metin').addEventListener('input', () => {
	if (!aktifKanal || !bagliyim) return;
	const simdi = Date.now();
	if (simdi - yaziyorZaman < 4000) return;
	yaziyorZaman = simdi;
	gonder({ type: 'yaziyor', kanal: aktifKanal });
});

$('yazma').addEventListener('submit', (e) => {
	e.preventDefault();
	yaziyiGonder();
});

function yaziyiGonder() {
	const t = $('metin');
	const metin = t.value.trim();
	if (!metin || !aktifKanal || !bagliyim) return;
	if (Date.now() - yaziZaman < 250) return; // çift Enter
	yaziZaman = Date.now();
	gonder({ type: 'yazi', kanal: aktifKanal, metin });
	t.value = '';
	t.style.height = 'auto';
	t.focus();
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
		if (simdi - zaman > 4000) yaziyorlar.delete(ad);
		else adlar.push(ad);
	}
	const e = $('yaziyor');
	if (!adlar.length) {
		e.textContent = '';
		e.classList.remove('gorunur');
		return;
	}
	e.classList.add('gorunur');
	e.textContent =
		adlar.length === 1 ? `${adlar[0]} yazıyor…` : `${adlar.slice(0, 3).join(', ')}${adlar.length > 3 ? ' ve diğerleri' : ''} yazıyor…`;
}
setInterval(yaziyorCiz, 1000);

// --- dosya

$('dosya-sec').addEventListener('click', () => $('dosya').click());
$('dosya').addEventListener('change', () => {
	const dosya = $('dosya').files && $('dosya').files[0];
	$('dosya').value = '';
	if (dosya) dosyaYukle(dosya);
});

$('mesaj-alani').addEventListener('dragover', (e) => {
	e.preventDefault();
	$('mesaj-alani').style.outline = '2px dashed #5865f2';
	$('mesaj-alani').style.outlineOffset = '-8px';
});
$('mesaj-alani').addEventListener('dragleave', () => {
	$('mesaj-alani').style.outline = '';
});
$('mesaj-alani').addEventListener('drop', (e) => {
	$('mesaj-alani').style.outline = '';
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
		$('yukleme-dolgu').style.width = Math.round((e.loaded / e.total) * 100) + '%';
		$('yukleme-yazi').textContent = `${dosya.name} · %${Math.round((e.loaded / e.total) * 100)}`;
	};
	xhr.onload = () => {
		yuklemeGizle();
		if (xhr.status === 200) return;
		let mesaj = 'Yükleme başarısız.';
		try {
			mesaj = JSON.parse(xhr.responseText).hata || mesaj;
		} catch {}
		durum(mesaj, true);
	};
	xhr.onerror = () => {
		yuklemeGizle();
		durum('Yükleme başarısız (ağ hatası).', true);
	};
	yuklemeGoster(dosya.name);
	xhr.send(dosya);
}

// ---------------------------------------------------------------- sesli kanallar (mesh)

const teklifEdenBenim = (ad) => benimAdim > ad;
const sesKartGuncelle = () => {
	$('ses-karti').hidden = !sesKanal;
	if (sesKanal) $('ses-kart-kanal').textContent = kanalBilgi(sesKanal)?.ad || sesKanal;
};

async function sesAc(kanal) {
	if (sesKanal === kanal) return;
	if (!bagliyim) return durum('Sunucuya bağlanmadan sesli kanala girilmez.', true);
	if (!mikrofon) {
		durum('Mikrofon izni bekleniyor…');
		try {
			// Yankı/gürültü giderme ve otomatik kazanç açık kalsın; sesi WebAudio'dan GEÇİRME
			// (geçirirse bu özellikler kapanır, ses robotikleşir).
			mikrofon = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
		} catch (hata) {
			const neden = hata && hata.name === 'NotFoundError' ? 'Mikrofon bulunamadı' : 'Mikrofon izni verilmedi';
			durum(neden + '; sesli kanal için mikrofon gerekli.', true);
			return;
		}
	}
	mikDugmeCiz();
	gonder({ type: 'ses-gir', kanal });
}

function sesKatil(kanal, kisiAdlari) {
	sesKanal = kanal;
	herkesiKapat();
	for (const ad of kisiAdlari) kisiEkle(ad);
	sesKartGuncelle();
	benSesSatirCiz();
	$('ben-kapat').hidden = false;
	mikDugmeCiz();
	gonder({ type: 'sessiz', sessiz: !mikrofon || mikrofon.getAudioTracks()[0]?.enabled === false });
	durum(`${kanalBilgi(kanal)?.ad || kanal} kanalına girdin.`);
}

function sesKapat(bildir = true) {
	if (bildir && bagliyim) gonder({ type: 'ses-cik' });
	const vardi = !!sesKanal;
	sesKanal = '';
	herkesiKapat();
	sesKartGuncelle();
	$('ben-kapat').hidden = true;
	$('ben-ses-satir').replaceChildren();
	if (mikrofon) {
		mikrofon.getTracks().forEach((t) => t.stop());
		mikrofon = null;
	}
	mikDugmeCiz();
	if (vardi) durum('Sesli kanaldan ayrıldın.');
}

$('ben-kapat').addEventListener('click', () => sesKapat());

$('ben-mikrofon').addEventListener('click', () => {
	const parca = mikrofon && mikrofon.getAudioTracks()[0];
	if (!parca) return;
	parca.enabled = !parca.enabled;
	mikDugmeCiz();
	benSesSatirCiz();
	gonder({ type: 'sessiz', sessiz: !parca.enabled });
});

function mikDugmeCiz() {
	const d = $('ben-mikrofon');
	const parca = mikrofon && mikrofon.getAudioTracks()[0];
	const acik = !!parca && parca.enabled;
	d.textContent = acik ? '🎤' : '🎤✕';
	d.classList.toggle('kapali', !acik);
	d.disabled = !sesKanal;
	d.setAttribute('aria-pressed', String(!acik));
	d.title = !sesKanal ? 'Sesli kanala girince mikrofon açılır' : acik ? 'Mikrofonu kapat' : 'Mikrofonu aç';
	$('ben-alt').textContent = sesKanal ? (acik ? 'sesli kanalda' : 'mikrofon kapalı') : 'bağlı';
}

function benSesSatirCiz() {
	const s = $('ben-ses-satir');
	if (!sesKanal) {
		s.replaceChildren();
		return;
	}
	const parca = mikrofon && mikrofon.getAudioTracks()[0];
	s.replaceChildren(
		el('span', 'nokta' + (parca && parca.enabled ? '' : ' kapali')),
		el('b', 'ad', benimAdim + ' (sen)'),
		el('span', 'etiket', parca && parca.enabled ? 'mikrofon açık' : 'sessiz'),
	);
	if (kendiOlcer) kendiOlcer.dur();
	kendiOlcer = seviyeOlcer(mikrofon, s, null, () => !!mikrofon && mikrofon.getAudioTracks()[0]?.enabled !== false);
}

function kisiEkle(ad) {
	if (!ad || ad === benimAdim || kisiler.has(ad)) return;
	const k = { pc: null, satir: null, ses: null, etiket: null, adaylar: [], kuyruk: Promise.resolve(), olcer: null, sesDugmesi: null, seviye: null };
	kisiler.set(ad, k);
	satirOlustur(ad, k);
	pcOlustur(ad, k);
	istatistikBaslat();
}

function kisiCikar(ad) {
	const k = kisiler.get(ad);
	if (!k) return;
	if (k.olcer) k.olcer.dur();
	try {
		k.pc?.close();
	} catch {}
	if (k.ses) {
		k.ses.srcObject = null;
		k.ses.remove();
	}
	if (k.satir) k.satir.remove();
	kisiler.delete(ad);
	if (!kisiler.size && istatistikZamanlayici) {
		clearInterval(istatistikZamanlayici);
		istatistikZamanlayici = null;
	}
}

function herkesiKapat() {
	for (const ad of [...kisiler.keys()]) kisiCikar(ad);
}

function satirOlustur(ad, k) {
	const satir = el('div', 'ses-kisi');
	const etiket = el('span', 'etiket', 'bağlanıyor…');
	const sus = el('button', 'ikon-dugme sus', '🔊');
	sus.type = 'button';
	sus.title = 'Bu kişiyi sustur/aç';
	sus.setAttribute('aria-label', ad + ' kişisini sustur veya aç');
	const seviye = el('input', 'ses-seviye');
	Object.assign(seviye, { type: 'range', min: 0, max: 100, value: 100 });
	seviye.title = 'Ses seviyesi';
	seviye.setAttribute('aria-label', ad + ' kişisinin ses seviyesi');
	const ses = el('audio');
	ses.autoplay = true;
	ses.hidden = true;
	sus.onclick = () => {
		ses.muted = !ses.muted;
		sus.classList.toggle('kapali', ses.muted);
		sus.textContent = ses.muted ? '🔇' : '🔊';
		satir.classList.toggle('sessiz', ses.muted);
	};
	seviye.oninput = () => (ses.volume = seviye.value / 100);
	satir.append(el('span', 'nokta'), el('b', 'ad', ad), etiket, sus, seviye, ses);
	$('ses-kisiler').append(satir);
	Object.assign(k, { satir, ses, etiket, seviye });
}

function pcOlustur(ad, k) {
	const pc = new RTCPeerConnection(ice);
	k.pc = pc;
	pc.onicecandidate = (e) => e.candidate && gonder({ type: 'ice', to: ad, ice: e.candidate });
	pc.ontrack = (e) => {
		const akis = e.streams[0] || new MediaStream([e.track]);
		k.ses.srcObject = akis;
		sesiBaslat(k);
		if (k.olcer) k.olcer.dur();
		k.olcer = seviyeOlcer(akis, k.satir, null, () => !k.ses.muted);
	};
	pc.onconnectionstatechange = () => {
		if (pc.connectionState === 'connected') bitHiziAyarla(pc);
		if (pc.connectionState === 'failed') {
			k.etiket.textContent = 'bağlanamadı';
			k.etiket.className = 'etiket hata';
			if (teklifEdenBenim(ad) && pc.signalingState === 'stable') pc.restartIce();
		}
	};
	if (teklifEdenBenim(ad)) {
		pc.onnegotiationneeded = async () => {
			try {
				await pc.setLocalDescription();
				gonder({ type: 'sdp', to: ad, sdp: pc.localDescription });
			} catch (h) {
				console.warn('teklif', ad, h);
			}
		};
		if (mikrofon) for (const t of mikrofon.getTracks()) pc.addTrack(t, mikrofon);
	}
}

function sdpGeldi(ad, sdp) {
	let k = kisiler.get(ad);
	if (!k) {
		kisiEkle(ad);
		k = kisiler.get(ad);
	}
	if (!k) return Promise.resolve();
	// Aynı kişiden art arda gelen teklifler sırayla işlensin; ICE yenilemesi araya girerse
	// setRemoteDescription "yanlış durumda" hatası verirdi.
	k.kuyruk = k.kuyruk.then(() => sdpIsle(ad, k, sdp)).catch((hata) => console.warn('sdp', ad, hata));
	return k.kuyruk;
}

async function sdpIsle(ad, k, sdp) {
	const pc = k.pc;
	if (!pc || pc.signalingState === 'closed') return;
	if (sdp.type === 'answer' && pc.signalingState !== 'have-local-offer') return;
	await pc.setRemoteDescription(sdp);
	for (const aday of k.adaylar.splice(0)) await pc.addIceCandidate(aday).catch(() => {});
	if (sdp.type === 'offer') {
		// Mikrofonu teklifteki ses kanalına bağla (yeni bir kanal açmadan).
		if (mikrofon && !pc.getSenders().some((s) => s.track)) {
			const tr = pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio');
			const parca = mikrofon.getAudioTracks()[0];
			if (tr && parca) {
				await tr.sender.replaceTrack(parca);
				tr.sender.setStreams?.(mikrofon);
				tr.direction = 'sendrecv';
			}
		}
		await pc.setLocalDescription();
		gonder({ type: 'sdp', to: ad, sdp: pc.localDescription });
	}
}

function iceGeldi(ad, aday) {
	const k = kisiler.get(ad);
	if (!k || !aday) return;
	if (k.pc.remoteDescription) k.pc.addIceCandidate(aday).catch(() => {});
	else k.adaylar.push(aday);
}

async function bitHiziAyarla(pc) {
	// Opus konuşma için 64 kbps fazlasıyla yeter.
	for (const s of pc.getSenders()) {
		if (!s.track || s.track.kind !== 'audio') continue;
		try {
			const p = s.getParameters();
			if (!p.encodings || !p.encodings.length) p.encodings = [{}];
			p.encodings[0].maxBitrate = 64000;
			await s.setParameters(p);
		} catch {}
	}
}

// Tarayıcı sesi kendiliğinden başlatmazsa (Safari, telefon) satıra bir kez basılacak "sesi aç" düğmesi ekler.
function sesiBaslat(k) {
	const basla = () =>
		k.ses.play().then(() => {
			if (k.sesDugmesi) {
				k.sesDugmesi.remove();
				k.sesDugmesi = null;
			}
		});
	basla().catch(() => {
		if (k.sesDugmesi) return;
		const dugme = el('button', 'ikon-dugme', '🔈');
		dugme.type = 'button';
		dugme.title = 'Tarayıcı sesi kendiliğinden başlatmadı; bir kez buraya bas';
		dugme.onclick = () => basla().catch(() => {});
		k.satir.append(dugme);
		k.sesDugmesi = dugme;
	});
}

// Ses seviyesi. Yalnızca ölçer; gönderilen/çalınan ses WebAudio'dan geçmez (geçseydi yankı ve
// gürültü giderme kapanır, ses robotikleşirdi).
function seviyeOlcer(akis, satir, yazi, acikMi) {
	let ac = null;
	try {
		ac = new AudioContext();
		const analiz = ac.createAnalyser();
		analiz.fftSize = 256;
		ac.createMediaStreamSource(akis).connect(analiz);
		const veri = new Uint8Array(analiz.frequencyBinCount);
		const zaman = setInterval(() => {
			analiz.getByteFrequencyData(veri);
			const yuzde = Math.round((Math.max(...veri) / 255) * 100);
			if (yazi) yazi.textContent = yuzde + '%';
			satir.classList.toggle('konusuyor', yuzde > 35 && (!acikMi || acikMi()));
		}, 200);
		return {
			dur() {
				clearInterval(zaman);
				satir.classList.remove('konusuyor');
				if (ac) ac.close().catch(() => {});
			},
		};
	} catch {
		return { dur() {} };
	}
}

// Her kişi için bağlantı türü (doğrudan / TURN aktarımı) ve gecikme.
function istatistikBaslat() {
	if (istatistikZamanlayici) return;
	istatistikZamanlayici = setInterval(async () => {
		for (const [, k] of kisiler) {
			if (!k.pc || k.pc.connectionState === 'failed') continue;
			try {
				const rapor = await k.pc.getStats();
				let cift = null;
				rapor.forEach((r) => {
					if (r.type === 'transport' && r.selectedCandidatePairId) cift = rapor.get(r.selectedCandidatePairId);
				});
				if (!cift)
					rapor.forEach((r) => {
						if (!cift && r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) cift = r;
					});
				if (!cift) continue;
				const yerel = rapor.get(cift.localCandidateId);
				const uzak = rapor.get(cift.remoteCandidateId);
				const aktarim = yerel?.candidateType === 'relay' || uzak?.candidateType === 'relay';
				const rtt = cift.currentRoundTripTime != null ? ` · ${Math.round(cift.currentRoundTripTime * 1000)} ms` : '';
				k.etiket.textContent = (aktarim ? 'TURN' : 'doğrudan') + rtt;
				k.etiket.className = 'etiket ' + (aktarim ? 'aktarim' : 'dogrudan');
			} catch {}
		}
	}, 3000);
}

function sessizGoster(ad, sessiz) {
	const k = kisiler.get(ad);
	if (k && k.satir) k.satir.classList.toggle('sessiz', !!sessiz);
}

// ---------------------------------------------------------------- kenar çubuğu (telefon)

const kenarAc = () => $('kanal-panosu').classList.add('acik');
const kenarKapat = () => $('kanal-panosu').classList.remove('acik');
$('menu').addEventListener('click', () => ($('kanal-panosu').classList.contains('acik') ? kenarKapat() : kenarAc()));
$('kenar-kapat').addEventListener('click', kenarKapat);

// ---------------------------------------------------------------- kapanış

window.addEventListener('pagehide', () => {
	sesKapat(false);
	if (ws) ws.close();
});
window.addEventListener('beforeunload', () => {
	if (mikrofon) mikrofon.getTracks().forEach((t) => t.stop());
});
