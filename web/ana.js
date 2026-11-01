// Ses Kanalı — tarayıcı tarafı.
// Odadaki herkes herkese doğrudan bağlanır (mesh WebRTC). Sunucu yalnızca kimin odada olduğunu söyler ve
// bağlantı tekliflerini (SDP/ICE) iletir; ses sunucudan geçmez (doğrudan bağlanamayanlar TURN'den geçer).
'use strict';

const $ = (id) => document.getElementById(id);
// hata=true: durum satırı kırmızı gösterilir (kullanıcı hatayı normal bilgiden ayırsın).
const durum = (metin, hata = false) => {
	const e = $('durum');
	e.textContent = metin;
	e.classList.toggle('hata', hata);
};

// Aynı sekme yeniden bağlanınca sunucu eski bağlantıyı tanısın ("bu ad zaten var" demesin).
const SEKME = sessionStorage.getItem('sekme') || crypto.getRandomValues(new Uint32Array(4)).join('-');
sessionStorage.setItem('sekme', SEKME);

let ws = null;
let benimAdim = '';
let oda = '';
let mikrofon = null;
let ice = { iceServers: [] };
let yenidenDene = 0;
let istatistikZamanlayici = null;
let kendiOlcer = null;
const kisiler = new Map(); // ad -> { pc, satir, ses, etiket, adaylar[] }

// ---------------------------------------------------------------- giriş

$('ad').value = localStorage.getItem('ad') || '';
// Bozuk bir bağlantı (#%E0%A4%A gibi) decodeURIComponent'i patlatıp bütün betiği durdurmasın.
if (location.hash.length > 1) {
	try {
		$('oda').value = decodeURIComponent(location.hash.slice(1));
	} catch {
		$('oda').value = location.hash.slice(1);
	}
}
(($('ad').value && $('oda').value) ? $('gir') : $('ad').value ? $('oda') : $('ad')).focus();

$('giris').addEventListener('submit', async (e) => {
	e.preventDefault();
	// Çift gönderim (Enter'a iki kez basmak) ikinci bir "sen" satırı ve ikinci mikrofon açardı.
	if (mikrofon || oda) return;
	benimAdim = $('ad').value.trim().slice(0, 32);
	oda = $('oda').value.trim().slice(0, 64);
	if (!benimAdim || !oda) return;
	localStorage.setItem('ad', benimAdim);
	$('gir').disabled = true;
	durum('Mikrofon izni bekleniyor…');
	try {
		// Önce mikrofon: bağlantı teklifleri gelmeye başladığında ses hazır olmalı.
		// Tarayıcının yankı/gürültü giderme ve otomatik kazancı açık kalsın; sesi WebAudio'dan
		// geçirmek bunları kapatır ve ses robotikleşir.
		mikrofon = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
		});
	} catch (hata) {
		$('gir').disabled = false;
		const neden = hata && hata.name === 'NotFoundError' ? 'Mikrofon bulunamadı' : 'Mikrofon izni verilmedi';
		durum(neden + '; ses kanalı için mikrofon gerekli.', true);
		return;
	}
	history.replaceState(null, '', '#' + encodeURIComponent(oda));
	$('oda-adi').textContent = oda;
	$('giris').hidden = true;
	$('kanal').hidden = false;
	kendiSatirim();
	baglan();
});

$('ayril').addEventListener('click', () => {
	oda = '';
	herkesiKapat();
	if (ws) ws.close();
	if (mikrofon) mikrofon.getTracks().forEach((t) => t.stop());
	location.reload();
});

$('kopyala').addEventListener('click', async () => {
	try {
		await navigator.clipboard.writeText(location.href);
		durum('Oda bağlantısı kopyalandı.');
	} catch {
		durum(location.href);
	}
});

window.addEventListener('pagehide', () => {
	herkesiKapat();
	if (ws) ws.close();
});

// ---------------------------------------------------------------- sunucu bağlantısı

async function baglan() {
	durum('Bağlanılıyor…');
	try {
		const yanit = await fetch('/api/ice', { cache: 'no-store' });
		if (yanit.ok) ice = await yanit.json();
	} catch {}
	ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/rtc');
	ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room: oda, name: benimAdim, id: SEKME }));
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
		if (!oda) return;
		// Sunucu yeniden başladı ya da ağ değişti: kısa bir beklemeyle yeniden bağlan.
		herkesiKapat();
		const bekle = Math.min(1000 * 2 ** yenidenDene++, 15000);
		durum(`Sunucu bağlantısı koptu; ${Math.round(bekle / 1000)} sn sonra yeniden denenecek…`);
		setTimeout(() => oda && baglan(), bekle);
	};
}

