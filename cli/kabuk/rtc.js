// WebRTC: @roamhq/wrtc (libwebrtc M106, Chrome'un motoru) ve sayfanın tarayıcıdan beklediği ama
// kitaplıkta olmayan birkaç şey.
//
// Kitaplığın nesneleri sayfaya olduğu gibi verilir (RTCPeerConnection, MediaStream, izler…): sayfa
// izleri kimliğiyle karşılaştırır (sender.track === iz), sarmalanmış kopyalar bunu bozardı. Eksikler
// nesnelerin üstüne eklenir:
//   - izler: label, contentHint, applyConstraints, getSettings (aygıtın gerçek bilgisi), durdurulunca
//     aygıtı bırakma (kitaplığın kendi yöntemleri değiştirilemez: örneğin üstünde tanımlanır),
//   - veri kanalı: bufferedAmountLowThreshold ve bufferedamountlow olayı (dosya gönderimi buna göre
//     ilerler),
//   - kanal başına istatistik (sender.getStats / receiver.getStats).
'use strict';

const wrtc = require('@roamhq/wrtc');

// ---------------------------------------------------------------- izler

const izBilgileri = new WeakMap(); // iz → { etiket, ayarlar(), kisit, ipucu }

// Bir ize kabuğun bildiklerini ekle. ayarlar: getSettings'in döndüreceği; dur: iz durdurulunca
// (aygıtı bırakmak için) çağrılır.
function izTanit(iz, { etiket = '', ayarlar = null, dur = null } = {}) {
	izBilgileri.set(iz, { etiket, ayarlar, kisit: {}, ipucu: '' });
	if (ayarlar) Object.defineProperty(iz, 'getSettings', { configurable: true, writable: true, value: () => ayarlar() });
	if (dur) {
		const yerel = iz.stop.bind(iz);
		let durdu = false;
		Object.defineProperty(iz, 'stop', {
			configurable: true,
			writable: true,
			value: () => {
				if (durdu) return;
				durdu = true;
				try {
					dur();
				} finally {
					yerel();
				}
			},
		});
	}
	return iz;
}

// İz kendiliğinden bitti (aygıt çıkarıldı): durdur ve 'ended' olayını çıkar (stop() olay çıkarmaz).
function izBitir(iz) {
	if (iz.readyState === 'ended') return;
	iz.stop();
	iz.dispatchEvent({ type: 'ended', target: iz });
}

{
	const P = wrtc.MediaStreamTrack.prototype;
	const bilgi = (iz) => {
		let b = izBilgileri.get(iz);
		if (!b) izBilgileri.set(iz, (b = { etiket: '', ayarlar: null, kisit: {}, ipucu: '' }));
		return b;
	};
	if (!('label' in P)) {
		Object.defineProperties(P, {
			label: {
				configurable: true,
				get() {
					return bilgi(this).etiket;
				},
			},
			contentHint: {
				configurable: true,
				get() {
					return bilgi(this).ipucu;
				},
				set(v) {
					bilgi(this).ipucu = String(v);
				},
			},
			applyConstraints: {
				configurable: true,
				writable: true,
				value(kisit) {
					bilgi(this).kisit = kisit || {};
					return Promise.resolve();
				},
			},
			getConstraints: {
				configurable: true,
				writable: true,
				value() {
					return { ...bilgi(this).kisit };
				},
			},
			getCapabilities: {
				configurable: true,
				writable: true,
				value() {
					return {};
				},
			},
		});
	}
}

// ---------------------------------------------------------------- veri kanalı

// Gönderim tamponu eşiğin altına inince 'bufferedamountlow' (kitaplık bu olayı vermiyor): tampon
// eşiğin üstündeyken 15 ms'de bir bakılır.
{
	const P = wrtc.RTCDataChannel.prototype;
	if (!P.diszortYama) {
		const durum = new WeakMap(); // kanal → { esik, zamanlayici }
		const al = (k) => {
			let d = durum.get(k);
			if (!d) durum.set(k, (d = { esik: 0, zamanlayici: null }));
			return d;
		};
		Object.defineProperty(P, 'bufferedAmountLowThreshold', {
			configurable: true,
			get() {
				return al(this).esik;
			},
			set(v) {
				al(this).esik = Math.max(0, Number(v) || 0);
			},
		});
		const gonder = P.send;
		P.send = function (veri) {
			gonder.call(this, veri);
			const d = al(this);
			if (d.zamanlayici || this.bufferedAmount <= d.esik) return;
			d.zamanlayici = setInterval(() => {
				let dolu = 0;
				let acik = false;
				try {
					acik = this.readyState === 'open';
					dolu = this.bufferedAmount;
				} catch {}
				if (acik && dolu > d.esik) return;
				clearInterval(d.zamanlayici);
				d.zamanlayici = null;
				if (acik) this.dispatchEvent({ type: 'bufferedamountlow', target: this });
			}, 15);
			if (d.zamanlayici.unref) d.zamanlayici.unref();
		};
		Object.defineProperty(P, 'diszortYama', { value: true });
	}
}

