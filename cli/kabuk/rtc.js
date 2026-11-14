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
//   - kanal başına istatistik (sender.getStats / receiver.getStats),
//   - setLocalDescription: Opus'ta stereo çözme (aşağıda).
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

// Opus'u stereo çözme. libwebrtc gelen Opus'u ancak KENDİ açıklamasında (yerel SDP) stereo=1 yazıyorsa
// iki kanal çözer (AudioDecoderOpus: "Default to mono"); yoksa stereo gelen ses (paylaşılan müzik)
// tek kanala indirilir. Yerel açıklamadaki her Opus satırına stereo=1 eklenir: yalnızca "stereo
// alabilirim" demektir, karşının ne göndereceğini yine karşının uyguladığı açıklama belirler.
function stereoCoz(sdp) {
	if (typeof sdp !== 'string') return sdp;
	const opus = new Set();
	for (const m of sdp.matchAll(/^a=rtpmap:(\d+) opus\/48000/gim)) opus.add(m[1]);
	if (!opus.size) return sdp;
	return sdp.replace(/^a=fmtp:(\d+) ([^\r\n]*)/gm, (satir, pt, deger) => {
		if (!opus.has(pt) || /(^|;)\s*stereo=/.test(deger)) return satir;
		return `a=fmtp:${pt} ${deger};stereo=1`;
	});
}

// Kanal başına istatistik (sender.getStats / receiver.getStats): kitaplıkta yok. Sayfa bir kanalın
// (mikrofon, paylaşılan ses, görüntü) gidenini ve gelenini ayrı ayrı okur; bağlantının tüm raporundan
// o kanalın (mid) ve o yönün akış kayıtları süzülür, gerisi (aktarım, aday çiftleri, kodekler) kalır.
async function kanalRaporu(pc, tr, giden) {
	const rapor = await pc.getStats();
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
	setLocalDescription(aciklama) {
		if (aciklama && typeof aciklama.sdp === 'string' && (aciklama.type === 'offer' || aciklama.type === 'answer')) {
			aciklama = { type: aciklama.type, sdp: stereoCoz(aciklama.sdp) };
		}
		return super.setLocalDescription(aciklama);
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

module.exports = { wrtc, izTanit, izBitir, stereoCoz, pencereAdlari };