function gonder(nesne) {
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(nesne));
}

function mesaj(m) {
	switch (m.type) {
		case 'joined':
			yenidenDene = 0;
			if (m.max) $('max').textContent = m.max;
			herkesiKapat();
			for (const ad of m.peers) kisiEkle(ad);
			durum(m.peers.length ? 'Kanalda: ' + m.peers.join(', ') : 'Kanalda yalnızsın; biri girince kendiliğinden bağlanır.');
			break;
		case 'peer-joined':
			kisiEkle(m.name);
			durum(m.name + ' kanala girdi.');
			break;
		case 'peer-left':
			kisiCikar(m.name);
			durum(m.name + ' çıktı.');
			break;
		case 'sdp':
			sdpGeldi(m.from, m.sdp).catch((h) => console.warn('sdp', m.from, h));
			break;
		case 'ice':
			iceGeldi(m.from, m.ice);
			break;
		case 'error':
			durum(m.message, true);
			if (!kisiler.size) {
				// Giremedik (oda dolu, ad alınmış...): giriş ekranına dön. Mikrofonu da bırak,
				// yoksa kullanılmayan mikrofonun ışığı yanık kalıyor ve yeniden girişte ikinci satır oluşuyordu.
				oda = '';
				if (ws) ws.close();
				herkesiKapat();
				if (mikrofon) mikrofon.getTracks().forEach((t) => t.stop());
				mikrofon = null;
				$('kisiler').replaceChildren();
				$('kanal').hidden = true;
				$('giris').hidden = false;
				$('gir').disabled = false;
			}
			break;
	}
}

// ---------------------------------------------------------------- eşler (mesh)

// Çakışmasın diye her çiftte teklifi yalnızca bir taraf yapar: adı alfabetik olarak büyük olan.
const teklifEdenBenim = (ad) => benimAdim > ad;

function kisiEkle(ad) {
	if (ad === benimAdim || kisiler.has(ad)) return;
	const k = { pc: null, satir: null, ses: null, etiket: null, adaylar: [], akis: null, olcer: null, sesDugmesi: null, kuyruk: Promise.resolve() };
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
	// Oda boşaldıysa ölçüm sayacı boşuna dönmesin.
	if (!kisiler.size && istatistikZamanlayici) {
		clearInterval(istatistikZamanlayici);
		istatistikZamanlayici = null;
	}
}

function herkesiKapat() {
	for (const ad of [...kisiler.keys()]) kisiCikar(ad);
}

