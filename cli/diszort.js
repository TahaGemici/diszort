#!/usr/bin/env node
// Diszort — tarayıcısız istemci (terminal).
//
// Web istemcisinin (web/) kendisini çalıştırır: arayüz terminale çizilir, ses PulseAudio/PipeWire'dan
// alınıp çalınır, bağlantılar tarayıcılarınkiyle aynı WebRTC motorundan (libwebrtc) geçer. Kurulum
// yok: tek dosyalık program. Ayarlar (sunucu adresi, giriş anahtarı, ses ayarları) programla aynı
// klasördeki diszort.json'da durur; başka bir yere bir şey yazılmaz.
//
//   ./diszort                      ayar dosyasındaki sunucuya bağlanır (ilk açılışta adres sorulur)
//   ./diszort https://sunucu/…     o sunucuya bağlanır (giriş bağlantısı, #anahtar=… da olur)
//   ./diszort --guncelle           son sürüme günceller (program kendini değiştirir)
//   ./diszort --surum              sürümü yazar
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { yapiBilgisi, gomulu, gomuluVarliklar, sunucuVarliklari } = require('./varlik');

const YAPI = yapiBilgisi();
const PROGRAM = gomulu ? process.execPath : __filename;
const AYAR_DOSYASI = process.env.DISZORT_AYAR || path.join(path.dirname(PROGRAM), 'diszort.json');
const GUNLUK_DOSYASI = process.env.DISZORT_GUNLUK || '';

// ---------------------------------------------------------------- ayar dosyası

