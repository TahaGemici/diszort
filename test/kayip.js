// Paket kaybı denemesi (gerçek Chromium, sunucusuz): aynı sayfada iki RTCPeerConnection, aralarında
// RTP paketlerinin bir kısmını düşüren bir UDP aracısı (Node). Adaylar aracıya yönlendirilir: A, B'yi
// aracının bir kapısında, B de A'yı ötekinde görür; A → B yönündeki RTP'nin %10'u (tohumlu, rastgele)
// düşer. Alıcıda duyulan bozulma ölçülür: uydurulan (sessiz olmayan) ses / alınan ses.
//
// Konuşma (mikrofon kanalının Opus ayarlarıyla: mono, 96 kbps) ve müzik (paylaşım kanalınınkiyle:
// stereo, yedekli 192 kbps; yedeğin sığmadığı 510 ayrıca), düz Opus ve RED'le (kodek sırası ana.js'teki kodekSirasi ile, uygulamadaki gibi).
// Beklenen: düz Opus'ta kaybın yaklaşık yarısı ile tamamı arası uydurulur (Opus'un kendi yedeği ancak
// kodlayıcı kaybı öğrenince, düşük kalitede devreye girer), RED'le yalnızca art arda iki paketin birden
// düştüğü yerler (rastgele %10 kayıpta ~%1).
//
//   node test/kayip.js        (playwright gerekir; make kayip)
'use strict';

const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

let chromium;
try {
	({ chromium } = require('playwright'));
} catch {
	console.log('playwright kurulu değil; kayıp denemesi atlandı (npm install --no-save playwright && npx playwright install chromium).');
	process.exit(process.env.TARAYICI_ZORUNLU === '1' ? 1 : 0);
}

const KOK = path.resolve(__dirname, '..');
// Uygulamanın kodek sırası işlevi (RED önde), sayfada aynen çalıştırılır.
const KODEK_SIRASI = (fs.readFileSync(path.join(KOK, 'web/ana.js'), 'utf8').match(/\nfunction kodekSirasi\(red\) \{[\s\S]*?\n\}\n/) || [])[0];
if (!KODEK_SIRASI) throw new Error('ana.js içinde kodekSirasi bulunamadı');
const KAYIP = 0.1;
const SURE = 12000; // ölçüm (ms), 3 sn ısınmadan sonra

let gecen = 0;
async function dene(ad, fn) {
	const t0 = Date.now();
	try {
		const ek = await fn();
		gecen++;
		console.log(`ok   ${ad} (${((Date.now() - t0) / 1000).toFixed(1)} sn)${ek ? '\n     ' + ek : ''}`);
	} catch (e) {
		process.exitCode = 1;
		console.error('HATA ' + ad + '\n     ' + (e && e.stack ? e.stack : e));
	}
}