// ---------------------------------------------------------------- bağlantı

const sonRapor = new WeakMap(); // bağlantı → { zaman, soz }
async function kanalRaporu(pc, tr, giden) {
	// Sayfa bir turda aynı bağlantının birkaç kanalını sorar: 150 ms içinde tek rapor yeter.
	let kayit = sonRapor.get(pc);
	if (!kayit || performance.now() - kayit.zaman > 150) sonRapor.set(pc, (kayit = { zaman: performance.now(), soz: pc.getStats() }));
	const rapor = await kayit.soz;
	const mid = tr.mid;
	const sonuc = new Map();
	rapor.forEach((r, id) => {
		const yerel = r.type === 'inbound-rtp' || r.type === 'outbound-rtp';
		const uzak = r.type === 'remote-inbound-rtp' || r.type === 'remote-outbound-rtp';
		if (yerel || uzak) {
			if (mid != null && r.mid != null && String(r.mid) !== String(mid)) return;
			// Giden: outbound-rtp ve karşının onun için bildirdiği (remote-inbound-rtp); gelen: tersi.
			if (giden !== (r.type === 'outbound-rtp' || r.type === 'remote-inbound-rtp')) return;
		}
		sonuc.set(id, r);
	});
	return sonuc;
}
const etiketli = new WeakSet();
function kanalEtiketle(pc, tr) {
	if (!tr || etiketli.has(tr)) return;
	etiketli.add(tr);
	const tanimla = (nesne, giden) => nesne && Object.defineProperty(nesne, 'getStats', { configurable: true, writable: true, value: () => kanalRaporu(pc, tr, giden) });
	tanimla(tr.sender, true);
	tanimla(tr.receiver, false);
}

// Bağlantı kurulduktan SONRA açılan veri kanalında kitaplık, kanalı açan tarafa 'open' olayını
// vermiyor (kanal açılır, readyState 'open' olur; olay gelmez). Sayfa dosya isteğini bu olayda
// gönderir: ikinci dosyadan itibaren indirme "bağlanıyor…"da kalırdı. Kanal açılana kadar durumuna
// bakılır; olay gelmediyse burada çıkarılır (gelirse ikincisi yutulur).
function acilisiIzle(kanal) {
	let acildi = false;
	const asil = kanal.dispatchEvent;
	kanal.dispatchEvent = function (olay) {
		if (olay && olay.type === 'open') {
			if (acildi) return undefined;
			acildi = true;
		}
		return asil.call(this, olay);
	};
	const bak = setInterval(() => {
		let durum = 'closed';
		try {
			durum = kanal.readyState;
		} catch {}
		if (acildi || durum === 'closing' || durum === 'closed') return clearInterval(bak);
		if (durum === 'open') {
			clearInterval(bak);
			kanal.dispatchEvent({ type: 'open', target: kanal });
		}
	}, 20);
	if (bak.unref) bak.unref();
}

class RTCPeerConnection extends wrtc.RTCPeerConnection {
	constructor(ayar) {
		super(ayar);
		// Sayfanın 'track' işleyicisinden önce: kanalın gönderici ve alıcısı istatistik verebilsin.
		this.addEventListener('track', (e) => kanalEtiketle(this, e.transceiver));
	}
	addTransceiver(...a) {
		const tr = super.addTransceiver(...a);
		kanalEtiketle(this, tr);
		return tr;
	}
	getTransceivers() {
		const liste = super.getTransceivers();
		for (const tr of liste) kanalEtiketle(this, tr);
		return liste;
	}
	createDataChannel(...a) {
		const kanal = super.createDataChannel(...a);
		acilisiIzle(kanal);
		return kanal;
	}
}

// Sayfaya verilecek adlar.
const pencereAdlari = {
	RTCPeerConnection,
	RTCSessionDescription: wrtc.RTCSessionDescription,
	RTCIceCandidate: wrtc.RTCIceCandidate,
	RTCRtpSender: wrtc.RTCRtpSender,
	RTCRtpReceiver: wrtc.RTCRtpReceiver,
	RTCRtpTransceiver: wrtc.RTCRtpTransceiver,
	RTCDataChannel: wrtc.RTCDataChannel,
	MediaStream: wrtc.MediaStream,
	MediaStreamTrack: wrtc.MediaStreamTrack,
};

module.exports = { wrtc, izTanit, izBitir, pencereAdlari };