function ayarOku() {
	try {
		const a = JSON.parse(fs.readFileSync(AYAR_DOSYASI, 'utf8'));
		return a && typeof a === 'object' ? a : {};
	} catch (h) {
		if (h.code === 'ENOENT') return {};
		throw new Error(`Ayar dosyası okunamadı (${AYAR_DOSYASI}): ${h.message}`);
	}
}
// Yazma: önce geçici dosyaya, sonra yerine (yarım dosya kalmasın). İçinde giriş anahtarı var: 0600.
function ayarYaz(ayar) {
	const gecici = AYAR_DOSYASI + '.yeni';
	fs.writeFileSync(gecici, JSON.stringify(ayar, null, '\t') + '\n', { mode: 0o600 });
	fs.renameSync(gecici, AYAR_DOSYASI);
}
function yazilabilirMi() {
	try {
		fs.accessSync(path.dirname(AYAR_DOSYASI), fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

// "chat.ornek.com" → "https://chat.ornek.com"; geçersizse null.
function adresDuzelt(girdi) {
	let s = String(girdi || '').trim();
	if (!s) return null;
	if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
	try {
		const u = new URL(s);
		return u.origin + (u.hash || '');
	} catch {
		return null;
	}
}

function sor(soru) {
	return new Promise((coz) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question(soru, (y) => {
			rl.close();
			coz(y);
		});
	});
}

// ---------------------------------------------------------------- güncelleme

// Yayındaki son sürüm: GitHub sürümündeki surum.json ({ surum, commit, sha256 }).
async function sonSurum() {
	if (!YAPI.depo) return null;
	const yanit = await fetch(`https://github.com/${YAPI.depo}/releases/latest/download/surum.json`, { signal: AbortSignal.timeout(15000) });
	if (!yanit.ok) return null;
	return yanit.json();
}
const yeniMi = (son) => !!son && !!son.commit && son.commit !== YAPI.commit;

// Programı son sürümle değiştir. Dönüş: yeni sürüm adı.
async function guncelle(bildir = () => {}) {
	if (!gomulu) throw new Error('Geliştirme kopyası güncellenmez (git pull).');
	const son = await sonSurum();
	if (!son) throw new Error('Son sürüm bilgisi alınamadı.');
	if (!yeniMi(son)) return null;
	const ad = `diszort-linux-${os.arch() === 'arm64' ? 'arm64' : 'x64'}`;
	bildir(`İndiriliyor: ${son.surum}…`);
	const yanit = await fetch(`https://github.com/${YAPI.depo}/releases/latest/download/${ad}`, { signal: AbortSignal.timeout(600000) });
	if (!yanit.ok) throw new Error(`İndirilemedi (HTTP ${yanit.status}).`);
	const veri = Buffer.from(await yanit.arrayBuffer());
	const ozet = crypto.createHash('sha256').update(veri).digest('hex');
	if (son.sha256 && son.sha256[ad] && son.sha256[ad] !== ozet) throw new Error('İndirilen dosyanın özeti tutmuyor; güncellenmedi.');
	const gecici = path.join(path.dirname(PROGRAM), '.diszort.yeni');
	fs.writeFileSync(gecici, veri, { mode: 0o755 });
	fs.renameSync(gecici, PROGRAM);
	return son.surum;
}

// Güncellenen programı aynı terminalde yeniden başlat.
function yenidenBaslat() {
	const argv = process.argv.slice(gomulu ? 1 : 2);
	if (typeof process.execve === 'function') process.execve(PROGRAM, [PROGRAM, ...argv], process.env);
	const { spawnSync } = require('node:child_process');
	const r = spawnSync(PROGRAM, argv, { stdio: 'inherit' });
	process.exit(r.status ?? 0);
}

// ---------------------------------------------------------------- günlük

function gunlukcu() {
	if (!GUNLUK_DOSYASI) return () => {};
	return (...a) => {
		const satir = a.map((x) => (x && x.stack ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
		try {
			fs.appendFileSync(GUNLUK_DOSYASI, `${new Date().toISOString()} ${satir}\n`);
		} catch {}
	};
}

// ---------------------------------------------------------------- ana

async function ana() {
	const argv = process.argv.slice(gomulu ? 1 : 2).filter((a) => a !== process.execPath);
	if (argv.includes('--surum') || argv.includes('-v') || argv.includes('--version')) {
		console.log(`Diszort ${YAPI.surum}${YAPI.commit ? ' (' + YAPI.commit + ')' : ''}`);
		return;
	}
	if (argv.includes('--yardim') || argv.includes('-h') || argv.includes('--help')) {
		console.log(`Diszort ${YAPI.surum} — terminalden Diszort

  ./diszort                      ayar dosyasındaki sunucuya bağlanır (ilk açılışta adres sorulur)
  ./diszort https://sunucu/…     o sunucuya bağlanır (giriş bağlantısı, #anahtar=… da olur)
  ./diszort --guncelle           son sürüme günceller
  ./diszort --surum              sürümü yazar

Ayarlar: ${AYAR_DOSYASI}
Tuşlar: Tab/↑↓ gez · Enter seç · Esc kapat · Alt+M mikrofon · Alt+D sağırlaştır · PgUp/PgDn kaydır · Ctrl+C çık
Dosya paylaşmak: dosyayı terminale sürükle (ya da yolunu yapıştır) ya da + düğmesi.`);
		return;
	}
	if (argv.includes('--guncelle')) {
		const yeni = await guncelle((m) => console.log(m));
		console.log(yeni ? `Güncellendi: ${yeni}` : `Zaten son sürüm: ${YAPI.surum}`);
		return;
	}
	if (process.platform !== 'linux') throw new Error('Diszort CLI yalnızca Linux\'ta çalışır (ses PulseAudio/PipeWire üzerinden).');
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Bir terminalde çalıştır (girdi ve çıktı terminal olmalı).');

	const ayar = ayarOku();
	const adresArg = argv.find((a) => !a.startsWith('-'));
	let adres = adresArg ? adresDuzelt(adresArg) : adresDuzelt(ayar.sunucu);
	if (adresArg && !adres) throw new Error('Geçersiz sunucu adresi: ' + adresArg);
	if (!adres) {
		console.log('Diszort — ilk açılış.\nSunucunun adresini ya da sana verilen giriş bağlantısını yapıştır (ör. https://chat.ornek.com).');
		adres = adresDuzelt(await sor('Adres: '));
		if (!adres) throw new Error('Adres verilmedi.');
	}
	if (!yazilabilirMi()) throw new Error(`Ayar dosyası yazılamıyor: ${AYAR_DOSYASI}\nProgramı yazabildiğin bir klasöre taşı (ayarlar programın yanında tutulur).`);
	const u = new URL(adres);
	const sunucu = u.origin;
	// Başka bir sunucuya geçildiyse eski sunucunun anahtarı (ve sayfa verisi) taşınmaz.
	const depo = ayar.sunucu && adresDuzelt(ayar.sunucu) && new URL(adresDuzelt(ayar.sunucu)).origin === sunucu ? ayar.depo || {} : {};
	const yeniAyar = { sunucu, depo, istemciKodu: ayar.istemciKodu || 'program' };
	ayarYaz(yeniAyar);

	const gunluk = gunlukcu();
	process.on('uncaughtException', (h) => gunluk('yakalanmamış hata', h));
	process.on('unhandledRejection', (h) => gunluk('yakalanmamış söz', h));

	const { Kabuk } = require('./kabuk/kabuk');
	const { Arayuz } = require('./arayuz/arayuz');
	const { Goruntu } = require('./arayuz/goruntu');
	const varliklar = yeniAyar.istemciKodu === 'sunucu' ? sunucuVarliklari(sunucu) : gomuluVarliklar();
	const kabuk = new Kabuk({ sunucu: sunucu + '/' + (u.hash || ''), depo, varliklar, surum: YAPI.surum, gunluk, genislik: (process.stdout.columns || 120) * 10 });

	// Sayfanın deposu (localStorage) değiştikçe ayar dosyasına yazılır (kısa aralıklarla bir kez).
	let yazZamani = null;
	const kaydet = () => {
		clearTimeout(yazZamani);
		yazZamani = null;
		try {
			ayarYaz({ ...yeniAyar, depo: kabuk.depo });
		} catch (h) {
			gunluk('ayar yazılamadı', h);
		}
	};
	kabuk.on('depo', () => {
		if (!yazZamani) yazZamani = setTimeout(kaydet, 500);
	});

	let arayuz = null;
	let kapaniyor = false;
	const kapat = async (kod = 0, sonra = null) => {
		if (kapaniyor) return;
		kapaniyor = true;
		const zorla = setTimeout(() => process.exit(kod), 3000);
		try {
			await kabuk.kapat();
		} catch {}
		kaydet();
		if (arayuz) arayuz.bitir();
		clearTimeout(zorla);
		if (sonra) sonra();
		// libwebrtc kapanışta (açık bağlantılar varken) çökebiliyor: süreç açıkça bitirilir.
		process.exit(kod);
	};
	for (const sinyal of ['SIGTERM', 'SIGHUP']) process.on(sinyal, () => kapat(0));

	await kabuk.baslat();
	arayuz = new Arayuz({ kabuk, surum: YAPI.surum, cikis: () => kapat(0) });
	arayuz.goruntu = new Goruntu({ kabuk, arayuz });
	arayuz.baslat();

	// Güncelleme denetimi: açılışta, sonra 6 saatte bir; sunucu güncellenince (sayfa yenilenir) de.
	if (gomulu && YAPI.depo) {
		const denetle = async () => {
			try {
				const son = await sonSurum();
				if (!yeniMi(son)) return;
				arayuz.guncelleme = {
					metin: `Yeni sürüm ${son.surum} · Ctrl+U güncelle`,
					yap: async () => {
						const ok = await arayuz.sor({ baslik: `Diszort ${son.surum}`, aciklama: 'Program yeni sürümle değiştirilip yeniden başlatılsın mı? (Sesli kanaldaysan kısa bir kesinti olur.)', dugmeler: [{ ad: 'Güncelle', deger: 'evet', tus: 'g' }, { ad: 'Sonra', deger: null, tus: 's' }] });
						if (ok !== 'evet') return;
						try {
							arayuz.bildir('Yeni sürüm indiriliyor…');
							const yeni = await guncelle((m) => arayuz.bildir(m));
							if (!yeni) return arayuz.bildir('Zaten son sürüm.');
							kapat(0, yenidenBaslat);
						} catch (h) {
							arayuz.bildir('Güncellenemedi: ' + h.message, true);
						}
					},
				};
				arayuz.planla(0);
			} catch (h) {
				gunluk('güncelleme denetimi', h);
			}
		};
		setTimeout(denetle, 5000).unref();
		setInterval(denetle, 6 * 3600 * 1000).unref();
		kabuk.on('pencere', () => setTimeout(denetle, 3000).unref());
	}
}

ana().catch((h) => {
	console.error('Diszort: ' + ((h && h.message) || h));
	process.exit(1);
});

module.exports = { adresDuzelt };