// 48 kHz WAV: konuşmaya benzeyen (mono, duraklamasız) ya da müzik (stereo: akorlar, bas, davul).
function wavYaz(dosya, kanallar) {
	const N = kanallar[0].length;
	const C = kanallar.length;
	const v = Buffer.alloc(44 + N * C * 2);
	v.write('RIFF', 0);
	v.writeUInt32LE(36 + N * C * 2, 4);
	v.write('WAVEfmt ', 8);
	v.writeUInt32LE(16, 16);
	v.writeUInt16LE(1, 20);
	v.writeUInt16LE(C, 22);
	v.writeUInt32LE(48000, 24);
	v.writeUInt32LE(48000 * C * 2, 28);
	v.writeUInt16LE(C * 2, 32);
	v.writeUInt16LE(16, 34);
	v.write('data', 36);
	v.writeUInt32LE(N * C * 2, 40);
	for (let i = 0; i < N; i++) for (let c = 0; c < C; c++) v.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(kanallar[c][i] * 32767))), 44 + (i * C + c) * 2);
	fs.writeFileSync(dosya, v);
}
function konusma(saniye) {
	const N = 48000 * saniye;
	const s = new Float32Array(N);
	let faz = 0;
	for (let i = 0; i < N; i++) {
		const t = i / 48000;
		const perde = 150 + 30 * Math.sin(2 * Math.PI * 0.3 * t);
		faz += (2 * Math.PI * perde) / 48000;
		let x = 0;
		for (let h = 1; h <= 20; h++) {
			const f = h * perde;
			x += (Math.sin(h * faz) / h) * (0.3 + Math.exp(-(((f - 600) / 300) ** 2)) + 0.5 * Math.exp(-(((f - 1700) / 400) ** 2)));
		}
		s[i] = x * 0.12 * (0.75 + 0.25 * Math.sin(2 * Math.PI * 4 * t));
	}
	return [s];
}
function muzik(saniye) {
	const N = 48000 * saniye;
	const L = new Float32Array(N);
	const R = new Float32Array(N);
	const akorlar = [[220, 277.18, 329.63], [196, 246.94, 293.66], [174.61, 220, 261.63], [196, 246.94, 329.63]];
	let tohum = 5;
	const r = () => ((tohum = (Math.imul(tohum, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
	for (let i = 0; i < N; i++) {
		const t = i / 48000;
		const a = akorlar[Math.floor(t / 2) % 4];
		let l = 0;
		let rr = 0;
		a.forEach((f, k) => {
			for (let h = 1; h <= 6; h++) {
				const v = Math.sin(2 * Math.PI * f * h * t + k) / (h * h);
				l += v * (k === 0 ? 1 : 0.6);
				rr += v * (k === 2 ? 1 : 0.6);
			}
		});
		const bas = Math.sin(2 * Math.PI * (a[0] / 2) * t) * 0.8;
		const vt = t % 0.5;
		const kick = Math.sin(2 * Math.PI * (60 + 80 * Math.exp(-vt * 30)) * vt) * Math.exp(-vt * 12);
		const hh = r() * Math.exp(-((t + 0.25) % 0.5) * 60) * 0.4;
		L[i] = l * 0.08 + bas * 0.15 + kick * 0.35 + hh * 0.5;
		R[i] = rr * 0.08 + bas * 0.15 + kick * 0.35 - hh * 0.4;
	}
	return [L, R];
}

// Aracı: Y'ye gelen (A'dan) B'ye X'ten, X'e gelen (B'den) A'ya Y'den iletilir. A → B yönünde RTP
// paketleri (RTCP, STUN ve DTLS değil) tohumlu rastgeleyle düşer. Her arabirimde dinler: adayların
// yalnızca kapısı değiştirilir (IP'si, hangi arabirimdeyse, aynı kalır).
function araciKur(kayip, tohum) {
	const X = dgram.createSocket('udp4');
	const Y = dgram.createSocket('udp4');
	const a = { A: null, B: null, giden: 0, dusen: 0 };
	let s = tohum >>> 0;
	const rastgele = () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const rtpMi = (m) => m.length > 12 && m[0] >= 128 && m[0] <= 191 && !(m[1] >= 192 && m[1] <= 223);
	Y.on('message', (m, r) => {
		a.A = r;
		if (!a.B) return;
		if (rtpMi(m)) {
			a.giden++;
			if (rastgele() < kayip) {
				a.dusen++;
				return;
			}
		}
		X.send(m, a.B.port, a.B.address);
	});
	X.on('message', (m, r) => {
		a.B = r;
		if (a.A) Y.send(m, a.A.port, a.A.address);
	});
	return new Promise((tamam) => X.bind(0, '0.0.0.0', () => Y.bind(0, '0.0.0.0', () => tamam({ a, X: X.address().port, Y: Y.address().port, kapat: () => (X.close(), Y.close()) }))));
}

// Sayfada: A (gönderen) → B (alan), aracıdan geçerek; red: kodek sırası RED önde. fmtp: B'nin yanıtına
// eklenen Opus ayarları (uygulamanın opusAyarla'sı gibi: karşının dediği bizim kodlayıcımızı ayarlar).
async function olc(sayfa, { red, fmtp, stereo }) {
	const ar = await araciKur(KAYIP, 12345);
	try {
		const r = await sayfa.evaluate(
			async ({ red, fmtp, stereo, X, Y, sure, kodekSirasiKaynak }) => {
				const kodekSirasi = new Function(kodekSirasiKaynak + '\nreturn kodekSirasi;')();
				const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: stereo ? 2 : 1 } });
				const A = new RTCPeerConnection();
				const B = new RTCPeerConnection();
				const yonlendir = (c, port) => {
					const p = c.candidate.split(' ');
					if (p[2].toLowerCase() !== 'udp' || p[7] !== 'host' || !/^\d+\.\d+\.\d+\.\d+$/.test(p[4])) return null;
					p[5] = String(port);
					return new RTCIceCandidate({ candidate: p.join(' '), sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex });
				};
				A.onicecandidate = (e) => {
					const c = e.candidate && yonlendir(e.candidate, X);
					if (c) B.addIceCandidate(c);
				};
				B.onicecandidate = (e) => {
					const c = e.candidate && yonlendir(e.candidate, Y);
					if (c) A.addIceCandidate(c);
				};
				const tr = A.addTransceiver(s.getAudioTracks()[0], { direction: 'sendonly' });
				let alici = null;
				B.ontrack = (e) => {
					alici = e.receiver;
					if (red) e.transceiver.setCodecPreferences(kodekSirasi(true));
					const a = new Audio();
					a.srcObject = new MediaStream([e.track]);
					a.play().catch(() => {});
				};
				if (red) tr.setCodecPreferences(kodekSirasi(true));
				await A.setLocalDescription();
				await B.setRemoteDescription(A.localDescription);
				await B.setLocalDescription();
				const yanit = B.localDescription.sdp.replace(/a=fmtp:(\d+) (minptime[^\r\n]*)/, (m, pt, v) => `a=fmtp:${pt} ${v};${fmtp}`);
				await A.setRemoteDescription({ type: 'answer', sdp: yanit });
				for (let i = 0; i < 80 && A.connectionState !== 'connected'; i++) await new Promise((r) => setTimeout(r, 100));
				const kodek = (tr.sender.getParameters().codecs || [])[0];
				await new Promise((r) => setTimeout(r, 3000));
				const oku = async () => {
					let o = null;
					(await alici.getStats()).forEach((x) => {
						if (x.type === 'inbound-rtp') o = x;
					});
					return o;
				};
				const r1 = await oku();
				await new Promise((r) => setTimeout(r, sure));
				const r2 = await oku();
				const durum = A.connectionState;
				A.close();
				B.close();
				s.getTracks().forEach((t) => t.stop());
				if (!r1 || !r2) return { hata: 'ses gelmedi (bağlantı: ' + durum + ')' };
				const d = (k) => (r2[k] || 0) - (r1[k] || 0);
				return {
					kodek: kodek && kodek.mimeType,
					uydurulan: (d('concealedSamples') - d('silentConcealedSamples')) / Math.max(1, d('totalSamplesReceived')),
					kbps: Math.round((d('bytesReceived') * 8) / sure),
				};
			},
			{ red, fmtp, stereo, X: ar.X, Y: ar.Y, sure: SURE, kodekSirasiKaynak: KODEK_SIRASI },
		);
		if (r.hata) throw new Error(r.hata);
		return { ...r, agKaybi: ar.a.giden ? ar.a.dusen / ar.a.giden : 0 };
	} finally {
		ar.kapat();
	}
}

(async () => {
	const klasor = fs.mkdtempSync(path.join(os.tmpdir(), 'diszort-kayip-'));
	const sunucu = http.createServer((q, r) => {
		r.setHeader('content-type', 'text/html; charset=utf-8');
		r.end('<!doctype html><title>kayıp</title>');
	});
	await new Promise((r) => sunucu.listen(0, '127.0.0.1', r));
	const yuzde = (x) => (x * 100).toFixed(1) + '%';
	try {
		for (const [tur, ses, fmtp, stereo, yedekSigar = true] of [
			['konuşma (mikrofon: mono, 96 kbps)', konusma(60), 'stereo=0;usedtx=0;useinbandfec=1;maxaveragebitrate=96000', false],
			// Paylaşımın otomatik ayarı yedek anlaşılınca 192 kbps: yedek pakete sığar.
			['müzik (paylaşım, yedekli: stereo, 192 kbps)', muzik(60), 'stereo=1;sprop-stereo=1;usedtx=0;useinbandfec=1;maxaveragebitrate=192000', true],
			// "En yüksek" (510): 20 ms'lik çerçeve ~1275 bayt; libwebrtc RED paketi 1200 baytı geçemez ve
			// 1024 bayttan büyük çerçeveyi yedekleyemez: yedek kendiliğinden atlanır.
			['müzik (paylaşım "En yüksek": stereo, 510 kbps)', muzik(60), 'stereo=1;sprop-stereo=1;usedtx=0;useinbandfec=1;maxaveragebitrate=510000', true, false],
		]) {
			const dosya = path.join(klasor, (stereo ? 'muzik' : 'konusma') + '.wav');
			wavYaz(dosya, ses);
			const tarayici = await chromium.launch({
				executablePath: process.env.CHROMIUM_YOLU || undefined,
				args: [
					'--use-fake-ui-for-media-stream',
					'--use-fake-device-for-media-stream',
					'--use-file-for-fake-audio-capture=' + dosya,
					'--autoplay-policy=no-user-gesture-required',
					// Adaylar gerçek IP'yle gelsin (aracıya yönlendirilebilsin).
					'--disable-features=WebRtcHideLocalIpsWithMdns',
				],
			});
			try {
				const sayfa = await (await tarayici.newContext({ permissions: ['microphone'] })).newPage();
				await sayfa.goto(`http://127.0.0.1:${sunucu.address().port}/`);
				if (!yedekSigar) {
					await dene(`%${KAYIP * 100} rastgele kayıpta ${tur}: RED yedeği pakete sığmaz, düz Opus gibi`, async () => {
						const duz = await olc(sayfa, { red: false, fmtp, stereo });
						const red = await olc(sayfa, { red: true, fmtp, stereo });
						for (const x of [duz, red]) assert.ok(x.agKaybi > 0.07 && x.agKaybi < 0.13, 'aracı beklenen kadar düşürmedi: ' + yuzde(x.agKaybi));
						// Opus değişken bit hızlıdır: bu yapay müzikte hedefin ~2/3'ü (gerçek müzikte ~510 ölçüldü).
						assert.ok(duz.kbps > 250 && red.kbps > 250, 'bit hızı 160 kbps ayarından belirgin yüksek olmalı: ' + duz.kbps + ' / ' + red.kbps);
						assert.ok(red.kbps < duz.kbps * 1.2, 'yedek gidiyor gibi (beklenmiyordu): ' + red.kbps + ' / ' + duz.kbps + ' kbps');
						assert.ok(red.uydurulan > duz.uydurulan / 2, 'RED burada kurtarmamalıydı: ' + yuzde(red.uydurulan) + ' / ' + yuzde(duz.uydurulan));
						return `ağ kaybı ${yuzde(duz.agKaybi)} / ${yuzde(red.agKaybi)}; uydurulan: düz Opus ${yuzde(duz.uydurulan)} (${duz.kbps} kbps), RED anlaşılınca ${yuzde(red.uydurulan)} (${red.kbps} kbps, ${red.kodek})`;
					});
					continue;
				}
				await dene(`%${KAYIP * 100} rastgele kayıpta ${tur}: RED uydurulan sesi kat kat azaltır`, async () => {
					const duz = await olc(sayfa, { red: false, fmtp, stereo });
					const red = await olc(sayfa, { red: true, fmtp, stereo });
					assert.equal(duz.kodek, 'audio/opus', 'düz denemede gönderilen kodek Opus olmalı');
					assert.equal(red.kodek, 'audio/red', "RED'li denemede gönderilen kodek RED olmalı");
					for (const x of [duz, red]) assert.ok(x.agKaybi > 0.07 && x.agKaybi < 0.13, 'aracı beklenen kadar düşürmedi: ' + yuzde(x.agKaybi));
					assert.ok(duz.uydurulan > duz.agKaybi * 0.3, 'düz Opus kaybı fazla iyi kurtardı (deneme anlamsız): ' + yuzde(duz.uydurulan));
					// RED'in kurtaramadığı: art arda iki kayıp (~kayıp²).
					assert.ok(red.uydurulan < 0.025 && red.uydurulan < duz.uydurulan / 3, "RED'le uydurulan ses düz Opus'unkinin üçte birinden az olmalı: " + yuzde(red.uydurulan) + ' / ' + yuzde(duz.uydurulan));
					assert.ok(red.kbps > duz.kbps * 1.5, 'RED kopyaları gitmiyor gibi: ' + red.kbps + ' / ' + duz.kbps + ' kbps');
					return `ağ kaybı ${yuzde(duz.agKaybi)} / ${yuzde(red.agKaybi)}; uydurulan: düz Opus ${yuzde(duz.uydurulan)} (${duz.kbps} kbps), RED ${yuzde(red.uydurulan)} (${red.kbps} kbps)`;
				});
			} finally {
				await tarayici.close();
			}
		}
	} finally {
		sunucu.close();
		fs.rmSync(klasor, { recursive: true, force: true });
	}
	console.log(process.exitCode ? 'BAŞARISIZ' : `Kayıp denemeleri geçti (${gecen}).`);
})();
