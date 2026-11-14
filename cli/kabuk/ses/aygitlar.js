// navigator.mediaDevices'in karşılığı: ses aygıtlarını ses sunucusundan (PulseAudio / PipeWire) verir.
//
// Tarayıcıdaki gibi: enumerateDevices mikrofonları ve hoparlörleri (adlarıyla; burada izin kavramı
// yok) listeler, getUserMedia seçilen aygıttan ses izi açar, aygıt takılıp çıkınca ya da sistemin
// varsayılanı değişince 'devicechange' olayı çıkar. Aygıt kimliği sunucudaki aygıt adıdır; görünen ad
// sunucunun açıklamasıdır ("Monitor of …" adları Firefox'takiyle aynıdır: sayfa bilgisayarın sesini
// bu adla bulur). Sistemin varsayılan aygıtı listenin başında gelir.
//
// Tarayıcının kendi ses işlemleri (yankı engelleme, gürültü bastırma, otomatik kazanç) burada yok:
// istenseler de uygulanmaz ve getSettings bunu doğru bildirir. Gürültü bastırmayı sayfanın kendisi
// yapar (RNNoise); yankı için kulaklık gerekir.
'use strict';

const { olayOzellikleri } = require('./webaudio');
const { wrtc, izTanit, izBitir } = require('../rtc');

const hata = (ad, metin, ek) => Object.assign(new Error(metin), { name: ad }, ek);
// Kısıt değeri: düz değer, { exact }, { ideal } ya da dizi.
function kisitDegeri(k) {
	if (k == null) return { deger: undefined, kesin: false };
	if (typeof k === 'object' && !Array.isArray(k)) {
		if (k.exact != null) return { deger: Array.isArray(k.exact) ? k.exact[0] : k.exact, kesin: true };
		if (k.ideal != null) return { deger: Array.isArray(k.ideal) ? k.ideal[0] : k.ideal, kesin: false };
		return { deger: undefined, kesin: false };
	}
	return { deger: Array.isArray(k) ? k[0] : k, kesin: false };
}

class MedyaAygitlari extends EventTarget {
	// motor: SesMotoru; pulse: () => Promise<PulseBaglantisi> (ortak bağlantı).
	constructor({ motor, pulse, gunluk = () => {} }) {
		super();
		this.motor = motor;
		this.pulse = pulse;
		this.gunluk = gunluk;
		this.abone = null; // olaylarına abone olunan bağlantı
		this.degisimZamani = null;
	}

	async baglanti() {
		const p = await this.pulse();
		if (this.abone !== p) {
			this.abone = p;
			p.on('olay', () => {
				// Değişiklikler art arda gelir: bir kez bildir.
				clearTimeout(this.degisimZamani);
				this.degisimZamani = setTimeout(() => this.dispatchEvent(new Event('devicechange')), 250);
			});
			p.on('kapandi', () => {
				if (this.abone === p) this.abone = null;
			});
			await p.aboneOl().catch(() => {});
		}
		return p;
	}

	// Ses sunucusundaki aygıtlar: { girisler, cikislar } (varsayılan başta).
	async aygitlar() {
		const p = await this.baglanti();
		const [bilgi, cikislar, girisler] = await Promise.all([p.sunucuBilgisi(), p.cikislar(), p.girisler()]);
		const basa = (liste, ad) => {
			const i = liste.findIndex((a) => a.ad === ad);
			if (i > 0) liste.unshift(...liste.splice(i, 1));
			return liste;
		};
		return { girisler: basa(girisler, bilgi.varsayilanGiris), cikislar: basa(cikislar, bilgi.varsayilanCikis) };
	}

	async enumerateDevices() {
		let a;
		try {
			a = await this.aygitlar();
		} catch (h) {
			this.gunluk('ses aygıtları okunamadı', h);
			return [];
		}
		const kayit = (kind, x) => {
			const k = { deviceId: x.ad, kind, label: x.aciklama, groupId: x.ozellikler['device.bus_path'] || x.ozellikler['alsa.card'] || '' };
			return { ...k, toJSON: () => k };
		};
		return [...a.girisler.map((x) => kayit('audioinput', x)), ...a.cikislar.map((x) => kayit('audiooutput', x))];
	}

	getSupportedConstraints() {
		return { deviceId: true, groupId: true, channelCount: true, sampleRate: true, sampleSize: true, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
	}

	async getUserMedia(kisitlar) {
		if (!kisitlar || (!kisitlar.audio && !kisitlar.video)) throw new TypeError('getUserMedia: ses ya da görüntü istenmeli');
		if (kisitlar.video) throw hata('NotFoundError', 'Kamera yok');
		const ses = kisitlar.audio === true ? {} : kisitlar.audio;
		const istenen = kisitDegeri(ses.deviceId);
		const kanal = Number(kisitDegeri(ses.channelCount).deger) >= 2 ? 2 : 1;
		let liste;
		try {
			liste = (await this.aygitlar()).girisler;
		} catch (h) {
			throw hata('NotFoundError', (h && h.message) || 'Ses sunucusuna ulaşılamadı');
		}
		let aygit = istenen.deger && istenen.deger !== 'default' ? liste.find((x) => x.ad === istenen.deger) : null;
		if (istenen.deger && istenen.deger !== 'default' && !aygit && istenen.kesin) throw hata('OverconstrainedError', 'İstenen ses aygıtı yok', { constraint: 'deviceId' });
		if (!aygit) aygit = liste[0];
		if (!aygit) throw hata('NotFoundError', 'Ses girişi yok');
		let y;
		try {
			y = await this.motor.yakalamaAc({ aygit: aygit.ad, kanal, etiket: aygit.aciklama });
		} catch (h) {
			// Aygıt o arada çıkarıldı (yok) ya da açılamıyor.
			throw hata(h && h.kod === 5 ? 'NotFoundError' : 'NotReadableError', (h && h.message) || 'Ses aygıtı açılamadı');
		}
		const iz = y.iz;
		izTanit(iz, {
			etiket: aygit.aciklama,
			ayarlar: () => ({ deviceId: aygit.ad, groupId: '', channelCount: kanal, sampleRate: 48000, sampleSize: 32, echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: 0.025 }),
			dur: () => y.kapat(),
		});
		// Aygıt çıkarıldı ya da ses sunucusu kapandı: iz biter (sayfa yeniden almayı dener).
		y.bittiGeri = () => izBitir(iz);
		return new wrtc.MediaStream([iz]);
	}
}
olayOzellikleri(MedyaAygitlari, 'devicechange');

module.exports = { MedyaAygitlari };