function pcOlustur(ad, k) {
	const pc = new RTCPeerConnection(ice);
	k.pc = pc;
	pc.onicecandidate = (e) => e.candidate && gonder({ type: 'ice', to: ad, ice: e.candidate });
	pc.ontrack = (e) => {
		k.akis = e.streams[0] || new MediaStream([e.track]);
		k.ses.srcObject = k.akis;
		sesiBaslat(k);
		// Gelen sesi ölç (ses bu yoldan geçmez; yalnızca seviye okunur) → konuşanın noktası yanar.
		if (k.olcer) k.olcer.dur();
		k.olcer = seviyeOlcer(k.akis, k.satir, null, () => !k.ses.muted);
	};
	pc.onconnectionstatechange = () => {
		if (pc.connectionState === 'connected') bitHiziAyarla(pc);
		if (pc.connectionState === 'failed') {
			k.etiket.textContent = 'bağlanamadı';
			k.etiket.className = 'etiket hata';
			// Ağ değişmiş olabilir: teklif eden taraf ICE'ı yeniden başlatır (teklif verilebilecek
			// bir durumdaysa; "have-local-offer" iken restartIce hata verirdi).
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
		for (const t of mikrofon.getTracks()) pc.addTrack(t, mikrofon);
	}
}

function sdpGeldi(ad, sdp) {
	let k = kisiler.get(ad);
	if (!k) {
		kisiEkle(ad);
		k = kisiler.get(ad);
	}
	// Aynı kişiden art arda gelen teklifler sırayla işlensin; ICE yenilemesi araya girerse
	// setRemoteDescription "yanlış durumda" hatası verirdi.
	k.kuyruk = k.kuyruk.then(() => sdpIsle(ad, k, sdp)).catch((hata) => console.warn('sdp', ad, hata));
	return k.kuyruk;
}

async function sdpIsle(ad, k, sdp) {
	const pc = k.pc;
	if (!pc || pc.signalingState === 'closed') return;
	// Elimizde teklif yokken gelen "answer" (eski/gecikmiş) yok sayılır.
	if (sdp.type === 'answer' && pc.signalingState !== 'have-local-offer') return;
	await pc.setRemoteDescription(sdp);
	for (const aday of k.adaylar.splice(0)) await pc.addIceCandidate(aday).catch(() => {});
	if (sdp.type === 'offer') {
		// Mikrofonu teklifteki ses kanalına bağla (yeni bir kanal açmadan).
		if (!pc.getSenders().some((s) => s.track)) {
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

// ---------------------------------------------------------------- arayüz

function el(etiket, sinif, metin) {
	const e = document.createElement(etiket);
	if (sinif) e.className = sinif;
	if (metin != null) e.textContent = metin;
	return e;
}

function kendiSatirim() {
	// Giriş hatasından sonra yeniden girildiğinde eski "sen" satırı kalmasın.
	document.querySelectorAll('.kisi.benim').forEach((e) => e.remove());
	const satir = el('div', 'kisi benim');
	const seviye = el('span', 'seviye bosluk');
	const dugme = el('button', 'kucuk', '🎤');
	dugme.type = 'button';
	dugme.title = 'Mikrofonu kapat/aç';
	dugme.setAttribute('aria-label', 'Mikrofonu kapat veya aç');
	const ciz = () => {
		const parca = mikrofon && mikrofon.getAudioTracks()[0];
		const acik = !parca || parca.enabled;
		dugme.textContent = acik ? '🎤' : '🎤✕';
		dugme.classList.toggle('kapali', !acik);
		dugme.setAttribute('aria-pressed', String(!acik));
	};
	dugme.onclick = () => {
		const parca = mikrofon && mikrofon.getAudioTracks()[0];
		if (!parca) return;
		parca.enabled = !parca.enabled;
		ciz();
	};
	ciz();
	satir.append(el('span', 'nokta'), el('b', 'ad', benimAdim), el('span', 'etiket', 'sen'), seviye, dugme);
	$('kisiler').prepend(satir);
	if (kendiOlcer) kendiOlcer.dur();
	kendiOlcer = seviyeOlcer(mikrofon, satir, seviye, () => !mikrofon || mikrofon.getAudioTracks()[0]?.enabled !== false);
}

function satirOlustur(ad, k) {
	const satir = el('div', 'kisi');
	const etiket = el('span', 'etiket', 'bağlanıyor…');
	const sus = el('button', 'kucuk bosluk sus', '🔊');
	sus.type = 'button';
	sus.title = 'Bu kişiyi sustur/aç';
	sus.setAttribute('aria-label', ad + ' kişisini sustur veya aç');
	const ses = el('audio');
	ses.autoplay = true;
	const seviye = el('input', 'ses');
	Object.assign(seviye, { type: 'range', min: 0, max: 100, value: 100, title: 'Ses seviyesi' });
	seviye.setAttribute('aria-label', ad + ' kişisinin ses seviyesi');
	sus.onclick = () => {
		ses.muted = !ses.muted;
		sus.classList.toggle('kapali', ses.muted);
		sus.textContent = ses.muted ? '🔇' : '🔊';
	};
	seviye.oninput = () => (ses.volume = seviye.value / 100);
	satir.append(el('span', 'nokta'), el('b', 'ad', ad), etiket, sus, seviye, ses);
	$('kisiler').append(satir);
	Object.assign(k, { satir, ses, etiket });
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
		const dugme = el('button', 'kucuk uyari', '🔈 sesi aç');
		dugme.type = 'button';
		dugme.title = 'Tarayıcı sesi kendiliğinden başlatmadı; bir kez buraya bas';
		dugme.onclick = () => basla().catch(() => {});
		const sus = k.satir.querySelector('.sus');
		if (sus) sus.after(dugme);
		else k.satir.append(dugme);
		k.sesDugmesi = dugme;
	});
}

// Ses seviyesi. Yalnızca ölçer; gönderilen/çalınan ses WebAudio'dan geçmez (geçseydi yankı ve
// gürültü giderme kapanır, ses robotikleşirdi). yazi: kendi satırındaki "42%" yazısı (uzak kişide yok).
// acikMi: mikrofon kapalı ya da kişi susturulmuşsa nokta yanmasın.
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
		for (const [ad, k] of kisiler) {
			if (k.pc.connectionState === 'failed') continue;
			try {
				const rapor = await k.pc.getStats();
				let cift = null;
				rapor.forEach((r) => {
					if (r.type === 'transport' && r.selectedCandidatePairId) cift = rapor.get(r.selectedCandidatePairId);
				});
				if (!cift) rapor.forEach((r) => {
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
